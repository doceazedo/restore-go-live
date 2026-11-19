use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context as _, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::paths::{CLI_EXE, DAEMON_EXE};
use crate::payload;

pub const DEFAULT_BASE: &str = "https://github.com/doceazedo/restore-go-live/releases/latest/download";
pub const MANIFEST: &str = "manifest.json";
pub const TARGET: &str = if cfg!(target_arch = "aarch64") { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" };
const MAX_DOWNLOAD: u64 = 64 * 1024 * 1024;

pub trait Fetch: Send + Sync {
    fn fetch(&self, name: &str) -> Result<Vec<u8>>;
}

pub struct Http {
    base: String,
    agent: ureq::Agent,
}

impl Http {
    pub fn from_env() -> Http {
        let base = env::var("RGL_RELEASE_URL").unwrap_or_else(|_| DEFAULT_BASE.to_string());
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(120)))
            .user_agent(concat!("restore-go-live/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Http { base: base.trim_end_matches('/').to_string(), agent }
    }
}

impl Fetch for Http {
    fn fetch(&self, name: &str) -> Result<Vec<u8>> {
        let url = format!("{}/{name}", self.base);
        let mut response = self.agent.get(&url).call().with_context(|| format!("downloading {url}"))?;
        response
            .body_mut()
            .with_config()
            .limit(MAX_DOWNLOAD)
            .read_to_vec()
            .with_context(|| format!("reading {url}"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asset {
    pub asset: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub commit: String,
    pub payload: BTreeMap<String, Asset>,
    #[serde(default)]
    pub binaries: BTreeMap<String, BTreeMap<String, Asset>>,
}

impl Manifest {
    pub fn binaries(&self) -> Option<&BTreeMap<String, Asset>> {
        self.binaries.get(TARGET)
    }

    pub fn binary(&self, name: &str) -> Option<&Asset> {
        self.binaries()?.get(name)
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_file(path: &Path) -> Option<String> {
    fs::read(path).ok().map(|b| sha256_hex(&b))
}

pub fn fetch_manifest(fetch: &dyn Fetch) -> Result<Manifest> {
    let bytes = fetch.fetch(MANIFEST)?;
    serde_json::from_slice(&bytes).context("parsing manifest.json")
}

pub fn download(fetch: &dyn Fetch, asset: &Asset) -> Result<Vec<u8>> {
    let bytes = fetch.fetch(&asset.asset)?;
    let actual = sha256_hex(&bytes);
    if !actual.eq_ignore_ascii_case(&asset.sha256) {
        bail!("{} failed verification (expected {}, got {actual})", asset.asset, asset.sha256);
    }
    Ok(bytes)
}

pub fn outdated_payload<'a>(manifest: &'a Manifest, dist: &Path) -> Result<Vec<(&'a String, &'a Asset)>> {
    for required in payload::FILES {
        if !manifest.payload.contains_key(required) {
            bail!("manifest is missing {required}");
        }
    }
    Ok(manifest
        .payload
        .iter()
        .filter(|(name, asset)| sha256_file(&dist.join(name)).is_none_or(|h| !h.eq_ignore_ascii_case(&asset.sha256)))
        .collect())
}

pub fn sync_payload(fetch: &dyn Fetch, manifest: &Manifest, dist: &Path) -> Result<Vec<String>> {
    let outdated = outdated_payload(manifest, dist)?;
    let mut files = Vec::new();
    for (name, asset) in &outdated {
        files.push(((*name).clone(), download(fetch, asset)?));
    }
    let names = files.iter().map(|(n, _)| n.clone()).collect();
    if !files.is_empty() {
        payload::write_files(dist, files)?;
    }
    Ok(names)
}

pub fn outdated_binaries<'a>(manifest: &'a Manifest, bin: &Path) -> Vec<(&'static str, &'a Asset)> {
    [CLI_EXE, DAEMON_EXE]
        .into_iter()
        .filter_map(|name| {
            let asset = manifest.binary(name)?;
            let current = sha256_file(&bin.join(name));
            current.is_none_or(|h| !h.eq_ignore_ascii_case(&asset.sha256)).then_some((name, asset))
        })
        .collect()
}

pub fn stage_binary(fetch: &dyn Fetch, asset: &Asset, target: &Path) -> Result<PathBuf> {
    let bytes = download(fetch, asset)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let staged = target.with_extension("exe.new");
    fs::write(&staged, bytes).with_context(|| format!("writing {}", staged.display()))?;
    Ok(staged)
}

pub fn require_binary<'a>(manifest: &'a Manifest, name: &str) -> Result<&'a Asset> {
    manifest
        .binary(name)
        .ok_or_else(|| anyhow!("the latest release has no {name} for {TARGET}"))
}
