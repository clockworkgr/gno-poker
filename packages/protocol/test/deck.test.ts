import { describe, expect, it } from "vitest";
import {
  CARD_ENCODINGS, DECK_BYTES, P, P_MINUS_1, canonicalDeck, cardKeys, deckError, deckToBase64,
  decodeCard, fromBase64, modPow, openCard, parseDeck, permutation, rekeyPass, serializeDeck,
  shuffleKey, shuffleKeyInverse, shufflePass, toBase64, newSeed,
} from "../src/index.ts";

describe("deck", () => {
  it("serializes to 13312 bytes and round-trips through base64", () => {
    const d = shufflePass(canonicalDeck(), newSeed());
    const bytes = serializeDeck(d);
    expect(bytes.length).toBe(DECK_BYTES);
    expect(DECK_BYTES).toBe(13312);
    const b64 = deckToBase64(d);
    expect(fromBase64(b64)).toEqual(bytes);
    expect(parseDeck(b64)).toEqual(d);
    expect(parseDeck(bytes)).toEqual(d);
  });

  it("base64 matches the platform encoder", () => {
    for (const len of [0, 1, 2, 3, 4, 5, 100]) {
      const b = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255);
      const ref = btoa(String.fromCharCode(...b));
      expect(toBase64(b)).toBe(ref);
      expect(fromBase64(ref)).toEqual(b);
    }
    expect(() => fromBase64("abc")).toThrow();
    expect(() => fromBase64("ab$=")).toThrow();
  });

  it("validation rejects bad sizes, out-of-range and duplicate elements", () => {
    const d = canonicalDeck();
    expect(deckError(d)).toBeNull();
    expect(deckError(d.slice(1))).toMatch(/elements/);
    expect(deckError([1n, ...d.slice(1)])).toMatch(/range/);
    expect(deckError([P, ...d.slice(1)])).toMatch(/range/);
    expect(deckError([d[1]!, ...d.slice(1)])).toMatch(/duplicate/);
    expect(() => parseDeck(new Uint8Array(100))).toThrow();
    const dup = serializeDeck([d[1]!, ...d.slice(1)]);
    expect(() => parseDeck(dup)).toThrow(/duplicate/);
    expect(parseDeck(dup, false).length).toBe(52);
  });

  it("SRA encryption commutes", () => {
    const a = shuffleKey(newSeed());
    const b = shuffleKey(newSeed());
    for (const m of CARD_ENCODINGS.slice(0, 5)) {
      expect(modPow(modPow(m, a, P), b, P)).toBe(modPow(modPow(m, b, P), a, P));
    }
  });

  it("shuffle pass follows the permutation and decrypts with d", () => {
    const s = newSeed();
    const d = shufflePass(canonicalDeck(), s);
    const pi = permutation(s);
    const inv = shuffleKeyInverse(s);
    d.forEach((v, i) => expect(decodeCard(modPow(v, inv, P))).toBe(pi[i]));
  });

  it("shuffle then rekey leaves m^k at every position", () => {
    const s = newSeed();
    const f = rekeyPass(shufflePass(canonicalDeck(), s), s);
    const ks = cardKeys(s);
    const pi = permutation(s);
    f.forEach((v, i) => {
      expect(v).toBe(modPow(CARD_ENCODINGS[pi[i]!]!, ks[i]!, P));
      expect(openCard(v, [ks[i]!])).toBe(pi[i]);
    });
    expect(openCard(f[0]!, [ks[1]!])).toBeNull();
    expect((ks[0]! * 1n) % P_MINUS_1).toBe(ks[0]);
  });

  it("extraPerm must be a permutation", () => {
    expect(() => shufflePass(canonicalDeck(), newSeed(), { extraPerm: [0, 0] })).toThrow();
  });
});
