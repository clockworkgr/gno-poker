// Betting strategies. A strategy only picks an action; the bot turns it into a legal realm call.

import { type BetOptions, type Phase, type TableState, cardRank, cardSuit, evaluateHand } from "@gno-poker/protocol";

export interface DecisionContext {
  table: TableState;
  phase: Phase;
  /** Our hand index. */
  me: number;
  options: BetOptions;
  /** Our hole cards: card index, null if it failed to decode, undefined if not open. */
  hole: (number | null | undefined)[];
  /** Board cards opened so far (only decoded ones). */
  board: number[];
  bigBlind: bigint;
  /** Number of players still in the hand (not folded). */
  live: number;
  rng: () => number;
}

export type Decision =
  | { action: "fold" }
  | { action: "check" }
  | { action: "call" }
  /** `to` is the total street bet after the raise; clamped into [minRaiseTo, maxRaiseTo]. */
  | { action: "raise"; to: bigint }
  | { action: "allin" };

export interface Strategy {
  readonly name: string;
  decide(ctx: DecisionContext): Decision;
}

/** Always checks or calls. */
export class CallingStation implements Strategy {
  readonly name = "calling-station";
  decide(ctx: DecisionContext): Decision {
    return ctx.options.canCheck ? { action: "check" } : { action: "call" };
  }
}

/**
 * Picks uniformly among the legal action kinds (fold, check, call, min raise, random raise, all-in),
 * with configurable weights, so every realm betting path gets exercised.
 */
export class RandomStrategy implements Strategy {
  readonly name = "random";
  private readonly weights: { fold: number; check: number; call: number; raise: number; allin: number };
  constructor(weights = { fold: 1, check: 3, call: 3, raise: 2, allin: 0.5 }) {
    this.weights = weights;
  }
  decide(ctx: DecisionContext): Decision {
    const o = ctx.options;
    const choices: [Decision, number][] = [];
    if (!o.canCheck) choices.push([{ action: "fold" }, this.weights.fold]);
    else choices.push([{ action: "check" }, this.weights.check]);
    if (!o.canCheck && o.toCall > 0n) choices.push([{ action: "call" }, this.weights.call]);
    if (o.minRaiseTo !== null) {
      const span = o.maxRaiseTo - o.minRaiseTo;
      const extra = span > 0n ? BigInt(Math.floor(ctx.rng() * Number(span < 3n * ctx.bigBlind ? span : 3n * ctx.bigBlind))) : 0n;
      choices.push([{ action: "raise", to: o.minRaiseTo + extra }, this.weights.raise]);
      choices.push([{ action: "allin" }, this.weights.allin]);
    }
    const total = choices.reduce((s, [, w]) => s + w, 0);
    let x = ctx.rng() * total;
    for (const [d, w] of choices) {
      x -= w;
      if (x <= 0) return d;
    }
    return choices[choices.length - 1]![0];
  }
}

/** Rough preflop strength in 0..1 from the two hole cards (pairs, high cards, suited, connected). */
export function preflopStrength(a: number, b: number): number {
  const ra = cardRank(a);
  const rb = cardRank(b);
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  let s = (hi + lo) / 24; // 0..1
  if (ra === rb) s = 0.55 + (ra / 12) * 0.45;
  if (cardSuit(a) === cardSuit(b)) s += 0.06;
  if (hi - lo === 1) s += 0.04;
  return Math.min(1, s);
}

/** Postflop strength in 0..1 from the made hand category. */
export function madeHandStrength(hole: number[], board: number[]): number {
  const v = evaluateHand([...hole, ...board]);
  // Category 0..8; a pair that uses a hole card counts more than a board pair.
  let s = v.category / 8;
  // Two pair or trips made with a pair on the board are worth about one category less.
  const boardRanks = board.map(cardRank);
  const boardPaired = new Set(boardRanks).size < boardRanks.length;
  if (boardPaired && (v.category === 2 || v.category === 3)) s = Math.max(0.3, (v.category - 1) / 8 + 0.15);
  if (v.category === 1) {
    const pairRank = v.tiebreak[0]!;
    const usesHole = hole.some((c) => cardRank(c) === pairRank);
    s = usesHole ? 0.3 + (pairRank / 12) * 0.2 : 0.15;
  }
  if (v.category === 0) s = (Math.max(...hole.map(cardRank)) / 12) * 0.15;
  return Math.min(1, s);
}

/**
 * Simple hand-strength player: raises strong hands, calls medium ones when the price is right,
 * checks or folds weak ones.
 */
export class HandStrengthStrategy implements Strategy {
  readonly name = "hand-strength";
  decide(ctx: DecisionContext): Decision {
    const o = ctx.options;
    const hole = ctx.hole.filter((c): c is number => typeof c === "number");
    if (hole.length !== 2) return o.canCheck ? { action: "check" } : { action: "fold" };
    const s = ctx.board.length >= 3 ? madeHandStrength(hole, ctx.board) : preflopStrength(hole[0]!, hole[1]!);
    const pot = ctx.table.hand?.pot ?? 0n;
    const priceOdds = o.toCall === 0n ? 0 : Number(o.toCall) / Number(pot + o.toCall);
    if (s > 0.8 && o.minRaiseTo !== null) {
      if (s > 0.92 && ctx.rng() < 0.3) return { action: "allin" };
      const target = (ctx.table.hand?.currentBet ?? 0n) + pot / 2n;
      return { action: "raise", to: target > o.minRaiseTo ? target : o.minRaiseTo };
    }
    if (s > 0.55 && o.minRaiseTo !== null && ctx.rng() < 0.35) return { action: "raise", to: o.minRaiseTo };
    if (o.canCheck) return { action: "check" };
    if (s >= priceOdds + 0.15 || (s > 0.35 && o.toCall <= ctx.bigBlind)) return { action: "call" };
    return { action: "fold" };
  }
}

export const STRATEGIES: Record<string, () => Strategy> = {
  "calling-station": () => new CallingStation(),
  random: () => new RandomStrategy(),
  "hand-strength": () => new HandStrengthStrategy(),
};

export function strategyByName(name: string): Strategy {
  const f = STRATEGIES[name];
  if (!f) throw new Error(`unknown strategy "${name}" (known: ${Object.keys(STRATEGIES).join(", ")})`);
  return f();
}

/** Deterministic PRNG (mulberry32) for reproducible bot runs. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Maps a strategy decision to a legal realm action given the options. */
export function toRealmAction(d: Decision, o: BetOptions): { action: "fold" | "check" | "call" | "raise"; amount: bigint } {
  switch (d.action) {
    case "fold":
      return { action: "fold", amount: 0n };
    case "check":
      return o.canCheck ? { action: "check", amount: 0n } : { action: "fold", amount: 0n };
    case "call":
      return o.canCheck ? { action: "check", amount: 0n } : { action: "call", amount: 0n };
    case "allin":
      if (o.minRaiseTo !== null) return { action: "raise", amount: o.maxRaiseTo };
      return o.canCheck ? { action: "check", amount: 0n } : { action: "call", amount: 0n };
    case "raise": {
      if (o.minRaiseTo === null) return o.canCheck ? { action: "check", amount: 0n } : { action: "call", amount: 0n };
      let to = d.to < o.minRaiseTo ? o.minRaiseTo : d.to;
      if (to > o.maxRaiseTo) to = o.maxRaiseTo;
      return { action: "raise", amount: to };
    }
  }
}
