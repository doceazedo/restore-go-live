use std::env;
use std::path::PathBuf;

use anyhow::{Context, Result};

pub const CLI_EXE: &str = "restore-go-live.exe";
pub const DAEMON_EXE: &str = "restore-go-live-daemon.exe";

#[derive(Debug, Clone)]
pub struct Paths {
    pub data: PathBuf,
    pub bin: PathBuf,
    pub legacy_dist: PathBuf,
}

impl Paths {
    pub fn from_env() -> Result<Self> {
        let roaming = env::var_os("APPDATA")
            .map(PathBuf::from)
            .context("APPDATA is not set")?;
        let local = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .context("LOCALAPPDATA is not set")?;
        Ok(Self {
            data: roaming.join("RestoreGoLive"),
            bin: local.join("RestoreGoLive"),
            legacy_dist: roaming.join("Vencord").join("dist"),
        })
    }

    pub fn dist(&self) -> PathBuf {
        self.data.join("dist")
    }

    pub fn main_js(&self) -> PathBuf {
        self.dist().join("main.js")
    }

    pub fn config(&self) -> PathBuf {
        self.data.join("state.json")
    }

    pub fn launch_signal(&self) -> PathBuf {
        self.data.join("launched.json")
    }

    pub fn logs(&self) -> PathBuf {
        self.data.join("logs")
    }

    pub fn cli_exe(&self) -> PathBuf {
        self.bin.join(CLI_EXE)
    }

    pub fn daemon_exe(&self) -> PathBuf {
        self.bin.join(DAEMON_EXE)
    }
}
