// Writes vectors/vectors.json at the repo root: cross-language test vectors for the gno side.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANON_ROOT_HEX, P_HEX, canonicalDeck, cardKeyBytes, commitOf, elementToBytes, encodingHex,
  merkleProof, merkleRootHex, permutation, shuffleKeyBytes, shufflePass, toHex,
} from "../src/index.ts";

const seedA = new Uint8Array(32).fill(0x01);
const seedB = Uint8Array.from({ length: 32 }, (_, i) => i);

function seedVectors(seed: Uint8Array) {
  return {
    seed: toHex(seed),
    commit: toHex(commitOf(seed)),
    shuffleKey: toHex(shuffleKeyBytes(seed)),
    cardKey0: toHex(cardKeyBytes(seed, 0)),
    cardKey51: toHex(cardKeyBytes(seed, 51)),
    permutation: permutation(seed),
  };
}

const deckA = shufflePass(canonicalDeck(), seedA);
const vectors = {
  description: "gno-poker protocol v1 vectors (docs/protocol.md). All byte strings lowercase hex.",
  P: P_HEX.toLowerCase(),
  CANON_ROOT: CANON_ROOT_HEX,
  m0: encodingHex(0),
  m51: encodingHex(51),
  seedA: seedVectors(seedA),
  seedB: seedVectors(seedB),
  shufflePassCanonicalA: {
    root: merkleRootHex(deckA),
    proofIndex7: toHex(merkleProof(deckA, 7)),
    element7: toHex(elementToBytes(deckA[7]!)),
    first: toHex(elementToBytes(deckA[0]!)),
    last: toHex(elementToBytes(deckA[51]!)),
  },
};

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../../vectors/vectors.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote ${out}`);
