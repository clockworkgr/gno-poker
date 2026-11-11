import { bytesToBigInt, toHex, u32be, utf8 } from "./bytes.ts";
import { DECK_SIZE } from "./cards.ts";
import { P_MINUS_1, modInverse } from "./group.ts";
import { sha256 } from "./hash.ts";

export const SEED_LEN = 32;

const TAG_COMMIT = utf8("gno-poker/commit/v1");
const TAG_SHUFKEY = utf8("gno-poker/shufkey/v1");
const TAG_CARDKEY = utf8("gno-poker/cardkey/v1");
const TAG_PERM = utf8("gno-poker/perm/v1");

function checkSeed(seed: Uint8Array): void {
  if (seed.length !== SEED_LEN) throw new Error(`seed must be ${SEED_LEN} bytes`);
}

function tweak(h: Uint8Array): Uint8Array {
  const k = h.slice();
  k[0]! |= 0x80;
  k[31]! |= 0x01;
  return k;
}

export function newSeed(): Uint8Array {
  const s = new Uint8Array(SEED_LEN);
  globalThis.crypto.getRandomValues(s);
  return s;
}

/** commit = H("gno-poker/commit/v1" || seed). */
export function commitOf(seed: Uint8Array): Uint8Array {
  checkSeed(seed);
  return sha256(TAG_COMMIT, seed);
}
export function commitHex(seed: Uint8Array): string {
  return toHex(commitOf(seed));
}

/** Shuffle key e as 32 bytes (top bit and low bit set). */
export function shuffleKeyBytes(seed: Uint8Array): Uint8Array {
  checkSeed(seed);
  return tweak(sha256(TAG_SHUFKEY, seed));
}
export function shuffleKey(seed: Uint8Array): bigint {
  return bytesToBigInt(shuffleKeyBytes(seed));
}
/** d = e^-1 mod (P-1). */
export function shuffleKeyInverse(seed: Uint8Array): bigint {
  return modInverse(shuffleKey(seed), P_MINUS_1);
}

/** Card key k_i as 32 bytes. */
export function cardKeyBytes(seed: Uint8Array, i: number): Uint8Array {
  checkSeed(seed);
  if (!Number.isInteger(i) || i < 0 || i >= DECK_SIZE) throw new Error(`invalid position ${i}`);
  return tweak(sha256(TAG_CARDKEY, seed, new Uint8Array([i])));
}
export function cardKey(seed: Uint8Array, i: number): bigint {
  return bytesToBigInt(cardKeyBytes(seed, i));
}
export function cardKeys(seed: Uint8Array): bigint[] {
  return Array.from({ length: DECK_SIZE }, (_, i) => cardKey(seed, i));
}

/** Fisher-Yates permutation driven by the sha256 counter stream (protocol section 2). */
export function permutation(seed: Uint8Array): number[] {
  checkSeed(seed);
  const a = Array.from({ length: DECK_SIZE }, (_, i) => i);
  let ctr = 0;
  let block: Uint8Array = new Uint8Array(0);
  let off = 0;
  const nextWord = (): number => {
    if (off >= block.length) {
      block = sha256(TAG_PERM, seed, u32be(ctr++));
      off = 0;
    }
    const w = ((block[off]! << 24) | (block[off + 1]! << 16) | (block[off + 2]! << 8) | block[off + 3]!) >>> 0;
    off += 4;
    return w;
  };
  for (let i = DECK_SIZE - 1; i >= 1; i--) {
    const n = i + 1;
    const limit = Math.floor(2 ** 32 / n) * n;
    let x = nextWord();
    while (x >= limit) x = nextWord();
    const j = x % n;
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

/** Everything derived from one seed, computed once. */
export interface SeedSecrets {
  seed: Uint8Array;
  commit: Uint8Array;
  e: bigint;
  d: bigint;
  perm: number[];
  keys: bigint[];
}

export function deriveSecrets(seed: Uint8Array): SeedSecrets {
  return {
    seed,
    commit: commitOf(seed),
    e: shuffleKey(seed),
    d: shuffleKeyInverse(seed),
    perm: permutation(seed),
    keys: cardKeys(seed),
  };
}
