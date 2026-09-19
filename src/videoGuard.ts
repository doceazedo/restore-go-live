import { Patch } from "@utils/types";

export const videoGuardPatch: Patch = {
  find: '"2026-08-video-guard"',
  replacement: {
    match:
      /(?<=name:"2026-08-video-guard".{0,200}?)variations:\{.+?\}\}(?=\}\))/,
    replace: "variations:{}",
  },
};
