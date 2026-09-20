import { decode64, encode64, Reader, Writer } from "./codec";

export const LABEL = "🔴 P2P";
export const SEP = "·";
export const MAX_STATUS = 500;
export const BEACON_TTL_MS = 6 * 60 * 60 * 1000;
export const VERSION = 1;

export interface Beacon {
  sessionId: string;
  ownerId: string;
  startedAt: number;
  hasAudio: boolean;
}

export function encodeBeacon(b: Beacon) {
  const w = new Writer();
  w.u8(VERSION);
  w.str(b.sessionId);
  w.str(b.ownerId);
  w.u48(b.startedAt);
  w.u8(b.hasAudio ? 1 : 0);
  const text = `${LABEL}${SEP}${encode64(w.finish())}`;
  if (text.length > MAX_STATUS) throw new Error(`beacon too large: ${text.length}`);
  return text;
}

function readBeacon(blob: string): Beacon | null {
  try {
    const r = new Reader(decode64(blob));
    if (r.u8() !== VERSION) return null;
    const sessionId = r.str();
    const ownerId = r.str();
    const startedAt = r.u48();
    const hasAudio = r.u8() === 1;

    if (!/^[0-9a-f]{8}$/.test(sessionId)) return null;
    if (!/^\d{16,21}$/.test(ownerId)) return null;
    if (startedAt < 1.6e12 || startedAt > Date.now() + 6e5) return null;

    return { sessionId, ownerId, startedAt, hasAudio };
  } catch {
    return null;
  }
}

export function decodeBeacon(status: string | null | undefined): Beacon | null {
  if (!status) return null;

  const idx = status.lastIndexOf(SEP);
  if (idx >= 0) {
    const found = readBeacon(status.slice(idx + SEP.length));
    if (found) return found;
  }

  const tail = [...status].slice(-MAX_STATUS).join("");
  const run = tail.match(/[A-Za-z0-9_-]+$/)?.[0];
  if (!run) return null;
  for (let i = 0; i < run.length - 8; i++) {
    const found = readBeacon(run.slice(i));
    if (found) return found;
  }
  return null;
}

export function isStale(b: Beacon, now = Date.now()) {
  return now - b.startedAt > BEACON_TTL_MS;
}
