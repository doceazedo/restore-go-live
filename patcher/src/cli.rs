use std::fs;
use std::path::PathBuf;

use anyhow::{bail, Context as _, Result};
use clap::{Parser, Subcommand, ValueEnum};

use crate::config::Config;
use crate::discord::{self, Branch, Install, Platform};
use crate::patch::{self, State};
use crate::paths::{Paths, DAEMON_EXE};
use crate::update::{self, Fetch};
use crate::{daemon, payload, system};

#[derive(Parser, Debug)]
#[command(name = "restore-go-live", version = crate::daemon::VERSION, about = "Keeps RestoreGoLive patched into Discord")]
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
        #[arg(long, help = "Skip installing the background daemon")]
        no_daemon: bool,
    },
    #[command(about = "Restore the original Discord and remove RestoreGoLive")]
    Uninstall {
        #[arg(long, value_enum)]
        branch: Option<Target>,
        #[arg(long)]
        keep_data: bool,
    },
    #[command(about = "Update the payload and programs from the latest release")]
    Update {
        #[arg(long, help = "Only report what would be updated")]
        check: bool,
    },
    #[command(about = "Run the background daemon in the foreground")]
    Daemon,
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
    pub fetch: Box<dyn Fetch>,
}

impl Context {
    pub fn from_env() -> Result<Self> {
        let Some(platform) = discord::Windows::from_env() else {
            bail!("LOCALAPPDATA is not set");
        };
        Ok(Self {
            paths: Paths::from_env()?,
            platform: Box::new(platform),
            fetch: Box::new(update::Http::from_env()),
        })
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
    system::remove_stale_exes(&ctx.paths.bin);
    match cli.command.unwrap_or(Command::Status) {
        Command::Status => status(&ctx),
        Command::Install { branch, force, payload, no_daemon } => {
            let mut report = install(&ctx, branch, force, payload)?;
            if !no_daemon && report.failures.is_empty() {
                setup_daemon(&ctx, &mut report);
            }
            report.print();
            report.into_result()?;
            println!("\ndone! fully quit and reopen Discord");
            Ok(())
        }
        Command::Uninstall { branch, keep_data } => {
            let mut config = Config::load(&ctx.paths.config());
            let remaining: Vec<Branch> = match branch.and_then(Target::branch) {
                Some(b) => config.branches.iter().copied().filter(|x| *x != b).collect(),
                None => Vec::new(),
            };
            let mut report = Report::default();
            if remaining.is_empty() {
                teardown_daemon(&ctx, &mut report);
            }
            let unpatched = uninstall(&ctx, branch, keep_data)?;
            report.lines.extend(unpatched.lines);
            report.failures.extend(unpatched.failures);
            if !remaining.is_empty() {
                config.branches = remaining;
                config.save(&ctx.paths.config())?;
            }
            report.print();
            report.into_result()
        }
        Command::Update { check } => {
            let report = update(&ctx, check)?;
            report.print();
            report.into_result()
        }
        Command::Daemon => daemon::run(ctx),
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

    let config = Config::load(&ctx.paths.config());
    let managed: Vec<&str> = config.branches.iter().map(|b| b.label()).collect();
    println!("managed      {}", if managed.is_empty() { "none".to_string() } else { managed.join(", ") });
    let pids: Vec<String> = system::processes_named(DAEMON_EXE).iter().map(|p| p.pid.to_string()).collect();
    println!(
        "daemon       {}",
        if pids.is_empty() { "not running".to_string() } else { format!("running (pid {})", pids.join(", ")) }
    );
    println!("autostart    {}", system::autostart().unwrap_or_else(|| "off".into()));
    Ok(())
}

fn stop_daemon() -> bool {
    let pids: Vec<u32> = system::processes_named(DAEMON_EXE).iter().map(|p| p.pid).collect();
    if pids.is_empty() {
        return false;
    }
    system::kill(&pids);
    for _ in 0..20 {
        if system::processes_named(DAEMON_EXE).is_empty() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    true
}

fn copy_binary(from: &std::path::Path, to: &std::path::Path) -> Result<()> {
    if system::same_file(from, to) {
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = to.with_extension("exe.new");
    fs::copy(from, &temp)?;
    patch::retry(&format!("replacing {}", to.display()), || fs::rename(&temp, to))
}

pub fn setup_daemon(ctx: &Context, report: &mut Report) {
    let result = (|| -> Result<()> {
        let current = std::env::current_exe()?;
        let source_daemon = current.with_file_name(DAEMON_EXE);
        stop_daemon();
        copy_binary(&current, &ctx.paths.cli_exe())?;
        if source_daemon.is_file() {
            copy_binary(&source_daemon, &ctx.paths.daemon_exe())?;
        } else {
            let manifest = update::fetch_manifest(ctx.fetch.as_ref())?;
            let asset = update::require_binary(&manifest, DAEMON_EXE)?;
            let staged = update::stage_binary(ctx.fetch.as_ref(), asset, &ctx.paths.daemon_exe())?;
            patch::retry("installing the daemon", || fs::rename(&staged, ctx.paths.daemon_exe()))?;
        }
        system::set_autostart(&ctx.paths.daemon_exe())?;
        system::spawn_detached(&ctx.paths.daemon_exe(), &[])?;
        Ok(())
    })();
    match result {
        Ok(()) => report.ok(format!("daemon running from {}, starts with Windows", ctx.paths.bin.display())),
        Err(e) => report.fail(format!("daemon: {e:#}")),
    }
}

pub fn teardown_daemon(ctx: &Context, report: &mut Report) {
    if stop_daemon() {
        report.ok("daemon stopped".into());
    }
    match system::remove_autostart() {
        Ok(()) => {}
        Err(e) => report.fail(format!("autostart: {e:#}")),
    }
    if fs::remove_file(ctx.paths.daemon_exe()).is_ok() {
        report.ok(format!("removed {}", ctx.paths.daemon_exe().display()));
    }
    let current = std::env::current_exe().ok();
    let cli = ctx.paths.cli_exe();
    if current.as_deref().is_some_and(|c| system::same_file(c, &cli)) {
        report.ok(format!("{} is in use, delete it after this command exits", cli.display()));
    } else if fs::remove_file(&cli).is_ok() {
        report.ok(format!("removed {}", cli.display()));
    }
    let _ = fs::remove_dir(&ctx.paths.bin);
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
    let mut report = Report::default();
    match source {
        Some(dir) => payload::install_from(&dir, &dist)?,
        None => match download_payload(ctx) {
            Ok(line) => report.ok(line),
            Err(e) if payload::is_complete(&dist) => {
                report.ok(format!("could not check for a newer payload, keeping the installed one: {e:#}"))
            }
            Err(e) => return Err(e.context("downloading the payload")),
        },
    }
    report.ok(format!("payload ready in {}", dist.display()));

    let main_js = ctx.paths.main_js();
    let mut config = Config::load(&ctx.paths.config());
    for install in select(installs, target)? {
        match patch::patch(&install.resources, &main_js, &ctx.paths.legacy_dist, force) {
            Ok(action) => {
                config.add(install.branch);
                report.ok(format!("{} {}: {action}", install.branch, install.version))
            }
            Err(e) => report.fail(format!("{} {}: {e:#}", install.branch, install.version)),
        }
    }
    config.save(&ctx.paths.config())?;

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
    let still_legacy = ctx.installs().iter().any(|i| ctx.state(i) == State::Legacy);
    if report.failures.is_empty() && !still_legacy {
        for removed in patch::cleanup_legacy_dist(&ctx.paths.legacy_dist)? {
            report.ok(format!("removed old build {}", removed.display()));
        }
    }

    Ok(report)
}

fn download_payload(ctx: &Context) -> Result<String> {
    let manifest = update::fetch_manifest(ctx.fetch.as_ref())?;
    let names = update::sync_payload(ctx.fetch.as_ref(), &manifest, &ctx.paths.dist())?;
    Ok(if names.is_empty() {
        format!("payload already at {}", manifest.version)
    } else {
        format!("downloaded payload {} ({})", manifest.version, names.join(", "))
    })
}

fn replace_installed(target: &std::path::Path, staged: &std::path::Path) -> Result<()> {
    let running_self = std::env::current_exe().ok().is_some_and(|c| system::same_file(&c, target));
    if running_self {
        return system::replace_running_exe(target, staged).with_context(|| format!("replacing {}", target.display()));
    }
    patch::retry(&format!("replacing {}", target.display()), || fs::rename(staged, target))
}

pub fn update(ctx: &Context, check: bool) -> Result<Report> {
    let mut report = Report::default();
    let manifest = update::fetch_manifest(ctx.fetch.as_ref())?;
    report.ok(format!("latest release {}", manifest.version));

    let dist = ctx.paths.dist();
    let outdated: Vec<String> = update::outdated_payload(&manifest, &dist)?
        .into_iter()
        .map(|(n, _)| n.clone())
        .collect();
    if outdated.is_empty() {
        report.ok("payload up to date".into());
    } else if check {
        report.ok(format!("payload update available ({})", outdated.join(", ")));
    } else {
        let names = update::sync_payload(ctx.fetch.as_ref(), &manifest, &dist)?;
        report.ok(format!("payload updated ({}), restart Discord to load it", names.join(", ")));
    }

    if !ctx.paths.daemon_exe().is_file() && !ctx.paths.cli_exe().is_file() {
        report.ok("programs not installed, skipping them".into());
        return Ok(report);
    }
    let binaries = update::outdated_binaries(&manifest, &ctx.paths.bin);
    if binaries.is_empty() {
        report.ok("programs up to date".into());
        return Ok(report);
    }
    for (name, asset) in binaries {
        if check {
            report.ok(format!("{name} update available"));
            continue;
        }
        let target = ctx.paths.bin.join(name);
        let result = (|| -> Result<()> {
            let staged = update::stage_binary(ctx.fetch.as_ref(), asset, &target)?;
            if name == DAEMON_EXE {
                let was_running = stop_daemon();
                replace_installed(&target, &staged)?;
                if was_running || system::autostart().is_some() {
                    system::spawn_detached(&target, &[])?;
                }
            } else {
                replace_installed(&target, &staged)?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => report.ok(format!("{name} updated")),
            Err(e) => report.fail(format!("{name}: {e:#}")),
        }
    }
    Ok(report)
}
