import { broadcast } from "./broadcast";
import {
  ApplicationStreamingStore,
  currentUserId,
  guildIdOf,
  voiceChannelId,
  VoiceStateStore,
} from "./discord";
import { scanBeacons } from "./signaling";
import { goLiveSource } from "./source";
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
    frameRate: (s as any).frameRate,
  };
}

function describeStream(s: MediaStream | null) {
  if (!s) return null;
  return {
    id: s.id.slice(0, 8),
    active: s.active,
    tracks: s.getTracks().map(describeTrack),
  };
}

function describeVideos() {
  const ours = broadcast.preview ?? watcher.activeStream();
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
      srcTracks: src
        ? src
            .getTracks()
            .map((t) => `${t.kind}:${t.readyState}${t.muted ? ":muted" : ""}`)
        : [],
      isOurs: !!src && !!ours && src.id === ours.id,
    };
  });
}

export async function diag() {
  const vc = voiceChannelId();
  const before = describeVideos();
  await new Promise((r) => setTimeout(r, 1000));
  const after = describeVideos();

  const advancing = after.map((v, i) => ({
    i: v.i,
    advanced: Number(
      (v.currentTime - (before[i]?.currentTime ?? 0)).toFixed(2),
    ),
  }));

  const report = {
    voiceChannelId: vc,
    broadcasting: broadcast.active,
    beaconMessageId: broadcast.beaconMessageId,
    broadcastSession: broadcast.sessionId,
    broadcastAudio: broadcast.hasAudio,
    broadcastStream: describeStream(broadcast.stream),
    goLiveSource: goLiveSource(),
    viewers: [...broadcast.viewers.entries()].map(([id, v]) => ({
      id,
      connection: v.pc.connectionState,
      ice: v.pc.iceConnectionState,
    })),
    watchedStream: describeStream(watcher.activeStream()),
    videos: after,
    frameAdvanceOver1s: advancing,
  };

  console.log("=== P2P DIAG ===\n" + JSON.stringify(report, null, 2));
  return report;
}

export async function audioDevices() {
  const { listInputs, pickLoopback } = await import("./audio");
  const { platform } = await import("./capture");
  const devices = await listInputs();
  const report = {
    platform: platform(),
    labelsVisible: devices.some((d) => !!d.label),
    autoPick: pickLoopback(devices, "auto")?.label ?? null,
    devices: devices.map((d) => ({
      label: d.label,
      looksLikeLoopback: d.looksLikeLoopback,
    })),
  };
  console.log("=== P2P AUDIO ===\n" + JSON.stringify(report, null, 2));
  return report;
}

export function describeQuality(stream: MediaStream | null) {
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState !== "live") return null;

  const settings = track.getSettings?.() ?? {};
  let height = Number(settings.height);
  const fps = Number(settings.frameRate);

  if (!Number.isFinite(height) || height <= 0) {
    for (const el of document.querySelectorAll("video")) {
      const v = el as HTMLVideoElement;
      if (v.srcObject === stream && v.videoHeight > 0) {
        height = v.videoHeight;
        break;
      }
    }
  }

  if (!Number.isFinite(height) || height <= 0) return null;
  return Number.isFinite(fps) && fps > 0
    ? `${Math.round(height)}p ${Math.round(fps)}FPS`
    : `${Math.round(height)}p`;
}

export async function nat(stunUrls: string[]) {
  const probe = async (urls: string[]) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls }] });
    pc.createDataChannel("probe");
    const cands: RTCIceCandidate[] = [];
    pc.addEventListener(
      "icecandidate",
      (e) => e.candidate && cands.push(e.candidate),
    );
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => setTimeout(r, 5000));
    pc.close();
    return cands;
  };

  const all = await probe(stunUrls);
  const parse = (c: RTCIceCandidate) => ({
    type: c.type,
    v6: (c.address ?? "").includes(":"),
    address: c.address,
    port: c.port,
    related: c.relatedPort,
  });
  const parsed = all.map(parse);

  const hostV6 = parsed.filter(
    (c) => c.type === "host" && c.v6 && !/^fe80:/i.test(c.address ?? ""),
  );
  const srflx = parsed.filter((c) => c.type === "srflx");
  const srflxPorts = new Set(srflx.map((c) => c.port));

  const symmetric = srflx.length > 1 && srflxPorts.size > 1;

  const verdict = hostV6.length
    ? "IPv6 available, direct connection should work even behind CGNAT"
    : symmetric
      ? "symmetric NAT and no IPv6, this peer cannot connect directly"
      : srflx.length
        ? "cone NAT with no IPv6, direct connection usually works"
        : "no public candidates found, check network";

  const report = {
    globalIPv6: hostV6.map((c) => c.address),
    publicIPv4: [...new Set(srflx.filter((c) => !c.v6).map((c) => c.address))],
    srflxPorts: [...srflxPorts],
    symmetricNat: symmetric,
    candidateTypes: parsed.reduce((acc: any, c) => {
      const k = `${c.type}${c.v6 ? "-v6" : "-v4"}`;
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
    verdict,
  };

  console.log("=== P2P NAT ===\n" + JSON.stringify(report, null, 2));
  console.log(verdict);
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
      channelId: v?.channelId,
    })),
    streamsForUsers: Object.keys(states).map((id) => ({
      userId: id,
      anyStream: ApplicationStreamingStore.getAnyStreamForUser?.(id) ?? null,
      currentUserStream:
        id === currentUserId()
          ? (ApplicationStreamingStore.getCurrentUserActiveStream?.() ?? null)
          : undefined,
    })),
    allStreams: ApplicationStreamingStore.getAllApplicationStreams?.() ?? [],
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
    hits.push({
      id,
      snippet: src.slice(Math.max(0, at - context), at + context),
    });
    if (hits.length >= limit) break;
  }
  console.log(
    `=== findModules(${pattern}) -> ${hits.length} ===\n` +
      JSON.stringify(hits, null, 2),
  );
  return hits;
}

export function attachToAllVideos() {
  const ours = broadcast.preview ?? watcher.activeStream();
  if (!ours) return "no p2p stream available";
  const videos = [...document.querySelectorAll("video")];
  for (const v of videos) {
    v.srcObject = ours;
    v.play().catch(() => undefined);
  }
  return `attached ${ours.id.slice(0, 8)} to ${videos.length} video element(s)`;
}
