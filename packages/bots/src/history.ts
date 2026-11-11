// Readable hand histories, collected from the bots' own actions plus the final table state.

import { type TableState, cardName } from "@gno-poker/protocol";
import type { TxRecord } from "./chain.ts";

export interface HistoryLine {
  at: number;
  text: string;
}

export interface HandSummary {
  tableId: number;
  handNo: number;
  startedAt: number;
  endedAt: number;
  ms: number;
  players: { index: number; seat: number; name: string; owner: string }[];
  /** Gas used per hand index (all txs signed for that player in this hand, incl. failures = 0). */
  gasByPlayer: Map<number, bigint>;
  /** Fees paid per hand index, ugnot. */
  feeByPlayer: Map<number, bigint>;
  txCountByPlayer: Map<number, number>;
  result: string;
}

/** Collects lines per (table, hand) and prints the history when the hand is done. */
export class HistoryBook {
  private readonly lines = new Map<string, HistoryLine[]>();
  private readonly started = new Map<string, number>();
  private readonly printed = new Map<string, Promise<HandSummary | null>>();
  /** Awaited after a hand's history is printed, before finish() resolves for any caller. */
  onFinish: ((table: TableState, summary: HandSummary) => Promise<void> | void) | null = null;
  readonly summaries: HandSummary[] = [];
  /** Display name by address (owner or session). */
  readonly names = new Map<string, string>();

  private readonly out: (s: string) => void;
  constructor(out: (s: string) => void = (s) => console.log(s)) {
    this.out = out;
  }

  private key(tableId: number, handNo: number): string {
    return `${tableId}/${handNo}`;
  }

  /** Marks the hand start (first time it is seen). */
  start(tableId: number, handNo: number, at = Date.now()): void {
    const k = this.key(tableId, handNo);
    if (!this.started.has(k)) this.started.set(k, at);
  }

  add(tableId: number, handNo: number, text: string): void {
    const k = this.key(tableId, handNo);
    let l = this.lines.get(k);
    if (!l) this.lines.set(k, (l = []));
    l.push({ at: Date.now(), text });
  }

  nameOf(addr: string): string {
    return this.names.get(addr) ?? addr.slice(0, 10);
  }

  /**
   * Prints the history of the table's last hand once it is done, runs onFinish, and returns its
   * summary (null if not done). Concurrent and repeated callers share one run.
   * `txs` attributes gas per player.
   */
  finish(table: TableState, txs: readonly TxRecord[] = []): Promise<HandSummary | null> {
    const h = table.hand;
    if (!h || h.phase !== "done") return Promise.resolve(null);
    const k = this.key(table.id, h.handNo);
    let p = this.printed.get(k);
    if (!p) {
      p = (async () => {
        const s = this.render(table, txs);
        if (this.onFinish) await this.onFinish(table, s);
        return s;
      })();
      this.printed.set(k, p);
    }
    return p;
  }

  private render(table: TableState, txs: readonly TxRecord[]): HandSummary {
    const h = table.hand!;
    const k = this.key(table.id, h.handNo);
    const endedAt = Date.now();
    const startedAt = this.started.get(k) ?? endedAt;
    const n = h.players.length;
    const out: string[] = [];
    const players = h.players.map((p) => ({ index: p.index, seat: p.seat, owner: p.owner, name: this.nameOf(p.owner) }));
    const pos = (j: number) => (n === 2 ? (j === 0 ? "BTN/SB" : "BB") : j === 0 ? "SB" : j === 1 ? "BB" : j === n - 1 ? "BTN" : `UTG${j - 2 === 0 ? "" : "+" + (j - 2)}`);
    out.push(`=== Table ${table.id} hand #${h.handNo} (${table.smallBlind}/${table.bigBlind} ugnot, ${n} players, ${((endedAt - startedAt) / 1000).toFixed(1)}s) ===`);
    for (const p of h.players) {
      const hole = h.cards.size ? `${cardName(h.cards.get(2 * p.index)!)} ${cardName(h.cards.get(2 * p.index + 1)!)}` : "?? ??";
      out.push(`  [${p.index}] seat ${p.seat} ${pos(p.index).padEnd(6)} ${this.nameOf(p.owner).padEnd(14)} hole ${hole}${p.folded ? "  (folded)" : ""}`);
    }
    for (const l of this.lines.get(k) ?? []) out.push(`  ${l.text}`);
    if (h.board.length) out.push(`  Board: ${h.board.map(cardName).join(" ")}`);
    const r = h.result;
    let resultText = "no result";
    if (r) {
      const parts: string[] = [];
      if (r.convicted.length) parts.push(`CONVICTED ${r.convicted.map((j) => this.nameOf(h.players[j]!.owner)).join(", ")}`);
      if (r.stallers.length) parts.push(`STALLED ${r.stallers.map((j) => this.nameOf(h.players[j]!.owner)).join(", ")}`);
      if (r.aborted && !parts.length) parts.push("aborted");
      for (const c of r.challenges) {
        parts.push(`challenge by ${this.nameOf(h.players[c.challenger]!.owner)} on ${this.nameOf(h.players[c.accused]!.owner)} ${c.kind}#${c.index}: ${c.guilty ? "GUILTY" : "not guilty (bond lost)"}`);
      }
      for (const [j, amt] of r.payouts) {
        if (amt > 0n) parts.push(`${this.nameOf(h.players[j]!.owner)} +${amt}${r.hands.has(j) ? ` (${r.hands.get(j)})` : ""}`);
      }
      resultText = parts.join("; ");
      out.push(`  Result: ${resultText}`);
      const shown = [...r.hands.entries()].map(([j, name]) => `${this.nameOf(h.players[j]!.owner)}: ${name}`);
      if (shown.length) out.push(`  Showdown: ${shown.join(", ")}`);
    }
    const stacks = table.seats.filter((s) => s !== null).map((s) => `${this.nameOf(s!.owner)}=${s!.stack}`);
    out.push(`  Stacks: ${stacks.join(" ")}`);

    // Gas per player for this hand.
    const gasByPlayer = new Map<number, bigint>();
    const feeByPlayer = new Map<number, bigint>();
    const txCountByPlayer = new Map<number, number>();
    const idxOf = new Map<string, number>();
    for (const p of h.players) {
      idxOf.set(p.owner, p.index);
      const s = table.seats[p.seat];
      if (s && s.session) idxOf.set(s.session, p.index);
    }
    for (const t of txs) {
      if (t.tableId !== table.id || t.handNo !== h.handNo) continue;
      const j = idxOf.get(t.signer);
      if (j === undefined) continue;
      gasByPlayer.set(j, (gasByPlayer.get(j) ?? 0n) + t.gasUsed);
      feeByPlayer.set(j, (feeByPlayer.get(j) ?? 0n) + t.fee);
      txCountByPlayer.set(j, (txCountByPlayer.get(j) ?? 0) + 1);
    }
    if (gasByPlayer.size) {
      out.push(`  Gas: ${h.players.map((p) => `${this.nameOf(p.owner)}=${((Number(gasByPlayer.get(p.index) ?? 0n)) / 1e6).toFixed(1)}M/${txCountByPlayer.get(p.index) ?? 0}tx`).join(" ")}`);
    }
    this.out(out.join("\n"));
    const summary: HandSummary = {
      tableId: table.id,
      handNo: h.handNo,
      startedAt,
      endedAt,
      ms: endedAt - startedAt,
      players,
      gasByPlayer,
      feeByPlayer,
      txCountByPlayer,
      result: resultText,
    };
    this.summaries.push(summary);
    this.lines.delete(k);
    return summary;
  }
}
