import { type TableState, parseTableJSON } from "@gno-poker/protocol";

export interface P {
  seat: number;
  contributed?: number;
  streetBet?: number;
  folded?: boolean;
  allIn?: boolean;
  acted?: boolean;
  revealed?: boolean;
  accepted?: boolean;
  keys?: Record<string, string>;
}

/** Builds a GetTable-shaped state; `hand` fields override defaults. */
export function table(o: { seats?: (null | { owner: string; stack: number; session?: string; waiting?: boolean; leaving?: boolean; sittingOut?: boolean })[]; hand?: Record<string, unknown> | null; height?: number; button?: number }): TableState {
  const seats = o.seats ?? [{ owner: "g1a", stack: 100000 }, { owner: "g1b", stack: 100000 }, { owner: "g1c", stack: 100000 }];
  const hand = o.hand === undefined ? null : o.hand === null ? null : {
    handNo: 1, phase: "preflop", turn: 0, owing: [], deadline: 100, pot: "0", currentBet: "0", minRaise: "2000", deckSeq: 0, roots: [], board: [], cards: {}, result: null,
    ...o.hand,
    players: ((o.hand.players as P[] | undefined) ?? []).map((p) => ({
      seat: p.seat, owner: seats[p.seat]?.owner ?? "", commit: "", contributed: String(p.contributed ?? 0), streetBet: String(p.streetBet ?? 0),
      folded: !!p.folded, allIn: !!p.allIn, acted: !!p.acted, revealed: !!p.revealed, accepted: !!p.accepted, seed: "", keys: p.keys ?? {},
    })),
  };
  return parseTableJSON({
    id: 1, smallBlind: "1000", bigBlind: "2000", minBuyIn: "40000", maxBuyIn: "200000", maxPlayers: seats.length,
    actionTimeoutBlocks: 30, challengeWindowBlocks: 20, challengeBond: "10000", height: o.height ?? 90, button: o.button ?? 0,
    handNo: hand ? (hand as { handNo: number }).handNo : 0,
    seats: seats.map((s, i) => (s ? { seat: i, owner: s.owner, session: s.session ?? "", stack: String(s.stack), sittingOut: !!s.sittingOut, leaving: !!s.leaving, waiting: !!s.waiting } : null)),
    hand,
  });
}
