// Byte helpers that work in Node and in browsers (no Buffer).

const HEX = "0123456789abcdef";

export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    const v = b[i]!;
    s += HEX[v >> 4]! + HEX[v & 15]!;
  }
  return s;
}

export function fromHex(h: string): Uint8Array {
  if (h.startsWith("0x") || h.startsWith("0X")) h = h.slice(2);
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INV: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Standard base64 with padding. */
export function toBase64(b: Uint8Array): string {
  let s = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    s += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rem = b.length - i;
  if (rem === 1) {
    const n = b[i]! << 16;
    s += B64[n >> 18]! + B64[(n >> 12) & 63]! + "==";
  } else if (rem === 2) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8);
    s += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + "=";
  }
  return s;
}

/** Strict standard base64 decoding (padding required). */
export function fromBase64(s: string): Uint8Array {
  if (s.length % 4 !== 0) throw new Error("invalid base64 length");
  let pad = 0;
  if (s.endsWith("==")) pad = 2;
  else if (s.endsWith("=")) pad = 1;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const c = s.charCodeAt(i + k);
      let v: number;
      if (c === 61 /* = */ && i + 4 === s.length && k >= 4 - pad) v = 0;
      else {
        v = c < 128 ? B64_INV[c]! : -1;
        if (v < 0) throw new Error("invalid base64 character");
      }
      n = (n << 6) | v;
    }
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function bytesToBigInt(b: Uint8Array): bigint {
  return b.length === 0 ? 0n : BigInt("0x" + toHex(b));
}

/** Big-endian, left-padded to exactly `len` bytes. Throws if the value does not fit. */
export function bigIntToBytes(x: bigint, len: number): Uint8Array {
  if (x < 0n) throw new Error("negative value");
  const h = x.toString(16);
  if (h.length > len * 2) throw new Error(`value does not fit in ${len} bytes`);
  return fromHex(h.padStart(len * 2, "0"));
}

export function u32be(x: number): Uint8Array {
  return new Uint8Array([(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255]);
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}
