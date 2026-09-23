import { Logger } from "@utils/Logger";

import { Beacon, beaconMessage, decodeBeacon, isStale } from "./core/beacon";
import { locale } from "./discord";
import { packPayload, unpackPayload } from "./core/wire";
import {
  currentUserId, deleteMessage, editMessage, fetchText, postMessage, recentMessages, subscribe,
  uploadText
} from "./discord";

const logger = new Logger("P2PShare:signaling");

const OFFER = "p2po";
const ANSWER = "p2pa";
const DELETE_FALLBACK_MS = 60000;

export interface Handshake {
  s: string;
  sdp: string;
}

export interface LiveBeacon {
  beacon: Beacon;
  ownerId: string;
  channelId: string;
  messageId: string;
}

export async function publishBeacon(channelId: string, beacon: Beacon) {
  const id = await postMessage(channelId, beaconMessage(beacon, locale()));
  logger.info(`beacon posted as message ${id}`);
  return id;
}

export function refreshBeacon(channelId: string, messageId: string, beacon: Beacon) {
  return editMessage(channelId, messageId, beaconMessage(beacon, locale())).catch(e =>
    logger.warn("heartbeat edit failed", e));
}

export function clearBeacon(channelId: string, messageId: string) {
  return deleteMessage(channelId, messageId);
}

function serverTime(msg: any) {
  const t = Date.parse(msg?.edited_timestamp ?? msg?.timestamp ?? "");
  return Number.isFinite(t) ? t : null;
}

function toLive(msg: any): LiveBeacon | null {
  const decoded = decodeBeacon(msg?.content);
  if (!decoded) return null;
  const beacon = { ...decoded, heartbeat: serverTime(msg) ?? decoded.heartbeat };
  if (isStale(beacon)) return null;
  const ownerId = msg.author?.id;
  if (!ownerId) return null;
  return { beacon, ownerId, channelId: msg.channel_id, messageId: msg.id };
}

async function scanRecent(channelId: string) {
  try {
    return await recentMessages(channelId);
  } catch (e) {
    logger.warn(`could not read recent messages in ${channelId}`, e);
    return [] as any[];
  }
}

export async function scanBeacons(channelId: string) {
  return (await scanRecent(channelId)).map(toLive).filter((b): b is LiveBeacon => b !== null);
}

export function watchBeacons(
  onLive: (live: LiveBeacon) => void,
  onGone: (channelId: string, messageId: string) => void
) {
  const offs = [
    subscribe("MESSAGE_CREATE", (d: any) => {
      const live = toLive(d?.message);
      if (live) onLive(live);
    }),
    subscribe("MESSAGE_UPDATE", (d: any) => {
      const msg = d?.message;
      const live = toLive(msg);
      if (live) onLive(live);
      else if (msg?.id && decodeBeacon(msg?.content) == null) onGone(msg.channel_id, msg.id);
    }),
    subscribe("MESSAGE_DELETE", (d: any) => {
      if (d?.id) onGone(d.channelId ?? d.channel_id, d.id);
    })
  ];
  return () => offs.forEach(off => off());
}

async function post(channelId: string, prefix: string, h: Handshake, replyToId: string) {
  const body = await packPayload(h);
  const filename = `${prefix}.${h.s}.txt`;
  logger.info(`uploading ${filename} (${body.length} chars)`);
  return uploadText(channelId, filename, body, replyToId);
}

export function deleteOwn(channelId: string, messageId: string | null | undefined) {
  if (!messageId) return;
  void deleteMessage(channelId, messageId);
}

export function deleteWhenPeerGone(channelId: string, ownId: string, peerId: string) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    off();
    deleteOwn(channelId, ownId);
  };
  const off = subscribe("MESSAGE_DELETE", (d: any) => {
    if (d?.id === peerId) finish();
  });
  const timer = setTimeout(finish, DELETE_FALLBACK_MS);
  return finish;
}

const HANDSHAKE_FILE = /^p2p[oa]\./;

export async function cleanupOwnLeftovers(channelId: string, keepMessageId?: string | null) {
  const me = currentUserId();
  let removed = 0;

  for (const msg of await scanRecent(channelId)) {
    if (msg.author?.id !== me || msg.id === keepMessageId) continue;

    const isBeacon = decodeBeacon(msg.content) != null;
    const isHandshake = (msg.attachments ?? []).some((a: any) => HANDSHAKE_FILE.test(a?.filename ?? ""));
    if (!isBeacon && !isHandshake) continue;

    await deleteMessage(channelId, msg.id);
    removed++;
  }

  if (removed) logger.info(`cleaned up ${removed} leftover message(s) in ${channelId}`);
  return removed;
}

export const sendOffer = (channelId: string, h: Handshake, beaconMessageId: string) =>
  post(channelId, OFFER, h, beaconMessageId);

export const sendAnswer = (channelId: string, h: Handshake, offerMessageId: string) =>
  post(channelId, ANSWER, h, offerMessageId);

function listen(
  prefix: string,
  channelId: string,
  replyingTo: () => string | null,
  cb: (h: Handshake, msg: any) => void
) {
  return subscribe("MESSAGE_CREATE", (data: any) => {
    const msg = data?.message;
    if (!msg || msg.channel_id !== channelId) return;
    if (msg.author?.id === currentUserId()) return;

    const target = replyingTo();
    if (!target || msg.message_reference?.message_id !== target) return;

    const att = (msg.attachments ?? []).find((a: any) =>
      typeof a?.filename === "string" && a.filename.startsWith(`${prefix}.`));
    if (!att) return;

    fetchText(att.url)
      .then(body => unpackPayload<Handshake>(body))
      .then(h => {
        if (!h?.sdp || !h.s) {
          logger.warn(`could not decode ${att.filename}`);
          return;
        }
        cb(h, msg);
      })
      .catch(e => logger.error(`failed to fetch ${att.filename}`, e));
  });
}

export function watchOffers(
  channelId: string,
  beaconMessageId: () => string | null,
  cb: (h: Handshake, msg: any) => void
) {
  return listen(OFFER, channelId, beaconMessageId, cb);
}

export function watchAnswers(
  channelId: string,
  offerMessageId: () => string | null,
  cb: (h: Handshake, msg: any) => void
) {
  return listen(ANSWER, channelId, offerMessageId, cb);
}
