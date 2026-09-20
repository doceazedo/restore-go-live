import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const BUNDLES = process.argv[2];
if (!BUNDLES || !existsSync(BUNDLES)) {
  console.error("usage: node scripts/checkpatches.mjs <dir-of-discord-js-bundles>");
  process.exit(2);
}

const files = readdirSync(BUNDLES).filter(f => f.endsWith(".js")).map(f => join(BUNDLES, f));
const src = ["src/patches.ts", "src/videoGuard.ts"].map(f => readFileSync(f, "utf8")).join("\n");

const patches = [...src.matchAll(
  /find:\s*(['"`])(.+?)\1,\s*replacement:\s*\{\s*match:\s*\/(.+?)\/,\s*replace:\s*"((?:[^"\\]|\\.)*)"/gs
)].map(m => ({ find: m[2], match: m[3], replace: m[4].replace(/\\"/g, '"') }));

const canon = s => s.replaceAll("\\i", "[A-Za-z_$][\\w$]*");

function enclosingFactory(text, at) {
  const start = text.lastIndexOf("function", at);
  if (start < 0) return null;
  let depth = 0, seen = false;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") { depth++; seen = true; }
    else if (text[i] === "}") { depth--; if (seen && depth === 0) return text.slice(start, i + 1); }
    if (i - start > 400000) return null;
  }
  return null;
}

let failed = 0;
for (const p of patches) {
  const re = new RegExp(canon(p.match));
  let status = "FIND NOT FOUND", detail = "";

  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (!text.includes(p.find)) continue;
    status = "MATCH FAILED";
    const m = re.exec(text);
    if (!m) continue;

    const fn = enclosingFactory(text, m.index);
    if (!fn) { status = "OK (unparsed)"; break; }

    const patched = fn.replace(re, p.replace.replaceAll("$self", "globalThis.__self"));
    try {
      new Function(`return (${patched})`);
      status = "OK";
    } catch (e) {
      status = "SYNTAX ERROR";
      detail = String(e.message);
    }
    break;
  }

  if (/\w\$self/.test(p.replace)) {
    status = "GLUED $self";
    detail = "$self directly follows a word character - insert a space";
  }

  if (status === "SYNTAX ERROR" || status === "MATCH FAILED" || status === "GLUED $self") failed++;
  const label = status === "FIND NOT FOUND" ? "NOT IN BUNDLE" : status;
  console.log(`${label.padEnd(14)} ${p.find.slice(0, 44)}`);
  if (detail) console.log(`               ${detail}`);
}

process.exit(failed ? 1 : 0);
