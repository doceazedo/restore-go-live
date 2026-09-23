import { execFileSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENCORD = join(ROOT, "Vencord");
const DIST = join(VENCORD, "dist");

const FILES = ["patcher.js", "preload.js", "renderer.js", "renderer.css"];

function installedDist() {
  if (process.env.VENCORD_DATA_DIR) return join(process.env.VENCORD_DATA_DIR, "dist");
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Vencord", "dist");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Vencord", "dist");
  }
  const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(config, "Vencord", "dist");
}

const skipBuild = process.argv.includes("--no-build");

if (!existsSync(VENCORD)) {
  console.error("Vencord is not cloned, run pnpm setup first");
  process.exit(2);
}

if (!skipBuild) {
  console.log("Embedding native helper...");
  execFileSync(process.execPath, [join(ROOT, "scripts", "embed-native.mjs")], {
    cwd: ROOT,
    stdio: "inherit"
  });

  console.log("Building...");
  execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs"), "build", "--standalone"], {
    cwd: ROOT,
    stdio: "inherit"
  });
}

const missing = FILES.filter(f => !existsSync(join(DIST, f)));
if (missing.length) {
  console.error(`Vencord/dist is missing ${missing.join(", ")}, run pnpm build first`);
  process.exit(1);
}

const target = installedDist();
mkdirSync(target, { recursive: true });
if (!existsSync(join(target, "package.json"))) writeFileSync(join(target, "package.json"), "{}");

for (const file of FILES) {
  copyFileSync(join(DIST, file), join(target, file));
  const kb = (statSync(join(target, file)).size / 1024).toFixed(1);
  console.log(`  ${file} (${kb} kb)`);
}

console.log(`\nDeployed to ${target}`);
console.log("Restart Discord to load it, it has to quit from the tray first.");
