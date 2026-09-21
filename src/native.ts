import { ChildProcess, execFileSync, spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { DesktopCapturerSource, desktopCapturer, IpcMainInvokeEvent, session } from "electron";

import { matchSource, sameSource } from "./core/sources";
import { PROCESS_AUDIO_CAPTURE } from "./csharp";

const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;

const MAX_BUFFERED = AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * 2 * 2;

let capture: ChildProcess | null = null;
let captured: Buffer[] = [];
let capturedBytes = 0;
let captureError: string | null = null;
let wake: (() => void) | null = null;

function compiler() {
  const root = process.env.WINDIR ?? "C:\Windows";
  const candidates = ["v4.0.30319", "v3.5"];
  for (const version of candidates) {
    const exe = join(root, "Microsoft.NET", "Framework64", version, "csc.exe");
    if (existsSync(exe)) return exe;
  }
  return null;
}

function helper() {
  const fingerprint = createHash("sha1").update(PROCESS_AUDIO_CAPTURE).digest("hex").slice(0, 12);
  const dir = join(tmpdir(), "restore-go-live");
  mkdirSync(dir, { recursive: true });
  return {
    exe: join(dir, `ProcessAudioCapture-${fingerprint}.exe`),
    source: join(dir, `ProcessAudioCapture-${fingerprint}.cs`)
  };
}

function buildHelper() {
  const { exe, source } = helper();
  if (existsSync(exe)) return exe;

  const csc = compiler();
  if (!csc) throw new Error("csc.exe not found, the .NET Framework is required");

  writeFileSync(source, PROCESS_AUDIO_CAPTURE, "utf8");
  execFileSync(csc, ["-nologo", "-optimize+", "-platform:x64", `-out:${exe}`, source], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  return exe;
}

function stopCapture() {
  captured = [];
  capturedBytes = 0;
  wake?.();
  wake = null;
  if (!capture) return;
  const dying = capture;
  capture = null;
  try {
    dying.stdin?.end();
    dying.kill();
  } catch {
    // the helper is already gone
  }
}

function drain() {
  const data = Buffer.concat(captured, capturedBytes);
  captured = [];
  capturedBytes = 0;
  return data.toString("base64");
}

export interface SourceInfo {
  id: string;
  name: string;
  display_id?: string;
}

export type SourceRoute = "listed" | "fallback" | "none";

export interface PinnedSource {
  ok: boolean;
  wanted: string | null;
  route?: SourceRoute;
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

async function resolveSource(id: string | null) {
  const sources = await allSources();

  const listed = id ? sources.find(s => sameSource(s, id)) : null;
  if (listed) return { source: listed, route: "listed" as SourceRoute, sources };

  const fallback = matchSource(sources, null);
  return { source: fallback, route: (fallback ? "fallback" : "none") as SourceRoute, sources };
}

export async function enableLoopbackAudio(_: IpcMainInvokeEvent) {
  if (installed) return { ok: true, already: true, platform: process.platform };

  try {
    const useSystemPicker = process.platform === "darwin";

    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        resolveSource(preferred)
          .then(({ source }) => callback({
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
    const { source, route, sources } = await resolveSource(preferred);
    return {
      ok: true,
      wanted: preferred,
      route,
      resolved: source?.id ?? null,
      name: source?.name ?? null,
      candidates: route === "fallback" ? describe(sources) : undefined
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e), wanted: preferred };
  }
}

export async function startAppAudio(_: IpcMainInvokeEvent, pid: number) {
  stopCapture();
  captureError = null;

  if (process.platform !== "win32") {
    return { ok: false, error: "per application audio is only implemented on windows" };
  }
  if (!Number.isInteger(pid) || pid <= 1) {
    return { ok: false, error: `${pid} is not a capturable process id` };
  }

  let exe: string;
  try {
    exe = buildHelper();
  } catch (e: any) {
    return { ok: false, error: `could not build the audio helper: ${String(e?.message ?? e)}` };
  }

  try {
    const child = spawn(exe, [String(pid), "--watch-stdin"], { stdio: ["pipe", "pipe", "pipe"] });
    capture = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (capture !== child) return;
      captured.push(chunk);
      capturedBytes += chunk.length;
      while (capturedBytes > MAX_BUFFERED && captured.length > 1) {
        capturedBytes -= captured.shift()!.length;
      }
      wake?.();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = String(chunk).trim();
      if (text.startsWith("error:")) captureError = text.slice(6).trim();
    });

    child.on("exit", code => {
      if (capture !== child) return;
      capture = null;
      if (captureError == null && code !== 0) captureError = `audio helper exited with code ${code}`;
      wake?.();
    });

    return { ok: true, pid, sampleRate: AUDIO_SAMPLE_RATE, channels: AUDIO_CHANNELS };
  } catch (e: any) {
    stopCapture();
    return { ok: false, error: `could not start the audio helper: ${String(e?.message ?? e)}` };
  }
}

export async function readAppAudio(_: IpcMainInvokeEvent, waitMs = 250) {
  if (capturedBytes > 0) return { ok: true, data: drain() };
  if (!capture) return { ok: false, error: captureError ?? "no capture is running" };

  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, waitMs);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });

  if (capturedBytes > 0) return { ok: true, data: drain() };
  if (!capture) return { ok: false, error: captureError ?? "the audio helper stopped" };
  return { ok: true, data: "" };
}

export async function stopAppAudio(_: IpcMainInvokeEvent) {
  stopCapture();
  return { ok: true };
}

export async function disableLoopbackAudio(_: IpcMainInvokeEvent) {
  stopCapture();
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
