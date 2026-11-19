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

    fs::create_dir_all(dist).with_context(|| format!("creating {}", dist.display()))?;

    let mut staged = Vec::new();
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let temp = dist.join(format!("{}.rgl-new", name.to_string_lossy()));
        fs::copy(entry.path(), &temp).with_context(|| format!("copying {}", entry.path().display()))?;
        staged.push((temp, dist.join(&name)));
    }

    staged.sort_by_key(|(_, target)| target.file_name() == Some("main.js".as_ref()));

    for (temp, target) in staged {
        retry(&format!("replacing {}", target.display()), || fs::rename(&temp, &target))?;
    }
    Ok(())
}
