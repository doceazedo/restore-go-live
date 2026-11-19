use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use anyhow::Result;
use notify::{RecursiveMode, Watcher};
use serde::Deserialize;

use crate::cli::Context;
use crate::config::Config;
use crate::discord::{Branch, Install};
use crate::info;
use crate::patch::{self, PatchAction, State};
use crate::paths::{CLI_EXE, DAEMON_EXE};
use crate::payload;
use crate::update;
use crate::system::{self, ProcessInfo};

pub const MUTEX: &str = "Local\\RestoreGoLiveDaemon";
const SWEEP: Duration = Duration::from_secs(300);
const HOT_TICK: Duration = Duration::from_secs(1);
const HOT_WINDOW: Duration = Duration::from_secs(120);
const SETTLE: Duration = Duration::from_secs(3);
const RELAUNCH_WINDOW_SECS: u64 = 60;
const FIRST_UPDATE_CHECK: Duration = Duration::from_secs(20);
const UPDATE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const UPDATE_RETRY: Duration = Duration::from_secs(30 * 60);
const LAUNCH_RECHECK: Duration = Duration::from_secs(120);
const STARTUP_LAUNCH_SECS: u64 = 60;
pub const VERSION: &str = match option_env!("RGL_VERSION") {
    Some(v) => v,
    None => concat!(env!("CARGO_PKG_VERSION"), "-dev"),
};

#[derive(Debug, Clone)]
pub struct Patched {
    pub install: Install,
    pub action: PatchAction,
    pub at: u64,
}

#[derive(Debug, Default)]
pub struct Reconciler {
    warned: HashSet<String>,
}

impl Reconciler {
    fn warn_once(&mut self, key: String, message: String) {
        if self.warned.insert(key) {
            info!("{message}");
        }
    }

    pub fn managed(ctx: &Context, config: &Config) -> Vec<Install> {
        let installs = ctx.installs();
        if config.branches.is_empty() {
            return installs
                .into_iter()
                .filter(|i| matches!(ctx.state(i), State::Patched { .. }))
                .collect();
        }
        installs.into_iter().filter(|i| config.branches.contains(&i.branch)).collect()
    }

    pub fn reconcile(&mut self, ctx: &Context, config: &Config) -> Vec<Patched> {
        let mut done = Vec::new();
        if !payload::is_complete(&ctx.paths.dist()) {
            self.warn_once(
                "payload".into(),
                format!("payload incomplete in {}, Discord will start without the mod", ctx.paths.dist().display()),
            );
        }

        let main_js = ctx.paths.main_js();
        for install in Self::managed(ctx, config) {
            let label = format!("{} {}", install.branch, install.version);
            let state = ctx.state(&install);
            let needs = match &state {
                State::Unpatched => settled(&install.resources.join("app.asar")),
                State::MissingAsar | State::Legacy => true,
                State::Patched { target } => target.as_deref().is_none_or(|t| !system::same_file(t, &main_js)),
                State::Foreign(why) => {
                    self.warn_once(format!("foreign {label}"), format!("{label}: left alone, {why}"));
                    false
                }
                State::Empty => false,
            };
            if !needs {
                continue;
            }
            match patch::patch(&install.resources, &main_js, &ctx.paths.legacy_dist, false) {
                Ok(action) => {
                    info!("{label}: {action}");
                    self.warned.remove(&format!("error {label}"));
                    done.push(Patched { install, action, at: system::now_secs() });
                }
                Err(e) => self.warn_once(format!("error {label}"), format!("{label}: {e:#}")),
            }
        }
        done
    }
}

fn settled(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age >= SETTLE)
}

pub fn stale_processes(procs: &[ProcessInfo], app_dir: &Path, patched_at: u64) -> Vec<u32> {
    procs
        .iter()
        .filter(|p| p.exe.parent().is_some_and(|d| system::same_file(d, app_dir)))
        .filter(|p| p.started <= patched_at && patched_at - p.started <= RELAUNCH_WINDOW_SECS)
        .map(|p| p.pid)
        .collect()
}

fn in_app_dir(p: &ProcessInfo, app_dir: &Path) -> bool {
    p.exe.parent().is_some_and(|d| system::same_file(d, app_dir))
}

fn relaunch_if_needed(patched: &Patched) {
    if patched.action != PatchAction::Patched {
        return;
    }
    let Some(app_dir) = patched.install.resources.parent() else {
        return;
    };
    let branch: Branch = patched.install.branch;
    let procs = system::processes_named(branch.executable());
    if stale_processes(&procs, app_dir, patched.at).is_empty() {
        if procs.iter().any(|p| in_app_dir(p, app_dir)) {
            info!("{branch}: running unpatched for a while, the mod loads on its next launch");
        }
        return;
    }

    info!("{branch}: started unpatched right after its update, restarting it");
    restart_discord(&patched.install);
}

fn restart_discord(install: &Install) {
    let branch = install.branch;
    let Some(app_dir) = install.resources.parent() else {
        return;
    };
    let running: Vec<u32> = system::processes_named(branch.executable())
        .iter()
        .filter(|p| in_app_dir(p, app_dir))
        .map(|p| p.pid)
        .collect();
    if running.is_empty() {
        return;
    }
    system::kill(&running);
    for _ in 0..20 {
        thread::sleep(Duration::from_millis(250));
        if !system::processes_named(branch.executable()).iter().any(|p| in_app_dir(p, app_dir)) {
            break;
        }
    }
    let updater = install.root.join("Update.exe");
    let result = if updater.is_file() {
        system::spawn_detached(&updater, &["--processStart", branch.executable()])
    } else {
        system::spawn_detached(&app_dir.join(branch.executable()), &[])
    };
    if let Err(e) = result {
        info!("{branch}: could not restart: {e:#}");
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Launch {
    pub pid: u32,
    pub exe: PathBuf,
    pub at: u64,
}

pub fn read_launch(path: &Path) -> Option<Launch> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

pub fn install_for<'a>(installs: &'a [Install], exe: &Path) -> Option<&'a Install> {
    let dir = exe.parent()?;
    installs
        .iter()
        .find(|i| i.resources.parent().is_some_and(|d| system::same_file(d, dir)))
}

fn restart_launched(ctx: &Context, launch: &Launch) {
    if !system::is_running(launch.pid) {
        info!("the update loads on the next Discord launch");
        return;
    }
    let installs = ctx.installs();
    let Some(install) = install_for(&installs, &launch.exe) else {
        info!("{} is not a known Discord install, not restarting it", launch.exe.display());
        return;
    };
    info!("{}: restarting to load the update", install.branch);
    restart_discord(install);
}

fn watch_roots(ctx: &Context, watcher: &mut impl Watcher, watched: &mut HashSet<PathBuf>) {
    for (branch, root) in ctx.platform.roots() {
        if watched.contains(&root) || !root.is_dir() {
            continue;
        }
        match watcher.watch(&root, RecursiveMode::NonRecursive) {
            Ok(()) => {
                info!("watching {branch} at {}", root.display());
                watched.insert(root);
            }
            Err(e) => info!("cannot watch {}: {e}", root.display()),
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct UpdateOutcome {
    pub payload_updated: bool,
    pub daemon_replaced: bool,
}

pub fn check_updates(ctx: &Context) -> Result<UpdateOutcome> {
    let fetch = ctx.fetch.as_ref();
    let manifest = update::fetch_manifest(fetch)?;
    let names = update::sync_payload(fetch, &manifest, &ctx.paths.dist())?;
    let mut outcome = UpdateOutcome { payload_updated: !names.is_empty(), daemon_replaced: false };
    if outcome.payload_updated {
        info!("payload updated to {} ({})", manifest.version, names.join(", "));
    }

    let installed = std::env::current_exe()
        .ok()
        .is_some_and(|c| system::same_file(&c, &ctx.paths.daemon_exe()));
    if !installed {
        return Ok(outcome);
    }

    let mut binaries = update::outdated_binaries(&manifest, &ctx.paths.bin);
    binaries.sort_by_key(|(name, _)| *name == DAEMON_EXE);
    for (name, asset) in binaries {
        let target = ctx.paths.bin.join(name);
        let staged = update::stage_binary(fetch, asset, &target)?;
        if name == CLI_EXE {
            match patch::retry("replacing the CLI", || fs::rename(&staged, &target)) {
                Ok(()) => info!("{name} updated to {}", manifest.version),
                Err(e) => {
                    let _ = fs::remove_file(&staged);
                    info!("{name}: {e:#}, trying again later");
                }
            }
        } else {
            system::replace_running_exe(&target, &staged)?;
            info!("{name} updated to {}, restarting", manifest.version);
            outcome.daemon_replaced = true;
        }
    }
    Ok(outcome)
}

pub fn run(ctx: Context) -> Result<()> {
    let mut instance = None;
    for _ in 0..50 {
        instance = system::SingleInstance::acquire(MUTEX);
        if instance.is_some() || !std::env::args().any(|a| a == "--restarted") {
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }
    let Some(instance) = instance else {
        return Ok(());
    };
    crate::log::init(&ctx.paths.logs(), "daemon.log");
    info!("daemon {VERSION} started");
    system::remove_stale_exes(&ctx.paths.bin);

    let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            let _ = tx.send(event.paths);
        }
    })?;
    let mut watched = HashSet::new();
    let mut reconciler = Reconciler::default();
    let mut hot_until: Option<Instant> = None;
    let mut next_update = Instant::now() + FIRST_UPDATE_CHECK;

    let signal = ctx.paths.launch_signal();
    let _ = fs::create_dir_all(&ctx.paths.data);
    if let Err(e) = watcher.watch(&ctx.paths.data, RecursiveMode::NonRecursive) {
        info!("cannot watch {}: {e}, updates will not be checked on launch", ctx.paths.data.display());
    }
    let mut seen_launch = read_launch(&signal);
    let mut pending_launch = seen_launch
        .clone()
        .filter(|l| system::now_secs().saturating_sub(l.at) <= STARTUP_LAUNCH_SECS);
    let mut last_check: Option<Instant> = None;

    loop {
        watch_roots(&ctx, &mut watcher, &mut watched);
        let config = Config::load(&ctx.paths.config());
        for patched in reconciler.reconcile(&ctx, &config) {
            if config.relaunch_after_update {
                relaunch_if_needed(&patched);
            }
        }

        let recently_checked = last_check.is_some_and(|t| t.elapsed() < LAUNCH_RECHECK);
        let launch = pending_launch.take().filter(|_| config.auto_update && !recently_checked);
        if config.auto_update && (launch.is_some() || Instant::now() >= next_update) {
            if let Some(l) = &launch {
                info!("Discord opened ({}), checking for updates", l.exe.display());
            }
            last_check = Some(Instant::now());
            match check_updates(&ctx) {
                Ok(outcome) => {
                    if outcome.payload_updated {
                        match &launch {
                            Some(l) => restart_launched(&ctx, l),
                            None => info!("the update loads on the next Discord launch"),
                        }
                    }
                    if outcome.daemon_replaced {
                        drop(instance);
                        system::spawn_detached(&ctx.paths.daemon_exe(), &["--restarted"])?;
                        return Ok(());
                    }
                    next_update = Instant::now() + UPDATE_INTERVAL;
                }
                Err(e) => {
                    info!("update check failed: {e:#}");
                    next_update = Instant::now() + UPDATE_RETRY;
                }
            }
        }

        let hot = hot_until.is_some_and(|t| Instant::now() < t);
        let until_update = next_update.saturating_duration_since(Instant::now()).max(HOT_TICK);
        match rx.recv_timeout(if hot { HOT_TICK } else { SWEEP.min(until_update) }) {
            Ok(first) => {
                let mut paths = first;
                while let Ok(more) = rx.try_recv() {
                    paths.extend(more);
                }
                let (launches, others): (Vec<PathBuf>, Vec<PathBuf>) =
                    paths.into_iter().partition(|p| p.file_name() == signal.file_name());
                if !launches.is_empty() {
                    if let Some(l) = read_launch(&signal).filter(|l| seen_launch.as_ref() != Some(l)) {
                        seen_launch = Some(l.clone());
                        pending_launch = Some(l);
                    }
                }
                if others.iter().any(|p| !p.starts_with(&ctx.paths.data)) {
                    hot_until = Some(Instant::now() + HOT_WINDOW);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}
