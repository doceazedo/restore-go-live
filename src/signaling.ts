import { Logger } from "@utils/Logger";

import { Beacon, decodeBeacon, encodeBeacon, isStale } from "./core/beacon";
import { packPayload, unpackPayload } from "./core/wire";
import {
  currentUserId, deleteMessage, fetchText, readVoiceStatus, setVoiceStatus, subscribe, uploadText
} from "./discord";

const logger = new Logger("P2PShare:signaling");

const OFFER = "p2po";
const ANSWER = "p2pa";
const DELETE_AFTER_MS = 20000;


export interface Handshake {
  s: string;
  from: string;
  to: string;
  sdp: string;
}

export async function publishBeacon(channelId: string, beacon: Beacon) {
  const text = encodeBeacon(beacon);
  logger.info(`publishing beacon to ${channelId}`);
  await setVoiceStatus(channelId, text);
}

export async function clearBeacon(channelId: string) {
  try {
    await setVoiceStatus(channelId, null);
    logger.info(`beacon cleared on ${channelId}`);
  } catch (e) {
    logger.error(`failed to clear beacon on ${channelId}`, e);
  }
}

export function currentBeacon(channelId: string): Beacon | null {
  const beacon = decodeBeacon(readVoiceStatus(channelId));
  return beacon && !isStale(beacon) ? beacon : null;
}

export function watchBeacons(cb: (channelId: string, beacon: Beacon | null) => void) {
  return subscribe("VOICE_CHANNEL_STATUS_UPDATE", (data: any) => {
    const decoded = decodeBeacon(data?.status);
    cb(data?.id, decoded && !isStale(decoded) ? decoded : null);
  });
}

async function post(channelId: string, prefix: string, payload: Handshake) {
  const body = await packPayload(payload);
  const filename = `${prefix}.${payload.s}.${payload.to}.txt`;
  logger.info(`uploading ${filename} (${body.length} chars)`);
  const id = await uploadText(channelId, filename, body);
  if (id) setTimeout(() => deleteMessage(channelId, id), DELETE_AFTER_MS);
  return id;
}

export const sendOffer = (channelId: string, h: Handshake) => post(channelId, OFFER, h);
export const sendAnswer = (channelId: string, h: Handshake) => post(channelId, ANSWER, h);

function listen(prefix: string, channelId: string, cb: (h: Handshake, messageId: string) => void) {
  return subscribe("MESSAGE_CREATE", (data: any) => {
    const msg = data?.message;
    if (!msg || msg.channel_id !== channelId) return;

    for (const att of msg.attachments ?? []) {
      const name: string = att?.filename ?? "";
      if (!name.startsWith(`${prefix}.`) || !name.endsWith(".txt")) continue;
      const [, sessionId, targetId] = name.split(".");
      if (targetId !== currentUserId()) continue;

      fetchText(att.url)
        .then(body => unpackPayload<Handshake>(body))
        .then(h => {
          if (!h?.sdp || !h.s || h.s !== sessionId) {
            logger.warn(`could not decode ${name}`);
            return;
          }
          cb(h, msg.id);
        })
        .catch(e => logger.error(`failed to fetch ${name}`, e));
      return;
    }
  });
}

export function watchOffers(channelId: string, sessionId: string, cb: (h: Handshake, messageId: string) => void) {
  return listen(OFFER, channelId, (h, id) => {
    if (h.s !== sessionId || h.to !== currentUserId()) return;
    cb(h, id);
  });
}

export function watchAnswers(channelId: string, sessionId: string, cb: (h: Handshake, messageId: string) => void) {
  return listen(ANSWER, channelId, (h, id) => {
    if (h.s !== sessionId || h.to !== currentUserId()) return;
    cb(h, id);
  });
}

