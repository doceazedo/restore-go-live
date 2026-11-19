use std::fs;
use std::path::PathBuf;

use anyhow::{bail, Result};
use clap::{Parser, Subcommand, ValueEnum};

use crate::discord::{self, Branch, Install, Platform};
use crate::patch::{self, State};
use crate::paths::Paths;
use crate::payload;

#[derive(Parser, Debug)]
#[command(name = "restore-go-live", version, about = "Keeps RestoreGoLive patched into Discord")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    #[command(about = "Show detected Discord installs and their patch state")]
    Status,
    #[command(about = "Install the payload and patch Discord")]
    Install {
        #[arg(long, value_enum)]
        branch: Option<Target>,
        #[arg(long)]
        force: bool,
        #[arg(long, value_name = "DIR")]
        payload: Option<PathBuf>,
    },
    #[command(about = "Restore the original Discord and remove RestoreGoLive")]
    Uninstall {
        #[arg(long, value_enum)]
        branch: Option<Target>,
        #[arg(long)]
        keep_data: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Target {
    Stable,
    Ptb,
    Canary,
    Development,
    All,
}

impl Target {
    fn branch(self) -> Option<Branch> {
        match self {
            Target::Stable => Some(Branch::Stable),
            Target::Ptb => Some(Branch::Ptb),
            Target::Canary => Some(Branch::Canary),
            Target::Development => Some(Branch::Development),
            Target::All => None,
        }
    }
}

pub struct Context {
    pub paths: Paths,
    pub platform: Box<dyn Platform>,
}

impl Context {
    pub fn from_env() -> Result<Self> {
        let Some(platform) = discord::Windows::from_env() else {
            bail!("LOCALAPPDATA is not set");
        };
        Ok(Self { paths: Paths::from_env()?, platform: Box::new(platform) })
    }

    pub fn installs(&self) -> Vec<Install> {
        discord::detect(self.platform.as_ref())
    }

    pub fn state(&self, install: &Install) -> State {
        patch::classify(&install.resources, &self.paths.legacy_dist)
    }
}

pub fn run(cli: Cli) -> Result<()> {
    let ctx = Context::from_env()?;
    match cli.command.unwrap_or(Command::Status) {
        Command::Status => status(&ctx),
        Command::Install { branch, force, payload } => {
            let report = install(&ctx, branch, force, payload)?;
            report.print();
            report.into_result()?;
            println!("\ndone! fully quit and reopen Discord");
            Ok(())
        }
        Command::Uninstall { branch, keep_data } => {
            let report = uninstall(&ctx, branch, keep_data)?;
            report.print();
            report.into_result()
        }
    }
}

fn status(ctx: &Context) -> Result<()> {
    let installs = ctx.installs();
    if installs.is_empty() {
        println!("no Discord installation found");
    }
    for install in &installs {
        println!("{:<12} {:<10} {}", install.branch, install.version, ctx.state(install));
        println!("{:<12} {}", "", install.resources.display());
    }
    let dist = ctx.paths.dist();
    let missing = payload::missing(&dist);
    if missing.is_empty() {
        println!("\npayload      {}", dist.display());
    } else {
        println!("\npayload      not installed ({} missing in {})", missing.join(", "), dist.display());
    }
    if patch::dir_has_marker(&ctx.paths.legacy_dist) {
        println!("legacy       old Vencord-based build in {}", ctx.paths.legacy_dist.display());
    }
    Ok(())
}

pub fn select(installs: Vec<Install>, target: Option<Target>) -> Result<Vec<Install>> {
    match target {
        Some(Target::All) => Ok(installs),
        Some(t) => {
            let branch = t.branch().unwrap();
            let picked: Vec<Install> = installs.into_iter().filter(|i| i.branch == branch).collect();
            if picked.is_empty() {
                bail!("no {branch} installation found");
            }
            Ok(picked)
        }
        None => {
            let default = installs
                .iter()
                .position(|i| i.branch == Branch::Stable)
                .unwrap_or(0);
            if installs.len() > 1 {
                let others: Vec<&str> = installs.iter().map(|i| i.branch.label()).collect();
                println!(
                    "found {} installs ({}), using {}. pass --branch to pick another or --branch all",
                    installs.len(),
                    others.join(", "),
                    installs[default].branch
                );
            }
            Ok(installs.into_iter().nth(default).into_iter().collect())
        }
    }
}

#[derive(Debug, Default)]
pub struct Report {
    pub lines: Vec<String>,
    pub failures: Vec<String>,
}

impl Report {
    fn ok(&mut self, line: String) {
        self.lines.push(line);
    }

    fn fail(&mut self, line: String) {
        self.lines.push(format!("FAILED: {line}"));
        self.failures.push(line);
    }

    pub fn print(&self) {
        for line in &self.lines {
            println!("{line}");
        }
    }

    pub fn into_result(self) -> Result<()> {
        if self.failures.is_empty() {
            Ok(())
        } else {
            bail!("{} installation(s) could not be updated", self.failures.len())
        }
    }
}

pub fn install(ctx: &Context, target: Option<Target>, force: bool, source: Option<PathBuf>) -> Result<Report> {
    let installs = ctx.installs();
    if installs.is_empty() {
        bail!("no Discord installation found, install Discord and launch it once first");
    }

    let dist = ctx.paths.dist();
    match source {
        Some(dir) => payload::install_from(&dir, &dist)?,
        None if !payload::is_complete(&dist) => bail!(
            "no payload in {}, pass --payload <dir> with main.js, preload.js and renderer.js",
            dist.display()
        ),
        None => {}
    }

    let mut report = Report::default();
    report.ok(format!("payload ready in {}", dist.display()));

    let main_js = ctx.paths.main_js();
    for install in select(installs, target)? {
        match patch::patch(&install.resources, &main_js, &ctx.paths.legacy_dist, force) {
            Ok(action) => report.ok(format!("{} {}: {action}", install.branch, install.version)),
            Err(e) => report.fail(format!("{} {}: {e:#}", install.branch, install.version)),
        }
    }

    let still_legacy = ctx.installs().iter().any(|i| ctx.state(i) == State::Legacy);
    if report.failures.is_empty() && !still_legacy {
        for removed in patch::cleanup_legacy_dist(&ctx.paths.legacy_dist)? {
            report.ok(format!("removed old build {}", removed.display()));
        }
    }

    Ok(report)
}

pub fn uninstall(ctx: &Context, target: Option<Target>, keep_data: bool) -> Result<Report> {
    let installs = ctx.installs();
    let selected = match target {
        None => installs,
        t => select(installs, t)?,
    };

    let mut report = Report::default();
    for install in selected {
        match patch::unpatch(&install.resources, &ctx.paths.legacy_dist) {
            Ok(action) => report.ok(format!("{} {}: {action}", install.branch, install.version)),
            Err(e) => report.fail(format!("{} {}: {e:#}", install.branch, install.version)),
        }
    }

    let any_patched = ctx
        .installs()
        .iter()
        .any(|i| matches!(ctx.state(i), State::Patched { .. } | State::Legacy));
    if !keep_data && !any_patched && ctx.paths.data.exists() {
        fs::remove_dir_all(&ctx.paths.data)?;
        report.ok(format!("removed {}", ctx.paths.data.display()));
    }

    Ok(report)
}
