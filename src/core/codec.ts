const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export class Writer {
  private bytes: number[] = [];

  u8(v: number) {
    this.bytes.push(v & 0xff);
    return this;
  }

  u16(v: number) {
    this.bytes.push((v >> 8) & 0xff, v & 0xff);
    return this;
  }

  u32(v: number) {
    this.bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }

  u48(v: number) {
    const hi = Math.floor(v / 0x100000000);
    this.u16(hi);
    this.u32(v >>> 0);
    return this;
  }

  raw(v: Uint8Array) {
    for (const b of v) this.bytes.push(b);
    return this;
  }

  str(v: string) {
    const encoded = new TextEncoder().encode(v);
    if (encoded.length > 255) throw new Error("string too long");
    this.u8(encoded.length).raw(encoded);
    return this;
  }

  hex(v: string) {
    const clean = v.replace(/[^0-9a-fA-F]/g, "");
    for (let i = 0; i < clean.length; i += 2) this.bytes.push(parseInt(clean.slice(i, i + 2), 16));
    return this;
  }

  finish() {
    return new Uint8Array(this.bytes);
  }
}

export class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  u8() {
    return this.bytes[this.offset++];
  }

  u16() {
    return (this.u8() << 8) | this.u8();
  }

  u32() {
    return ((this.u8() << 24) >>> 0) + (this.u8() << 16) + (this.u8() << 8) + this.u8();
  }

  u48() {
    return this.u16() * 0x100000000 + this.u32();
  }

  raw(len: number) {
    const out = this.bytes.slice(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }

  str() {
    return new TextDecoder().decode(this.raw(this.u8()));
  }

  hex(len: number) {
    return [...this.raw(len)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  get done() {
    return this.offset >= this.bytes.length;
  }
}

export function encode64(bytes: Uint8Array) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += ALPHABET[c & 63];
  }
  return out;
}

export function decode64(text: string) {
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function ipv4ToBytes(ip: string) {
  return new Uint8Array(ip.split(".").map(Number));
}

export function bytesToIpv4(bytes: Uint8Array) {
  return [...bytes].join(".");
}

export function ipv6ToBytes(ip: string) {
  const [head, tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = new Array(8 - left.length - right.length).fill("0");
  const groups = tail === undefined ? left : [...left, ...fill, ...right];
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    const v = parseInt(g || "0", 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  });
  return out;
}

export function bytesToIpv6(bytes: Uint8Array) {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return groups.join(":").replace(/(^|:)(0:)+/, "::").replace(/:{3,}/, "::");
}
