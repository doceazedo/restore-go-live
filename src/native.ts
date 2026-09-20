import { IpcMainInvokeEvent, session } from "electron";

let installed = false;

export async function enableLoopbackAudio(_: IpcMainInvokeEvent) {
  if (installed) return { ok: true, already: true };
  try {
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        callback({ video: undefined, audio: "loopback", enableLocalEcho: false } as any);
      },
      { useSystemPicker: true }
    );
    installed = true;
    return { ok: true, already: false };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function disableLoopbackAudio(_: IpcMainInvokeEvent) {
  if (!installed) return { ok: true };
  try {
    session.defaultSession.setDisplayMediaRequestHandler(null as any);
    installed = false;
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
