// Misbehaviour for the security tests. Never enable any of this against real players.

import type { CheatHooks, Deck } from "@gno-poker/protocol";

export type CheatKind = "last-shuffler" | "bad-rekey" | "wrong-card-key";
export const CHEAT_KINDS: readonly CheatKind[] = ["last-shuffler", "bad-rekey", "wrong-card-key"];

/** Protocol step a staller stops at. */
export type StallStep = "bet" | "shuffle" | "rekey" | "keys" | "reveal";
export const STALL_STEPS: readonly StallStep[] = ["bet", "shuffle", "rekey", "keys", "reveal"];

/**
 * Last-shuffler attack (spec "Security"): the last shuffler applies an extra permutation after its
 * honest pass. Rekeying does not move cards, so honest output position p carries the official card
 * of position p. Sending the victim's hole positions to our own hole positions lets us open the
 * victim's official hole cards (what the realm will use at showdown); the victim is dealt two
 * undealt cards (positions 50, 51) instead, and our official cards go there.
 */
export function lastShufflerPerm(n: number, me: number, victim: number): number[] {
  const x = Array.from({ length: 52 }, (_, i) => i);
  const [m0, m1, v0, v1] = [2 * me, 2 * me + 1, 2 * victim, 2 * victim + 1];
  x[m0] = v0;
  x[m1] = v1;
  x[v0] = 50;
  x[v1] = 51;
  x[50] = m0;
  x[51] = m1;
  if (2 * n + 5 > 50) throw new Error("board would overlap the swap positions");
  return x;
}

export interface CheatOptions {
  /** Hand numbers the cheat applies to (default: every hand where it is possible). */
  onlyHand?: (handNo: number) => boolean;
  /** Called when the cheat is applied, for logging. */
  onApply?: (what: string) => void;
}

export function cheatHooks(kind: CheatKind, opts: CheatOptions = {}): CheatHooks {
  const when = opts.onlyHand ?? (() => true);
  switch (kind) {
    case "last-shuffler":
      return {
        shuffleExtraPerm: (ctx) => {
          if (ctx.myIndex !== ctx.n - 1 || !when(ctx.handNo)) return null;
          const victim = 0;
          opts.onApply?.(`hand ${ctx.handNo}: last-shuffler swap, my hole positions take player ${victim}'s official cards`);
          return lastShufflerPerm(ctx.n, ctx.myIndex, victim);
        },
      };
    case "bad-rekey":
      return {
        tamperRekey: (ctx, honest: Deck) => {
          if (!when(ctx.handNo)) return null;
          opts.onApply?.(`hand ${ctx.handNo}: bad rekey, swapping output elements 0 and 1`);
          const d = honest.slice();
          [d[0], d[1]] = [d[1]!, d[0]!];
          return d;
        },
      };
    case "wrong-card-key":
      return {
        tamperCardKeys: (ctx, positions, honest) => {
          if (ctx.step !== "hole" || !when(ctx.handNo) || honest.length === 0) return null;
          opts.onApply?.(`hand ${ctx.handNo}: publishing a wrong key for position ${positions[0]}`);
          const keys = honest.slice();
          keys[0] = keys[0]! ^ 2n; // still odd and 256-bit, but not k_i
          return keys;
        },
      };
  }
}
