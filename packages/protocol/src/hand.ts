// Pure hand-level helpers: positions, key obligations, official cards and pass verification.

import { bytesToBigInt, fromHex, toHex } from "./bytes.ts";
import { DECK_SIZE, canonicalDeck } from "./cards.ts";
import { type Deck, elementToBase64, rekeyPass, shufflePass } from "./deck.ts";
import { type SeedSecrets, cardKey, deriveSecrets } from "./derive.ts";
import { P, modPow } from "./group.ts";
import { merkleProof, merkleRootHex } from "./merkle.ts";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/** Root of the canonical deck, hex. The realm hardcodes the same value. */
export const CANON_ROOT_HEX: string = merkleRootHex(canonicalDeck());

export type DealStep = "hole" | "flop" | "turn" | "river";

function checkN(n: number): void {
  if (!Number.isInteger(n) || n < MIN_PLAYERS || n > MAX_PLAYERS) throw new Error(`invalid player count ${n}`);
}
function checkJ(n: number, j: number): void {
  if (!Number.isInteger(j) || j < 0 || j >= n) throw new Error(`invalid hand index ${j}`);
}

/** Hole positions of hand player j: [2j, 2j+1]. */
export function holePositions(n: number, j: number): [number, number] {
  checkN(n);
  checkJ(n, j);
  return [2 * j, 2 * j + 1];
}
/** All hole positions 0..2n-1. */
export function allHolePositions(n: number): number[] {
  checkN(n);
  return Array.from({ length: 2 * n }, (_, i) => i);
}
/** Board positions 2n..2n+4 (flop, flop, flop, turn, river). */
export function boardPositions(n: number): number[] {
  checkN(n);
  return [0, 1, 2, 3, 4].map((k) => 2 * n + k);
}

/** Positions opened by a deal step. */
export function dealPositions(step: DealStep, n: number): number[] {
  const b = boardPositions(n);
  switch (step) {
    case "hole":
      return allHolePositions(n);
    case "flop":
      return b.slice(0, 3);
    case "turn":
      return [b[3]!];
    case "river":
      return [b[4]!];
  }
}

/** Positions for which hand player j must publish k_{j,i} in this step, ascending. */
export function keysOwed(step: DealStep, n: number, j: number): number[] {
  checkJ(n, j);
  const own = holePositions(n, j);
  return dealPositions(step, n).filter((i) => step !== "hole" || (i !== own[0] && i !== own[1]));
}

/** Deal step for a realm phase name, or null. */
export function dealStepOfPhase(phase: string): DealStep | null {
  switch (phase) {
    case "deal_hole":
      return "hole";
    case "deal_flop":
      return "flop";
    case "deal_turn":
      return "turn";
    case "deal_river":
      return "river";
    default:
      return null;
  }
}

/** deckSeq of shuffle pass j (= j) and rekey pass j (= n + j). */
export function shuffleSeq(j: number): number {
  return j;
}
export function rekeySeq(n: number, j: number): number {
  return n + j;
}
export function totalPasses(n: number): number {
  return 2 * n;
}

/** Card index at every position: idx = i; for j = n-1..0: idx = pi_j[idx]. */
export function officialCards(perms: readonly (readonly number[])[]): number[] {
  return Array.from({ length: DECK_SIZE }, (_, i) => {
    let idx = i;
    for (let j = perms.length - 1; j >= 0; j--) idx = perms[j]![idx]!;
    return idx;
  });
}
export function officialCardsFromSeeds(seeds: readonly Uint8Array[]): number[] {
  return officialCards(seeds.map((s) => deriveSecrets(s).perm));
}

/** Arguments of the realm Challenge call (protocol section 5 and 7). */
export interface ChallengeArgs {
  accused: number;
  kind: "shuffle" | "rekey";
  index: number;
  inB64: string;
  inProofHex: string;
  outB64: string;
  outProofHex: string;
}

export type VerifyResult =
  | { ok: true; passes: Deck[] }
  | { ok: false; kind: "shuffle" | "rekey"; accused: number; index: number; challenge: ChallengeArgs; passes: Deck[] }
  /** A pass is neither recorded nor reconstructible, so no challenge can be built for it. */
  | { ok: false; kind: "missing"; accused: number; seq: number; reason: string };

export interface VerifyInput {
  /** Revealed seeds in hand-index order. */
  seeds: readonly Uint8Array[];
  /** Recorded passes by deckSeq (0..2n-1); entries may be missing. */
  passes: readonly (Deck | undefined | null)[];
  /** On-chain roots by deckSeq, hex. When given, recorded passes are checked against them and
   *  missing passes are reconstructed if the honest recomputation matches the root. */
  roots?: readonly string[];
}

/**
 * Recomputes every pass from the revealed seeds and returns the first mismatching
 * (pass, index) in deckSeq order, with ready-to-send challenge arguments.
 */
export function verifyHand(input: VerifyInput): VerifyResult {
  const n = input.seeds.length;
  checkN(n);
  const secrets: SeedSecrets[] = input.seeds.map((s) => deriveSecrets(s));
  const total = totalPasses(n);
  const passes: Deck[] = [];

  for (let s = 0; s < total; s++) {
    const isShuffle = s < n;
    const j = isShuffle ? s : s - n;
    const prev = s === 0 ? canonicalDeck() : passes[s - 1]!;
    const rootHex = input.roots?.[s];
    let rec = input.passes[s] ?? undefined;
    if (rec && rootHex && merkleRootHex(rec) !== rootHex.toLowerCase()) rec = undefined;
    if (!rec) {
      if (!rootHex) return { ok: false, kind: "missing", accused: j, seq: s, reason: "pass not recorded and no root" };
      const honest = isShuffle ? shufflePass(prev, input.seeds[j]!) : rekeyPass(prev, input.seeds[j]!);
      if (merkleRootHex(honest) !== rootHex.toLowerCase()) {
        return { ok: false, kind: "missing", accused: j, seq: s, reason: "pass not recorded and does not match honest recomputation" };
      }
      rec = honest;
    }
    passes.push(rec);

    const sec = secrets[j]!;
    for (let i = 0; i < DECK_SIZE; i++) {
      let good: boolean;
      let inPos: number;
      if (isShuffle) {
        inPos = sec.perm[i]!;
        good = modPow(prev[inPos]!, sec.e, P) === rec[i];
      } else {
        inPos = i;
        good = modPow(rec[i]!, sec.e, P) === modPow(prev[i]!, sec.keys[i]!, P);
      }
      if (!good) {
        const kind = isShuffle ? "shuffle" : "rekey";
        return {
          ok: false,
          kind,
          accused: j,
          index: i,
          passes,
          challenge: {
            accused: j,
            kind,
            index: i,
            inB64: elementToBase64(prev[inPos]!),
            inProofHex: toHex(merkleProof(prev, inPos)),
            outB64: elementToBase64(rec[i]!),
            outProofHex: toHex(merkleProof(rec, i)),
          },
        };
      }
    }
  }
  return { ok: true, passes };
}

/** Checks that a published card key matches the seed (what the realm does at reveal). */
export function publishedKeyMatches(seed: Uint8Array, position: number, keyHex: string): boolean {
  return bytesToBigInt(fromHex(keyHex)) === cardKey(seed, position);
}

/**
 * Builds Challenge arguments for any (kind, accused, index) from recorded passes (by deckSeq) and
 * the accused's revealed seed, whether or not that element is actually wrong. verifyHand already
 * returns ready arguments for real faults; this is for tooling and tests (e.g. a false challenge).
 */
export function buildChallengeArgs(
  n: number,
  passes: readonly (Deck | undefined | null)[],
  accusedSeed: Uint8Array,
  kind: "shuffle" | "rekey",
  accused: number,
  index: number,
): ChallengeArgs {
  checkN(n);
  checkJ(n, accused);
  if (!Number.isInteger(index) || index < 0 || index >= DECK_SIZE) throw new Error(`invalid index ${index}`);
  const outSeq = kind === "shuffle" ? shuffleSeq(accused) : rekeySeq(n, accused);
  const prev = outSeq === 0 ? canonicalDeck() : passes[outSeq - 1];
  const out = passes[outSeq];
  if (!prev || !out) throw new Error(`passes ${outSeq - 1} and ${outSeq} must be recorded`);
  const inPos = kind === "shuffle" ? deriveSecrets(accusedSeed).perm[index]! : index;
  return {
    accused,
    kind,
    index,
    inB64: elementToBase64(prev[inPos]!),
    inProofHex: toHex(merkleProof(prev, inPos)),
    outB64: elementToBase64(out[index]!),
    outProofHex: toHex(merkleProof(out, index)),
  };
}
