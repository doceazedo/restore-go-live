import definePlugin from "@utils/types";

import { videoGuardPatch } from "./videoGuard";

export default definePlugin({
  name: "RestoreGoLive",
  description:
    'Re-enables Go Live and camera by disabling the "2026-08-video-guard" experiment',
  tags: ["Voice", "Media"],
  authors: [{ name: "doceazedo911", id: 0n }],
  required: false,
  patches: [videoGuardPatch],
});
