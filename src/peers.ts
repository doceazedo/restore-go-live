import { perPeerBitrate } from "./core/bitrate";

export interface IceConfig {
  stun: string[];
  turnUrl?: string;
  turnUsername?: string;
  turnCredential?: string;
}

export function iceServers(cfg: IceConfig): RTCIceServer[] {
  const servers: RTCIceServer[] = [];
  if (cfg.stun.length) servers.push({ urls: cfg.stun });
  if (cfg.turnUrl && cfg.turnUsername && cfg.turnCredential) {
    servers.push({ urls: cfg.turnUrl, username: cfg.turnUsername, credential: cfg.turnCredential });
  }
  return servers;
}

export function newConnection(cfg: IceConfig) {
  return new RTCPeerConnection({ iceServers: iceServers(cfg), bundlePolicy: "max-bundle" });
}

export async function gatherComplete(pc: RTCPeerConnection, timeoutMs = 4000) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => pc.iceGatheringState === "complete" && done();
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

export async function applyBitrate(pc: RTCPeerConnection, budgetMbps: number, viewers: number, relayed: boolean) {
  const maxBitrate = perPeerBitrate(budgetMbps, viewers, relayed);
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== "video") continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = maxBitrate;
    params.degradationPreference = "maintain-framerate";
    await sender.setParameters(params).catch(() => undefined);
  }
  return maxBitrate;
}

export async function isRelayed(pc: RTCPeerConnection) {
  const stats = await pc.getStats();
  let relayed = false;
  const locals = new Map<string, any>();
  stats.forEach(r => {
    if (r.type === "local-candidate") locals.set(r.id, r);
  });
  stats.forEach(r => {
    if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated !== false) {
      if (locals.get(r.localCandidateId)?.candidateType === "relay") relayed = true;
    }
  });
  return relayed;
}

export function waitConnected(pc: RTCPeerConnection, timeoutMs = 30000) {
  return new Promise<boolean>(resolve => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      pc.removeEventListener("connectionstatechange", check);
      resolve(ok);
    };
    const check = () => {
      if (pc.connectionState === "connected") finish(true);
      else if (pc.connectionState === "failed" || pc.connectionState === "closed") finish(false);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    pc.addEventListener("connectionstatechange", check);
    check();
  });
}

export async function createViewerOffer(cfg: IceConfig, wantAudio: boolean, target?: MediaStream) {
  const pc = newConnection(cfg);
  const stream = target ?? new MediaStream();
  const want = wantAudio ? 2 : 1;

  const ready = new Promise<MediaStream>(resolve => {
    let seen = 0;
    pc.ontrack = e => {
      stream.addTrack(e.track);
      if (++seen >= want) resolve(stream);
    };
  });

  pc.addTransceiver("video", { direction: "recvonly" });
  if (wantAudio) pc.addTransceiver("audio", { direction: "recvonly" });

  await pc.setLocalDescription(await pc.createOffer());
  await gatherComplete(pc);
  return { pc, stream, ready, sdp: pc.localDescription!.sdp };
}

export async function answerViewer(cfg: IceConfig, offerSdp: string, media: MediaStream) {
  const pc = newConnection(cfg);
  await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });

  const senders = new Map<string, RTCRtpTransceiver>();
  for (const t of pc.getTransceivers()) {
    const kind = t.receiver.track?.kind;
    if (kind && !senders.has(kind)) senders.set(kind, t);
  }
  for (const track of media.getTracks()) {
    const t = senders.get(track.kind);
    if (t) {
      await t.sender.replaceTrack(track);
      t.direction = "sendonly";
    } else {
      pc.addTrack(track, media);
    }
  }

  await pc.setLocalDescription(await pc.createAnswer());
  await gatherComplete(pc);
  return { pc, sdp: pc.localDescription!.sdp };
}
