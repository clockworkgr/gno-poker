import { type BetOptions, type TableState, parseCard } from "@gno-poker/protocol";
import { describe, expect, it } from "vitest";
import { lastShufflerPerm } from "../src/cheats.ts";
import { CallingStation, HandStrengthStrategy, RandomStrategy, madeHandStrength, preflopStrength, seededRng, toRealmAction } from "../src/strategy.ts";

const c = (s: string) => parseCard(s);
const opts = (o: Partial<BetOptions>): BetOptions => ({ toCall: 0n, canCheck: true, minRaiseTo: 4000n, maxRaiseTo: 80000n, stack: 78000n, ...o });
const table = { hand: { pot: 3000n, currentBet: 2000n } } as unknown as TableState;
const ctx = (o: BetOptions, hole: number[], board: number[] = [], rng = seededRng(1)) => ({
  table, phase: board.length ? ("flop" as const) : ("preflop" as const), me: 0, options: o, hole, board, bigBlind: 2000n, live: 2, rng,
});

describe("strategies", () => {
  it("calling station checks or calls", () => {
    const s = new CallingStation();
    expect(s.decide(ctx(opts({}), [0, 1]))).toEqual({ action: "check" });
    expect(s.decide(ctx(opts({ canCheck: false, toCall: 1000n }), [0, 1]))).toEqual({ action: "call" });
  });

  it("random strategy produces every legal action kind over many draws", () => {
    const s = new RandomStrategy();
    const rng = seededRng(3);
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const o = i % 2 ? opts({}) : opts({ canCheck: false, toCall: 2000n });
      seen.add(toRealmAction(s.decide(ctx(o, [0, 1], [], rng)), o).action + (s.decide(ctx(o, [0, 1], [], rng)).action === "allin" ? "-allin" : ""));
    }
    for (const a of ["fold", "check", "call", "raise"]) expect([...seen].some((x) => x.startsWith(a))).toBe(true);
  });

  it("hand strength ranks hands sensibly", () => {
    expect(preflopStrength(c("As"), c("Ah"))).toBeGreaterThan(preflopStrength(c("7c"), c("2d")));
    expect(madeHandStrength([c("Ks"), c("Kd")], [c("5c"), c("5h"), c("Qd")])).toBeGreaterThan(madeHandStrength([c("7s"), c("2d")], [c("5c"), c("5h"), c("Qd")]));
    const s = new HandStrengthStrategy();
    expect(s.decide(ctx(opts({ canCheck: false, toCall: 70000n }), [c("7c"), c("2d")])).action).toBe("fold");
    expect(["raise", "allin"]).toContain(s.decide(ctx(opts({}), [c("As"), c("Ah")])).action);
    // Undecodable hole cards: never put chips in.
    expect(s.decide(ctx(opts({ canCheck: false, toCall: 2000n }), [null as unknown as number, 3])).action).toBe("fold");
  });

  it("toRealmAction keeps actions legal", () => {
    expect(toRealmAction({ action: "raise", to: 1n }, opts({}))).toEqual({ action: "raise", amount: 4000n });
    expect(toRealmAction({ action: "raise", to: 10n ** 9n }, opts({}))).toEqual({ action: "raise", amount: 80000n });
    expect(toRealmAction({ action: "raise", to: 9000n }, opts({ minRaiseTo: null }))).toEqual({ action: "check", amount: 0n });
    expect(toRealmAction({ action: "allin" }, opts({ minRaiseTo: null, canCheck: false, toCall: 5n }))).toEqual({ action: "call", amount: 0n });
    expect(toRealmAction({ action: "check" }, opts({ canCheck: false }))).toEqual({ action: "fold", amount: 0n });
  });
});

describe("last-shuffler permutation", () => {
  it("moves the victim's positions to the cheater's and is a permutation", () => {
    const x = lastShufflerPerm(3, 2, 0);
    expect(new Set(x).size).toBe(52);
    expect([x[4], x[5]]).toEqual([0, 1]);
    // Board positions untouched.
    for (let p = 6; p < 11; p++) expect(x[p]).toBe(p);
  });
});
