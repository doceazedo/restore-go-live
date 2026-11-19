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

pub fn write_files(dist: &Path, mut files: Vec<(String, Vec<u8>)>) -> Result<()> {
    fs::create_dir_all(dist).with_context(|| format!("creating {}", dist.display()))?;
    files.sort_by_key(|(name, _)| name == "main.js");

    let mut staged = Vec::new();
    for (name, bytes) in files {
        let temp = dist.join(format!("{name}.rgl-new"));
        fs::write(&temp, bytes).with_context(|| format!("writing {}", temp.display()))?;
        staged.push((temp, dist.join(name)));
    }
    for (temp, target) in staged {
        retry(&format!("replacing {}", target.display()), || fs::rename(&temp, &target))?;
    }
    Ok(())
}

pub fn install_from(source: &Path, dist: &Path) -> Result<()> {
    let absent = missing(source);
    if !absent.is_empty() {
        bail!("{} is missing {}", source.display(), absent.join(", "));
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            let bytes = fs::read(entry.path()).with_context(|| format!("reading {}", entry.path().display()))?;
            files.push((entry.file_name().to_string_lossy().into_owned(), bytes));
        }
    }
    write_files(dist, files)
}
