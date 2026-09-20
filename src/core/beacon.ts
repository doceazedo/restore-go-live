import { decode64, encode64, Reader, Writer } from "./codec";

export const VERSION = 1;
export const HEARTBEAT_MS = 60_000;
export const STALE_AFTER_MS = 3 * HEARTBEAT_MS;
export const MAX_MESSAGE = 1900;

const BLOB = /\|\|(\d{10,13})\s+p2p:([A-Za-z0-9_-]+)\|\|/;

export interface Beacon {
  sessionId: string;
  startedAt: number;
  heartbeat: number;
  hasAudio: boolean;
}

export function beaconText(locale: string | undefined) {
  return locale?.toLowerCase().startsWith("pt")
    ? "🔴 Estou ao vivo via P2P!"
    : "🔴 I'm live via P2P!";
}

export function beaconMessage(b: Beacon, locale: string | undefined) {
  const w = new Writer();
  w.u8(VERSION);
  w.str(b.sessionId);
  w.u48(b.startedAt);
  w.u8(b.hasAudio ? 1 : 0);

  const seconds = Math.floor(b.heartbeat / 1000);
  const text = `${beaconText(locale)} ||${seconds} p2p:${encode64(w.finish())}||`;
  if (text.length > MAX_MESSAGE) throw new Error(`beacon too large: ${text.length}`);
  return text;
}

export function decodeBeacon(content: string | null | undefined): Beacon | null {
  const found = content?.match(BLOB);
  if (!found) return null;

  const heartbeat = Number(found[1]) * 1000;
  if (!Number.isFinite(heartbeat) || heartbeat < 1.6e12) return null;

  try {
    const r = new Reader(decode64(found[2]));
    if (r.u8() !== VERSION) return null;
    const sessionId = r.str();
    const startedAt = r.u48();
    const hasAudio = r.u8() === 1;
    if (!/^[0-9a-f]{8}$/.test(sessionId)) return null;
    if (startedAt < 1.6e12) return null;
    return { sessionId, startedAt, heartbeat, hasAudio };
  } catch {
    return null;
  }
}

export function isStale(b: Beacon, now = Date.now()) {
  return now - b.heartbeat > STALE_AFTER_MS;
}
