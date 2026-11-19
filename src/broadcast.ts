import { Logger } from "@runtime/logger";

import { Beacon, HEARTBEAT_MS } from "./core/beacon";
import { streamKey } from "./core/session";
import { captureScreen } from "./capture";
import {
  addInterceptor, announceStream, announceVideo, currentUserId, dispatch, guildIdOf,
  refreshAttached, streamQuality, subscribe
} from "./discord";
import { answerViewer, applyBitrate, IceConfig, selectedPair, waitConnected } from "./peers";
import { GoLiveSource } from "./source";
import {
  cleanupOwnLeftovers, clearBeacon, deleteWhenPeerGone, Handshake, publishBeacon, refreshBeacon,
  sendAnswer, watchOffers
} from "./signaling";
import { setJoinStage, StartStage } from "./status";
import { trackViewers, untrackViewers } from "./viewers";

const logger = new Logger("P2PShare:broadcast");

export interface BroadcastOptions {
  ice: IceConfig;
  budgetMbps: number;
  audioPreference: string;
  source: GoLiveSource;
}

interface Viewer {
  pc: RTCPeerConnection;
}

class Broadcast {
  channelId = "";
  guildId: string | null = null;
  stream: MediaStream | null = null;
  preview: MediaStream | null = null;
  hasAudio = false;
  viewers = new Map<string, Viewer>();
  private stopOffers: (() => void) | null = null;
  beaconMessageId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private stopHooks: Array<() => void> = [];
  private stopping = false;
  private starting = false;
  private cancelled = false;
  private opts: BroadcastOptions | null = null;

  get active() {
    return this.stream !== null && !this.starting;
  }

  get engaged() {
    return this.starting || this.stream !== null;
  }

  get key() {
    return this.engaged ? streamKey(this.guildId, this.channelId, currentUserId()) : null;
  }

  async start(channelId: string, opts: BroadcastOptions) {
    if (this.engaged) return;
    this.starting = true;
    this.cancelled = false;
    this.opts = opts;
    this.channelId = channelId;
    this.guildId = guildIdOf(channelId);
    this.preview = new MediaStream();
    const key = this.key!;

    this.stopHooks.push(addInterceptor((action: any) => {
      if (action?.type !== "STREAM_TIMED_OUT") return false;
      return this.engaged && action.streamKey === this.key;
    }));

    for (const event of ["STREAM_STOP", "STREAM_DELETE", "STREAM_CLOSE"]) {
      this.stopHooks.push(subscribe(event, () => {
        if (!this.stopping && this.engaged) {
          logger.info(`${event} observed, tearing down`);
          void this.stop();
        }
      }));
    }

    this.announceSelf(true);

    try {
      const { height, fps } = streamQuality();
      logger.info(`capturing at ${height}p ${fps}fps from discord settings`);
      setJoinStage(key, StartStage.CAPTURING);

      const capture = await captureScreen(fps, height, opts.audioPreference, opts.source);
      this.stream = capture.stream;
      this.hasAudio = capture.hasAudio;
      this.ensureNotCancelled();

      capture.stream.getVideoTracks()[0]?.addEventListener("ended", () => void this.stop());

      this.startedAt = Date.now();
      setJoinStage(key, StartStage.CLEANING);
      await cleanupOwnLeftovers(channelId);
      this.ensureNotCancelled();

      setJoinStage(key, StartStage.PUBLISHING);
      try {
        this.beaconMessageId = await publishBeacon(channelId, this.beacon());
      } catch (e) {
        throw new Error(`could not post beacon: ${(e as Error).message}`);
      }
      this.ensureNotCancelled();
    } catch (e) {
      this.starting = false;
      setJoinStage(key, null);
      await this.teardown();
      if (e instanceof StartCancelled) {
        logger.info("start cancelled during setup");
        return;
      }
      throw e;
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.beaconMessageId) void refreshBeacon(this.channelId, this.beaconMessageId, this.beacon());
    }, HEARTBEAT_MS);

    this.stopOffers = watchOffers(channelId, () => this.beaconMessageId, (h, msg) => {
      this.onOffer(h, msg).catch(err => logger.error("offer handling failed", err));
    });

    for (const event of ["STREAM_UPDATE_SETTINGS", "MEDIA_ENGINE_SET_GO_LIVE_SOURCE"]) {
      this.stopHooks.push(subscribe(event, () => void this.applyQuality()));
    }

    this.starting = false;
    setJoinStage(key, null);
    for (const track of this.stream!.getVideoTracks()) this.preview.addTrack(track);
    refreshAttached(this.preview);
    void trackViewers(key, currentUserId(), channelId, this.beaconMessageId!, true);
    logger.info(`live beacon=${this.beaconMessageId} audio=${this.hasAudio} channel=${channelId}`);
  }

  private ensureNotCancelled() {
    if (this.cancelled) throw new StartCancelled();
  }

  private beacon(): Beacon {
    return {
      startedAt: this.startedAt,
      heartbeat: Date.now(),
      hasAudio: this.hasAudio
    };
  }

  private async onOffer(h: Handshake, msg: any) {
    if (!this.stream || !this.opts) return;

    const viewerId: string = msg.author?.id;
    if (!viewerId) return;

    this.viewers.get(viewerId)?.pc.close();
    this.viewers.delete(viewerId);

    logger.info(`offer from ${viewerId}: ${h.sdp.length} chars`);

    let answered;
    try {
      answered = await answerViewer(this.opts.ice, h.sdp, this.stream);
    } catch (e) {
      logger.error("could not answer offer, sdp was:\n" + h.sdp);
      throw e;
    }
    const { pc, sdp } = answered;
    const answerId = await sendAnswer(this.channelId, { sdp }, msg.id);
    if (answerId) deleteWhenPeerGone(this.channelId, answerId, msg.id);

    const ok = await waitConnected(pc);
    if (!ok) {
      logger.warn(`viewer ${viewerId} never connected`);
      pc.close();
      return;
    }

    this.viewers.set(viewerId, { pc });
    await this.rebalance();
    logger.info(`viewer ${viewerId} connected via ${await selectedPair(pc)} total=${this.viewers.size}`);

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.viewers.delete(viewerId);
        void this.rebalance();
      }
    });
  }

  private announceSelf(on: boolean) {
    const key = streamKey(this.guildId, this.channelId, currentUserId());
    if (on) {
      dispatch({
        type: "STREAM_CREATE",
        streamKey: key,
        rtcServerId: `p2p-${this.channelId}`,
        rtcChannelId: this.channelId,
        region: "p2p",
        viewerIds: []
      });
    } else {
      dispatch({ type: "STREAM_DELETE", streamKey: key, unavailable: false });
    }
    if (!announceStream(currentUserId(), this.channelId, on)) {
      logger.warn("no local voice state, native streaming UI will not update");
    }
    announceVideo(currentUserId(), this.channelId, on);
  }

  private async applyQuality() {
    const track = this.stream?.getVideoTracks()[0];
    if (!track || track.readyState !== "live") return;

    const { height, fps } = streamQuality();
    const current = track.getSettings?.() ?? {};
    if (current.height === height && current.frameRate === fps) return;

    try {
      await track.applyConstraints({ height: { ideal: height }, frameRate: { ideal: fps } });
      const applied = track.getSettings?.() ?? {};
      logger.info(`quality changed to ${height}p ${fps}fps, source now ${applied.height}p ${applied.frameRate}fps`);
    } catch (e) {
      logger.warn("could not apply new quality to live capture", e);
    }
  }

  private async rebalance() {
    if (!this.opts) return;
    for (const [, v] of this.viewers) {
      await applyBitrate(v.pc, this.opts.budgetMbps, this.viewers.size);
    }
  }

  private async teardownMedia() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.preview = null;
  }

  async stop() {
    if (this.starting) {
      this.cancelled = true;
      return;
    }
    if (!this.active) return;
    logger.info("stopping broadcast");
    await this.teardown();
    logger.info("broadcast stopped");
  }

  private async teardown() {
    if (this.stopping) return;
    this.stopping = true;
    for (const off of this.stopHooks) off();
    this.stopHooks = [];
    this.stopOffers?.();
    this.stopOffers = null;
    for (const [, v] of this.viewers) v.pc.close();
    this.viewers.clear();
    if (this.beaconMessageId) untrackViewers(this.beaconMessageId);
    await this.teardownMedia();
    this.announceSelf(false);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.beaconMessageId) await clearBeacon(this.channelId, this.beaconMessageId);
    this.beaconMessageId = null;
    this.stopping = false;
  }
}

class StartCancelled extends Error {}

export const broadcast = new Broadcast();
