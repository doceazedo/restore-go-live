use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};

use crate::patch::retry;

pub const FILES: [&str; 3] = ["main.js", "preload.js", "renderer.js"];

pub fn missing(dir: &Path) -> Vec<&'static str> {
    FILES.iter().copied().filter(|f| !dir.join(f).is_file()).collect()
}

pub fn is_complete(dir: &Path) -> bool {
    missing(dir).is_empty()
}

pub fn install_from(source: &Path, dist: &Path) -> Result<()> {
    let absent = missing(source);
    if !absent.is_empty() {
        bail!("{} is missing {}", source.display(), absent.join(", "));
    }

    let parent = dist.parent().context("payload dir has no parent")?;
    fs::create_dir_all(parent)?;
    let staged = parent.join("dist.new");
    let old = parent.join("dist.old");
    if staged.exists() {
        fs::remove_dir_all(&staged)?;
    }
    fs::create_dir_all(&staged)?;

    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            fs::copy(entry.path(), staged.join(entry.file_name()))
                .with_context(|| format!("copying {}", entry.path().display()))?;
        }
    }

    if old.exists() {
        fs::remove_dir_all(&old)?;
    }
    if dist.exists() {
        retry("moving the old payload aside", || fs::rename(dist, &old))?;
    }
    if let Err(e) = retry("activating the new payload", || fs::rename(&staged, dist)) {
        if old.exists() {
            let _ = fs::rename(&old, dist);
        }
        return Err(e);
    }
    if old.exists() {
        fs::remove_dir_all(&old).ok();
    }
    Ok(())
}
