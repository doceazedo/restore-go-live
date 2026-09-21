import { readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "native", "ProcessAudioCapture.cs");
const OUT = join(ROOT, "src", "csharp.ts");

const csharp = readFileSync(SOURCE, "utf8");
const escaped = csharp.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

writeFileSync(
  OUT,
  `export const PROCESS_AUDIO_CAPTURE = \`${escaped}\`;\n`,
  "utf8",
);

console.log(`embedded ${csharp.length} bytes of C# into src/csharp.ts`);
