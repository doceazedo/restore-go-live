import { Logger } from "@utils/Logger";

const logger = new Logger("P2PShare:audio");

const LOOPBACK_HINTS = [
  /\bmonitor\b/i,
  /\bloopback\b/i,
  /blackhole/i,
  /soundflower/i,
  /stereo\s*mix/i,
  /what\s*u\s*hear/i,
  /vb-?audio/i,
  /voicemeeter/i,
  /virtual\s*(audio|cable)/i,
  /pipewire/i
];

export interface AudioDevice {
  deviceId: string;
  label: string;
  looksLikeLoopback: boolean;
}

export async function listInputs(): Promise<AudioDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter(d => d.kind === "audioinput")
    .map(d => ({
      deviceId: d.deviceId,
      label: d.label,
      looksLikeLoopback: LOOPBACK_HINTS.some(re => re.test(d.label))
    }));
}

export function pickLoopback(devices: AudioDevice[], preference: string) {
  const wanted = preference.trim().toLowerCase();
  if (wanted && wanted !== "auto") {
    return devices.find(d => d.label.toLowerCase().includes(wanted)) ?? null;
  }
  return devices.find(d => d.looksLikeLoopback) ?? null;
}

export async function captureFromDevice(deviceId: string) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false
    }
  });
  return stream.getAudioTracks()[0] ?? null;
}

export async function hasSignal(track: MediaStreamTrack, ms = 1500) {
  if (track.readyState !== "live") return false;

  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const data = new Uint8Array(analyser.fftSize);
    const deadline = Date.now() + ms;

    while (Date.now() < deadline) {
      analyser.getByteTimeDomainData(data);
      if (data.some(v => v < 126 || v > 130)) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  } catch (e) {
    logger.warn("could not probe audio track", e);
    return false;
  } finally {
    void ctx?.close();
  }
}

export async function loopbackTrack(preference: string) {
  if (preference.trim().toLowerCase() === "off") return null;

  try {
    const devices = await listInputs();
    if (!devices.some(d => d.label)) {
      logger.warn("device labels unavailable - cannot identify a loopback input");
      return null;
    }

    const device = pickLoopback(devices, preference);
    if (!device) {
      logger.info(`no loopback input found among ${devices.length} device(s)`);
      return null;
    }

    logger.info(`using audio input "${device.label}"`);
    return await captureFromDevice(device.deviceId);
  } catch (e) {
    logger.warn("loopback capture failed", e);
    return null;
  }
}
