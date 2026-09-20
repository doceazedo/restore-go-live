import { Logger } from "@utils/Logger";

import { Beacon } from "./core/beacon";
import { newSessionId, streamKey } from "./core/session";
import { captureScreen, hasLiveAudio } from "./capture";
import {
  addInterceptor, announceStream, announceVideo, currentUserId, deleteMessage, dispatch, guildIdOf,
  subscribe
} from "./discord";
import { answerViewer, applyBitrate, IceConfig, isRelayed, waitConnected } from "./peers";
import { clearBeacon, Handshake, publishBeacon, sendAnswer, watchOffers } from "./signaling";

const logger = new Logger("P2PShare:broadcast");

export interface BroadcastOptions {
  ice: IceConfig;
  fps: number;
  height: number;
  budgetMbps: number;
  label: string;
}

interface Viewer {
  pc: RTCPeerConnection;
  relayed: boolean;
}

class Broadcast {
  sessionId = "";
  channelId = "";
  guildId: string | null = null;
  stream: MediaStream | null = null;
  hasAudio = false;
  viewers = new Map<string, Viewer>();
  private stopOffers: (() => void) | null = null;
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

    const capture = await captureScreen(opts.fps, opts.height);
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

    const beacon: Beacon = {
      sessionId: this.sessionId,
      ownerId: currentUserId(),
      startedAt: Date.now(),
      hasAudio: this.hasAudio
    };

    try {
      await publishBeacon(channelId, beacon, opts.label);
    } catch (e) {
      await this.teardownMedia();
      throw new Error(`could not set voice channel status: ${(e as Error).message}`);
    }

    this.stopOffers = watchOffers(channelId, this.sessionId, (h, msgId) => {
      deleteMessage(channelId, msgId);
      this.onOffer(h).catch(err => logger.error("offer handling failed", err));
    });

    this.stopHooks.push(addInterceptor((action: any) => {
      if (action?.type !== "STREAM_TIMED_OUT") return false;
      if (!this.active || action.streamKey !== this.key) return false;
      return true;
    }));

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

  private async onOffer(h: Handshake) {
    if (!this.stream || !this.opts) return;

    this.viewers.get(h.from)?.pc.close();
    this.viewers.delete(h.from);

    logger.info(`offer from ${h.from}: ${h.sdp.length} chars, m-lines=${(h.sdp.match(/^m=/gm) ?? []).length}`);

    let answered;
    try {
      answered = await answerViewer(this.opts.ice, h.sdp, this.stream);
    } catch (e) {
      logger.error("could not answer offer, sdp was:\n" + h.sdp);
      throw e;
    }
    const { pc, sdp } = answered;
    await sendAnswer(this.channelId, {
      s: this.sessionId,
      from: currentUserId(),
      to: h.from,
      sdp
    });

    const ok = await waitConnected(pc);
    if (!ok) {
      logger.warn(`viewer ${h.from} never connected`);
      pc.close();
      return;
    }

    const relayed = await isRelayed(pc);
    this.viewers.set(h.from, { pc, relayed });
    await this.rebalance();
    logger.info(`viewer ${h.from} connected relayed=${relayed} total=${this.viewers.size}`);

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.viewers.delete(h.from);
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
    const videoStreamId = announceVideo(currentUserId(), this.channelId, on);
    logger.info(`announceSelf on=${on} videoStreamId=${videoStreamId}`);
  }

  private async rebalance() {
    if (!this.opts) return;
    for (const [, v] of this.viewers) {
      await applyBitrate(v.pc, this.opts.budgetMbps, this.viewers.size, v.relayed);
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
    await clearBeacon(this.channelId);
    this.sessionId = "";
    this.stopping = false;
    logger.info("broadcast stopped");
  }
}

export const broadcast = new Broadcast();
