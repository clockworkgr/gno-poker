import { type HandState, type TableState, boardPositions } from "@gno-poker/protocol";
import type { CSSProperties } from "react";
import { formatChips, shortAddr } from "../config.ts";
import { slotCard } from "../engine/protocolCore.ts";
import { computePots } from "../engine/pots.ts";
import type { RunnerSnapshot, TableRunner } from "../engine/runner.ts";
import type { HandStatus } from "../engine/status.ts";
import { Card, type CardValue } from "./Card.tsx";

const DEALT_PHASES = new Set(["preflop", "deal_flop", "flop", "deal_turn", "turn", "deal_river", "river", "reveal", "challenge", "done"]);

/** Board positions opened on-chain so far: every player has published a key for them. */
export function dealtBoardCount(h: HandState): number {
  const n = h.players.length;
  return boardPositions(n).filter((pos) => h.players.every((p) => p.keys.has(pos))).length;
}

function seatGeometry(display: number, m: number): { seat: CSSProperties; bet: CSSProperties; button: CSSProperties } {
  const a = Math.PI / 2 + (display * 2 * Math.PI) / m;
  // Radii live in CSS (--seat-rx etc.) so the phone layout can pull seats inward.
  const v = { "--c": Math.cos(a).toFixed(4), "--s": Math.sin(a).toFixed(4) } as CSSProperties;
  return { seat: v, bet: v, button: v };
}

export function Felt({ snap, runner, status }: { snap: RunnerSnapshot; runner: TableRunner; status: HandStatus | null }) {
  const t = snap.table!;
  const h = t.hand;
  const m = t.maxPlayers;
  const anchor = snap.mySeat >= 0 ? snap.mySeat : 0;
  const revealed = !!h && h.cards.size > 0;
  const dealtBoard = h ? (revealed ? dealtBoardCount(h) : Math.max(dealtBoardCount(h), snap.view?.board.filter((c) => c >= 0).length ?? 0)) : 0;

  const board: { card: CardValue; unplayed: boolean }[] = [];
  for (let k = 0; k < 5; k++) {
    if (h && revealed && h.board[k] !== undefined) board.push({ card: h.board[k]!, unplayed: k >= dealtBoard });
    else if (h && k < dealtBoard) {
      const mine = snap.view?.board[k];
      board.push({ card: mine !== undefined && mine !== -1 ? slotCard(mine) : null, unplayed: false });
    } else board.push({ card: null, unplayed: true });
  }

  const pots = h && h.phase !== "done" ? computePots(h) : [];
  const live = !!h && h.phase !== "done";
  const winners = new Set<number>();
  if (h?.result && !h.result.aborted && !h.result.convicted.length) for (const [j, v] of h.result.payouts) if (v > 0n) winners.add(j);

  return (
    <div className={`felt-wrap seats-${m}${status?.mine && status.betting && live ? " felt-your-turn" : ""}${h?.phase === "done" ? " felt-settled" : ""}`}>
      <div className="felt" aria-label={`Table ${t.id}`}>
        <div className="felt-inner">
          <div className="felt-signature" aria-hidden="true"><span>GNO POKER</span><span>THE PLAYER’S TABLE</span></div>
          <div className="felt-center">
            <div className="board" aria-label="Board">
              {board.map((b, k) => (
                <span key={k} className={b.unplayed && revealed ? "board-unplayed" : ""}>
                  {b.unplayed && !revealed ? <Card card={null} empty size="md" /> : <Card card={b.card} size="md" />}
                </span>
              ))}
            </div>
            {live && (
              <div className="pots" data-testid="pots">
                {pots.length <= 1 ? (
                  <span className="pot"><span className="pot-label">Pot</span> <strong>{formatChips(h!.pot)}</strong></span>
                ) : (
                  pots.map((p, i) => (
                    <span key={i} className="pot" title={`Can be won by ${p.eligible.map((j) => runner.seatName(h!.players[j]!.seat)).join(", ")}`}>
                      <span className="pot-label">{i === 0 ? "Main" : `Side ${i}`}</span> <strong>{formatChips(p.amount)}</strong>
                    </span>
                  ))
                )}
              </div>
            )}
            {status && (
              <div className={`status-pill ${status.mine ? "status-mine" : ""} ${!status.betting && live ? "status-protocol" : ""}`} data-testid="status-pill" title={status.detail}>
                <span className="status-label">{status.label}</span>
                {status.blocksLeft !== null && live && <span className={`status-blocks ${status.blocksLeft <= 5 ? "urgent" : ""}`}>{status.blocksLeft > 0 ? `${status.blocksLeft} blocks` : "deadline passed"}</span>}
                {snap.computing && <span className="status-work">computing</span>}
                {snap.tx && <span className="status-work">sending</span>}
              </div>
            )}
            {!h && <p className="felt-empty">Waiting for the first hand</p>}
          </div>
        </div>
      </div>

      {Array.from({ length: m }, (_, seatIdx) => {
        const display = (seatIdx - anchor + m) % m;
        const g = seatGeometry(display, m);
        const seat = t.seats[seatIdx] ?? null;
        const j = h ? h.players.findIndex((p) => p.seat === seatIdx) : -1;
        const p = j >= 0 ? h!.players[j]! : null;
        const isMe = seatIdx === snap.mySeat;
        const acting = !!status && live && status.turn === j && j >= 0 && ["shuffle", "rekey", "preflop", "flop", "turn", "river"].includes(h!.phase);
        const owing = live && j >= 0 && h!.owing.includes(j);
        const cards = seatCards(t, j, isMe, snap);
        const deadlineFrac = acting && status?.blocksLeft !== null && status ? Math.max(0, Math.min(1, status.blocksLeft! / t.actionTimeoutBlocks)) : 0;
        const tags: string[] = [];
        if (j === 0 && live) tags.push("SB");
        if (j === 1 && live) tags.push("BB");
        return (
          <div key={seatIdx}>
            <div
              className={`seat ${seat ? "" : "seat-open"} ${isMe ? "seat-me" : ""} ${acting ? "seat-acting" : ""} ${owing ? "seat-owing" : ""} ${p?.folded ? "seat-folded" : ""} ${winners.has(j) ? "seat-winner" : ""}`}
              style={g.seat}
              data-testid={`seat-${seatIdx}`}
            >
              {seat ? (
                <>
                  {cards.length > 0 && (
                    <div className="seat-cards">
                      {cards.map((c, k) => <Card key={k} card={c} size={isMe ? "md" : "sm"} />)}
                    </div>
                  )}
                  <div className="seat-plate">
                    {acting && status && <span className={`seat-turn-label${status.blocksLeft !== null && status.blocksLeft <= 5 ? " urgent" : ""}`}>
                      {status.betting ? (isMe ? "Your turn" : "To act") : "Working"}{" "}
                      {status.blocksLeft !== null && <span aria-label={`${Math.max(0, status.blocksLeft)} blocks left`}>{Math.max(0, status.blocksLeft)}<span className="clock-unit"> blocks</span></span>}
                    </span>}
                    <div className="seat-name">
                      <span>{isMe ? "You" : `Seat ${seatIdx + 1}`}</span>
                      {t.button === seatIdx && h && <span className="tag tag-button" title="Button">D</span>}
                      {tags.map((x) => <span key={x} className="tag">{x}</span>)}
                    </div>
                    <div className="seat-addr mono">{shortAddr(seat.owner)}</div>
                    <div className="seat-stack">{formatChips(seat.stack)}</div>
                    {p && live && p.streetBet > 0n && <div className="seat-bet">Bet {formatChips(p.streetBet)}</div>}
                    <SeatState seat={seat} p={p} h={h} j={j} />
                    {acting && <div className="deadline" aria-hidden="true"><span style={{ width: `${deadlineFrac * 100}%` }} /></div>}
                  </div>
                </>
              ) : (
                <div className="seat-plate seat-plate-open">Open seat</div>
              )}
            </div>
            {p && live && p.streetBet > 0n && (
              <div className="bet-chip" style={g.bet} data-testid={`bet-${seatIdx}`}>
                <span className="chip-stack" aria-hidden="true" />
                {formatChips(p.streetBet)}
              </div>
            )}
            {t.button === seatIdx && h && <div className="dealer-button" style={g.button} title="Button">D</div>}
          </div>
        );
      })}
    </div>
  );
}

function SeatState({ seat, p, h, j }: { seat: NonNullable<TableState["seats"][number]>; p: HandState["players"][number] | null; h: HandState | null; j: number }) {
  const out: { text: string; cls: string }[] = [];
  if (p?.folded) out.push({ text: "Folded", cls: "st-fold" });
  if (p?.allIn) out.push({ text: "All-in", cls: "st-allin" });
  if (seat.waiting) out.push({ text: "Next hand", cls: "st-wait" });
  if (seat.sittingOut) out.push({ text: "Sitting out", cls: "st-wait" });
  if (seat.leaving) out.push({ text: "Leaving", cls: "st-wait" });
  const r = h?.result;
  if (r && j >= 0) {
    if (r.convicted.includes(j)) out.push({ text: "Convicted", cls: "st-bad" });
    if (r.stallers.includes(j)) out.push({ text: "Timed out", cls: "st-bad" });
    const won = r.payouts.get(j);
    if (won && won > 0n) out.push({ text: `${r.aborted || r.convicted.length ? "Refund" : "Wins"} +${formatChips(won)}`, cls: "st-win" });
    const name = r.hands.get(j);
    if (name && !p?.folded) out.push({ text: name, cls: "st-hand" });
  }
  if (!out.length) return null;
  return (
    <div className="seat-state">
      {out.map((x) => <span key={x.text} className={`st ${x.cls}`}>{x.text}</span>)}
    </div>
  );
}

function seatCards(t: TableState, j: number, isMe: boolean, snap: RunnerSnapshot): CardValue[] {
  const h = t.hand;
  if (!h || j < 0) return [];
  const p = h.players[j]!;
  if (h.cards.size > 0) {
    const a = h.cards.get(2 * j);
    const b = h.cards.get(2 * j + 1);
    if (a !== undefined && b !== undefined) return [a, b];
  }
  if (!DEALT_PHASES.has(h.phase)) return [];
  if (isMe && snap.view) {
    return snap.view.hole.map((c) => (c === -1 ? null : slotCard(c)));
  }
  if (p.folded) return [];
  return [null, null];
}
