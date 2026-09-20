import { Patch } from "@utils/types";

type PluginPatch = Omit<Patch, "plugin">;

export const videoGuardPatch: PluginPatch = {
  find: '"2026-08-video-guard"',
  replacement: {
    match:
      /(?<=name:"2026-08-video-guard".{0,200}?)variations:\{.+?\}\}(?=\}\))/,
    replace: "variations:{}",
  },
};
