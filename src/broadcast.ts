import { Logger } from "@utils/Logger";

import { Beacon, HEARTBEAT_MS } from "./core/beacon";
import { newSessionId, streamKey } from "./core/session";
import { captureScreen, hasLiveAudio } from "./capture";
import {
  addInterceptor, announceStream, announceVideo, currentUserId, dispatch, guildIdOf,
  streamQuality, subscribe
} from "./discord";
import { answerViewer, applyBitrate, IceConfig, selectedPair, waitConnected } from "./peers";
import {
  cleanupOwnLeftovers, clearBeacon, deleteWhenPeerGone, Handshake, publishBeacon, refreshBeacon,
  sendAnswer, watchOffers
} from "./signaling";

const logger = new Logger("P2PShare:broadcast");

export interface BroadcastOptions {
  ice: IceConfig;
  budgetMbps: number;
}

interface Viewer {
  pc: RTCPeerConnection;
}

class Broadcast {
  sessionId = "";
  channelId = "";
  guildId: string | null = null;
  stream: MediaStream | null = null;
  hasAudio = false;
  viewers = new Map<string, Viewer>();
  private stopOffers: (() => void) | null = null;
  beaconMessageId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private stopHooks: Array<() => void> = [];
  private stopping = false;
  private opts: BroadcastOptions | null = null;

  get active() {
    return this.stream !== null;
  }

  get key() {
    return this.active ? streamKey(this.guildId, this.channelId, currentUserId()) : null;
  }

  async start(channelId: string, opts: BroadcastOptions) {
    if (this.active) return;
    this.opts = opts;
    this.channelId = channelId;
    this.guildId = guildIdOf(channelId);
    this.sessionId = newSessionId();

    const { height, fps } = streamQuality();
    logger.info(`capturing at ${height}p ${fps}fps from discord settings`);
    const capture = await captureScreen(fps, height);
    this.stream = capture.stream;
    this.hasAudio = capture.hasAudio && (await hasLiveAudio(capture.stream));

    if (capture.hasAudio && !this.hasAudio) {
      logger.warn("audio track was silent, dropping it");
      for (const t of capture.stream.getAudioTracks()) {
        capture.stream.removeTrack(t);
        t.stop();
      }
    }

    capture.stream.getVideoTracks()[0]?.addEventListener("ended", () => void this.stop());

    this.startedAt = Date.now();
    await cleanupOwnLeftovers(channelId);

    try {
      this.beaconMessageId = await publishBeacon(channelId, this.beacon());
    } catch (e) {
      await this.teardownMedia();
      throw new Error(`could not post beacon: ${(e as Error).message}`);
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.beaconMessageId) void refreshBeacon(this.channelId, this.beaconMessageId, this.beacon());
    }, HEARTBEAT_MS);

    this.stopOffers = watchOffers(channelId, () => this.beaconMessageId, (h, msg) => {
      this.onOffer(h, msg).catch(err => logger.error("offer handling failed", err));
    });

    this.stopHooks.push(addInterceptor((action: any) => {
      if (action?.type !== "STREAM_TIMED_OUT") return false;
      if (!this.active || action.streamKey !== this.key) return false;
      return true;
    }));

    for (const event of ["STREAM_UPDATE_SETTINGS", "MEDIA_ENGINE_SET_GO_LIVE_SOURCE"]) {
      this.stopHooks.push(subscribe(event, () => void this.applyQuality()));
    }

    for (const event of ["STREAM_STOP", "STREAM_DELETE", "STREAM_CLOSE"]) {
      this.stopHooks.push(subscribe(event, () => {
        if (!this.stopping && this.active) {
          logger.info(`${event} observed, tearing down`);
          void this.stop();
        }
      }));
    }

    this.announceSelf(true);
    logger.info(`live session=${this.sessionId} audio=${this.hasAudio} channel=${channelId}`);
  }

  private beacon(): Beacon {
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      heartbeat: Date.now(),
      hasAudio: this.hasAudio
    };
  }

  private async onOffer(h: Handshake, msg: any) {
    if (!this.stream || !this.opts) return;
    if (h.s !== this.sessionId) return;

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
    const answerId = await sendAnswer(this.channelId, { s: this.sessionId, sdp }, msg.id);
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
        rtcServerId: `p2p-${this.sessionId}`,
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
  }

  async stop() {
    if (!this.active || this.stopping) return;
    this.stopping = true;
    logger.info("stopping broadcast");
    for (const off of this.stopHooks) off();
    this.stopHooks = [];
    this.stopOffers?.();
    this.stopOffers = null;
    for (const [, v] of this.viewers) v.pc.close();
    this.viewers.clear();
    await this.teardownMedia();
    this.announceSelf(false);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.beaconMessageId) await clearBeacon(this.channelId, this.beaconMessageId);
    this.beaconMessageId = null;
    this.sessionId = "";
    this.stopping = false;
    logger.info("broadcast stopped");
  }
}

export const broadcast = new Broadcast();
