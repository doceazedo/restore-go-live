import { Logger } from "@utils/Logger";

import { Beacon } from "./core/beacon";
import { streamKey } from "./core/session";
import {
  addInterceptor, announceStream, announceVideo, currentUserId, deleteMessage, dispatch, guildIdOf,
  refreshAttached, requestChannelInfo, subscribe, voiceChannelId
} from "./discord";
import { createViewerOffer, IceConfig, waitConnected } from "./peers";
import { currentBeacon, sendOffer, watchAnswers, watchBeacons } from "./signaling";

const logger = new Logger("P2PShare:watch");

interface Session {
  beacon: Beacon;
  channelId: string;
  pc?: RTCPeerConnection;
  stream?: MediaStream;
  joining?: boolean;
}

class Watcher {
  private sessions = new Map<string, Session>();
  private stopBeacons: (() => void) | null = null;
  private extra: Array<() => void> = [];
  private lastScanned: string | null = null;
  private ice: IceConfig = { stun: [] };

  start(ice: IceConfig) {
    this.ice = ice;
    this.stopBeacons = watchBeacons((channelId, beacon) => this.onBeacon(channelId, beacon));

    for (const event of ["VOICE_CHANNEL_SELECT", "RTC_CONNECTION_STATE", "CHANNEL_INFO"]) {
      this.extra.push(subscribe(event, () => this.rescan()));
    }

    this.extra.push(addInterceptor((action: any) => {
      const type: string = action?.type ?? "";
      const key: string | undefined = action?.streamKey;
      const session = key ? this.sessions.get(key) : undefined;
      if (!session) return false;

      if (type.startsWith("STREAM_") || type.startsWith("RTC_")) {
        logger.info(`action ${type} for our session`);
      }

      if (type === "STREAM_CLOSE") {
        if (session.pc) {
          logger.info(`user closed ${key}, tearing down p2p`);
          this.leave(key!);
        }
        return false;
      }

      if (type === "STREAM_DELETE" || type === "STREAM_TIMED_OUT") return true;

      return false;
    }));

    this.rescan();
  }

  private rescan() {
    const vc = voiceChannelId();
    if (!vc || vc === this.lastScanned) return;
    this.lastScanned = vc;

    requestChannelInfo(vc);

    let attempt = 0;
    const tick = () => {
      if (voiceChannelId() !== vc) return;
      const beacon = currentBeacon(vc);
      if (beacon) {
        logger.info(`rescan found beacon in ${vc} from ${beacon.ownerId}`);
        this.onBeacon(vc, beacon);
        return;
      }
      if (++attempt < 3) setTimeout(tick, attempt * 1500);
    };
    tick();
  }

  stop() {
    this.stopBeacons?.();
    this.stopBeacons = null;
    for (const off of this.extra) off();
    this.extra = [];
    this.lastScanned = null;
    for (const key of [...this.sessions.keys()]) this.forget(key);
  }

  private onBeacon(channelId: string, beacon: Beacon | null) {
    if (!channelId) return;

    if (!beacon) {
      for (const [key, s] of [...this.sessions]) {
        if (s.channelId === channelId) this.forget(key);
      }
      return;
    }

    if (beacon.ownerId === currentUserId()) return;

    const key = streamKey(guildIdOf(channelId), channelId, beacon.ownerId);
    if (this.sessions.get(key)?.beacon.sessionId === beacon.sessionId) return;

    const session: Session = { beacon, channelId, stream: new MediaStream() };
    this.sessions.set(key, session);
    this.announceLocal(session, true);
    logger.info(`beacon from ${beacon.ownerId} session=${beacon.sessionId} audio=${beacon.hasAudio}`);
  }

  private announceLocal(s: Session, on: boolean) {
    const owner = s.beacon.ownerId;
    if (owner === currentUserId()) return;
    if (!announceStream(owner, s.channelId, on)) {
      logger.warn(`no voice state for ${owner}, cannot show native live badge`);
      return;
    }
    const videoStreamId = announceVideo(owner, s.channelId, on);
    logger.info(`announced selfStream=${on} for ${owner} videoStreamId=${videoStreamId}`);
  }

  isOurs(key: string) {
    return this.sessions.has(key);
  }

  ownsUser(userId: string) {
    for (const [, s] of this.sessions) if (s.beacon.ownerId === userId) return true;
    return false;
  }

  activeStream() {
    for (const [, s] of this.sessions) if (s.stream) return s.stream;
    return null;
  }

  streamForOwner(userId: string) {
    for (const [, s] of this.sessions) if (s.beacon.ownerId === userId) return s.stream ?? null;
    return null;
  }

  async join(key: string) {
    const session = this.sessions.get(key);
    if (!session || session.pc || session.joining) return;
    session.joining = true;

    try {
      logger.info(`joining ${key}`);
      const { pc, ready, sdp } = await createViewerOffer(this.ice, session.beacon.hasAudio, session.stream);
      session.pc = pc;

      const answered = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          stop();
          reject(new Error("broadcaster did not answer"));
        }, 30000);
        const stop = watchAnswers(session.channelId, session.beacon.sessionId, (h, msgId) => {
          if (h.from !== session.beacon.ownerId) return;
          deleteMessage(session.channelId, msgId);
          clearTimeout(timer);
          stop();
          resolve(h.sdp);
        });
      });

      await sendOffer(session.channelId, {
        s: session.beacon.sessionId,
        from: currentUserId(),
        to: session.beacon.ownerId,
        sdp
      });

      await pc.setRemoteDescription({ type: "answer", sdp: await answered });

      if (!(await waitConnected(pc))) {
        throw new Error("no route to broadcaster (symmetric NAT or CGNAT without TURN)");
      }

      await ready;
      const attached = session.stream ? refreshAttached(session.stream) : 0;
      const remountId = announceVideo(session.beacon.ownerId, session.channelId, true);
      logger.info(
        `watching ${key} tracks=${session.stream?.getTracks().map(t => t.kind).join("+")}` +
        ` reattached=${attached} remountId=${remountId}`
      );
      dispatch({ type: "P2PSHARE_STREAM_READY", key });
    } catch (e) {
      session.pc?.close();
      session.pc = undefined;
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
