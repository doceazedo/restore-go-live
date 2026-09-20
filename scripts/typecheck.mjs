import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = join(ROOT, "Vencord", "node_modules", ".bin", "tsc");

if (!existsSync(TSC)) {
  console.error(`tsc not found at ${TSC}, run pnpm setup first`);
  process.exit(2);
}

let output = "";
try {
  output = execFileSync(TSC, ["--noEmit", "-p", "tsconfig.json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
}

const mine = output.split("\n").filter((l) => l.startsWith("src/"));
if (mine.length) {
  console.error(mine.join("\n"));
  console.error(`\n${mine.length} error(s) in src/`);
  process.exit(1);
}
console.log("typecheck clean");
