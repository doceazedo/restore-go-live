import { Logger } from "@utils/Logger";

import { addReaction, currentUserId, dispatch, reactors, removeReaction, subscribe } from "./discord";

const logger = new Logger("P2PShare:viewers");

export const WATCHING_EMOJI = "👀";

interface Tracked {
  streamKey: string;
  ownerId: string;
  channelId: string;
  ids: Set<string>;
}

const tracked = new Map<string, Tracked>();
let offs: Array<() => void> = [];

function isWatchingEmoji(emoji: any) {
  return !emoji?.id && emoji?.name === WATCHING_EMOJI;
}

function publish(t: Tracked) {
  dispatch({
    type: "STREAM_UPDATE",
    streamKey: t.streamKey,
    viewerIds: [...t.ids],
    paused: false,
    region: "p2p"
  });
}

function update(messageId: string, change: (t: Tracked) => void) {
  const t = tracked.get(messageId);
  if (!t) return;
  const before = [...t.ids].join();
  change(t);
  t.ids.delete(t.ownerId);
  if ([...t.ids].join() !== before) publish(t);
}

export function startViewerTracking() {
  if (offs.length) return;
  offs = [
    subscribe("MESSAGE_REACTION_ADD", (d: any) => {
      if (!isWatchingEmoji(d?.emoji) || !d?.userId) return;
      update(d.messageId, t => t.ids.add(d.userId));
    }),
    subscribe("MESSAGE_REACTION_ADD_MANY", (d: any) => {
      for (const r of d?.reactions ?? []) {
        if (!isWatchingEmoji(r?.emoji)) continue;
        update(d.messageId, t => (r.users ?? []).forEach((id: string) => t.ids.add(id)));
      }
    }),
    subscribe("MESSAGE_REACTION_REMOVE", (d: any) => {
      if (!isWatchingEmoji(d?.emoji) || !d?.userId) return;
      update(d.messageId, t => t.ids.delete(d.userId));
    }),
    subscribe("MESSAGE_REACTION_REMOVE_EMOJI", (d: any) => {
      if (!isWatchingEmoji(d?.emoji)) return;
      update(d.messageId, t => t.ids.clear());
    }),
    subscribe("MESSAGE_REACTION_REMOVE_ALL", (d: any) => {
      update(d?.messageId, t => t.ids.clear());
    })
  ];
}

export function stopViewerTracking() {
  for (const off of offs) off();
  offs = [];
  for (const messageId of [...tracked.keys()]) untrackViewers(messageId);
}

export async function trackViewers(streamKey: string, ownerId: string, channelId: string, messageId: string) {
  const t: Tracked = { streamKey, ownerId, channelId, ids: new Set() };
  tracked.set(messageId, t);
  publish(t);

  try {
    const found = await reactors(channelId, messageId, WATCHING_EMOJI);
    update(messageId, t => found.forEach(id => t.ids.add(id)));
    return found;
  } catch (e) {
    logger.warn(`could not fetch viewers of ${messageId}`, e);
    return [];
  }
}

export function untrackViewers(messageId: string) {
  const t = tracked.get(messageId);
  if (!t) return;
  tracked.delete(messageId);
  t.ids.clear();
  publish(t);
}

export function markWatching(channelId: string, messageId: string, on: boolean) {
  const me = currentUserId();
  update(messageId, t => (on ? t.ids.add(me) : t.ids.delete(me)));
  const request = on
    ? addReaction(channelId, messageId, WATCHING_EMOJI)
    : removeReaction(channelId, messageId, WATCHING_EMOJI);
  return request.catch(e => logger.warn(`could not ${on ? "add" : "remove"} watching reaction`, e));
}
