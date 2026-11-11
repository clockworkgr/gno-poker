// Human-readable hand status and "what you owe" derived from table state.

import { type Phase, type TableState, dealStepOfPhase } from "@gno-poker/protocol";

export interface HandStatus {
  /** Short label for the protocol pill, e.g. "Shuffling 2/3". */
  label: string;
  /** Detail, e.g. "Seat 4 is shuffling". */
  detail: string;
  /** Hand index whose turn it is in in-turn phases, else -1. */
  turn: number;
  /** True when the local player owes something now (protocol step or bet). */
  mine: boolean;
  /** Betting street in progress. */
  betting: boolean;
  blocksLeft: number | null;
}

const STREET_NAMES: Partial<Record<Phase, string>> = { preflop: "Pre-flop", flop: "Flop", turn: "Turn", river: "River" };

export function handStatus(t: TableState, myIndex: number, seatName: (seat: number) => string): HandStatus | null {
  const h = t.hand;
  if (!h) return null;
  const n = h.players.length;
  const who = (j: number) => {
    const p = h.players[j];
    return j === myIndex ? "You" : p ? seatName(p.seat) : `Player ${j + 1}`;
  };
  const blocksLeft = h.deadline > 0 && h.phase !== "done" ? h.deadline - t.height : null;
  const base = { turn: h.turn, blocksLeft };
  switch (h.phase) {
    case "shuffle":
      return { ...base, label: `Shuffling ${h.turn + 1}/${n}`, detail: `${who(h.turn)} ${h.turn === myIndex ? "are" : "is"} shuffling and locking the deck`, mine: h.turn === myIndex, betting: false };
    case "rekey":
      return { ...base, label: `Re-keying ${h.turn + 1}/${n}`, detail: `${who(h.turn)} ${h.turn === myIndex ? "are" : "is"} re-locking each card with its own key`, mine: h.turn === myIndex, betting: false };
    case "deal_hole":
    case "deal_flop":
    case "deal_turn":
    case "deal_river": {
      const step = dealStepOfPhase(h.phase)!;
      const done = n - h.owing.length;
      return {
        ...base,
        label: `Sharing keys ${done}/${n}`,
        detail: `Dealing the ${step === "hole" ? "hole cards" : step}: waiting for ${h.owing.map(who).join(", ") || "nobody"}`,
        mine: h.owing.includes(myIndex),
        betting: false,
      };
    }
    case "preflop":
    case "flop":
    case "turn":
    case "river":
      return {
        ...base,
        label: STREET_NAMES[h.phase]!,
        detail: h.turn === myIndex ? "Your turn to act" : `${who(h.turn)} to act`,
        mine: h.turn === myIndex,
        betting: true,
      };
    case "reveal": {
      const done = h.players.filter((p) => p.revealed).length;
      return { ...base, label: `Revealing ${done}/${n}`, detail: `Every player publishes their seed so the realm can derive all cards; waiting for ${h.owing.map(who).join(", ")}`, mine: h.owing.includes(myIndex), betting: false };
    }
    case "challenge": {
      const done = h.players.filter((p) => p.accepted).length;
      return { ...base, label: `Verifying ${done}/${n}`, detail: "Players re-check every deck pass against the revealed seeds", mine: myIndex >= 0 && !h.players[myIndex]?.accepted, betting: false };
    }
    case "done":
      return { ...base, label: "Hand over", detail: h.result?.aborted ? "Hand aborted" : "Payouts applied", mine: false, betting: false };
  }
}

/** Seats eligible for the next StartHand (realm rule: active with stack >= big blind). */
export function eligibleSeats(t: TableState): number[] {
  return t.seats.flatMap((s, i) => (s && !s.sittingOut && !s.leaving && s.stack >= t.bigBlind ? [i] : []));
}

export function handLive(t: TableState): boolean {
  return !!t.hand && t.hand.phase !== "done";
}
