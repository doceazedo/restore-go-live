import { Logger } from "@utils/Logger";

import { Beacon, HEARTBEAT_MS, isStale } from "./core/beacon";
import { broadcast } from "./broadcast";
import { streamKey } from "./core/session";
import {
  addInterceptor,
  announceStream,
  announceVideo,
  currentUserId,
  guildIdOf,
  isWatchingStream,
  outputDeviceId,
  refreshAttached,
  STREAM_CONTEXT,
  streamAudioState,
  subscribe,
  voiceChannelId,
} from "./discord";
import {
  createViewerOffer,
  IceConfig,
  selectedPair,
  waitConnected,
} from "./peers";
import {
  cleanupOwnLeftovers,
  deleteOwn,
  LiveBeacon,
  scanBeacons,
  sendOffer,
  watchAnswers,
  watchBeacons,
} from "./signaling";
import { clearJoinStages, JoinStage, setJoinStage } from "./status";
import { markWatching, trackViewers, untrackViewers } from "./viewers";

const logger = new Logger("P2PShare:watch");

export function applyAudioState(el: HTMLAudioElement, ownerId: string) {
  const { muted, volume } = streamAudioState(ownerId);
  el.muted = muted;
  el.volume = Math.max(0, Math.min(volume / 100, 1));
  return { muted, volume };
}

export async function attachAudio(track: MediaStreamTrack, label: string) {
  const el = new Audio();
  el.autoplay = true;
  el.srcObject = new MediaStream([track]);
  applyAudioState(el, label);

  const sink = outputDeviceId();
  if (sink && typeof (el as any).setSinkId === "function") {
    await (el as any)
      .setSinkId(sink)
      .catch((e: unknown) => logger.warn("could not route stream audio to the discord output device", e));
  }

  try {
    await el.play();
    logger.info(`playing stream audio from ${label}`);
  } catch (e) {
    logger.warn("stream audio could not start", e);
  }
  return el;
}

interface Session {
  beacon: Beacon;
  ownerId: string;
  channelId: string;
  messageId: string;
  pc?: RTCPeerConnection;
  stream?: MediaStream;
  audio?: HTMLAudioElement;
  joining?: boolean;
  offerMessageId?: string;
  watching?: boolean;
}

class Watcher {
  private sessions = new Map<string, Session>();
  private stopBeacons: (() => void) | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private extra: Array<() => void> = [];
  private lastScanned: string | null = null;
  private ice: IceConfig = { stun: [] };
  private pendingWatch = new Set<string>();
  private onJoinError: (e: Error) => void = () => undefined;

  start(ice: IceConfig, onJoinError: (e: Error) => void) {
    this.ice = ice;
    this.onJoinError = onJoinError;
    this.stopBeacons = watchBeacons(
      (live) => this.onBeacon(live),
      (channelId, messageId) => this.onBeaconGone(channelId, messageId),
    );
    this.sweeper = setInterval(() => this.sweep(), HEARTBEAT_MS);

    for (const event of [
      "VOICE_CHANNEL_SELECT",
      "RTC_CONNECTION_STATE",
      "CHANNEL_INFO",
    ]) {
      this.extra.push(subscribe(event, () => this.rescan()));
    }

    for (const event of ["AUDIO_TOGGLE_LOCAL_MUTE", "AUDIO_SET_LOCAL_VOLUME"]) {
      this.extra.push(
        subscribe(event, (action: any) => {
          if (action?.context !== STREAM_CONTEXT) return;
          setTimeout(() => this.applyAudioSettings(action?.userId), 0);
        }),
      );
    }

    this.extra.push(
      addInterceptor((action: any) => {
        const type: string = action?.type ?? "";
        const key: string | undefined = action?.streamKey;
        if (!key) return false;
        const session = this.sessions.get(key);

        if (type === "STREAM_WATCH" && !session) {
          this.pendingWatch.add(key);
          return false;
        }

        if (type === "STREAM_CLOSE") this.pendingWatch.delete(key);

        if (!session) return false;

        if (type === "STREAM_CLOSE") {
          if (session.pc) {
            logger.info(`user closed ${key}, tearing down p2p`);
            this.leave(key!);
          }
          return false;
        }

        if (type === "STREAM_DELETE" || type === "STREAM_TIMED_OUT")
          return true;

        return false;
      }),
    );

    this.rescan();
  }

  private rescan() {
    const vc = voiceChannelId();
    if (!vc || vc === this.lastScanned) return;
    this.lastScanned = vc;
    void cleanupOwnLeftovers(vc, broadcast.beaconMessageId)
      .then(() => scanBeacons(vc))
      .then((found) => {
        if (voiceChannelId() !== vc) return;
        for (const live of found) this.onBeacon(live);
      });
  }

  private sweep() {
    for (const [key, s] of [...this.sessions]) {
      if (isStale(s.beacon)) {
        logger.info(`${s.ownerId} stopped heartbeating, dropping ${key}`);
        this.forget(key);
      }
    }
  }

  stop() {
    this.stopBeacons?.();
    this.stopBeacons = null;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const off of this.extra) off();
    this.extra = [];
    this.lastScanned = null;
    this.pendingWatch.clear();
    clearJoinStages();
    for (const key of [...this.sessions.keys()]) this.forget(key);
  }

  private onBeacon(live: LiveBeacon) {
    const { beacon, ownerId, channelId, messageId } = live;
    if (ownerId === currentUserId()) return;

    const key = streamKey(guildIdOf(channelId), channelId, ownerId);
    const existing = this.sessions.get(key);

    if (existing?.beacon.sessionId === beacon.sessionId) {
      existing.beacon = beacon;
      return;
    }

    if (existing) this.forget(key);

    const session: Session = {
      beacon,
      ownerId,
      channelId,
      messageId,
      stream: new MediaStream(),
    };
    this.sessions.set(key, session);
    this.announceLocal(session, true);
    void trackViewers(key, ownerId, channelId, messageId).then((found) => {
      if (this.sessions.get(key) !== session || session.watching) return;
      if (found.includes(currentUserId())) void markWatching(channelId, messageId, false);
    });
    logger.info(
      `${ownerId} is live (session ${beacon.sessionId}, audio=${beacon.hasAudio})`,
    );
    this.resumeWatch(key);
  }

  private resumeWatch(key: string) {
    const pending = this.pendingWatch.delete(key);
    if (!pending && !isWatchingStream(key)) return;
    logger.info(`discord is already watching ${key}, resuming p2p`);
    this.join(key).catch((e) => {
      logger.error("failed to resume watching", e);
      this.onJoinError(e);
    });
  }

  private onBeaconGone(channelId: string, messageId: string) {
    for (const [key, s] of [...this.sessions]) {
      if (s.channelId === channelId && s.messageId === messageId) {
        logger.info(`beacon for ${s.ownerId} removed`);
        this.forget(key);
      }
    }
  }

  private announceLocal(s: Session, on: boolean) {
    const owner = s.ownerId;
    if (owner === currentUserId()) return;
    if (!announceStream(owner, s.channelId, on)) {
      logger.warn(`no voice state for ${owner}, cannot show native live badge`);
      return;
    }
    const videoStreamId = announceVideo(owner, s.channelId, on);
    logger.info(
      `announced selfStream=${on} for ${owner} videoStreamId=${videoStreamId}`,
    );
  }

  private applyAudioSettings(userId?: string) {
    for (const [, session] of this.sessions) {
      if (userId && session.ownerId !== userId) continue;
      if (!session.audio) continue;
      const { muted, volume } = applyAudioState(session.audio, session.ownerId);
      logger.info(`${session.ownerId} stream audio muted=${muted} volume=${volume}`);
    }
  }

  private async playAudio(session: Session, track: MediaStreamTrack) {
    this.stopAudio(session);
    session.audio = await attachAudio(track, session.ownerId);
  }

  private stopAudio(session: Session) {
    const el = session.audio;
    if (!el) return;
    const playing = el.srcObject as MediaStream | null;
    el.pause();
    el.srcObject = null;
    for (const t of playing?.getTracks() ?? []) t.stop();
    session.audio = undefined;
  }

  isOurs(key: string) {
    return this.sessions.has(key);
  }

  ownsUser(userId: string) {
    for (const [, s] of this.sessions) if (s.ownerId === userId) return true;
    return false;
  }

  activeStream() {
    for (const [, s] of this.sessions) if (s.stream) return s.stream;
    return null;
  }

  streamForOwner(userId: string) {
    for (const [, s] of this.sessions)
      if (s.ownerId === userId) return s.stream ?? null;
    return null;
  }

  async join(key: string) {
    const session = this.sessions.get(key);
    if (!session || session.pc || session.joining) return;
    session.joining = true;

    try {
      logger.info(`joining ${key}`);
      setJoinStage(key, JoinStage.PREPARING);
      const { pc, ready, sdp } = await createViewerOffer(
        this.ice,
        session.beacon.hasAudio,
        session.stream,
      );
      session.pc = pc;
      pc.addEventListener("track", e => {
        if (e.track.kind === "audio") void this.playAudio(session, e.track);
      });

      const answered = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          stop();
          reject(new Error("broadcaster did not answer"));
        }, 30000);
        const stop = watchAnswers(
          session.channelId,
          () => session.offerMessageId ?? null,
          (h, msg) => {
            if (
              msg.author?.id !== session.ownerId ||
              h.s !== session.beacon.sessionId
            )
              return;
            clearTimeout(timer);
            stop();
            resolve(h.sdp);
          },
        );
      });

      setJoinStage(key, JoinStage.REQUESTING);
      session.offerMessageId = await sendOffer(
        session.channelId,
        { s: session.beacon.sessionId, sdp },
        session.messageId,
      );

      setJoinStage(key, JoinStage.WAITING_ANSWER);
      const answerSdp = await answered;
      deleteOwn(session.channelId, session.offerMessageId);
      session.offerMessageId = undefined;
      setJoinStage(key, JoinStage.CONNECTING);
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      if (!(await waitConnected(pc))) {
        throw new Error(
          "no direct route to broadcaster, run __p2p.nat() on both peers",
        );
      }

      logger.info(`connected via ${await selectedPair(pc)}`);
      setJoinStage(key, JoinStage.WAITING_VIDEO);

      await Promise.race([ready, new Promise(r => setTimeout(r, 8000))]);
      if (session.stream) refreshAttached(session.stream);
      announceVideo(session.ownerId, session.channelId, true);
      session.watching = true;
      void markWatching(session.channelId, session.messageId, true);
      logger.info(
        `watching ${key} tracks=${session.stream
          ?.getTracks()
          .map((t) => t.kind)
          .join("+")}`,
      );
    } catch (e) {
      session.pc?.close();
      session.pc = undefined;
      deleteOwn(session.channelId, session.offerMessageId);
      session.offerMessageId = undefined;
      throw e;
    } finally {
      session.joining = false;
      setJoinStage(key, null);
    }
  }

  leave(key: string) {
    const s = this.sessions.get(key);
    if (!s) return;
    s.pc?.close();
    s.pc = undefined;
    s.joining = false;
    setJoinStage(key, null);
    if (s.watching) {
      s.watching = false;
      void markWatching(s.channelId, s.messageId, false);
    }
    this.stopAudio(s);
    for (const t of s.stream?.getTracks() ?? []) {
      t.stop();
      s.stream?.removeTrack(t);
    }
    s.stream = new MediaStream();
    logger.info(`disconnected from ${key}, session kept for rejoin`);
  }

  forget(key: string) {
    const s = this.sessions.get(key);
    if (!s) return;
    this.leave(key);
    untrackViewers(s.messageId);
    this.announceLocal(s, false);
    this.sessions.delete(key);
  }
}

export const watcher = new Watcher();
