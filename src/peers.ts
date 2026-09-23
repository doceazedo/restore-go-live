import { Logger } from "@utils/Logger";

import { perPeerBitrate } from "./core/bitrate";

const logger = new Logger("P2PShare:ice");

export interface IceConfig {
  stun: string[];
}

export function newConnection(cfg: IceConfig) {
  const pc = new RTCPeerConnection({
    iceServers: cfg.stun.length ? [{ urls: cfg.stun }] : [],
    bundlePolicy: "max-bundle"
  });
  pc.addEventListener("icecandidateerror", (e: any) => {
    if (e.errorCode !== 701) logger.warn(`ICE error ${e.errorCode} ${e.errorText} (${e.url})`);
  });
  return pc;
}

export async function selectedPair(pc: RTCPeerConnection) {
  const stats = await pc.getStats();
  const byId = new Map<string, any>();
  stats.forEach(r => byId.set(r.id, r));
  let out = "unknown";
  stats.forEach(r => {
    if (r.type !== "candidate-pair" || r.state !== "succeeded") return;
    const local = byId.get(r.localCandidateId);
    const remote = byId.get(r.remoteCandidateId);
    if (local && remote) out = `${local.candidateType}/${local.protocol} -> ${remote.candidateType}`;
  });
  return out;
}

export async function gatherComplete(pc: RTCPeerConnection, timeoutMs = 2000, graceMs = 300) {
  if (pc.iceGatheringState === "complete") return;
  const started = performance.now();
  await new Promise<void>(resolve => {
    let grace: ReturnType<typeof setTimeout> | null = null;
    const done = (reason: string) => {
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      pc.removeEventListener("icegatheringstatechange", onChange);
      pc.removeEventListener("icecandidate", onCandidate);
      logger.info(`ice gathering ended (${reason}) after ${Math.round(performance.now() - started)}ms`);
      resolve();
    };
    const onChange = () => pc.iceGatheringState === "complete" && done("complete");
    const onCandidate = (e: RTCPeerConnectionIceEvent) => {
      if (grace || e.candidate?.type !== "srflx") return;
      grace = setTimeout(() => done("srflx"), graceMs);
    };
    const timer = setTimeout(() => done("timeout"), timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
    pc.addEventListener("icecandidate", onCandidate);
  });
}

export async function applyBitrate(pc: RTCPeerConnection, budgetMbps: number, viewers: number) {
  const maxBitrate = perPeerBitrate(budgetMbps, viewers);
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
      if (e.track.kind === "video") stream.addTrack(e.track);
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
