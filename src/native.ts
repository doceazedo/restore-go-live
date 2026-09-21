import { DesktopCapturerSource, desktopCapturer, IpcMainInvokeEvent, session } from "electron";

import { matchSource, sameSource } from "./core/sources";

export interface SourceInfo {
  id: string;
  name: string;
  display_id?: string;
}

export interface PinnedSource {
  ok: boolean;
  wanted: string | null;
  matched?: boolean;
  resolved?: string | null;
  name?: string | null;
  candidates?: SourceInfo[];
  error?: string;
}

let installed = false;
let preferred: string | null = null;

function loopbackSupported() {
  return process.platform === "win32" || process.platform === "linux";
}

function describe(sources: DesktopCapturerSource[]): SourceInfo[] {
  return sources.map(s => ({ id: s.id, name: s.name, display_id: s.display_id }));
}

function allSources() {
  return desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 0, height: 0 }
  });
}

async function resolveSource(id: string | null): Promise<DesktopCapturerSource | null> {
  return matchSource(await allSources(), id);
}

export async function enableLoopbackAudio(_: IpcMainInvokeEvent) {
  if (installed) return { ok: true, already: true, platform: process.platform };

  try {
    const useSystemPicker = process.platform === "darwin";

    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        resolveSource(preferred)
          .then(source => callback({
            video: source ?? undefined,
            audio: loopbackSupported() ? "loopback" : undefined,
            enableLocalEcho: false
          }))
          .catch(() => callback({}));
      },
      { useSystemPicker }
    );

    installed = true;
    return {
      ok: true,
      already: false,
      platform: process.platform,
      useSystemPicker,
      loopback: loopbackSupported()
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e), platform: process.platform };
  }
}

export async function listSources(_: IpcMainInvokeEvent): Promise<SourceInfo[]> {
  return describe(await allSources());
}

export async function preferSource(_: IpcMainInvokeEvent, id: string | null): Promise<PinnedSource> {
  preferred = typeof id === "string" && id.length ? id : null;
  if (!installed) return { ok: false, error: "display media handler not installed", wanted: preferred };

  try {
    const sources = await allSources();
    const source = matchSource(sources, preferred);
    const matched = !preferred || (!!source && sameSource(source, preferred));
    return {
      ok: true,
      wanted: preferred,
      matched,
      resolved: source?.id ?? null,
      name: source?.name ?? null,
      candidates: matched ? undefined : describe(sources)
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e), wanted: preferred };
  }
}

export async function disableLoopbackAudio(_: IpcMainInvokeEvent) {
  preferred = null;
  if (!installed) return { ok: true };
  try {
    session.defaultSession.setDisplayMediaRequestHandler(null);
    installed = false;
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
