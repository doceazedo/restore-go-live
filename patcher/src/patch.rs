use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

pub const MARKER: &str = "RestoreGoLive";
const SHIM_KEY: &str = "restoreGoLive";
const LEGACY_FILES: [&str; 4] = ["patcher.js", "preload.js", "renderer.js", "renderer.css"];
const RETRY_DELAYS_MS: [u64; 5] = [100, 250, 500, 1000, 2000];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Unpatched,
    Patched { target: Option<PathBuf> },
    Legacy,
    Foreign(String),
    MissingAsar,
    Empty,
}

impl fmt::Display for State {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            State::Unpatched => f.write_str("not patched"),
            State::Patched { .. } => f.write_str("patched"),
            State::Legacy => f.write_str("patched by the old Vencord-based RestoreGoLive"),
            State::Foreign(why) => write!(f, "patched by another mod ({why})"),
            State::MissingAsar => f.write_str("broken (app.asar missing, _app.asar present)"),
            State::Empty => f.write_str("no app.asar found"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatchAction {
    Patched,
    Refreshed,
    Migrated,
    Repaired,
    Replaced,
}

impl fmt::Display for PatchAction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            PatchAction::Patched => "patched",
            PatchAction::Refreshed => "already patched, shim refreshed",
            PatchAction::Migrated => "migrated from the old Vencord-based install",
            PatchAction::Repaired => "repaired missing app.asar shim",
            PatchAction::Replaced => "replaced another mod's shim",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnpatchAction {
    Restored,
    NotPatched,
    SkippedForeign(String),
}

impl fmt::Display for UnpatchAction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UnpatchAction::Restored => f.write_str("restored original app.asar"),
            UnpatchAction::NotPatched => f.write_str("not patched, nothing to do"),
            UnpatchAction::SkippedForeign(why) => write!(f, "skipped, patched by another mod ({why})"),
        }
    }
}

fn app_asar(resources: &Path) -> PathBuf {
    resources.join("app.asar")
}

fn original_asar(resources: &Path) -> PathBuf {
    resources.join("_app.asar")
}

pub fn dir_has_marker(dir: &Path) -> bool {
    ["patcher.js", "renderer.js"].iter().any(|f| {
        fs::read(dir.join(f))
            .map(|bytes| bytes.windows(MARKER.len()).any(|w| w == MARKER.as_bytes()))
            .unwrap_or(false)
    })
}

fn literal_between(source: &str, open: &str, close: char) -> Option<PathBuf> {
    let start = source.find(open)? + open.len();
    let end = start + source[start..].find(close)?;
    serde_json::from_str::<String>(source[start..end].trim()).ok().map(PathBuf::from)
}

fn shim_target(shim: &Path) -> Option<PathBuf> {
    let index = fs::read_to_string(shim.join("index.js")).ok()?;
    literal_between(&index, "const target = ", ';').or_else(|| literal_between(&index, "require(", ')'))
}

pub fn shim_source(main_js: &Path) -> Result<String> {
    let target = serde_json::to_string(&main_js.to_string_lossy())?;
    Ok(format!(
        r#"const target = {target};
if (require("fs").existsSync(target)) {{
  require(target);
}} else {{
  const path = require("path");
  const message = "[" + new Date().toISOString() + "] [" + process.pid + "] payload missing at " + target + ", starting Discord without it";
  console.error("[RestoreGoLive] " + message);
  try {{
    const logs = path.join(path.dirname(target), "..", "logs");
    require("fs").mkdirSync(logs, {{ recursive: true }});
    require("fs").appendFileSync(path.join(logs, "main.log"), message + "\n");
  }} catch {{}}
  const original = path.join(__dirname, "..", "_app.asar");
  const pkg = require(path.join(original, "package.json"));
  require.main.filename = path.join(original, pkg.main);
  require("electron").app.setAppPath(original);
  require(require.main.filename);
}}
"#
    ))
}

fn shim_is_ours(shim: &Path) -> bool {
    fs::read_to_string(shim.join("package.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get(SHIM_KEY).and_then(Value::as_bool))
        .unwrap_or(false)
}

fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    norm(a) == norm(b)
}

pub fn classify(resources: &Path, legacy_dist: &Path) -> State {
    let asar = app_asar(resources);
    let original = original_asar(resources).is_file();

    if asar.is_dir() {
        if shim_is_ours(&asar) {
            return State::Patched { target: shim_target(&asar) };
        }
        return match shim_target(&asar) {
            Some(target)
                if target.parent().is_some_and(|p| same_path(p, legacy_dist)) && dir_has_marker(legacy_dist) =>
            {
                State::Legacy
            }
            Some(target) => State::Foreign(format!("shim requires {}", target.display())),
            None => State::Foreign("unrecognized app.asar folder".into()),
        };
    }

    if asar.is_file() {
        return if original {
            State::Foreign("app.asar archive next to _app.asar, likely Vencord".into())
        } else {
            State::Unpatched
        };
    }

    if original {
        State::MissingAsar
    } else {
        State::Empty
    }
}

pub fn retry<T>(what: &str, mut op: impl FnMut() -> io::Result<T>) -> Result<T> {
    let mut last = None;
    for delay in std::iter::once(0).chain(RETRY_DELAYS_MS) {
        if delay > 0 {
            thread::sleep(Duration::from_millis(delay));
        }
        match op() {
            Ok(v) => return Ok(v),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(e).context(what.to_string()),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap()).with_context(|| format!("{what}, fully quit Discord (including the tray icon) and try again"))
}

fn write_shim(resources: &Path, main_js: &Path) -> Result<()> {
    let shim = app_asar(resources);
    fs::create_dir_all(&shim).with_context(|| format!("creating {}", shim.display()))?;
    fs::write(shim.join("index.js"), shim_source(main_js)?)?;
    let package = json!({ "name": "discord", "main": "index.js", SHIM_KEY: true });
    fs::write(shim.join("package.json"), serde_json::to_string(&package)?)?;
    Ok(())
}

fn remove_legacy_app_dir(resources: &Path) -> Result<()> {
    let legacy = resources.join("app");
    if legacy.join("index.js").is_file() {
        fs::remove_dir_all(&legacy).with_context(|| format!("removing {}", legacy.display()))?;
    }
    Ok(())
}

fn remove_any(path: &Path) -> io::Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

pub fn patch(resources: &Path, main_js: &Path, legacy_dist: &Path, force: bool) -> Result<PatchAction> {
    let asar = app_asar(resources);
    let original = original_asar(resources);

    let action = match classify(resources, legacy_dist) {
        State::Unpatched => {
            retry("moving app.asar to _app.asar", || fs::rename(&asar, &original))?;
            PatchAction::Patched
        }
        State::Patched { .. } => PatchAction::Refreshed,
        State::Legacy => PatchAction::Migrated,
        State::MissingAsar => PatchAction::Repaired,
        State::Foreign(why) if !force => {
            bail!("{} is {why}, rerun with --force to replace it", resources.display())
        }
        State::Foreign(_) => {
            retry("removing the existing app.asar shim", || remove_any(&asar))?;
            PatchAction::Replaced
        }
        State::Empty => bail!("{} has no app.asar", resources.display()),
    };

    write_shim(resources, main_js)?;
    remove_legacy_app_dir(resources)?;
    Ok(action)
}

pub fn unpatch(resources: &Path, legacy_dist: &Path) -> Result<UnpatchAction> {
    let asar = app_asar(resources);
    let original = original_asar(resources);

    match classify(resources, legacy_dist) {
        State::Patched { .. } | State::Legacy => {
            let parked = resources.join("app.asar.rgl-old");
            if parked.exists() {
                remove_any(&parked)?;
            }
            retry("moving the shim out of the way", || fs::rename(&asar, &parked))?;
            if let Err(e) = retry("restoring _app.asar", || fs::rename(&original, &asar)) {
                let _ = fs::rename(&parked, &asar);
                return Err(e);
            }
            fs::remove_dir_all(&parked).ok();
            Ok(UnpatchAction::Restored)
        }
        State::MissingAsar => {
            retry("restoring _app.asar", || fs::rename(&original, &asar))?;
            Ok(UnpatchAction::Restored)
        }
        State::Foreign(why) => Ok(UnpatchAction::SkippedForeign(why)),
        State::Unpatched | State::Empty => Ok(UnpatchAction::NotPatched),
    }
}

pub fn cleanup_legacy_dist(legacy_dist: &Path) -> Result<Vec<PathBuf>> {
    if !dir_has_marker(legacy_dist) {
        return Ok(Vec::new());
    }
    let mut removed = Vec::new();
    for file in LEGACY_FILES {
        for name in [file.to_string(), format!("{file}.map"), format!("{file}.LEGAL.txt")] {
            let path = legacy_dist.join(name);
            if path.is_file() {
                fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
                removed.push(path);
            }
        }
    }
    Ok(removed)
}
