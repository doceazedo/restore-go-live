use std::env;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use semver::Version;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, clap::ValueEnum, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Branch {
    Stable,
    Ptb,
    Canary,
    Development,
}

impl Branch {
    pub const ALL: [Branch; 4] = [Branch::Stable, Branch::Ptb, Branch::Canary, Branch::Development];

    pub fn label(self) -> &'static str {
        match self {
            Branch::Stable => "stable",
            Branch::Ptb => "ptb",
            Branch::Canary => "canary",
            Branch::Development => "development",
        }
    }

    pub fn executable(self) -> &'static str {
        match self {
            Branch::Stable => "Discord.exe",
            Branch::Ptb => "DiscordPTB.exe",
            Branch::Canary => "DiscordCanary.exe",
            Branch::Development => "DiscordDevelopment.exe",
        }
    }

    pub fn windows_dir(self) -> &'static str {
        match self {
            Branch::Stable => "Discord",
            Branch::Ptb => "DiscordPTB",
            Branch::Canary => "DiscordCanary",
            Branch::Development => "DiscordDevelopment",
        }
    }
}

impl fmt::Display for Branch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.pad(self.label())
    }
}

pub trait Platform {
    fn roots(&self) -> Vec<(Branch, PathBuf)>;
}

pub struct Windows {
    local_app_data: PathBuf,
}

impl Windows {
    pub fn from_env() -> Option<Self> {
        env::var_os("LOCALAPPDATA").map(|p| Self { local_app_data: PathBuf::from(p) })
    }
}

impl Platform for Windows {
    fn roots(&self) -> Vec<(Branch, PathBuf)> {
        Branch::ALL
            .iter()
            .map(|b| (*b, self.local_app_data.join(b.windows_dir())))
            .collect()
    }
}

#[derive(Debug, Clone)]
pub struct Install {
    pub branch: Branch,
    pub root: PathBuf,
    pub version: Version,
    pub resources: PathBuf,
}

pub fn app_dirs(root: &Path) -> Vec<(Version, PathBuf)> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found: Vec<(Version, PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let version = Version::parse(name.strip_prefix("app-")?).ok()?;
            let resources = e.path().join("resources");
            let has_app = resources.join("app.asar").exists() || resources.join("_app.asar").exists();
            has_app.then_some((version, resources))
        })
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

pub fn newest(branch: Branch, root: &Path) -> Option<Install> {
    let (version, resources) = app_dirs(root).pop()?;
    Some(Install { branch, root: root.to_path_buf(), version, resources })
}

pub fn detect(platform: &dyn Platform) -> Vec<Install> {
    platform
        .roots()
        .into_iter()
        .filter_map(|(branch, root)| newest(branch, &root))
        .collect()
}
