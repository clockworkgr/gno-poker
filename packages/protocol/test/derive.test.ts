import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CANON_ROOT_HEX, P_HEX, P_MINUS_1, canonicalDeck, cardKeyBytes, commitHex, elementToBytes,
  encodingHex, merkleProof, merkleRootHex, permutation, shuffleKey, shuffleKeyBytes,
  shuffleKeyInverse, shufflePass, toHex,
} from "../src/index.ts";

const seedA = new Uint8Array(32).fill(1);
const seedB = Uint8Array.from({ length: 32 }, (_, i) => i);

describe("derivations", () => {
  it("permutation is a deterministic permutation of 0..51", () => {
    for (const s of [seedA, seedB]) {
      const p = permutation(s);
      expect([...p].sort((a, b) => a - b)).toEqual(Array.from({ length: 52 }, (_, i) => i));
      expect(permutation(s)).toEqual(p);
    }
    expect(permutation(seedA)).not.toEqual(permutation(seedB));
  });

  it("keys have the two bit tweaks and e is invertible mod P-1", () => {
    for (const s of [seedA, seedB]) {
      const e = shuffleKeyBytes(s);
      expect(e[0]! & 0x80).toBe(0x80);
      expect(e[31]! & 1).toBe(1);
      const k = cardKeyBytes(s, 7);
      expect(k[0]! & 0x80).toBe(0x80);
      expect(k[31]! & 1).toBe(1);
      expect((shuffleKey(s) * shuffleKeyInverse(s)) % P_MINUS_1).toBe(1n);
    }
  });

  it("rejects bad seeds and positions", () => {
    expect(() => commitHex(new Uint8Array(31))).toThrow();
    expect(() => cardKeyBytes(seedA, 52)).toThrow();
  });

  it("matches the committed cross-language vectors", () => {
    const v = JSON.parse(readFileSync(new URL("../../../vectors/vectors.json", import.meta.url), "utf8"));
    expect(v.P).toBe(P_HEX.toLowerCase());
    expect(v.CANON_ROOT).toBe(CANON_ROOT_HEX);
    expect(v.CANON_ROOT).toBe(merkleRootHex(canonicalDeck()));
    expect(v.m0).toBe(encodingHex(0));
    expect(v.m51).toBe(encodingHex(51));
    for (const [name, s] of [["seedA", seedA], ["seedB", seedB]] as const) {
      expect(v[name].commit).toBe(commitHex(s));
      expect(v[name].shuffleKey).toBe(toHex(shuffleKeyBytes(s)));
      expect(v[name].cardKey0).toBe(toHex(cardKeyBytes(s, 0)));
      expect(v[name].cardKey51).toBe(toHex(cardKeyBytes(s, 51)));
      expect(v[name].permutation).toEqual(permutation(s));
    }
    const d = shufflePass(canonicalDeck(), seedA);
    expect(v.shufflePassCanonicalA.root).toBe(merkleRootHex(d));
    expect(v.shufflePassCanonicalA.proofIndex7).toBe(toHex(merkleProof(d, 7)));
    expect(v.shufflePassCanonicalA.first).toBe(toHex(elementToBytes(d[0]!)));
    expect(v.shufflePassCanonicalA.last).toBe(toHex(elementToBytes(d[51]!)));
  });
});
