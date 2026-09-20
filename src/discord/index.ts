import { Logger } from "@utils/Logger";
import { findByCodeLazy, findByPropsLazy, findLazy, findStoreLazy } from "@webpack";
import { ChannelStore, Constants, FluxDispatcher, RestAPI, SelectedChannelStore, UserStore } from "@webpack/common";

const announceLogger = new Logger("P2PShare:announce");

export const ApplicationStreamingStore = findStoreLazy("ApplicationStreamingStore");
export const VoiceStateStore = findStoreLazy("VoiceStateStore");
export const RTCConnectionStore = findStoreLazy("RTCConnectionStore");
export const ChannelStatusStore = findStoreLazy("ChannelStatusStore");

export const ChannelActions = findByPropsLazy("updateVoiceChannelStatus");
export const SocketHolder = findByPropsLazy("getSocket");
export const CloudUpload: any = findLazy((m: any) => m.prototype?.trackUploadFinished);
export const StreamActions = findByPropsLazy("startStream", "stopStream");
export const DesktopSources = findByCodeLazy("getDesktopCaptureSources");

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
  announceLogger.info(`dispatch VOICE_STATE_UPDATES selfStream=${on}`, payload);
  dispatch({ type: "VOICE_STATE_UPDATES", voiceStates: [payload] });

  return true;
}

export function isInChannel(userId: string, channelId: string) {
  const states = VoiceStateStore.getVoiceStatesForChannel?.(channelId) ?? {};
  return Object.prototype.hasOwnProperty.call(states, userId);
}

export function guildIdOf(channelId: string | null) {
  const ch = channelOf(channelId);
  return ch?.guild_id ?? null;
}

export async function setVoiceStatus(channelId: string, status: string | null) {
  return RestAPI.put({
    url: `/channels/${channelId}/voice-status`,
    body: { status: status === "" ? null : status }
  });
}

export function requestChannelInfo(channelId: string) {
  const guildId = guildIdOf(channelId);
  if (!guildId) return false;
  try {
    const socket = SocketHolder.getSocket?.();
    socket?.requestChannelInfo?.(guildId, ["status", "voice_start_time"]);
    announceLogger.info(`requested channel info for guild ${guildId}`);
    return true;
  } catch (e) {
    announceLogger.warn("requestChannelInfo failed", e);
    return false;
  }
}

export function refreshAttached(stream: MediaStream) {
  let n = 0;
  const seen: string[] = [];
  for (const el of document.querySelectorAll("video")) {
    const v = el as HTMLVideoElement;
    const src = v.srcObject as MediaStream | null;
    seen.push(src ? `${src.id.slice(0, 6)}(${src.getTracks().length})` : "none");
    if (src !== stream) continue;
    v.srcObject = null;
    v.srcObject = stream;
    void v.play().catch(() => undefined);
    n++;
  }
  if (n === 0) {
    announceLogger.warn(`refreshAttached found no element with ${stream.id.slice(0, 6)}; videos=[${seen.join(", ")}]`);
  }
  return n;
}

export function readVoiceStatus(channelId: string): string | null {
  const ch = channelOf(channelId);
  if (!ch) return null;
  return ChannelStatusStore.getChannelStatus(ch) ?? null;
}

export async function sendSignal(channelId: string, content: string) {
  const res = await RestAPI.post({
    url: Constants.Endpoints.MESSAGES(channelId),
    body: {
      content,
      flags: 1 << 12,
      nonce: String(Date.now())
    }
  });
  return res.body?.id as string | undefined;
}

export function uploadText(channelId: string, filename: string, text: string) {
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
            flags: 1 << 12,
            nonce: String(Date.now()),
            sticker_ids: [],
            attachments: [{ id: "0", filename: upload.filename, uploaded_filename: upload.uploadedFilename }]
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
