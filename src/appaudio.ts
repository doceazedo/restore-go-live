import { Logger } from "@utils/Logger";

import { Native } from "./bridge";
import { sourceParts } from "./core/sources";

const logger = new Logger("P2PShare:appaudio");

declare const DiscordNative: any;

function discordUtils() {
  try {
    return DiscordNative?.nativeModules?.requireModule?.("discord_utils") ?? null;
  } catch (e) {
    logger.warn("discord_utils is unavailable", e);
    return null;
  }
}

export function audioPidOf(sourceId: string | null) {
  const { type, handle } = sourceParts(sourceId ?? "");
  if (type !== "window" || !handle) return null;

  const utils = discordUtils();
  const pid = utils?.getPidFromWindowHandle?.(handle);
  if (typeof pid !== "number" || pid <= 1) {
    logger.warn(`no process owns window handle ${handle}`);
    return null;
  }

  const audioPid = utils?.getAudioPid?.(pid);
  if (typeof audioPid === "number" && audioPid > 1 && audioPid !== pid) {
    logger.info(`window ${handle} runs as pid ${pid}, its audio comes from pid ${audioPid}`);
    return audioPid;
  }
  return pid;
}

const LEAD_SECONDS = 0.08;

function decode(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

function toBuffer(ctx: AudioContext, samples: Int16Array, channels: number) {
  const frames = Math.floor(samples.length / channels);
  const buffer = ctx.createBuffer(channels, frames, ctx.sampleRate);
  for (let channel = 0; channel < channels; channel++) {
    const target = buffer.getChannelData(channel);
    for (let frame = 0; frame < frames; frame++) {
      target[frame] = samples[frame * channels + channel] / 32768;
    }
  }
  return buffer;
}

export async function appAudioTrack(sourceId: string) {
  if (!IS_DISCORD_DESKTOP) return null;

  const pid = audioPidOf(sourceId);
  if (!pid) return null;

  const started = await Native.startAppAudio(pid);
  if (!started?.ok) {
    logger.warn(`could not capture pid ${pid}: ${started?.error}`);
    return null;
  }

  const ctx = new AudioContext({ sampleRate: started.sampleRate });
  const destination = ctx.createMediaStreamDestination();
  const track = destination.stream.getAudioTracks()[0] ?? null;
  if (!track) {
    void Native.stopAppAudio();
    void ctx.close();
    return null;
  }

  let playAt = 0;
  let starved = 0;

  const pump = async () => {
    while (track.readyState === "live") {
      const chunk = await Native.readAppAudio();
      if (!chunk?.ok) {
        logger.warn(`application audio stopped: ${chunk?.error}`);
        break;
      }
      if (!chunk.data) {
        starved++;
        continue;
      }

      const buffer = toBuffer(ctx, decode(chunk.data), started.channels);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);

      const now = ctx.currentTime;
      if (playAt < now + 0.01) playAt = now + LEAD_SECONDS;
      source.start(playAt);
      playAt += buffer.duration;
    }

    logger.info(`application audio ended after ${starved} idle polls`);
    await Native.stopAppAudio();
    void ctx.close();
  };

  void pump();
  logger.info(`streaming audio of pid ${pid} at ${started.sampleRate}hz`);
  return track;
}
