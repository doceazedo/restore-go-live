use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System, UpdateKind};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
use winreg::RegKey;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "RestoreGoLive";

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

fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

pub fn command_line(exe: &Path, args: &[&str]) -> String {
    let mut line = format!("\"{}\"", exe.display());
    for arg in args {
        line.push(' ');
        if arg.is_empty() || arg.contains([' ', '\t']) {
            line.push_str(&format!("\"{arg}\""));
        } else {
            line.push_str(arg);
        }
    }
    line
}

pub fn spawn_detached(exe: &Path, args: &[&str]) -> Result<()> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS, PROCESS_INFORMATION,
        STARTUPINFOW,
    };

    let application = wide(exe.as_os_str());
    let mut line = wide(std::ffi::OsStr::new(&command_line(exe, args)));
    let directory = exe.parent().map(|p| wide(p.as_os_str()));
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    let ok = unsafe {
        CreateProcessW(
            application.as_ptr(),
            line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
            std::ptr::null(),
            directory.as_ref().map_or(std::ptr::null(), |d| d.as_ptr()),
            &startup,
            &mut info,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error()).with_context(|| format!("starting {}", exe.display()));
    }
    unsafe {
        CloseHandle(info.hProcess);
        CloseHandle(info.hThread);
    }
    Ok(())
}

pub fn same_file(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").to_lowercase();
    norm(a) == norm(b)
}
