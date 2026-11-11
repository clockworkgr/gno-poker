import { describe, expect, it } from "vitest";
import { betOptions, handIndexOf, parseGnoBool, parseGnoResults, parseGnoString, parseTableJSON, parseTableListJSON, unquoteGo } from "../src/index.ts";

/** Go's strconv.Quote for the characters we care about, to build realistic fixtures. */
function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + '"';
}

export const TABLE_JSON = JSON.stringify({
  id: 1, smallBlind: "1000", bigBlind: "2000", minBuyIn: "40000", maxBuyIn: "200000",
  maxPlayers: 6, actionTimeoutBlocks: 30, challengeWindowBlocks: 30, challengeBond: "10000",
  height: 1234, button: 0, handNo: 3,
  seats: [
    { seat: 0, owner: "g1owner0", session: "g1sess0", stack: "98000", sittingOut: false, leaving: false, waiting: false },
    { seat: 1, owner: "g1owner1", session: "", stack: "50000", sittingOut: false, leaving: false, waiting: false },
    null, null, null, null,
  ],
  hand: {
    handNo: 3, phase: "preflop",
    players: [
      { seat: 0, owner: "g1owner0", commit: "AB", contributed: "1000", streetBet: "1000", folded: false, allIn: false,
        acted: false, revealed: false, accepted: false, seed: "", keys: { "2": "aa", "3": "BB" } },
      { seat: 1, owner: "g1owner1", commit: "cd", contributed: "2000", streetBet: "2000", folded: false, allIn: false,
        acted: false, revealed: false, accepted: false, seed: "", keys: {} },
    ],
    turn: 0, owing: [], deadline: 1264, pot: "3000", currentBet: "2000", minRaise: "2000",
    deckSeq: 4, roots: ["r0", "r1", "r2", "r3"], board: [], cards: {},
    result: null,
  },
});

describe("gno result parsing", () => {
  it("unquotes Go strings", () => {
    for (const s of ['{"a":"b\\\\c"}', "line\nbreak\ttab", "ctrl\x01\x7f", "unicode é ♠ 🂡", ""]) {
      expect(unquoteGo(goQuote(s))).toBe(s);
    }
    expect(unquoteGo('"\\u00e9\\U0001F0A1\\x41\\101\\a"')).toBe("é🂡AA\x07");
    expect(() => unquoteGo("abc")).toThrow();
    expect(() => unquoteGo('"\\q"')).toThrow();
  });

  it("parses qeval results", () => {
    expect(parseGnoString(`(${goQuote(TABLE_JSON)} string)`)).toBe(TABLE_JSON);
    expect(parseGnoString('("" string)')).toBe("");
    expect(parseGnoString("( string)")).toBe("");
    expect(parseGnoBool("(true bool)")).toBe(true);
    expect(parseGnoResults("(1 uint64)\n(\"x y\" string)")).toEqual([
      { value: "1", type: "uint64" },
      { value: "x y", type: "string" },
    ]);
    expect(() => parseGnoString("(1 uint64)")).toThrow();
  });

  it("parses GetTable JSON", () => {
    const t = parseTableJSON(TABLE_JSON);
    expect(t.bigBlind).toBe(2000n);
    expect(t.seats.length).toBe(6);
    expect(t.seats[2]).toBeNull();
    expect(t.seats[0]!.stack).toBe(98000n);
    const h = t.hand!;
    expect(h.phase).toBe("preflop");
    expect(h.players[0]!.commit).toBe("ab");
    expect(h.players[0]!.keys.get(3)).toBe("bb");
    expect(h.players[1]!.index).toBe(1);
    expect(h.roots.length).toBe(4);
    expect(h.result).toBeNull();
    expect(handIndexOf(t, "g1sess0")).toBe(0);
    expect(handIndexOf(t, "g1owner1")).toBe(1);
    expect(handIndexOf(t, "g1nobody")).toBe(-1);
    expect(() => parseTableJSON(TABLE_JSON.replace('"preflop"', '"bogus"'))).toThrow();
  });

  it("parses a settled result", () => {
    const o = JSON.parse(TABLE_JSON);
    o.hand.phase = "done";
    o.hand.result = {
      aborted: false, convicted: [2], stallers: [], payouts: { "0": "5000", "1": "0" }, hands: { "0": "Two pair" },
      challenges: [{ challenger: 0, accused: 2, kind: "shuffle", index: 5, guilty: true }],
    };
    const r = parseTableJSON(JSON.stringify(o)).hand!.result!;
    expect(r.convicted).toEqual([2]);
    expect(r.payouts.get(0)).toBe(5000n);
    expect(r.hands.get(0)).toBe("Two pair");
    expect(r.challenges[0]).toEqual({ challenger: 0, accused: 2, kind: "shuffle", index: 5, guilty: true });
  });

  it("bet options", () => {
    const t = parseTableJSON(TABLE_JSON);
    expect(betOptions(t, 0)).toEqual({ toCall: 1000n, canCheck: false, minRaiseTo: 4000n, maxRaiseTo: 99000n, stack: 98000n });
    expect(betOptions(t, 1)).toMatchObject({ toCall: 0n, canCheck: true, minRaiseTo: 4000n });
  });

  it("parses ListTables JSON", () => {
    const l = parseTableListJSON('[{"id":2,"smallBlind":"5","bigBlind":"10","minBuyIn":"100","maxBuyIn":"1000","maxPlayers":2,"seated":1,"handNo":0,"phase":""}]');
    expect(l[0]).toMatchObject({ id: 2, bigBlind: 10n, seated: 1, phase: "" });
  });
});
