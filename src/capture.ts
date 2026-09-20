import { Logger } from "@utils/Logger";

const logger = new Logger("P2PShare:capture");

declare const DiscordNative: any;

export interface CaptureResult {
  stream: MediaStream;
  hasAudio: boolean;
  via: string;
}

async function viaDisplayMedia(fps: number, height: number): Promise<CaptureResult | null> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: fps, height: { ideal: height } },
      audio: true
    } as DisplayMediaStreamOptions);
    return { stream, hasAudio: stream.getAudioTracks().length > 0, via: "getDisplayMedia" };
  } catch (e) {
    logger.warn("getDisplayMedia failed", e);
    return null;
  }
}

async function viaDiscordNative(fps: number, height: number): Promise<CaptureResult | null> {
  try {
    const sources = await DiscordNative?.desktopCapture?.getDesktopCaptureSources?.({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 }
    });
    if (!sources?.length) return null;
    const source = sources.find((s: any) => s.id?.startsWith("screen")) ?? sources[0];

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: source.id
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: source.id,
          maxFrameRate: fps,
          maxHeight: height
        }
      }
    } as any).catch(async () => navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: source.id,
          maxFrameRate: fps,
          maxHeight: height
        }
      }
    } as any));

    return { stream, hasAudio: stream.getAudioTracks().length > 0, via: "DiscordNative.desktopCapture" };
  } catch (e) {
    logger.warn("DiscordNative capture failed", e);
    return null;
  }
}

export async function captureScreen(fps: number, height: number): Promise<CaptureResult> {
  const result = (await viaDisplayMedia(fps, height)) ?? (await viaDiscordNative(fps, height));
  if (!result) throw new Error("no screen capture API available");
  logger.info(`captured via ${result.via}, audio=${result.hasAudio}`);
  return result;
}

export function hasLiveAudio(stream: MediaStream) {
  const track = stream.getAudioTracks()[0];
  if (!track) return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let checks = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        if (data.some(v => v !== 128)) {
          ctx.close();
          return resolve(true);
        }
        if (++checks > 20) {
          ctx.close();
          return resolve(false);
        }
        setTimeout(tick, 100);
      };
      tick();
    } catch {
      resolve(false);
    }
  });
}
