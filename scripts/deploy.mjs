import { execFileSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const skipBuild = args.includes("--no-build");
const passthrough = args.filter((a) => a !== "--no-build");

const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: ROOT, stdio: "inherit" });

try {
  if (!skipBuild) {
    run(process.execPath, [join(ROOT, "scripts", "embed-native.mjs")]);
    run(process.execPath, [join(ROOT, "scripts", "build.mjs"), "--desktop"]);
  }
  run("cargo", [
    "run",
    "--quiet",
    "--manifest-path",
    join(ROOT, "patcher", "Cargo.toml"),
    "--",
    "install",
    "--payload",
    join(ROOT, "dist"),
    ...passthrough,
  ]);
} catch (e) {
  process.exit(e.status ?? 1);
}
