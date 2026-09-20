import { execFileSync } from "child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENCORD = join(ROOT, "Vencord");
const PLUGIN_LINK = join(VENCORD, "src", "userplugins", "discordP2PSS");

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit" });

if (!existsSync(VENCORD)) {
  console.log("Cloning Vencord...");
  run(
    "git",
    ["clone", "https://github.com/Vendicated/Vencord.git", VENCORD],
    ROOT,
  );
} else {
  console.log("Vencord already cloned, skipping");
}

console.log("Installing Vencord dependencies...");
run("pnpm", ["install", "--frozen-lockfile"], VENCORD);

const installerScript = join(VENCORD, "scripts", "runInstaller.mjs");
const installer = readFileSync(installerScript, "utf8");
if (installer.includes("VencordInstaller.MacOS.zip")) {
  console.log(
    "Patching runInstaller.mjs for the current macOS installer asset...",
  );

  const unzipStart = installer.indexOf(
    '    if (process.platform === "darwin") {',
  );
  const unzipEnd = installer.indexOf(
    '    console.log("Finished downloading!");',
  );

  writeFileSync(
    installerScript,
    installer
      .slice(0, unzipStart)
      .replace(
        'return "VencordInstaller.MacOS.zip";',
        'return "VencordInstallerCli-darwin";',
      ) +
      `    const body = Readable.fromWeb(res.body);
    await finished(body.pipe(createWriteStream(outputFile, {
        mode: 0o755,
        autoClose: true
    })));

    if (process.platform === "darwin") {
        console.log("Clearing quarantine on installer binary (xattr may error, that's okay)");
        try { execSync(\`xattr -d com.apple.quarantine '\${outputFile}'\`); } catch { }
    }

` +
      installer.slice(unzipEnd),
  );
} else {
  console.log("runInstaller.mjs already patched or fixed upstream, skipping");
}

mkdirSync(dirname(PLUGIN_LINK), { recursive: true });
if (
  existsSync(PLUGIN_LINK) ||
  lstatSync(PLUGIN_LINK, { throwIfNoEntry: false })
) {
  rmSync(PLUGIN_LINK, { recursive: true, force: true });
}
symlinkSync(relative(dirname(PLUGIN_LINK), join(ROOT, "src")), PLUGIN_LINK);
console.log(`Linked src/ -> ${relative(ROOT, PLUGIN_LINK)}`);

console.log("\nDone. Next: pnpm build, then pnpm inject (first time only).");
