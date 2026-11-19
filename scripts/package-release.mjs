import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const OUT = join(ROOT, "release");
const BINARIES_DIR = process.env.RGL_BINARIES ?? join(ROOT, "patcher", "target", "release");
const TARGET = process.env.RGL_TARGET ?? "x86_64-pc-windows-msvc";

const DESKTOP = ["main.js", "preload.js", "renderer.js"];
const BROWSER = ["extension-chrome.zip", "extension-firefox.zip"];
const BINARIES = ["restore-go-live.exe", "restore-go-live-daemon.exe"];
const SCRIPTS = ["install.sh", "install.ps1", "uninstall.sh", "uninstall.ps1"];
const requireBinaries = process.argv.includes("--require-binaries");

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

for (const file of [...DESKTOP, ...BROWSER]) {
  if (!existsSync(join(DIST, file))) fail(`dist/${file} is missing, run pnpm build first`);
}

const missingBinaries = BINARIES.filter((b) => !existsSync(join(BINARIES_DIR, b)));
if (missingBinaries.length && requireBinaries) {
  fail(`${missingBinaries.join(", ")} missing in ${BINARIES_DIR}, run cargo build --release in patcher/`);
}

const commit =
  process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const version = commit.slice(0, 7);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const asset = (name) => ({ asset: name, sha256: sha256(join(OUT, name)) });

for (const file of [...DESKTOP, ...BROWSER]) cpSync(join(DIST, file), join(OUT, file));
for (const script of SCRIPTS) cpSync(join(ROOT, "installer", script), join(OUT, script));

const manifest = {
  version,
  commit,
  payload: Object.fromEntries(DESKTOP.map((f) => [f, asset(f)])),
  binaries: {},
};

if (!missingBinaries.length) {
  for (const binary of BINARIES) cpSync(join(BINARIES_DIR, binary), join(OUT, binary));
  manifest.binaries[TARGET] = Object.fromEntries(BINARIES.map((b) => [b, asset(b)]));
} else {
  console.warn(`skipping programs, missing in ${BINARIES_DIR}: ${missingBinaries.join(", ")}`);
}

writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));

const files = readdirSync(OUT);
const total = files.reduce((n, f) => n + statSync(join(OUT, f)).size, 0);
console.log(`release/ ready for ${version}, ${files.length} assets, ${(total / 1024 / 1024).toFixed(2)} MB`);
for (const f of files) console.log(`  ${f}`);
