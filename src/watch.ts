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
  refreshAttached,
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

const logger = new Logger("P2PShare:watch");

interface Session {
  beacon: Beacon;
  ownerId: string;
  channelId: string;
  messageId: string;
  pc?: RTCPeerConnection;
  stream?: MediaStream;
  joining?: boolean;
  offerMessageId?: string;
}

class Watcher {
  private sessions = new Map<string, Session>();
  private stopBeacons: (() => void) | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private extra: Array<() => void> = [];
  private lastScanned: string | null = null;
  private ice: IceConfig = { stun: [] };

  start(ice: IceConfig) {
    this.ice = ice;
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

    this.extra.push(
      addInterceptor((action: any) => {
        const type: string = action?.type ?? "";
        const key: string | undefined = action?.streamKey;
        const session = key ? this.sessions.get(key) : undefined;
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
    logger.info(
      `${ownerId} is live (session ${beacon.sessionId}, audio=${beacon.hasAudio})`,
    );
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
      const { pc, ready, sdp } = await createViewerOffer(
        this.ice,
        session.beacon.hasAudio,
        session.stream,
      );
      session.pc = pc;

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

      session.offerMessageId = await sendOffer(
        session.channelId,
        { s: session.beacon.sessionId, sdp },
        session.messageId,
      );

      const answerSdp = await answered;
      deleteOwn(session.channelId, session.offerMessageId);
      session.offerMessageId = undefined;
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      if (!(await waitConnected(pc))) {
        throw new Error(
          "no direct route to broadcaster, run __p2p.nat() on both peers",
        );
      }

      logger.info(`connected via ${await selectedPair(pc)}`);

      await ready;
      if (session.stream) refreshAttached(session.stream);
      announceVideo(session.ownerId, session.channelId, true);
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
    }
  }

  leave(key: string) {
    const s = this.sessions.get(key);
    if (!s) return;
    s.pc?.close();
    s.pc = undefined;
    s.joining = false;
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
    this.announceLocal(s, false);
    this.sessions.delete(key);
  }
}

export const watcher = new Watcher();
