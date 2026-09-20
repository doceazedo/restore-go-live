import { Logger } from "@utils/Logger";

import { hasSignal, loopbackTrack } from "./audio";

const logger = new Logger("P2PShare:capture");

declare const DiscordNative: any;

export interface CaptureResult {
  stream: MediaStream;
  hasAudio: boolean;
  via: string;
  audioVia: string;
}

export function platform(): "win32" | "darwin" | "linux" | "web" {
  const p = DiscordNative?.process?.platform;
  if (p === "win32" || p === "darwin" || p === "linux") return p;
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "win32";
  if (/Mac OS X/i.test(ua)) return "darwin";
  if (/Linux/i.test(ua)) return "linux";
  return "web";
}

async function viaDisplayMedia(fps: number, height: number, wantAudio: boolean) {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: fps, height: { ideal: height } },
      audio: wantAudio
    } as DisplayMediaStreamOptions);
    return { stream, via: "getDisplayMedia" };
  } catch (e) {
    logger.warn("getDisplayMedia failed", e);
    return null;
  }
}

async function viaDiscordNative(fps: number, height: number, wantAudio: boolean) {
  try {
    const sources = await DiscordNative?.desktopCapture?.getDesktopCaptureSources?.({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 }
    });
    if (!sources?.length) return null;

    const source = sources.find((s: any) => s.id?.startsWith("screen")) ?? sources[0];
    const video = {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: source.id,
        maxFrameRate: fps,
        maxHeight: height
      }
    };
    const audio = { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: source.id } };

    const stream = wantAudio
      ? await navigator.mediaDevices
        .getUserMedia({ audio, video } as any)
        .catch(() => navigator.mediaDevices.getUserMedia({ video } as any))
      : await navigator.mediaDevices.getUserMedia({ video } as any);

    return { stream, via: "DiscordNative.desktopCapture" };
  } catch (e) {
    logger.warn("DiscordNative capture failed", e);
    return null;
  }
}

export async function captureScreen(fps: number, height: number, audioPreference: string) {
  const os = platform();
  const wantAudio = audioPreference.trim().toLowerCase() !== "off";

  const order = os === "win32"
    ? [viaDiscordNative, viaDisplayMedia]
    : [viaDisplayMedia, viaDiscordNative];

  let captured: { stream: MediaStream; via: string } | null = null;
  for (const attempt of order) {
    captured = await attempt(fps, height, wantAudio);
    if (captured) break;
  }
  if (!captured) throw new Error("no screen capture API available");

  const { stream, via } = captured;
  let audioVia = "none";
  let track: MediaStreamTrack | null = stream.getAudioTracks()[0] ?? null;

  if (track && !(await hasSignal(track))) {
    logger.warn("capture audio track was silent, discarding it");
    stream.removeTrack(track);
    track.stop();
    track = null;
  } else if (track) {
    audioVia = via;
  }

  if (!track && wantAudio) {
    const fallback = await loopbackTrack(audioPreference);
    if (fallback) {
      stream.addTrack(fallback);
      track = fallback;
      audioVia = "loopback device";
    }
  }

  logger.info(`captured via ${via} on ${os}, audio=${audioVia}`);
  return { stream, hasAudio: track !== null, via, audioVia } as CaptureResult;
}
