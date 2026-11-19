use std::fs;
use std::path::{Path, PathBuf};

use rgl::cli::{self, Context, Target};
use rgl::discord::{self, Branch, Platform};
use rgl::patch::{self, PatchAction, State, UnpatchAction};
use rgl::paths::Paths;
use tempfile::TempDir;

const ORIGINAL: &[u8] = b"original discord asar";

struct Fake {
    roots: Vec<(Branch, PathBuf)>,
}

impl Platform for Fake {
    fn roots(&self) -> Vec<(Branch, PathBuf)> {
        self.roots.clone()
    }
}

struct Env {
    _tmp: TempDir,
    local: PathBuf,
    ctx: Context,
    payload_src: PathBuf,
}

fn app(root: &Path, version: &str) -> PathBuf {
    let resources = root.join(format!("app-{version}")).join("resources");
    fs::create_dir_all(&resources).unwrap();
    fs::write(resources.join("app.asar"), ORIGINAL).unwrap();
    resources
}

fn env(branches: &[Branch]) -> Env {
    let tmp = TempDir::new().unwrap();
    let local = tmp.path().join("Local");
    let roaming = tmp.path().join("Roaming");
    let roots = branches
        .iter()
        .map(|b| (*b, local.join(b.windows_dir())))
        .collect::<Vec<_>>();
    for (_, root) in &roots {
        app(root, "1.0.10");
        app(root, "1.0.9");
    }
    let payload_src = tmp.path().join("build");
    fs::create_dir_all(&payload_src).unwrap();
    for f in ["main.js", "preload.js", "renderer.js"] {
        fs::write(payload_src.join(f), format!("// {f}")).unwrap();
    }
    let paths = Paths {
        data: roaming.join("RestoreGoLive"),
        legacy_dist: roaming.join("Vencord").join("dist"),
    };
    Env {
        local,
        payload_src,
        ctx: Context { paths, platform: Box::new(Fake { roots }) },
        _tmp: tmp,
    }
}

fn newest(e: &Env, branch: Branch) -> PathBuf {
    e.local.join(branch.windows_dir()).join("app-1.0.10").join("resources")
}

#[test]
fn detects_newest_version_by_semver() {
    let e = env(&[Branch::Stable, Branch::Canary]);
    let installs = e.ctx.installs();
    assert_eq!(installs.len(), 2);
    for install in installs {
        assert_eq!(install.version.to_string(), "1.0.10");
        assert_eq!(e.ctx.state(&install), State::Unpatched);
    }
}

#[test]
fn ignores_app_dirs_without_asar() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("DiscordCanary");
    app(&root, "1.0.5");
    fs::create_dir_all(root.join("app-1.0.6").join("resources")).unwrap();
    let found = discord::newest(Branch::Canary, &root).unwrap();
    assert_eq!(found.version.to_string(), "1.0.5");
}

#[test]
fn patch_unpatch_roundtrip_is_idempotent() {
    let e = env(&[Branch::Canary]);
    let res = newest(&e, Branch::Canary);
    let main_js = e.ctx.paths.main_js();
    let legacy = &e.ctx.paths.legacy_dist;

    assert_eq!(patch::patch(&res, &main_js, legacy, false).unwrap(), PatchAction::Patched);
    assert!(res.join("app.asar").is_dir());
    assert_eq!(fs::read(res.join("_app.asar")).unwrap(), ORIGINAL);
    let index = fs::read_to_string(res.join("app.asar").join("index.js")).unwrap();
    assert!(index.contains("main.js"));
    assert_eq!(
        patch::classify(&res, legacy),
        State::Patched { target: Some(main_js.clone()) }
    );

    assert_eq!(patch::patch(&res, &main_js, legacy, false).unwrap(), PatchAction::Refreshed);

    assert_eq!(patch::unpatch(&res, legacy).unwrap(), UnpatchAction::Restored);
    assert_eq!(fs::read(res.join("app.asar")).unwrap(), ORIGINAL);
    assert!(!res.join("_app.asar").exists());
    assert_eq!(patch::unpatch(&res, legacy).unwrap(), UnpatchAction::NotPatched);
}

#[test]
fn shim_escapes_windows_paths() {
    let e = env(&[Branch::Canary]);
    let res = newest(&e, Branch::Canary);
    let main_js = PathBuf::from(r#"C:\Users\some "quoted" user\RestoreGoLive\dist\main.js"#);
    patch::patch(&res, &main_js, &e.ctx.paths.legacy_dist, false).unwrap();
    assert_eq!(
        patch::classify(&res, &e.ctx.paths.legacy_dist),
        State::Patched { target: Some(main_js) }
    );
}

fn legacy_install(e: &Env, branch: Branch) -> PathBuf {
    let legacy = &e.ctx.paths.legacy_dist;
    fs::create_dir_all(legacy).unwrap();
    fs::write(legacy.join("patcher.js"), "x RestoreGoLive y").unwrap();
    fs::write(legacy.join("patcher.js.map"), "{}").unwrap();
    fs::write(legacy.join("renderer.js"), "renderer").unwrap();
    fs::write(legacy.join("vencordDesktopMain.js"), "vesktop").unwrap();

    let res = newest(e, branch);
    fs::rename(res.join("app.asar"), res.join("_app.asar")).unwrap();
    fs::create_dir_all(res.join("app.asar")).unwrap();
    let target = serde_json::to_string(&legacy.join("patcher.js").to_string_lossy()).unwrap();
    fs::write(res.join("app.asar").join("index.js"), format!("require({target});")).unwrap();
    fs::write(res.join("app.asar").join("package.json"), r#"{"name":"discord","main":"index.js"}"#).unwrap();
    res
}

#[test]
fn migrates_old_vencord_based_install_and_cleans_up() {
    let e = env(&[Branch::Canary]);
    let res = legacy_install(&e, Branch::Canary);
    let legacy = e.ctx.paths.legacy_dist.clone();
    assert_eq!(patch::classify(&res, &legacy), State::Legacy);

    let report = cli::install(&e.ctx, Some(Target::Canary), false, Some(e.payload_src.clone())).unwrap();
    assert!(report.failures.is_empty(), "{:?}", report.lines);
    assert!(matches!(patch::classify(&res, &legacy), State::Patched { .. }));
    assert!(!legacy.join("patcher.js").exists());
    assert!(!legacy.join("patcher.js.map").exists());
    assert!(legacy.join("vencordDesktopMain.js").exists());
    assert_eq!(fs::read(res.join("_app.asar")).unwrap(), ORIGINAL);
}

#[test]
fn keeps_legacy_build_while_another_branch_still_uses_it() {
    let e = env(&[Branch::Stable, Branch::Canary]);
    legacy_install(&e, Branch::Stable);
    legacy_install(&e, Branch::Canary);
    cli::install(&e.ctx, Some(Target::Canary), false, Some(e.payload_src.clone())).unwrap();
    assert!(e.ctx.paths.legacy_dist.join("patcher.js").exists());
}

#[test]
fn failed_install_keeps_legacy_build() {
    let e = env(&[Branch::Stable, Branch::Canary]);
    let res = legacy_install(&e, Branch::Stable);
    fs::remove_dir_all(res.join("app.asar")).unwrap();
    fs::copy(res.join("_app.asar"), res.join("app.asar")).unwrap();
    let report = cli::install(&e.ctx, Some(Target::All), false, Some(e.payload_src.clone())).unwrap();
    assert_eq!(report.failures.len(), 1);
    assert!(e.ctx.paths.legacy_dist.join("patcher.js").exists());
}

#[test]
fn refuses_foreign_shim_without_force() {
    let e = env(&[Branch::Canary]);
    let res = newest(&e, Branch::Canary);
    fs::copy(res.join("app.asar"), res.join("_app.asar")).unwrap();
    fs::write(res.join("app.asar"), b"vencord asar shim").unwrap();
    let legacy = &e.ctx.paths.legacy_dist;
    assert!(matches!(patch::classify(&res, legacy), State::Foreign(_)));

    let main_js = e.ctx.paths.main_js();
    assert!(patch::patch(&res, &main_js, legacy, false).is_err());
    assert_eq!(fs::read(res.join("app.asar")).unwrap(), b"vencord asar shim");
    assert!(matches!(patch::unpatch(&res, legacy).unwrap(), UnpatchAction::SkippedForeign(_)));

    assert_eq!(patch::patch(&res, &main_js, legacy, true).unwrap(), PatchAction::Replaced);
    assert!(matches!(patch::classify(&res, legacy), State::Patched { .. }));
    assert_eq!(fs::read(res.join("_app.asar")).unwrap(), ORIGINAL);
}

#[test]
fn foreign_shim_folder_is_detected() {
    let e = env(&[Branch::Canary]);
    let res = newest(&e, Branch::Canary);
    fs::rename(res.join("app.asar"), res.join("_app.asar")).unwrap();
    fs::create_dir_all(res.join("app.asar")).unwrap();
    fs::write(res.join("app.asar").join("index.js"), r#"require("C:\\other\\mod.js");"#).unwrap();
    assert!(matches!(
        patch::classify(&res, &e.ctx.paths.legacy_dist),
        State::Foreign(_)
    ));
}

#[test]
fn repairs_missing_shim() {
    let e = env(&[Branch::Canary]);
    let res = newest(&e, Branch::Canary);
    fs::rename(res.join("app.asar"), res.join("_app.asar")).unwrap();
    let legacy = &e.ctx.paths.legacy_dist;
    assert_eq!(patch::classify(&res, legacy), State::MissingAsar);
    assert_eq!(
        patch::patch(&res, &e.ctx.paths.main_js(), legacy, false).unwrap(),
        PatchAction::Repaired
    );
}

#[test]
fn removes_legacy_app_folder() {
    let e = env(&[Branch::Canary]);
    let res = newest(&e, Branch::Canary);
    fs::create_dir_all(res.join("app")).unwrap();
    fs::write(res.join("app").join("index.js"), "old").unwrap();
    patch::patch(&res, &e.ctx.paths.main_js(), &e.ctx.paths.legacy_dist, false).unwrap();
    assert!(!res.join("app").exists());
}

#[test]
fn install_selects_only_requested_branch() {
    let e = env(&[Branch::Stable, Branch::Canary]);
    cli::install(&e.ctx, Some(Target::Canary), false, Some(e.payload_src.clone())).unwrap();
    let legacy = &e.ctx.paths.legacy_dist;
    assert!(matches!(patch::classify(&newest(&e, Branch::Canary), legacy), State::Patched { .. }));
    assert_eq!(patch::classify(&newest(&e, Branch::Stable), legacy), State::Unpatched);
    assert!(rgl::payload::is_complete(&e.ctx.paths.dist()));
}

#[test]
fn install_without_payload_fails_before_touching_discord() {
    let e = env(&[Branch::Canary]);
    assert!(cli::install(&e.ctx, Some(Target::Canary), false, None).is_err());
    assert_eq!(patch::classify(&newest(&e, Branch::Canary), &e.ctx.paths.legacy_dist), State::Unpatched);
}

#[test]
fn incomplete_payload_is_rejected() {
    let e = env(&[Branch::Canary]);
    fs::remove_file(e.payload_src.join("renderer.js")).unwrap();
    let err = cli::install(&e.ctx, Some(Target::Canary), false, Some(e.payload_src.clone())).unwrap_err();
    assert!(format!("{err:#}").contains("renderer.js"));
}

#[test]
fn payload_update_replaces_files() {
    let e = env(&[Branch::Canary]);
    let dist = e.ctx.paths.dist();
    rgl::payload::install_from(&e.payload_src, &dist).unwrap();
    fs::write(e.payload_src.join("main.js"), "v2").unwrap();
    rgl::payload::install_from(&e.payload_src, &dist).unwrap();
    assert_eq!(fs::read_to_string(dist.join("main.js")).unwrap(), "v2");
    let leftovers = fs::read_dir(&dist)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".rgl-new"))
        .count();
    assert_eq!(leftovers, 0);
}

#[test]
fn payload_update_never_removes_the_folder() {
    let e = env(&[Branch::Canary]);
    let dist = e.ctx.paths.dist();
    rgl::payload::install_from(&e.payload_src, &dist).unwrap();
    fs::write(dist.join("settings-like.json"), "keep").unwrap();
    rgl::payload::install_from(&e.payload_src, &dist).unwrap();
    assert!(dist.join("settings-like.json").exists());
}

#[test]
fn shim_checks_payload_before_requiring_it() {
    let source = patch::shim_source(Path::new(r"C:\data\dist\main.js")).unwrap();
    assert!(source.starts_with(r#"const target = "C:\\data\\dist\\main.js";"#));
    assert!(source.contains("existsSync(target)"));
    assert!(source.contains("_app.asar"));
}

#[test]
fn reads_target_from_old_style_shim() {
    let e = env(&[Branch::Canary]);
    let res = newest(&e, Branch::Canary);
    fs::rename(res.join("app.asar"), res.join("_app.asar")).unwrap();
    fs::create_dir_all(res.join("app.asar")).unwrap();
    fs::write(res.join("app.asar").join("index.js"), r#"require("C:\\x\\main.js");"#).unwrap();
    fs::write(
        res.join("app.asar").join("package.json"),
        r#"{"name":"discord","main":"index.js","restoreGoLive":true}"#,
    )
    .unwrap();
    assert_eq!(
        patch::classify(&res, &e.ctx.paths.legacy_dist),
        State::Patched { target: Some(PathBuf::from(r"C:\x\main.js")) }
    );
}

#[test]
fn uninstall_all_restores_and_removes_data() {
    let e = env(&[Branch::Stable, Branch::Canary]);
    cli::install(&e.ctx, Some(Target::All), false, Some(e.payload_src.clone())).unwrap();
    let report = cli::uninstall(&e.ctx, None, false).unwrap();
    assert!(report.failures.is_empty());
    for b in [Branch::Stable, Branch::Canary] {
        assert_eq!(fs::read(newest(&e, b).join("app.asar")).unwrap(), ORIGINAL);
    }
    assert!(!e.ctx.paths.data.exists());
}

#[test]
fn uninstall_one_branch_keeps_data_for_the_other() {
    let e = env(&[Branch::Stable, Branch::Canary]);
    cli::install(&e.ctx, Some(Target::All), false, Some(e.payload_src.clone())).unwrap();
    cli::uninstall(&e.ctx, Some(Target::Canary), false).unwrap();
    assert!(e.ctx.paths.data.exists());
    assert!(matches!(
        patch::classify(&newest(&e, Branch::Stable), &e.ctx.paths.legacy_dist),
        State::Patched { .. }
    ));
}
