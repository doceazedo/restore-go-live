import { Logger } from "@utils/Logger";

import { hasSignal, loopbackTrack } from "./audio";
import { Native } from "./bridge";
import { electronSourceId, matchSource, sameSource, sourceParts } from "./core/sources";
import { GoLiveSource } from "./source";

const logger = new Logger("P2PShare:capture");

declare const DiscordNative: any;

export interface CaptureResult {
  stream: MediaStream;
  hasAudio: boolean;
  via: string;
  audioVia: string;
}

type Attempt = (
  fps: number,
  height: number,
  wantAudio: boolean,
  sourceId: string | null
) => Promise<{ stream: MediaStream; via: string } | null>;

export function platform(): "win32" | "darwin" | "linux" | "web" {
  const p = DiscordNative?.process?.platform;
  if (p === "win32" || p === "darwin" || p === "linux") return p;
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "win32";
  if (/Mac OS X/i.test(ua)) return "darwin";
  if (/Linux/i.test(ua)) return "linux";
  return "web";
}

function displayMedia(fps: number, height: number, wantAudio: boolean) {
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: fps, height: { ideal: height } },
    audio: wantAudio
  } as DisplayMediaStreamOptions);
}

const SURFACE: Record<string, string> = { window: "window", screen: "monitor" };

function surfaceOf(stream: MediaStream) {
  const settings: any = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
  return settings.displaySurface as string | undefined;
}

function wrongSurface(stream: MediaStream, sourceId: string | null) {
  if (!sourceId) return false;
  const want = SURFACE[sourceParts(sourceId).type];
  const got = surfaceOf(stream);
  if (!want || !got) return false;
  return got !== want;
}

function stop(stream: MediaStream) {
  stream.getTracks().forEach(t => t.stop());
}

const viaDisplayMedia: Attempt = async (fps, height, wantAudio, sourceId) => {
  try {
    if (IS_DISCORD_DESKTOP) {
      const pinned = await Native.preferSource(sourceId);
      if (!pinned?.ok) {
        logger.warn("could not pin the capture source", pinned);
      } else if (sourceId && pinned.route === "fallback") {
        const seen = (pinned.candidates ?? []).map(c => `${c.id} "${c.name}"`).join(", ");
        logger.warn(`main process has no source for ${sourceId}, it offered: ${seen}`);
        return null;
      } else {
        logger.info(`main process will capture ${pinned.resolved} (${pinned.route})`);
      }
    }

    const stream = await displayMedia(fps, height, wantAudio);
    if (wrongSurface(stream, sourceId)) {
      logger.warn(`getDisplayMedia returned a ${surfaceOf(stream)} instead of ${sourceId}`);
      stop(stream);
      return null;
    }
    return { stream, via: "getDisplayMedia" };
  } catch (e) {
    logger.warn("getDisplayMedia failed", e);
    return null;
  }
};

const viaDiscordNative: Attempt = async (fps, height, wantAudio, sourceId) => {
  try {
    const sources = await DiscordNative?.desktopCapture?.getDesktopCaptureSources?.({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 }
    });

    const listed = sourceId ? sources?.find((s: any) => sameSource(s, sourceId)) : null;
    const addressed = sourceId && !listed ? electronSourceId(sourceId) : null;
    const id = listed?.id ?? addressed ?? matchSource(sources ?? [], null)?.id;
    if (!id) return null;

    if (addressed) logger.info(`${sourceId} is not listed, addressing it as ${addressed}`);
    else if (sourceId && !listed) logger.warn(`falling back to ${id}, ${sourceId} could not be addressed`);

    const video = {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: id,
        maxFrameRate: fps,
        maxHeight: height
      }
    };
    const audio = { mandatory: { chromeMediaSource: "desktop" } };
    const onScreen = sourceParts(id).type === "screen";

    const stream = wantAudio && onScreen
      ? await navigator.mediaDevices
        .getUserMedia({ audio, video } as any)
        .catch(() => navigator.mediaDevices.getUserMedia({ video } as any))
      : await navigator.mediaDevices.getUserMedia({ video } as any);

    if (wrongSurface(stream, sourceId)) {
      logger.warn(`desktop capture returned a ${surfaceOf(stream)} instead of ${sourceId}`);
      stop(stream);
      return null;
    }

    return { stream, via: "DiscordNative.desktopCapture" };
  } catch (e) {
    logger.warn("DiscordNative capture failed", e);
    return null;
  }
};

async function loopbackFromHandler() {
  if (!IS_DISCORD_DESKTOP) return null;
  try {
    await Native.preferSource(null);
    const stream = await displayMedia(5, 240, true);
    const audio = stream.getAudioTracks()[0] ?? null;
    for (const track of stream.getVideoTracks()) {
      stream.removeTrack(track);
      track.stop();
    }
    if (!audio) return null;
    logger.info("took desktop audio from a second capture");
    return audio;
  } catch (e) {
    logger.warn("could not open a loopback audio stream", e);
    return null;
  }
}

async function resolveAudio(
  stream: MediaStream,
  via: string,
  wantAudio: boolean,
  audioPreference: string
) {
  const track: MediaStreamTrack | null = stream.getAudioTracks()[0] ?? null;
  const drop = () => {
    if (!track) return;
    stream.removeTrack(track);
    track.stop();
  };

  if (!wantAudio) {
    drop();
    return { track: null, audioVia: "off" };
  }

  const trusted = via === "getDisplayMedia";
  if (track && track.readyState === "live" && (trusted || (await hasSignal(track)))) {
    return { track, audioVia: via };
  }

  const handler = await loopbackFromHandler();
  if (handler) {
    drop();
    stream.addTrack(handler);
    return { track: handler, audioVia: "loopback handler" };
  }

  const device = await loopbackTrack(audioPreference);
  if (device) {
    drop();
    stream.addTrack(device);
    return { track: device, audioVia: "loopback device" };
  }

  if (track && track.readyState === "live") {
    logger.info("capture audio is silent so far, keeping it anyway");
    return { track, audioVia: via };
  }

  drop();
  return { track: null, audioVia: "none" };
}

export async function captureScreen(
  fps: number,
  height: number,
  audioPreference: string,
  source: GoLiveSource
) {
  const os = platform();
  const wantAudio = audioPreference.trim().toLowerCase() !== "off" && source.sound;

  let captured: { stream: MediaStream; via: string } | null = null;
  for (const attempt of [viaDisplayMedia, viaDiscordNative]) {
    captured = await attempt(fps, height, wantAudio, source.id);
    if (captured?.stream.getVideoTracks().length) break;
    if (captured) stop(captured.stream);
    captured = null;
  }
  if (!captured && source.id) {
    throw new Error(`could not capture ${source.name ?? source.id}, nothing else was shared`);
  }
  if (!captured) throw new Error("no screen capture API available");

  const { stream, via } = captured;
  const { track, audioVia } = await resolveAudio(stream, via, wantAudio, audioPreference);

  logger.info(`captured ${stream.getVideoTracks()[0]?.label ?? "?"} via ${via} on ${os}, audio=${audioVia}`);
  return { stream, hasAudio: track !== null, via, audioVia } as CaptureResult;
}
