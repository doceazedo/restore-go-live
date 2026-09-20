import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Toasts } from "@webpack/common";

import { parseStreamKey, streamKey } from "./core/session";
import { broadcast } from "./broadcast";
import { attachToAllVideos, describeQuality, diag, findModules, nat, voice } from "./diag";
import { currentUserId, dispatch, ownerOfVideoId, voiceChannelId } from "./discord";
import { scanBeacons } from "./signaling";
import { IceConfig } from "./peers";
import {
  browserVideoSourcePatch, qualityChangePatch, qualityLabelPatch, streamStartPatch,
  streamTileEndedPatch, streamTileErrorPatch, streamWatchPatch, videoSourcePatch
} from "./patches";
import { videoGuardPatch } from "./videoGuard";
import { watcher } from "./watch";

const logger = new Logger("P2PShare");
const placeholderStream = new MediaStream();
const Native = VencordNative.pluginHelpers.RestoreGoLive as PluginNative<typeof import("./native")>;

const settings = definePluginSettings({
  uploadBudgetMbps: {
    type: OptionType.SLIDER,
    description: "Total upload budget shared between viewers (Mbps)",
    markers: [5, 10, 15, 20, 30, 50],
    default: 15,
    stickToMarkers: false
  },
  stunServers: {
    type: OptionType.STRING,
    description: "STUN servers, comma separated",
    default: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun.cloudflare.com:3478"
    ].join(",")
  },
});

function ice(): IceConfig {
  return { stun: parseUrls(settings.store.stunServers) };
}

function parseUrls(raw: string) {
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function toast(message: string, type: string = Toasts.Type.MESSAGE) {
  Toasts.show({ message, type, id: Toasts.genId() });
}

export default definePlugin({
  name: "RestoreGoLive",
  description: "Replaces Discord's Go Live with direct peer-to-peer screen sharing",
  tags: ["Voice", "Media"],
  authors: [{ name: "doceazedo911", id: 0n }],
  required: false,
  settings,

  patches: [
    videoGuardPatch,
    streamStartPatch,
    streamWatchPatch,
    videoSourcePatch,
    browserVideoSourcePatch,
    streamTileEndedPatch,
    streamTileErrorPatch,
    qualityLabelPatch,
    qualityChangePatch
  ],

  async start() {
    (globalThis as any).__p2p = {
      broadcast,
      watcher,
      settings: settings.store,
      diag,
      attach: attachToAllVideos,
      findModules,
      voice,
      nat: () => nat(ice().stun),
      beacons: (channelId?: string) => scanBeacons(channelId ?? voiceChannelId()!),
      voiceChannelId
    };

    if (IS_DISCORD_DESKTOP) {
      const res = await Native.enableLoopbackAudio().catch(() => ({ ok: false, error: "ipc failed" }));
      if (!res.ok) logger.warn("loopback audio unavailable", (res as any).error);
    }
    watcher.start(ice());
  },

  stop() {
    broadcast.stop();
    watcher.stop();
    if (IS_DISCORD_DESKTOP) Native.disableLoopbackAudio().catch(() => undefined);
  },

  onStreamStart(guildId: string | null, channelId: string, _opts: any) {
    const target = channelId ?? voiceChannelId();
    if (!target) return false;

    broadcast.start(target, {
      ice: ice(),
      budgetMbps: settings.store.uploadBudgetMbps
    }).then(() => {
      toast(broadcast.hasAudio ? "P2P stream live (with audio)" : "P2P stream live (no desktop audio)");
    }).catch(e => {
      logger.error("failed to start", e);
      toast(`P2P stream failed: ${e.message}`, Toasts.Type.FAILURE);
    });

    return true;
  },

  onStreamWatch(key: string) {
    if (!watcher.isOurs(key)) return false;
    watcher.join(key).catch(e => {
      logger.error("failed to join", e);
      toast(`Could not connect: ${e.message}`, Toasts.Type.FAILURE);
    });
    return false;
  },

  onQualityChange(resolution: number, frameRate: number) {
    if (!broadcast.active) return false;
    logger.info(`quality change requested: ${resolution}p ${frameRate}fps`);
    dispatch({ type: "STREAM_UPDATE_SETTINGS", resolution, frameRate });
    return true;
  },

  qualityLabel() {
    return describeQuality(broadcast.stream ?? watcher.activeStream()) ?? undefined;
  },

  isOurStream(stream: any) {
    if (!stream) return false;
    const owner = stream.ownerId;
    if (!owner) return false;
    if (owner === currentUserId()) return broadcast.active;
    return watcher.ownsUser(owner);
  },

  isOurUserStream(userId: string) {
    if (userId === currentUserId()) return broadcast.active;
    return watcher.ownsUser(userId);
  },

  maskStreamError(userId: string, error: any) {
    return this.isOurUserStream(userId) ? undefined : error;
  },

  p2pStreamFor(streamId: any): MediaStream | null {
    const owner = ownerOfVideoId(streamId);
    if (owner == null) return null;
    const ours = owner === currentUserId() ? broadcast.stream : watcher.streamForOwner(owner);
    return ours ?? placeholderStream;
  },

  resolveStream(streamId: any, original: () => { stream: MediaStream; release: () => void }) {
    const ours = this.p2pStreamFor(streamId);
    if (ours) return { stream: ours, release: () => undefined };
    return original();
  },

  resolveStreamRaw(streamId: any, original: () => MediaStream) {
    return this.p2pStreamFor(streamId) ?? original();
  },

  get isLive() {
    return broadcast.active;
  }
});
