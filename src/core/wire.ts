import { decode64, encode64 } from "./codec";

async function through(bytes: Uint8Array, stream: "CompressionStream" | "DecompressionStream") {
  const Ctor = (globalThis as any)[stream];
  if (!Ctor) return bytes;
  const src = new Blob([bytes as BlobPart]).stream().pipeThrough(new Ctor("deflate-raw"));
  return new Uint8Array(await new Response(src).arrayBuffer());
}

export async function packPayload(value: unknown) {
  const raw = new TextEncoder().encode(JSON.stringify(value));
  return encode64(await through(raw, "CompressionStream"));
}

export async function unpackPayload<T>(text: string): Promise<T | null> {
  try {
    const bytes = await through(decode64(text), "DecompressionStream");
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}
