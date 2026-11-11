import { bigIntToBytes, bytesToBigInt, fromBase64, toBase64 } from "./bytes.ts";
import { CARD_LEN, DECK_BYTES, DECK_SIZE, decodeCard } from "./cards.ts";
import { cardKeys, permutation, shuffleKey, shuffleKeyInverse } from "./derive.ts";
import { P, P_MINUS_1, modInverse, modPow } from "./group.ts";

/** A deck is 52 elements of Z_P^*, in position order. */
export type Deck = bigint[];

export function elementToBytes(v: bigint): Uint8Array {
  return bigIntToBytes(v, CARD_LEN);
}
export function elementToBase64(v: bigint): string {
  return toBase64(elementToBytes(v));
}
export function elementFromBase64(s: string): bigint {
  const b = fromBase64(s);
  if (b.length !== CARD_LEN) throw new Error(`element must be ${CARD_LEN} bytes`);
  return bytesToBigInt(b);
}

export function serializeDeck(deck: Deck): Uint8Array {
  if (deck.length !== DECK_SIZE) throw new Error(`deck must have ${DECK_SIZE} elements`);
  const out = new Uint8Array(DECK_BYTES);
  deck.forEach((v, i) => out.set(elementToBytes(v), i * CARD_LEN));
  return out;
}
export function deckToBase64(deck: Deck): string {
  return toBase64(serializeDeck(deck));
}

/** Returns a reason the deck would be rejected by the realm, or null if valid. */
export function deckError(deck: Deck): string | null {
  if (deck.length !== DECK_SIZE) return `deck has ${deck.length} elements, want ${DECK_SIZE}`;
  const seen = new Set<bigint>();
  for (let i = 0; i < deck.length; i++) {
    const v = deck[i]!;
    if (v <= 1n || v >= P) return `element ${i} out of range`;
    if (seen.has(v)) return `element ${i} is a duplicate`;
    seen.add(v);
  }
  return null;
}

/** Parses a 13312-byte deck (bytes or base64). Validates unless `validate` is false. */
export function parseDeck(data: Uint8Array | string, validate = true): Deck {
  const b = typeof data === "string" ? fromBase64(data) : data;
  if (b.length !== DECK_BYTES) throw new Error(`deck must be ${DECK_BYTES} bytes, got ${b.length}`);
  const deck: Deck = [];
  for (let i = 0; i < DECK_SIZE; i++) deck.push(bytesToBigInt(b.subarray(i * CARD_LEN, (i + 1) * CARD_LEN)));
  if (validate) {
    const err = deckError(deck);
    if (err) throw new Error(`invalid deck: ${err}`);
  }
  return deck;
}

export interface ShuffleOptions {
  /**
   * Cheat hook for testing: after the honest pass, output position i takes the element at
   * position extraPerm[i] of the honest output. Never set this in honest clients.
   */
  extraPerm?: readonly number[];
}

/** D_j[i] = D_{j-1}[pi[i]] ^ e mod P. */
export function shufflePass(prev: Deck, seed: Uint8Array, opts: ShuffleOptions = {}): Deck {
  if (prev.length !== DECK_SIZE) throw new Error("bad deck size");
  const e = shuffleKey(seed);
  const pi = permutation(seed);
  const out = pi.map((src) => modPow(prev[src]!, e, P));
  if (opts.extraPerm) {
    const x = opts.extraPerm;
    if (x.length !== DECK_SIZE || new Set(x).size !== DECK_SIZE || x.some((v) => v < 0 || v >= DECK_SIZE)) {
      throw new Error("extraPerm must be a permutation of 0..51");
    }
    return x.map((src) => out[src]!);
  }
  return out;
}

/** R_j[i] = R_{j-1}[i] ^ (d * k_i mod (P-1)) mod P. */
export function rekeyPass(prev: Deck, seed: Uint8Array): Deck {
  if (prev.length !== DECK_SIZE) throw new Error("bad deck size");
  const d = shuffleKeyInverse(seed);
  const ks = cardKeys(seed);
  return prev.map((v, i) => modPow(v, (d * ks[i]!) % P_MINUS_1, P));
}

/**
 * Removes the given card keys from a final-deck element and decodes it.
 * Returns the card index, or null if the result is not one of the 52 encodings.
 */
export function openCard(element: bigint, keys: readonly bigint[]): number | null {
  return decodeCard(unlockElement(element, keys));
}

/** element ^ (prod k^-1 mod (P-1)) mod P. */
export function unlockElement(element: bigint, keys: readonly bigint[]): bigint {
  let inv = 1n;
  for (const k of keys) inv = (inv * modInverse(k, P_MINUS_1)) % P_MINUS_1;
  return modPow(element, inv, P);
}
