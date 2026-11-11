import { bytesEqual, concatBytes, toHex } from "./bytes.ts";
import { DECK_SIZE } from "./cards.ts";
import { type Deck, elementToBytes } from "./deck.ts";
import { sha256 } from "./hash.ts";

export const MERKLE_LEAVES = 64;
export const MERKLE_DEPTH = 6;
export const PROOF_LEN = MERKLE_DEPTH * 32;

const ZERO32 = new Uint8Array(32);
const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);

export function leafHash(element: bigint): Uint8Array {
  return sha256(LEAF, elementToBytes(element));
}

function nodeHash(l: Uint8Array, r: Uint8Array): Uint8Array {
  return sha256(NODE, l, r);
}

/** All tree levels, leaves first, root last. */
function levels(deck: Deck): Uint8Array[][] {
  if (deck.length !== DECK_SIZE) throw new Error("bad deck size");
  let level: Uint8Array[] = [];
  for (let i = 0; i < MERKLE_LEAVES; i++) level.push(i < DECK_SIZE ? leafHash(deck[i]!) : ZERO32);
  const out = [level];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(nodeHash(level[i]!, level[i + 1]!));
    out.push(next);
    level = next;
  }
  return out;
}

export function merkleRoot(deck: Deck): Uint8Array {
  const ls = levels(deck);
  return ls[ls.length - 1]![0]!;
}
export function merkleRootHex(deck: Deck): string {
  return toHex(merkleRoot(deck));
}

/** 192-byte proof: sibling hashes from the leaf level upward. */
export function merkleProof(deck: Deck, index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index >= DECK_SIZE) throw new Error("bad index");
  const ls = levels(deck);
  const sibs: Uint8Array[] = [];
  let i = index;
  for (let l = 0; l < MERKLE_DEPTH; l++) {
    sibs.push(ls[l]![i ^ 1]!);
    i >>= 1;
  }
  return concatBytes(...sibs);
}

export function verifyMerkleProof(root: Uint8Array, element: bigint, index: number, proof: Uint8Array): boolean {
  if (proof.length !== PROOF_LEN || !Number.isInteger(index) || index < 0 || index >= DECK_SIZE) return false;
  let h = leafHash(element);
  for (let l = 0; l < MERKLE_DEPTH; l++) {
    const sib = proof.subarray(l * 32, (l + 1) * 32);
    h = ((index >> l) & 1) === 0 ? nodeHash(h, sib) : nodeHash(sib, h);
  }
  return bytesEqual(h, root);
}
