// Main and side pots for display while a hand is running. A side pot starts at the contribution of
// each live all-in player (protocol section 4.5); a live player who is not all-in can still match
// any level, so is eligible for every pot. The realm computes the binding split at settlement.

import type { HandState } from "@gno-poker/protocol";

export interface Pot {
  amount: bigint;
  /** Hand indices that can win this pot. */
  eligible: number[];
}

export function computePots(h: Pick<HandState, "players">): Pot[] {
  const live = h.players.filter((p) => !p.folded);
  const max = h.players.reduce((m, p) => (p.contributed > m ? p.contributed : m), 0n);
  // Pots split only at the contribution of an all-in live player; everything else is one pot so far.
  const levels = [...new Set([...live.filter((p) => p.allIn).map((p) => p.contributed), max])]
    .filter((x) => x > 0n)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pots: Pot[] = [];
  let prev = 0n;
  for (const level of levels) {
    let amount = 0n;
    for (const p of h.players) {
      const top = p.contributed < level ? p.contributed : level;
      if (top > prev) amount += top - prev;
    }
    const eligible = live.filter((p) => p.contributed >= level || !p.allIn).map((p) => p.index);
    if (amount > 0n) {
      const before = pots[pots.length - 1];
      if (before && before.eligible.join() === eligible.join()) before.amount += amount;
      else pots.push({ amount, eligible });
    }
    prev = level;
  }
  return pots;
}
