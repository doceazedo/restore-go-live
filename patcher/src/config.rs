use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::discord::Branch;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub branches: Vec<Branch>,
    pub relaunch_after_update: bool,
    pub auto_update: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self { branches: Vec::new(), relaunch_after_update: true, auto_update: true }
    }
}

impl Config {
    pub fn load(path: &Path) -> Config {
        fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temp = path.with_extension("json.tmp");
        fs::write(&temp, serde_json::to_string_pretty(self)?)?;
        fs::rename(&temp, path).with_context(|| format!("writing {}", path.display()))
    }

    pub fn add(&mut self, branch: Branch) {
        if !self.branches.contains(&branch) {
            self.branches.push(branch);
        }
    }

    pub fn remove(&mut self, branch: Branch) {
        self.branches.retain(|b| *b != branch);
    }
}
