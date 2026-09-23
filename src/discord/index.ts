import { Logger } from "@utils/Logger";
import { findByCodeLazy, findByPropsLazy, findLazy, findStoreLazy } from "@webpack";
import {
  ChannelStore, Constants, FluxDispatcher, LocaleStore, RestAPI, SelectedChannelStore, UserStore
} from "@webpack/common";

const announceLogger = new Logger("P2PShare:announce");

export const ApplicationStreamingStore = findStoreLazy("ApplicationStreamingStore");
export const VoiceStateStore = findStoreLazy("VoiceStateStore");
export const StreamingSettingsStore = findStoreLazy("ApplicationStreamingSettingsStore");
export const MediaEngineStore = findStoreLazy("MediaEngineStore");
export const RunningGameStore = findStoreLazy("RunningGameStore");

export const CloudUpload: any = findLazy((m: any) => m.prototype?.trackUploadFinished);

export function locale(): string | undefined {
  return LocaleStore?.locale;
}

export function currentUserId(): string {
  return UserStore.getCurrentUser()?.id ?? "";
}

export function voiceChannelId(): string | null {
  return SelectedChannelStore.getVoiceChannelId() ?? null;
}

export function channelOf(id: string | null) {
  return id ? ChannelStore.getChannel(id) : null;
}

export function voiceStateOf(userId: string, channelId: string): any | null {
  const guildId = guildIdOf(channelId);
  return VoiceStateStore.getVoiceState?.(guildId, userId)
    ?? VoiceStateStore.getVoiceStateForUser?.(userId)
    ?? VoiceStateStore.getVoiceStatesForChannel?.(channelId)?.[userId]
    ?? null;
}

let nextStreamId = 9000;
const ownedVideoIds = new Map<number, string>();

export function ownerOfVideoId(streamId: unknown): string | null {
  const id = typeof streamId === "string" ? Number(streamId) : streamId;
  return typeof id === "number" ? ownedVideoIds.get(id) ?? null : null;
}

export function announceVideo(userId: string, channelId: string, on: boolean) {
  const guildId = guildIdOf(channelId);
  const streamId = on ? ++nextStreamId : null;
  if (streamId != null) ownedVideoIds.set(streamId, userId);
  else for (const [id, owner] of [...ownedVideoIds]) if (owner === userId) ownedVideoIds.delete(id);
  dispatch({
    type: "RTC_CONNECTION_VIDEO",
    userId,
    guildId,
    channelId,
    streamId,
    context: "stream"
  });
  return streamId;
}

export function announceStream(userId: string, channelId: string, on: boolean) {
  const vs = voiceStateOf(userId, channelId);
  if (!vs?.sessionId) {
    announceLogger.warn(`no voice state for ${userId} in ${channelId}`, {
      tried: Object.keys(VoiceStateStore).filter(k => k.startsWith("getVoiceState"))
    });
    return false;
  }
  const payload = {
    ...vs,
    userId,
    channelId,
    guildId: guildIdOf(channelId) ?? undefined,
    oldChannelId: on ? channelId : vs.channelId,
    selfStream: on,
    selfVideo: vs.selfVideo ?? false,
    discoverable: true
  };
  dispatch({ type: "VOICE_STATE_UPDATES", voiceStates: [payload] });

  return true;
}

export function guildIdOf(channelId: string | null) {
  const ch = channelOf(channelId);
  return ch?.guild_id ?? null;
}

export function streamQuality() {
  const state = StreamingSettingsStore.getState?.() ?? {};
  const resolution = Number(state.resolution);
  const fps = Number(state.fps);
  return {
    height: Number.isFinite(resolution) && resolution > 0 ? resolution : 1080,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30
  };
}

export const STREAM_CONTEXT = "stream";

export function streamAudioState(userId: string) {
  try {
    const volume = MediaEngineStore?.getLocalVolume?.(userId, STREAM_CONTEXT);
    return {
      muted: MediaEngineStore?.isLocalMute?.(userId, STREAM_CONTEXT) === true,
      volume: typeof volume === "number" && Number.isFinite(volume) ? volume : 100
    };
  } catch {
    return { muted: false, volume: 100 };
  }
}

export function outputDeviceId(): string | null {
  try {
    const id = MediaEngineStore?.getOutputDeviceId?.();
    return typeof id === "string" && id && id !== "default" ? id : null;
  } catch {
    return null;
  }
}

export function refreshAttached(stream: MediaStream) {
  let n = 0;
  for (const el of document.querySelectorAll("video")) {
    const v = el as HTMLVideoElement;
    if (v.srcObject !== stream) continue;
    v.srcObject = null;
    v.srcObject = stream;
    void v.play().catch(() => undefined);
    n++;
  }
  return n;
}

const NO_MENTIONS = { parse: [] as string[], replied_user: false };

function replyTo(channelId: string, messageId?: string) {
  if (!messageId) return undefined;
  return { message_id: messageId, channel_id: channelId, fail_if_not_exists: false };
}

export async function postMessage(channelId: string, content: string) {
  const res = await RestAPI.post({
    url: Constants.Endpoints.MESSAGES(channelId),
    body: {
      content,
      channel_id: channelId,
      type: 0,
      nonce: String(Date.now()),
      allowed_mentions: NO_MENTIONS
    }
  });
  return res.body?.id as string;
}

export async function editMessage(channelId: string, messageId: string, content: string) {
  return RestAPI.patch({
    url: Constants.Endpoints.MESSAGE(channelId, messageId),
    body: { content, allowed_mentions: NO_MENTIONS }
  });
}

export async function recentMessages(channelId: string, limit = 50) {
  const res = await RestAPI.get({
    url: Constants.Endpoints.MESSAGES(channelId),
    query: { limit }
  });
  return (res.body ?? []) as any[];
}

function reactionUrl(channelId: string, messageId: string, emoji: string, userId = "@me") {
  return `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/${userId}`;
}

export async function addReaction(channelId: string, messageId: string, emoji: string) {
  return RestAPI.put({ url: reactionUrl(channelId, messageId, emoji) });
}

export async function removeReaction(channelId: string, messageId: string, emoji: string) {
  return RestAPI.del({ url: reactionUrl(channelId, messageId, emoji) });
}

export async function reactors(channelId: string, messageId: string, emoji: string) {
  const res = await RestAPI.get({
    url: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    query: { limit: 100 }
  });
  return ((res.body ?? []) as any[]).map(u => u?.id as string).filter(Boolean);
}

export function uploadText(channelId: string, filename: string, text: string, replyToId?: string) {
  return new Promise<string>((resolve, reject) => {
    const upload = new CloudUpload({
      file: new File([text], filename, { type: "text/plain" }),
      isThumbnail: false,
      platform: 1
    }, channelId);

    upload.on("complete", async () => {
      try {
        const res = await RestAPI.post({
          url: Constants.Endpoints.MESSAGES(channelId),
          body: {
            content: "",
            channel_id: channelId,
            type: 0,
            nonce: String(Date.now()),
            sticker_ids: [],
            attachments: [{ id: "0", filename: upload.filename, uploaded_filename: upload.uploadedFilename }],
            allowed_mentions: NO_MENTIONS,
            message_reference: replyTo(channelId, replyToId)
          }
        });
        resolve(res.body?.id);
      } catch (e) {
        reject(e);
      }
    });
    upload.on("error", () => reject(new Error("attachment upload failed")));
    upload.upload();
  });
}

export async function fetchText(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`attachment fetch ${res.status}`);
  return res.text();
}

export async function deleteMessage(channelId: string, messageId: string) {
  return RestAPI.del({ url: Constants.Endpoints.MESSAGE(channelId, messageId) }).catch(() => undefined);
}

export function dispatch(payload: any) {
  FluxDispatcher.dispatch(payload);
}

export function addInterceptor(fn: (action: any) => boolean) {
  let active = true;
  const wrapped = (action: any) => (active ? fn(action) : false);
  const flux: any = FluxDispatcher;
  if (typeof flux.addInterceptor === "function") flux.addInterceptor(wrapped);
  else if (Array.isArray(flux._interceptors)) flux._interceptors.push(wrapped);
  else {
    announceLogger.warn("no flux interceptor support");
    return () => undefined;
  }
  return () => {
    active = false;
  };
}

export function subscribe(event: string, cb: (data: any) => void) {
  FluxDispatcher.subscribe(event as any, cb);
  return () => FluxDispatcher.unsubscribe(event as any, cb);
}
