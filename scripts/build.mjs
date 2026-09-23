import { execFileSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENCORD = join(ROOT, "Vencord");
const REMOTE = "doceazedo/restore-go-live";

const hash = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();

const args = ["--dir", VENCORD, ...process.argv.slice(2)];
const [cmd, argv] = process.env.npm_execpath
  ? [process.execPath, [process.env.npm_execpath, ...args]]
  : ["pnpm", args];

try {
  execFileSync(cmd, argv, {
    cwd: ROOT,
    stdio: "inherit",
    shell: !process.env.npm_execpath && process.platform === "win32",
    env: { ...process.env, VENCORD_REMOTE: REMOTE, VENCORD_HASH: hash },
  });
} catch (e) {
  process.exit(e.status ?? 1);
}
