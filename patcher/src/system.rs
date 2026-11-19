use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System, UpdateKind};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
use winreg::RegKey;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "RestoreGoLive";
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct SingleInstance(windows_sys::Win32::Foundation::HANDLE);

impl SingleInstance {
    pub fn acquire(name: &str) -> Option<SingleInstance> {
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
        use windows_sys::Win32::System::Threading::CreateMutexW;

        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 1, wide.as_ptr()) };
        if handle.is_null() {
            return None;
        }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return None;
        }
        Some(SingleInstance(handle))
    }
}

impl Drop for SingleInstance {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

pub fn autostart_command(daemon: &Path) -> String {
    format!("\"{}\"", daemon.display())
}

pub fn set_autostart(daemon: &Path) -> Result<()> {
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY).context("opening the Run key")?;
    key.set_value(RUN_VALUE, &autostart_command(daemon)).context("writing the Run key")
}

pub fn remove_autostart() -> Result<()> {
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)?;
    match key.delete_value(RUN_VALUE) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

pub fn autostart() -> Option<String> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN_KEY, KEY_READ)
        .ok()?
        .get_value(RUN_VALUE)
        .ok()
}

#[derive(Debug, Clone)]
pub struct ProcessInfo {
    pub pid: u32,
    pub exe: PathBuf,
    pub started: u64,
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn system() -> Option<System> {
    System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing().with_exe(UpdateKind::Always)),
    )
    .ok()
}

pub fn processes_named(file_name: &str) -> Vec<ProcessInfo> {
    let Some(mut sys) = system() else {
        return Vec::new();
    };
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
    );
    sys.processes()
        .values()
        .filter_map(|p| {
            let exe = p.exe()?.to_path_buf();
            let matches = exe
                .file_name()
                .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(file_name));
            matches.then(|| ProcessInfo { pid: p.pid().as_u32(), exe, started: p.start_time() })
        })
        .collect()
}

pub fn kill(pids: &[u32]) {
    let Some(mut sys) = system() else {
        return;
    };
    sys.refresh_processes(ProcessesToUpdate::All, true);
    for pid in pids {
        if let Some(p) = sys.process(sysinfo::Pid::from_u32(*pid)) {
            p.kill();
        }
    }
}

pub fn replace_running_exe(target: &Path, staged: &Path) -> Result<()> {
    let old = target.with_extension("exe.old");
    if old.exists() {
        let _ = std::fs::remove_file(&old);
    }
    let parked = if old.exists() { target.with_extension(format!("exe.{}.old", std::process::id())) } else { old };
    std::fs::rename(target, &parked).with_context(|| format!("moving {} aside", target.display()))?;
    if let Err(e) = std::fs::rename(staged, target) {
        let _ = std::fs::rename(&parked, target);
        return Err(e).with_context(|| format!("installing {}", target.display()));
    }
    Ok(())
}

pub fn remove_stale_exes(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name.ends_with(".old") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn stop_inheriting_std_handles() {
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};

    for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        unsafe {
            let handle = GetStdHandle(which);
            if !handle.is_null() {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

pub fn spawn_detached(exe: &Path, args: &[&str]) -> Result<()> {
    stop_inheriting_std_handles();
    Command::new(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
        .spawn()
        .with_context(|| format!("starting {}", exe.display()))?;
    Ok(())
}

pub fn same_file(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").to_lowercase();
    norm(a) == norm(b)
}
