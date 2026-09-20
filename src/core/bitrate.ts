export const MIN_BITRATE = 800_000;
export const MAX_BITRATE = 8_000_000;
export const RELAY_BITRATE = 2_000_000;

export function perPeerBitrate(budgetMbps: number, viewers: number, relayed = false) {
  const budget = budgetMbps * 1_000_000;
  const share = viewers > 0 ? budget / viewers : budget;
  const capped = Math.min(Math.max(share, MIN_BITRATE), MAX_BITRATE);
  return relayed ? Math.min(capped, RELAY_BITRATE) : capped;
}
