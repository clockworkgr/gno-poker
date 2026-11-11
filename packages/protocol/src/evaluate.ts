// Best-five-of-seven evaluation for display and bot decisions.

import { RANK_NAMES, cardRank, cardSuit } from "./cards.ts";

export const HAND_CATEGORIES = [
  "High card",
  "One pair",
  "Two pair",
  "Three of a kind",
  "Straight",
  "Flush",
  "Full house",
  "Four of a kind",
  "Straight flush",
] as const;
export type HandCategory = (typeof HAND_CATEGORIES)[number];

export interface HandValue {
  /** Higher is better; equal scores tie. */
  score: number;
  /** 0 = high card .. 8 = straight flush. */
  category: number;
  name: HandCategory;
  /** Ranks (0 = Two .. 12 = Ace) that decide ties, most significant first. */
  tiebreak: number[];
  /** The five cards used. */
  cards: number[];
  description: string;
}

function packScore(category: number, tb: number[]): number {
  let s = category;
  for (let k = 0; k < 5; k++) s = s * 16 + (tb[k] ?? 0);
  return s;
}

/** Evaluates exactly five cards. */
export function evaluateFive(cards: readonly number[]): HandValue {
  if (cards.length !== 5) throw new Error("need 5 cards");
  const ranks = cards.map(cardRank).sort((a, b) => b - a);
  const flush = cards.every((c) => cardSuit(c) === cardSuit(cards[0]!));
  const uniq = [...new Set(ranks)];
  let straightHigh = -1;
  if (uniq.length === 5) {
    if (ranks[0]! - ranks[4]! === 4) straightHigh = ranks[0]!;
    else if (ranks[0] === 12 && ranks[1] === 3) straightHigh = 3; // A-2-3-4-5
  }
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // Groups ordered by size, then rank.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const byGroup = groups.map((g) => g[0]);
  let category: number;
  let tb: number[];
  if (straightHigh >= 0 && flush) [category, tb] = [8, [straightHigh]];
  else if (groups[0]![1] === 4) [category, tb] = [7, byGroup];
  else if (groups[0]![1] === 3 && groups[1]![1] === 2) [category, tb] = [6, byGroup];
  else if (flush) [category, tb] = [5, ranks];
  else if (straightHigh >= 0) [category, tb] = [4, [straightHigh]];
  else if (groups[0]![1] === 3) [category, tb] = [3, byGroup];
  else if (groups[0]![1] === 2 && groups[1]![1] === 2) [category, tb] = [2, byGroup];
  else if (groups[0]![1] === 2) [category, tb] = [1, byGroup];
  else [category, tb] = [0, ranks];
  const name = HAND_CATEGORIES[category]!;
  return { score: packScore(category, tb), category, name, tiebreak: tb, cards: [...cards], description: describe(category, tb) };
}

function describe(category: number, tb: number[]): string {
  const r = (i: number) => RANK_NAMES[tb[i]!]!;
  switch (category) {
    case 8:
      return tb[0] === 12 ? "Royal flush" : `Straight flush, ${r(0)} high`;
    case 7:
      return `Four of a kind, ${r(0)}s`;
    case 6:
      return `Full house, ${r(0)}s full of ${r(1)}s`;
    case 5:
      return `Flush, ${r(0)} high`;
    case 4:
      return `Straight, ${r(0)} high`;
    case 3:
      return `Three of a kind, ${r(0)}s`;
    case 2:
      return `Two pair, ${r(0)}s and ${r(1)}s`;
    case 1:
      return `Pair of ${r(0)}s`;
    default:
      return `${r(0)} high`;
  }
}

/** Best five of 5 to 7 cards. */
export function evaluateHand(cards: readonly number[]): HandValue {
  if (cards.length < 5 || cards.length > 7) throw new Error("need 5 to 7 cards");
  if (new Set(cards).size !== cards.length) throw new Error("duplicate cards");
  let best: HandValue | null = null;
  const pick: number[] = [];
  const walk = (from: number): void => {
    if (pick.length === 5) {
      const v = evaluateFive(pick.map((i) => cards[i]!));
      if (!best || v.score > best.score) best = v;
      return;
    }
    for (let i = from; i <= cards.length - (5 - pick.length); i++) {
      pick.push(i);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return best!;
}

/** Negative if a loses to b, 0 on a tie, positive if a wins. */
export function compareHands(a: HandValue, b: HandValue): number {
  return a.score - b.score;
}
