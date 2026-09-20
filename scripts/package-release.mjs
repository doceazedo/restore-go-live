import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "Vencord", "dist");
const OUT = join(ROOT, "release");

const DESKTOP = ["patcher.js", "preload.js", "renderer.js", "renderer.css"];
const VESKTOP = [
  "vencordDesktopMain.js",
  "vencordDesktopPreload.js",
  "vencordDesktopRenderer.js",
  "vencordDesktopRenderer.css",
];

if (!existsSync(join(DIST, "patcher.js"))) {
  console.error("Vencord/dist is missing, run pnpm build first");
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const file of [...DESKTOP, ...VESKTOP]) {
  const from = join(DIST, file);
  if (existsSync(from)) cpSync(from, join(OUT, file));
}

for (const script of [
  "install.sh",
  "install.ps1",
  "uninstall.sh",
  "uninstall.ps1",
]) {
  cpSync(join(ROOT, "installer", script), join(OUT, script));
}

const files = readdirSync(OUT);
const total = files.reduce((n, f) => n + statSync(join(OUT, f)).size, 0);

console.log(
  `release/ ready, ${files.length} assets, ${(total / 1024 / 1024).toFixed(2)} MB`,
);
for (const f of files) console.log(`  ${f}`);
