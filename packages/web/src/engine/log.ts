// Hand history derived from consecutive GetTable snapshots. The realm keeps no event feed (no
// indexer by design), so events are inferred from what changed between two polls; actions that
// happen and are superseded between polls are merged (a call and a later raise show as a raise).

import { type HandState, type TableState, cardName } from "@gno-poker/protocol";
import { formatChips } from "../config.ts";

export type LogKind = "hand" | "protocol" | "bet" | "deal" | "result" | "tx" | "error" | "info";

export interface LogEntry {
  id: number;
  at: number;
  handNo: number;
  kind: LogKind;
  text: string;
}

export type SeatNamer = (seat: number) => string;

const STREET: Record<string, string> = { preflop: "Pre-flop", flop: "Flop", turn: "Turn", river: "River" };
const DEAL_STEP: Record<string, string> = { deal_hole: "hole cards", deal_flop: "flop", deal_turn: "turn", deal_river: "river" };

export interface LogDraft {
  kind: LogKind;
  text: string;
  handNo: number;
}

export function diffTable(prev: TableState | null, next: TableState, name: SeatNamer): LogDraft[] {
  const out: LogDraft[] = [];
  const add = (kind: LogKind, text: string, handNo = next.hand?.handNo ?? next.handNo) => out.push({ kind, text, handNo });

  // Seats
  if (prev) {
    for (let i = 0; i < next.seats.length; i++) {
      const a = prev.seats[i] ?? null;
      const b = next.seats[i] ?? null;
      if (!a && b) add("info", `${name(i)} sat down with ${formatChips(b.stack)}${b.waiting ? " (dealt in next hand)" : ""}`);
      else if (a && !b) add("info", `${seatLabel(i)} left the table`);
      else if (a && b && a.owner !== b.owner) add("info", `${name(i)} took seat ${i + 1}`);
      else if (a && b) {
        if (!a.leaving && b.leaving) add("info", `${name(i)} will leave after this hand`);
        if (a.sittingOut !== b.sittingOut) add("info", says(name(i), "sits", b.sittingOut ? " out" : " back in"));
      }
    }
  }

  const h = next.hand;
  if (!h) return out;
  const ph = prev?.hand && prev.hand.handNo === h.handNo ? prev.hand : null;

  if (!ph) {
    if (prev && prev.hand?.handNo !== h.handNo) {
      const sb = h.players[0];
      const bb = h.players[1];
      add("hand", `Hand #${h.handNo} started · button ${seatLabel(next.button)} · blinds ${sb ? name(sb.seat) : "?"} / ${bb ? name(bb.seat) : "?"}`);
    }
    return out;
  }

  diffHand(ph, h, next, name, add);
  return out;
}

function diffHand(a: HandState, b: HandState, t: TableState, name: SeatNamer, add: (k: LogKind, s: string) => void): void {
  const n = b.players.length;
  // Deck passes
  for (let s = a.deckSeq; s < b.deckSeq; s++) {
    const j = s < n ? s : s - n;
    const p = b.players[j];
    add("protocol", `${p ? name(p.seat) : `Player ${j + 1}`} ${s < n ? "shuffled and locked the deck" : "re-keyed the deck"} (pass ${s + 1}/${2 * n})`);
  }
  // Key shares
  for (let j = 0; j < n; j++) {
    const pa = a.players[j];
    const pb = b.players[j];
    if (!pa || !pb) continue;
    const fresh = [...pb.keys.keys()].filter((pos) => !pa.keys.has(pos));
    if (fresh.length) {
      // Name the deal from the positions (the phase may have moved on between two polls).
      const steps = new Set(fresh.map((pos) => (pos < 2 * n ? "hole cards" : pos < 2 * n + 3 ? "flop" : pos === 2 * n + 3 ? "turn" : "river")));
      add("protocol", `${name(pb.seat)} shared card keys for the ${[...steps].join(" and ")}`);
    }
  }
  // Betting
  const streetChanged = a.phase !== b.phase;
  for (let j = 0; j < n; j++) {
    const pa = a.players[j];
    const pb = b.players[j];
    if (!pa || !pb) continue;
    if (!pa.folded && pb.folded) {
      add("bet", says(name(pb.seat), "folds"));
      continue;
    }
    const added = pb.contributed - pa.contributed;
    if (added > 0n) {
      const total = streetChanged ? pa.streetBet + added : pb.streetBet;
      const allIn = pb.allIn && !pa.allIn ? " (all-in)" : "";
      if (total > a.currentBet && a.currentBet === 0n) add("bet", says(name(pb.seat), "bets", ` ${formatChips(total)}${allIn}`));
      else if (total > a.currentBet) add("bet", says(name(pb.seat), "raises", ` to ${formatChips(total)}${allIn}`));
      else add("bet", says(name(pb.seat), "calls", ` ${formatChips(added)}${allIn}`));
    } else if (!streetChanged && !pa.acted && pb.acted && pb.streetBet === pa.streetBet) {
      add("bet", says(name(pb.seat), "checks"));
    }
  }
  if (streetChanged) {
    if (STREET[b.phase]) add("deal", `${STREET[b.phase]} · pot ${formatChips(b.pot)}`);
    if (b.phase === "reveal") add("protocol", "Betting closed · every player reveals their seed");
    if (b.phase === "challenge") add("protocol", "All seeds revealed · cards derived on-chain · challenge window open");
    if (DEAL_STEP[b.phase] && b.phase !== "deal_hole") add("protocol", `Dealing the ${DEAL_STEP[b.phase]}: players share card keys`);
    if (b.phase === "deal_hole") add("protocol", "Deck ready · players share keys for each other's hole cards");
  }
  // Reveals and accepts
  for (let j = 0; j < n; j++) {
    const pa = a.players[j];
    const pb = b.players[j];
    if (!pa || !pb) continue;
    if (!pa.revealed && pb.revealed) add("protocol", `${name(pb.seat)} revealed ${name(pb.seat) === "You" ? "your" : "their"} seed`);
    if (!pa.accepted && pb.accepted) add("protocol", `${name(pb.seat)} verified and accepted the result`);
  }
  // Challenges
  const ca = a.result?.challenges.length ?? 0;
  for (const c of (b.result?.challenges ?? []).slice(ca)) {
    const ch = b.players[c.challenger];
    const ac = b.players[c.accused];
    add("result", `${ch ? name(ch.seat) : "?"} challenged ${ac ? name(ac.seat) : "?"}'s ${c.kind} pass at position ${c.index}: ${c.guilty ? "GUILTY" : "not guilty, bond paid to the accused"}`);
  }
  // Settlement
  if (!a.result && b.result) {
    const r = b.result;
    if (r.convicted.length) {
      add("result", `Convicted: ${r.convicted.map((j) => name(b.players[j]!.seat)).join(", ")} · stack split among the others, bets refunded`);
    } else if (r.aborted) {
      const st = r.stallers.map((j) => name(b.players[j]!.seat)).join(", ");
      add("result", `Hand aborted${st ? ` · stalled: ${st} (stack forfeited)` : ""}`);
    } else {
      if (b.board.length) add("deal", `Board ${b.board.map((c) => cardName(c)).join(" ")}`);
      for (const [j, amt] of r.payouts) {
        if (amt <= 0n) continue;
        const p = b.players[j];
        const what = r.hands.get(j);
        add("result", says(p ? name(p.seat) : "?", "wins", ` ${formatChips(amt)}${what ? ` with ${what}` : ""}`));
      }
    }
  }
  if (a.phase !== "done" && b.phase === "done") add("hand", `Hand #${b.handNo} finalized · payouts applied`);
  void t;
}

/** "Seat 2 raises" / "You raise". */
function says(who: string, verb3: string, rest = ""): string {
  const v = who === "You" ? verb3.replace(/es$/, "e").replace(/([^s])s$/, "$1") : verb3;
  return `${who} ${v}${rest}`;
}

export function seatLabel(seat: number): string {
  return `Seat ${seat + 1}`;
}
