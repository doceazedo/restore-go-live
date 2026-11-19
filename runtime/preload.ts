import { contextBridge, ipcRenderer, webFrame } from "electron";
import { readFileSync } from "fs";
import { join } from "path";

const PREFIX = "RestoreGoLive";

const methods: string[] = ipcRenderer.sendSync(`${PREFIX}:methods`) ?? [];
const helpers = Object.fromEntries(
  methods.map((name) => [name, (...args: unknown[]) => ipcRenderer.invoke(`${PREFIX}:${name}`, ...args)]),
);

contextBridge.exposeInMainWorld("RestoreGoLiveNative", {
  helpers,
  settings: {
    get: () => ipcRenderer.sendSync(`${PREFIX}:settings:get`),
    set: (values: Record<string, unknown>) => ipcRenderer.invoke(`${PREFIX}:settings:set`, values),
    onChange: (cb: (values: Record<string, unknown>) => void) => {
      ipcRenderer.on(`${PREFIX}:settings:changed`, (_, values) => cb(values));
    },
  },
});

if (location.protocol !== "data:") {
  try {
    webFrame.executeJavaScript(readFileSync(join(__dirname, "renderer.js"), "utf8"));
  } catch (e) {
    console.error(`[${PREFIX}] failed to inject renderer`, e);
  }
}

if (process.env.DISCORD_PRELOAD) require(process.env.DISCORD_PRELOAD);
