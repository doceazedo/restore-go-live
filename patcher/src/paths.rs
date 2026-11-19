use std::env;
use std::path::PathBuf;

use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct Paths {
    pub data: PathBuf,
    pub legacy_dist: PathBuf,
}

impl Paths {
    pub fn from_env() -> Result<Self> {
        let roaming = env::var_os("APPDATA")
            .map(PathBuf::from)
            .context("APPDATA is not set")?;
        Ok(Self {
            data: roaming.join("RestoreGoLive"),
            legacy_dist: roaming.join("Vencord").join("dist"),
        })
    }

    pub fn dist(&self) -> PathBuf {
        self.data.join("dist")
    }

    pub fn main_js(&self) -> PathBuf {
        self.dist().join("main.js")
    }
}
