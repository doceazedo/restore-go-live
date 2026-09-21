import { Logger } from "@utils/Logger";

import { MediaEngineStore, RunningGameStore, subscribe } from "./discord";

const logger = new Logger("P2PShare:source");

const SOURCE_ID = /^(?:screen|window):/;
const ID_KEYS = ["sourceId", "desktopSourceId", "id"];
const NAME_KEYS = ["sourceName", "desktopDescription", "name"];
const SOUND_KEYS = ["sound", "desktopAudio", "withSound"];

export interface GoLiveSource {
  id: string | null;
  name: string | null;
  sound: boolean;
}

let lastSeen: GoLiveSource | null = null;

function soundOf(holder: any) {
  for (const key of SOUND_KEYS) {
    if (typeof holder[key] === "boolean") return holder[key];
  }
  return true;
}

function nameOf(holder: any) {
  for (const key of NAME_KEYS) {
    const value = holder[key];
    if (typeof value === "string" && value && !SOURCE_ID.test(value)) return value;
  }
  return null;
}

function found(id: string, holder: any): GoLiveSource {
  return { id, name: nameOf(holder), sound: soundOf(holder) };
}

function pluck(value: any, depth = 3): GoLiveSource | null {
  if (!value || typeof value !== "object" || depth < 0) return null;

  for (const key of ID_KEYS) {
    const candidate = value[key];
    if (typeof candidate === "string" && SOURCE_ID.test(candidate)) return found(candidate, value);
  }
  for (const candidate of Object.values(value)) {
    if (typeof candidate === "string" && SOURCE_ID.test(candidate)) return found(candidate, value);
  }
  for (const nested of Object.values(value)) {
    const hit = pluck(nested, depth - 1);
    if (hit) return hit;
  }
  return null;
}

function fromPid(value: any) {
  const pid = typeof value?.pid === "number" ? value.pid : null;
  if (pid == null) return null;

  try {
    const game = RunningGameStore?.getGameForPID?.(pid);
    if (game?.windowHandle == null) {
      logger.warn(`no window handle for pid ${pid}`);
      return null;
    }
    return { id: `window:${game.windowHandle}`, name: game.name ?? null, sound: soundOf(value) };
  } catch (e) {
    logger.warn("could not resolve the shared application window", e);
    return null;
  }
}

function fromStore() {
  try {
    return pluck(MediaEngineStore?.getGoLiveSource?.());
  } catch (e) {
    logger.warn("could not read the go live source from the store", e);
    return null;
  }
}

export function watchGoLiveSource() {
  return subscribe("MEDIA_ENGINE_SET_GO_LIVE_SOURCE", (action: any) => {
    const picked = pluck(action);
    if (!picked) return;
    lastSeen = picked;
    logger.info(`picker selected ${picked.name ?? picked.id} sound=${picked.sound}`);
  });
}

export function goLiveSource(opts?: any): GoLiveSource {
  const picked = pluck(opts) ?? fromPid(opts) ?? fromStore() ?? lastSeen;
  if (!picked) {
    logger.warn("could not tell which source was picked, falling back to the primary screen");
    return { id: null, name: null, sound: true };
  }
  logger.info(`sharing ${picked.name ?? "?"} (${picked.id}) sound=${picked.sound}`);
  return picked;
}
