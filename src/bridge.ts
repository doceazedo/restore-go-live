import { PluginNative } from "@utils/types";

export const Native = VencordNative.pluginHelpers.RestoreGoLive as PluginNative<
  typeof import("./native")
>;
