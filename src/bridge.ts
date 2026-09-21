import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";

const logger = new Logger("P2PShare:bridge");

type Helpers = PluginNative<typeof import("./native")>;

function helpers() {
  return (VencordNative.pluginHelpers.RestoreGoLive ?? {}) as Record<
    string,
    (...args: any[]) => Promise<any>
  >;
}

export const Native = new Proxy({} as Helpers, {
  get(_target, name: string) {
    const method = helpers()[name];
    if (typeof method === "function") return method;

    return async () => {
      const known = Object.keys(helpers()).join(", ") || "nothing";
      logger.error(
        `${name} is missing from the native bridge, discord's main process is running an older build. `
        + `quit discord from the tray and start it again. it currently offers: ${known}`,
      );
      return { ok: false, error: `${name} is not loaded, restart discord completely` };
    };
  },
});
