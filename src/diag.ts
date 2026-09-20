import { broadcast } from "./broadcast";
import {
  ApplicationStreamingStore, currentUserId, guildIdOf, readVoiceStatus, voiceChannelId, VoiceStateStore
} from "./discord";
import { currentBeacon } from "./signaling";
import { watcher } from "./watch";

function describeTrack(t: MediaStreamTrack) {
  const s = t.getSettings?.() ?? {};
  return {
    kind: t.kind,
    id: t.id.slice(0, 8),
    label: t.label,
    readyState: t.readyState,
    enabled: t.enabled,
    muted: t.muted,
    width: (s as any).width,
    height: (s as any).height,
    frameRate: (s as any).frameRate
  };
}

function describeStream(s: MediaStream | null) {
  if (!s) return null;
  return { id: s.id.slice(0, 8), active: s.active, tracks: s.getTracks().map(describeTrack) };
}

function describeVideos() {
  const ours = broadcast.stream ?? watcher.activeStream();
  return [...document.querySelectorAll("video")].map((v, i) => {
    const src = v.srcObject as MediaStream | null;
    return {
      i,
      cls: v.parentElement?.className?.toString().slice(0, 40),
      w: v.videoWidth,
      h: v.videoHeight,
      clientW: v.clientWidth,
      clientH: v.clientHeight,
      paused: v.paused,
      readyState: v.readyState,
      currentTime: Number(v.currentTime.toFixed(2)),
      srcObject: src ? src.id.slice(0, 8) : null,
      srcTracks: src ? src.getTracks().map(t => `${t.kind}:${t.readyState}${t.muted ? ":muted" : ""}`) : [],
      isOurs: !!src && !!ours && src.id === ours.id
    };
  });
}

export async function diag() {
  const vc = voiceChannelId();
  const before = describeVideos();
  await new Promise(r => setTimeout(r, 1000));
  const after = describeVideos();

  const advancing = after.map((v, i) => ({
    i: v.i,
    advanced: Number((v.currentTime - (before[i]?.currentTime ?? 0)).toFixed(2))
  }));

  const report = {
    voiceChannelId: vc,
    voiceStatus: vc ? readVoiceStatus(vc) : null,
    beacon: vc ? currentBeacon(vc) : null,
    broadcasting: broadcast.active,
    broadcastSession: broadcast.sessionId,
    broadcastAudio: broadcast.hasAudio,
    broadcastStream: describeStream(broadcast.stream),
    viewers: [...broadcast.viewers.entries()].map(([id, v]) => ({
      id,
      relayed: v.relayed,
      connection: v.pc.connectionState,
      ice: v.pc.iceConnectionState
    })),
    watchedStream: describeStream(watcher.activeStream()),
    videos: after,
    frameAdvanceOver1s: advancing
  };

  console.log("=== P2P DIAG ===\n" + JSON.stringify(report, null, 2));
  return report;
}

export function voice() {
  const vc = voiceChannelId();
  if (!vc) return "not in a voice channel";
  const guildId = guildIdOf(vc);
  const states = VoiceStateStore.getVoiceStatesForChannel?.(vc) ?? {};

  const report = {
    me: currentUserId(),
    channelId: vc,
    guildId,
    voiceStates: Object.entries(states).map(([id, v]: [string, any]) => ({
      userId: id,
      sessionId: v?.sessionId,
      selfStream: v?.selfStream,
      selfVideo: v?.selfVideo,
      channelId: v?.channelId
    })),
    streamsForUsers: Object.keys(states).map(id => ({
      userId: id,
      anyStream: ApplicationStreamingStore.getAnyStreamForUser?.(id) ?? null,
      currentUserStream: id === currentUserId()
        ? ApplicationStreamingStore.getCurrentUserActiveStream?.() ?? null
        : undefined
    })),
    allStreams: ApplicationStreamingStore.getAllApplicationStreams?.() ?? []
  };

  console.log("=== P2P VOICE ===\n" + JSON.stringify(report, null, 2));
  return report;
}

export function findModules(pattern: string, context = 300, limit = 4) {
  const wreq = (globalThis as any).Vencord?.Webpack?.wreq;
  if (!wreq?.m) return "webpack not ready";
  const re = new RegExp(pattern);
  const hits: Array<{ id: string; snippet: string }> = [];
  for (const id of Object.keys(wreq.m)) {
    let src: string;
    try {
      src = String(wreq.m[id]);
    } catch {
      continue;
    }
    const m = re.exec(src);
    if (!m) continue;
    const at = m.index ?? 0;
    hits.push({ id, snippet: src.slice(Math.max(0, at - context), at + context) });
    if (hits.length >= limit) break;
  }
  console.log(`=== findModules(${pattern}) -> ${hits.length} ===\n` + JSON.stringify(hits, null, 2));
  return hits;
}

export function attachToAllVideos() {
  const ours = broadcast.stream ?? watcher.activeStream();
  if (!ours) return "no p2p stream available";
  const videos = [...document.querySelectorAll("video")];
  for (const v of videos) {
    v.srcObject = ours;
    v.play().catch(() => undefined);
  }
  return `attached ${ours.id.slice(0, 8)} to ${videos.length} video element(s)`;
}
