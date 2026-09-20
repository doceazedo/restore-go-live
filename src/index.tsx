import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Toasts } from "@webpack/common";

import { parseStreamKey, streamKey } from "./core/session";
import { broadcast } from "./broadcast";
import { attachToAllVideos, diag, findModules, nat, voice } from "./diag";
import { currentUserId, ownerOfVideoId, readVoiceStatus, voiceChannelId } from "./discord";
import { currentBeacon } from "./signaling";
import { IceConfig } from "./peers";
import {
  browserVideoSourcePatch, streamStartPatch, streamStopPatch, streamTileEndedPatch,
  streamTileErrorPatch, streamWatchPatch, videoSourcePatch
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
  frameRate: {
    type: OptionType.SLIDER,
    description: "Capture frame rate",
    markers: [15, 30, 60],
    default: 60,
    stickToMarkers: true
  },
  height: {
    type: OptionType.SLIDER,
    description: "Capture height",
    markers: [720, 1080, 1440],
    default: 1080,
    stickToMarkers: true
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
    streamStopPatch,
    streamWatchPatch,
    videoSourcePatch,
    browserVideoSourcePatch,
    streamTileEndedPatch,
    streamTileErrorPatch
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
      status: (channelId?: string) => readVoiceStatus(channelId ?? voiceChannelId()!),
      beacon: (channelId?: string) => currentBeacon(channelId ?? voiceChannelId()!),
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
      fps: settings.store.frameRate,
      height: settings.store.height,
      budgetMbps: settings.store.uploadBudgetMbps
    }).then(() => {
      toast(broadcast.hasAudio ? "P2P stream live (with audio)" : "P2P stream live (no desktop audio)");
    }).catch(e => {
      logger.error("failed to start", e);
      toast(`P2P stream failed: ${e.message}`, Toasts.Type.FAILURE);
    });

    return true;
  },

  onStreamStop(key?: string) {
    logger.info(`onStreamStop(${key}) active=${broadcast.active}`);
    if (!broadcast.active) return false;
    void broadcast.stop();
    return true;
  },

  onStreamWatch(key: string) {
    if (!watcher.isOurs(key)) return false;
    logger.info(`joining p2p for ${key}, letting discord STREAM_WATCH through`);
    watcher.join(key).catch(e => {
      logger.error("failed to join", e);
      toast(`Could not connect: ${e.message}`, Toasts.Type.FAILURE);
    });
    return false;
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
    logger.info(`resolveStream(${streamId}) -> ${ours ? `p2p tracks=${ours.getTracks().length}` : "discord"}`);
    if (ours) return { stream: ours, release: () => undefined };
    return original();
  },

  resolveStreamRaw(streamId: any, original: () => MediaStream) {
    const ours = this.p2pStreamFor(streamId);
    logger.info(`resolveStreamRaw(${streamId}) -> ${ours ? `p2p tracks=${ours.getTracks().length}` : "discord"}`);
    return ours ?? original();
  },

  get isLive() {
    return broadcast.active;
  }
});
