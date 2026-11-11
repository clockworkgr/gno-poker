import { describe, expect, it } from "vitest";
import { canonicalDeck, merkleProof, merkleRoot, newSeed, shufflePass, verifyMerkleProof } from "../src/index.ts";

describe("merkle", () => {
  const deck = shufflePass(canonicalDeck(), newSeed());
  const root = merkleRoot(deck);

  it("every proof verifies", () => {
    for (let i = 0; i < 52; i++) {
      const p = merkleProof(deck, i);
      expect(p.length).toBe(192);
      expect(verifyMerkleProof(root, deck[i]!, i, p)).toBe(true);
    }
  });

  it("tampered proofs, elements, indices and roots fail", () => {
    const p = merkleProof(deck, 9);
    for (const byte of [0, 31, 32, 100, 191]) {
      const t = p.slice();
      t[byte]! ^= 1;
      expect(verifyMerkleProof(root, deck[9]!, 9, t)).toBe(false);
    }
    expect(verifyMerkleProof(root, deck[10]!, 9, p)).toBe(false);
    expect(verifyMerkleProof(root, deck[9]!, 8, p)).toBe(false);
    expect(verifyMerkleProof(root, deck[9]!, 52, p)).toBe(false);
    expect(verifyMerkleProof(root, deck[9]!, 9, p.slice(0, 160))).toBe(false);
    const badRoot = root.slice();
    badRoot[0]! ^= 1;
    expect(verifyMerkleProof(badRoot, deck[9]!, 9, p)).toBe(false);
  });

  it("root changes when any element changes", () => {
    const d2 = deck.slice();
    [d2[3], d2[4]] = [d2[4]!, d2[3]!];
    expect(merkleRoot(d2)).not.toEqual(root);
  });
});
