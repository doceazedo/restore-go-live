import { execFileSync } from "child_process";
import { context } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { crc32, deflateRawSync } from "zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const EXTENSION = join(ROOT, "runtime", "extension");

const args = process.argv.slice(2);
const watch = args.includes("--watch");
const webOnly = args.includes("--web");
const desktopOnly = args.includes("--desktop");

const hash = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

const alias = {
  "@runtime": join(ROOT, "runtime"),
};

const defines = (desktop) => ({
  IS_DISCORD_DESKTOP: String(desktop),
  IS_WEB: String(!desktop),
  RGL_VERSION: JSON.stringify(hash),
});

const shared = {
  bundle: true,
  logLevel: "info",
  alias,
  target: "esnext",
  legalComments: "none",
  sourcemap: watch ? "inline" : false,
  banner: { js: `/* RestoreGoLive ${hash} */` },
};

const renderer = (desktop, outfile) => ({
  ...shared,
  entryPoints: [join(ROOT, "runtime", "renderer.ts")],
  outfile,
  platform: "browser",
  format: "iife",
  jsx: "transform",
  jsxFactory: "__rglCreateElement",
  jsxFragment: "__rglFragment",
  inject: [join(ROOT, "runtime", "jsx.ts")],
  define: defines(desktop),
});

const node = (entry, outfile) => ({
  ...shared,
  entryPoints: [join(ROOT, "runtime", entry)],
  outfile,
  platform: "node",
  format: "cjs",
  external: ["electron", "original-fs"],
  define: defines(true),
});

const desktop = [
  node("main.ts", join(DIST, "main.js")),
  node("preload.ts", join(DIST, "preload.js")),
  renderer(true, join(DIST, "renderer.js")),
];

const web = [renderer(false, join(DIST, "web", "renderer.js"))];

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content);
    const packed = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function packageExtensions() {
  const manifest = JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8"));
  const rules = readFileSync(join(EXTENSION, "rules.json"));
  const script = readFileSync(join(DIST, "web", "renderer.js"));
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

  const variants = {
    chrome: { ...manifest, version, minimum_chrome_version: "111" },
    firefox: {
      ...manifest,
      version,
      browser_specific_settings: { gecko: { id: "restore-go-live@doce.sh", strict_min_version: "128.0" } },
    },
  };

  for (const [name, m] of Object.entries(variants)) {
    const out = join(DIST, `extension-${name}.zip`);
    writeFileSync(
      out,
      zip([
        ["manifest.json", JSON.stringify(m, null, 2)],
        ["rules.json", rules],
        ["renderer.js", script],
      ]),
    );
    console.log(`  ${out}`);
  }
}

const configs = webOnly ? web : desktopOnly ? desktop : [...desktop, ...web];

if (!watch) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const contexts = await Promise.all(configs.map((c) => context(c)));

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  if (!desktopOnly) packageExtensions();
}
