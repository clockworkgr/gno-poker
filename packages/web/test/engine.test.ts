import { describe, expect, it } from "vitest";
import { cleanGnot, formatAmount, formatChips, formatGnot, gnotInput, parseGnot } from "../src/config.ts";
import { diffTable } from "../src/engine/log.ts";
import { computePots } from "../src/engine/pots.ts";
import { eligibleSeats, handStatus } from "../src/engine/status.ts";
import { table } from "./helpers.ts";

const name = (s: number) => (s === 0 ? "You" : `Seat ${s + 1}`);

describe("computePots", () => {
  it("keeps one pot while nobody is all-in, even with unequal street bets", () => {
    const t = table({ hand: { players: [{ seat: 0, contributed: 1000 }, { seat: 1, contributed: 2000 }, { seat: 2, contributed: 6000 }] } });
    expect(computePots(t.hand!)).toEqual([{ amount: 9000n, eligible: [0, 1, 2] }]);
  });
  it("splits at an all-in player's contribution and drops folded players from eligibility", () => {
    const t = table({ hand: { players: [
      { seat: 0, contributed: 5000, allIn: true },
      { seat: 1, contributed: 20000 },
      { seat: 2, contributed: 20000 },
      { seat: 3, contributed: 3000, folded: true },
    ] }, seats: [{ owner: "a", stack: 0 }, { owner: "b", stack: 1 }, { owner: "c", stack: 1 }, { owner: "d", stack: 1 }] });
    expect(computePots(t.hand!)).toEqual([
      { amount: 5000n * 3n + 3000n, eligible: [0, 1, 2] },
      { amount: 30000n, eligible: [1, 2] },
    ]);
  });
});

describe("diffTable", () => {
  const base = { phase: "preflop", currentBet: "2000", players: [{ seat: 0, contributed: 1000, streetBet: 1000 }, { seat: 1, contributed: 2000, streetBet: 2000 }, { seat: 2 }] };
  it("logs a new hand", () => {
    const prev = table({});
    const next = table({ hand: { ...base, phase: "shuffle" } });
    expect(diffTable(prev, next, name).map((d) => d.text)).toEqual(["Hand #1 started · button Seat 1 · blinds You / Seat 2"]);
  });
  it("infers calls, raises, folds and checks with the right grammar", () => {
    const prev = table({ hand: base });
    const next = table({ hand: { ...base, currentBet: "6000", players: [
      { seat: 0, contributed: 1000, streetBet: 1000, folded: true },
      { seat: 1, contributed: 6000, streetBet: 6000, acted: true },
      { seat: 2, contributed: 2000, streetBet: 2000, acted: true },
    ] } });
    expect(diffTable(prev, next, name).map((d) => d.text)).toEqual(["You fold", "Seat 2 raises to 0.006 GNOT", "Seat 3 calls 0.002 GNOT"]);
  });
  it("logs deck passes and seat changes", () => {
    const prev = table({ hand: { ...base, phase: "shuffle", deckSeq: 0 } });
    const next = table({ hand: { ...base, phase: "shuffle", deckSeq: 2 }, seats: [{ owner: "g1a", stack: 100000 }, { owner: "g1b", stack: 100000, leaving: true }, null] });
    const texts = diffTable(prev, next, name).map((d) => d.text);
    expect(texts).toContain("You shuffled and locked the deck (pass 1/6)");
    expect(texts).toContain("Seat 2 shuffled and locked the deck (pass 2/6)");
    expect(texts).toContain("Seat 2 will leave after this hand");
    expect(texts).toContain("Seat 3 left the table");
  });
  it("logs settlement", () => {
    const prev = table({ hand: { ...base, phase: "reveal" } });
    const next = table({ hand: { ...base, phase: "challenge", board: [12, 25, 38, 51, 0], result: { aborted: false, convicted: [], stallers: [], payouts: { "1": "5000" }, hands: { "1": "pair" } } } });
    const texts = diffTable(prev, next, name).map((d) => d.text);
    expect(texts).toContain("Board Ac Ad Ah As 2c");
    expect(texts).toContain("Seat 2 wins 0.005 GNOT with pair");
  });
});

describe("handStatus", () => {
  it("shows shuffle progress and whether it is our turn", () => {
    const t = table({ hand: { ...{ phase: "shuffle", turn: 1, deadline: 100 }, players: [{ seat: 0 }, { seat: 1 }, { seat: 2 }] }, height: 90 });
    const s = handStatus(t, 1, name)!;
    expect(s.label).toBe("Shuffling 2/3");
    expect(s.mine).toBe(true);
    expect(s.blocksLeft).toBe(10);
  });
  it("shows key sharing as a simultaneous step", () => {
    const t = table({ hand: { phase: "deal_flop", turn: -1, owing: [2], players: [{ seat: 0 }, { seat: 1 }, { seat: 2 }] } });
    const s = handStatus(t, 0, name)!;
    expect(s.label).toBe("Sharing keys 2/3");
    expect(s.mine).toBe(false);
    expect(s.detail).toContain("Seat 3");
  });
  it("lists eligible seats like the realm", () => {
    const t = table({ seats: [{ owner: "a", stack: 1999 }, { owner: "b", stack: 2000 }, { owner: "c", stack: 5000, sittingOut: true }, { owner: "d", stack: 5000 }] });
    expect(eligibleSeats(t)).toEqual([1, 3]);
  });
});

describe("formatting", () => {
  it("formats chips and GNOT", () => {
    expect(formatChips(100000n)).toBe("0.1 GNOT");
    expect(formatChips(2_500_000n)).toBe("2.5 GNOT");
    expect(formatChips(-1500n)).toBe("-0.0015 GNOT");
    expect(formatChips(1_234_567_000_001n)).toBe("1,234,567.000001 GNOT");
    expect(formatAmount(2000n)).toBe("0.002");
    expect(parseGnot("0.002")).toBe(2000n);
    expect(parseGnot("1.5")).toBe(1_500_000n);
    expect(parseGnot(".25")).toBe(250_000n);
    expect(parseGnot("3.")).toBe(3_000_000n);
    expect(parseGnot("")).toBe(0n);
    expect(parseGnot("1.2345678")).toBe(1_234_567n);
    expect(cleanGnot("1,5x.2")).toBe("1.52");
    expect(gnotInput(1_234_500n)).toBe("1.2345");
    expect(gnotInput(40_000n)).toBe("0.04");
    expect(parseGnot(gnotInput(123_456_789n))).toBe(123_456_789n);
    expect(formatGnot(1_400_000n)).toBe("1.4");
    expect(formatGnot(5_000_000n)).toBe("5");
  });
});
