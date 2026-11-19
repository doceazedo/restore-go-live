import plugin from "../src/index";
import { Logger } from "./logger";
import { onceReady, Toasts } from "./webpack/common";
import { find, findStore } from "./webpack/finders";
import { addPatches, executed, getWreq, installWebpackHook, patchReport } from "./webpack/patcher";

const logger = new Logger("Renderer");
const SELF = "globalThis.RestoreGoLive";

declare global {
  var RestoreGoLive: typeof plugin;
  var __rglLoaded: boolean | undefined;
  var RestoreGoLiveRuntime: object;
}

function boot() {
  if (globalThis.__rglLoaded) return;
  globalThis.__rglLoaded = true;
  globalThis.RestoreGoLive = plugin;
  globalThis.RestoreGoLiveRuntime = { getWreq, executed, patchReport, find, findStore, Toasts };

  addPatches((plugin.patches ?? []).map((p) => ({ ...p, plugin: plugin.name })), SELF);
  installWebpackHook();

  setTimeout(() => {
    const missing = [...patchReport].filter(([p, r]) => !r.found && !p.noWarn).map(([p]) => String(p.find));
    if (missing.length) logger.warn("patches not applied 60s after startup:", missing.join(" | "));
  }, 60_000);

  onceReady.then(async () => {
    try {
      await plugin.start?.();
      logger.info("started");
    } catch (e) {
      logger.error("failed to start", e);
    }
  });
}

boot();
