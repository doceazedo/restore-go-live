import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Toasts } from "@webpack/common";

import { parseStreamKey, streamKey } from "./core/session";
import { Native } from "./bridge";
import { broadcast } from "./broadcast";
import {
  attachToAllVideos,
  audioDevices,
  describeQuality,
  diag,
  findModules,
  nat,
  selftest,
  voice,
} from "./diag";
import {
  currentUserId,
  dispatch,
  ownerOfVideoId,
  voiceChannelId,
} from "./discord";
import { scanBeacons } from "./signaling";
import { goLiveSource, watchGoLiveSource } from "./source";
import { IceConfig } from "./peers";
import { JoinStatus } from "./status";
import {
  browserVideoSourcePatch,
  qualityChangePatch,
  qualityLabelPatch,
  streamStartPatch,
  streamTileEndedPatch,
  streamSpinnerLabelPatch,
  streamTileErrorPatch,
  streamWatchPatch,
  videoSourcePatch,
} from "./patches";
import { videoGuardPatch } from "./videoGuard";
import { startViewerTracking, stopViewerTracking } from "./viewers";
import { watcher } from "./watch";

const logger = new Logger("P2PShare");
const placeholderStream = new MediaStream();
let stopSourceWatch: (() => void) | null = null;

const settings = definePluginSettings({
  uploadBudgetMbps: {
    type: OptionType.SLIDER,
    description: "Total upload budget shared between viewers (Mbps)",
    markers: [5, 10, 15, 20, 30, 50],
    default: 15,
    stickToMarkers: false,
  },
  desktopAudio: {
    type: OptionType.STRING,
    description:
      "Stream audio: auto shares the audio of the window you picked, off shares none, or name an input device (BlackHole, Monitor, Stereo Mix) to capture that instead",
    default: "auto",
  },
  stunServers: {
    type: OptionType.STRING,
    description: "STUN servers, comma separated",
    default: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun.cloudflare.com:3478",
    ].join(","),
  },
});

function ice(): IceConfig {
  return { stun: parseUrls(settings.store.stunServers) };
}

function parseUrls(raw: string) {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function toast(message: string, type: string = Toasts.Type.MESSAGE) {
  Toasts.show({ message, type, id: Toasts.genId() });
}

export default definePlugin({
  name: "RestoreGoLive",
  description: "Replaces Discord's Go Live with P2P screen sharing",
  tags: ["Voice", "Media"],
  authors: [{ name: "doceazedo911", id: 241978119899185165n }],
  required: false,
  enabledByDefault: true,
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
    qualityChangePatch,
    streamSpinnerLabelPatch,
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
      audio: audioDevices,
      selftest,
      beacons: (channelId?: string) =>
        scanBeacons(channelId ?? voiceChannelId()!),
      sources: () => (IS_DISCORD_DESKTOP ? Native.listSources() : null),
      picked: () => goLiveSource(),
      voiceChannelId,
    };

    if (IS_DISCORD_DESKTOP) {
      const res = await Native.enableLoopbackAudio().catch(() => ({
        ok: false,
        error: "ipc failed",
      }));
      if (res.ok) logger.info("loopback audio handler installed", res);
      else logger.warn("loopback audio unavailable", (res as any).error);
    }
    stopSourceWatch = watchGoLiveSource();
    startViewerTracking();
    watcher.start(ice());
  },

  stop() {
    broadcast.stop();
    watcher.stop();
    stopViewerTracking();
    stopSourceWatch?.();
    stopSourceWatch = null;
    if (IS_DISCORD_DESKTOP)
      Native.disableLoopbackAudio().catch(() => undefined);
  },

  onStreamStart(guildId: string | null, channelId: string, opts: any) {
    const target = channelId ?? voiceChannelId();
    if (!target) return false;

    broadcast
      .start(target, {
        ice: ice(),
        budgetMbps: settings.store.uploadBudgetMbps,
        audioPreference: settings.store.desktopAudio,
        source: goLiveSource(opts),
      })
      .catch((e) => {
        logger.error("failed to start", e);
        toast(`P2P stream failed: ${e.message}`, Toasts.Type.FAILURE);
      });

    return true;
  },

  onStreamWatch(key: string) {
    if (!watcher.isOurs(key)) return false;
    watcher.join(key).catch((e) => {
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

  renderJoinStatus(streamKey?: string) {
    return <JoinStatus streamKey={streamKey} />;
  },

  qualityLabel() {
    return (
      describeQuality(broadcast.preview ?? watcher.activeStream()) ?? undefined
    );
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
    const ours =
      owner === currentUserId()
        ? broadcast.preview
        : watcher.streamForOwner(owner);
    return ours ?? placeholderStream;
  },

  resolveStream(
    streamId: any,
    original: () => { stream: MediaStream; release: () => void },
  ) {
    const ours = this.p2pStreamFor(streamId);
    if (ours) return { stream: ours, release: () => undefined };
    return original();
  },

  resolveStreamRaw(streamId: any, original: () => MediaStream) {
    return this.p2pStreamFor(streamId) ?? original();
  },

  get isLive() {
    return broadcast.active;
  },
});
