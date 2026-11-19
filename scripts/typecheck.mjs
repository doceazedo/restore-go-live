import { execFileSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

try {
  execFileSync(process.execPath, [TSC, "--noEmit", "-p", "tsconfig.json"], { cwd: ROOT, stdio: "inherit" });
  console.log("typecheck clean");
} catch (e) {
  process.exit(e.status ?? 1);
}
