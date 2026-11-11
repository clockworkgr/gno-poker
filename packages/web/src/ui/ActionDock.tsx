import type { BetOptions, OwedAction } from "@gno-poker/protocol";
import { type CSSProperties, useEffect, useState } from "react";
import { useApp } from "../App.tsx";
import { cleanGnot, formatChips, gnotInput, parseGnot } from "../config.ts";
import { type VerifySummary, slotCard } from "../engine/protocolCore.ts";
import type { RunnerSnapshot, TableRunner } from "../engine/runner.ts";
import { type HandStatus, eligibleSeats } from "../engine/status.ts";
import { Card } from "./Card.tsx";

export function ActionDock({ snap, runner, status }: { snap: RunnerSnapshot; runner: TableRunner; status: HandStatus | null }) {
  const app = useApp();
  const t = snap.table!;
  const h = t.hand;
  const v = snap.view;
  const live = !!h && h.phase !== "done";
  const myIndex = v?.myIndex ?? (h ? h.players.findIndex((p) => p.seat === snap.mySeat) : -1);
  const inHand = myIndex >= 0 && live;
  const a = v?.action;

  if (snap.mySeat < 0) {
    return (
      <div className="dock dock-quiet" data-testid="dock">
        <p className="dock-head">{app.wallet ? "You are watching this table." : "Connect a wallet to take a seat."}</p>
        {snap.notice && <p className="muted small">{snap.notice.text}</p>}
        {snap.sessionAddress && snap.sessionBalance !== null && snap.sessionBalance > 2000n && (
          <button className="btn btn-small" disabled={!!snap.tx} onClick={() => void runner.sweepSession()} data-testid="sweep">Return unused gas to my wallet</button>
        )}
      </div>
    );
  }

  const hole = inHand || (h && myIndex >= 0) ? (v?.hole ?? []).map((c) => (c === -1 ? null : slotCard(c))) : [];
  const revealedHole = h && myIndex >= 0 && h.cards.size > 0 ? [h.cards.get(2 * myIndex), h.cards.get(2 * myIndex + 1)] : null;
  const showHole = revealedHole && revealedHole.every((c) => c !== undefined) ? (revealedHole as number[]) : hole.some((c) => c !== null) ? hole : [];

  let head: string;
  let sub: string | null = null;
  let tone = "";
  if (snap.tx) {
    head = `${snap.tx.label}…`;
    sub = "Waiting for the transaction to be included in a block.";
  } else if (inHand && a?.type === "bet") {
    head = "Your turn";
    tone = "dock-turn";
    sub = status?.blocksLeft != null ? `${Math.max(0, status.blocksLeft)} blocks left before you are checked or folded automatically` : null;
  } else if (snap.computing) {
    head = h?.phase === "rekey" ? "Computing your re-key pass" : "Computing your shuffle";
    sub = "Encrypting all 52 cards; this runs in the background.";
  } else if (inHand && h!.phase === "challenge") {
    const ver = v?.verification;
    const accepted = h!.players[myIndex]?.accepted;
    if (snap.pendingChallenge) head = "The deck does not match a revealed seed";
    else if (accepted) head = "You accepted the result. Waiting for the others to verify.";
    else if (ver && !ver.ok) head = ver.kind === "missing" ? "This hand cannot be verified in this browser" : "Challenging the mismatched deck pass";
    else head = "Checking every deck pass against the revealed seeds";
    sub = status?.blocksLeft != null ? `Challenge window: ${Math.max(0, status.blocksLeft)} blocks left.` : null;
  } else if (inHand && status) {
    head = status.detail;
    sub = status.mine ? "Handled automatically by your session key." : null;
  } else if (h && h.phase === "done" && myIndex >= 0) {
    head = resultHeadline(snap, myIndex, runner);
  } else if (snap.seat?.waiting) {
    head = "You are seated. You will be dealt in from the next hand.";
  } else {
    head = "Between hands";
  }

  const result = h?.phase === "done" ? h.result : null;
  const resultTone = result ? (result.aborted || result.convicted.length ? "dock-void" : "dock-settled") : "";
  const eyebrow = tone ? "Action required"
    : result ? (result.aborted || result.convicted.length ? "Hand voided" : "Hand settled")
    : h && live ? `Hand ${h.handNo} · ${status?.betting ? "At the table" : "Protocol"}`
    : "At the table";
  const blocks = status?.blocksLeft;
  const deadlineWidth = blocks != null ? Math.max(0, Math.min(100, blocks / t.actionTimeoutBlocks * 100)) : 0;

  return (
    <div className={`dock ${tone} ${resultTone}${tone && blocks != null && blocks <= 5 ? " dock-urgent" : ""}`} data-testid="dock">
      <div className="dock-main">
        {showHole.length > 0 && (
          <div className="dock-cards" data-testid="my-cards">
            {showHole.map((c, k) => <Card key={k} card={c} size="lg" />)}
          </div>
        )}
        <div className="dock-text">
          <span className="eyebrow dock-eyebrow">{eyebrow}</span>
          <p className="dock-head" data-testid="dock-head">{head}</p>
          {sub && <p className="dock-sub">{sub}</p>}
          {snap.lastError && !snap.tx && Date.now() - snap.lastError.at < 30_000 && (
            <p className="error-text small" role="alert" data-testid="tx-error">{snap.lastError.message}</p>
          )}
        </div>
        {tone && blocks != null && <div className="turn-clock"><strong>{Math.max(0, blocks)}</strong><span>blocks left</span></div>}
      </div>
      {tone && blocks != null && <div className="turn-countdown" aria-hidden="true"><span style={{ width: `${deadlineWidth}%` }} /></div>}

      {inHand && a?.type === "bet" && !snap.tx && snap.sentBetId !== a.id && (
        <BetControls key={a.id} options={a.options} pot={h!.pot} currentBet={h!.currentBet} bigBlind={t.bigBlind} streetBet={h!.players[myIndex]!.streetBet} onAct={(act, amt) => void runner.act(act, amt)} />
      )}

      {snap.stuck && !snap.tx && (
        <div className="dock-row">
          <p className="small">Sending “{describe(snap.stuck)}” failed three times.</p>
          <button className="btn btn-small" onClick={() => void runner.retryStuck()} data-testid="retry">Try again</button>
        </div>
      )}

      {snap.pendingChallenge && !snap.tx && (
        <div className="dock-row dock-alarm">
          <p>Verification failed. Send a challenge? The bond of {formatChips(t.challengeBond)} is taken from your stack and returned if the accused is guilty.</p>
          <button className="btn btn-danger" onClick={() => void runner.confirmChallenge()} data-testid="send-challenge">Send challenge</button>
        </div>
      )}

      {(a?.type === "timeout" || a?.type === "finalize") && !snap.tx && (
        <div className="dock-row">
          <p className="small">{a.type === "timeout" ? "The deadline has passed. Anyone may now enforce it: a stalled bet is checked or folded, a stalled protocol step aborts the hand and the staller forfeits." : "The challenge window is over; the hand can be finalized and paid out."}</p>
          <button className="btn btn-small" onClick={() => void runner.timeoutOrFinalize()} data-testid={a.type}>{a.type === "timeout" ? "Enforce timeout" : "Finalize hand"}</button>
        </div>
      )}

      {v?.verification && h && (h.phase === "challenge" || h.phase === "done") && <VerifyBox v={v.verification} runner={runner} />}

      <SeatControls snap={snap} runner={runner} />
    </div>
  );
}

function resultHeadline(snap: RunnerSnapshot, myIndex: number, runner: TableRunner): string {
  const h = snap.table!.hand!;
  const r = h.result;
  if (!r) return "Hand over";
  if (r.convicted.length) {
    const names = r.convicted.map((j) => (j === myIndex ? "you" : runner.seatName(h.players[j]!.seat))).join(", ");
    return `Hand voided: ${names} convicted of cheating. Bets refunded, the cheater's stack shared out.`;
  }
  if (r.aborted) {
    const names = r.stallers.map((j) => (j === myIndex ? "you" : runner.seatName(h.players[j]!.seat))).join(", ");
    return `Hand aborted${names ? `: ${names} missed a deadline and forfeited` : ""}.`;
  }
  const mine = r.payouts.get(myIndex) ?? 0n;
  const name = r.hands.get(myIndex);
  if (mine > 0n) return `You won ${formatChips(mine)}${name ? ` with ${name}` : ""}.`;
  const winners = [...r.payouts].filter(([, x]) => x > 0n).map(([j, x]) => `${runner.seatName(h.players[j]!.seat)} won ${formatChips(x)}${r.hands.get(j) ? ` with ${r.hands.get(j)}` : ""}`);
  return winners.length ? `${winners.join("; ")}.` : "Hand over.";
}

function describe(a: OwedAction): string {
  const m: Record<string, string> = { submitShuffle: "shuffle", submitRekey: "re-key", shareKeys: "share keys", revealSeed: "reveal seed", accept: "accept", challenge: "challenge" };
  return m[a.type] ?? a.type;
}

function BetControls({ options, pot, currentBet, bigBlind, streetBet, onAct }: {
  options: BetOptions;
  pot: bigint;
  currentBet: bigint;
  bigBlind: bigint;
  streetBet: bigint;
  onAct: (a: "fold" | "check" | "call" | "raise", amount?: bigint) => void;
}) {
  const { toCall, canCheck, minRaiseTo, maxRaiseTo, stack } = options;
  const [raiseTo, setRaiseTo] = useState<bigint>(minRaiseTo ?? maxRaiseTo);
  const [text, setText] = useState(gnotInput(minRaiseTo ?? maxRaiseTo));
  useEffect(() => setText(gnotInput(raiseTo)), [raiseTo]);
  const clamp = (x: bigint) => (minRaiseTo === null ? maxRaiseTo : x < minRaiseTo ? minRaiseTo : x > maxRaiseTo ? maxRaiseTo : x);
  const canRaise = minRaiseTo !== null;
  const opening = currentBet === 0n;
  const callAllIn = toCall >= stack;
  const potRaise = clamp(currentBet + pot + toCall);
  const halfPot = clamp(currentBet + (pot + toCall) / 2n);
  const step = bigBlind > 0n ? bigBlind : 1n;
  const activePreset = raiseTo === maxRaiseTo ? "allin" : raiseTo === minRaiseTo ? "min" : raiseTo === halfPot ? "half" : raiseTo === potRaise ? "pot" : null;

  return (
    <div className="bet-controls" data-testid="bet-controls">
      <div className="bet-buttons">
        <button className="btn btn-fold" onClick={() => onAct("fold")} data-testid="act-fold">Fold</button>
        {canCheck ? (
          <button className="btn btn-call" onClick={() => onAct("check")} data-testid="act-check">Check</button>
        ) : (
          <button className="btn btn-call" onClick={() => onAct("call")} data-testid="act-call">
            {callAllIn ? `Call all-in ${formatChips(toCall)}` : `Call ${formatChips(toCall)}`}
          </button>
        )}
        {canRaise && (
          <button className="btn btn-raise" onClick={() => onAct("raise", raiseTo)} data-testid="act-raise">
            {raiseTo === maxRaiseTo ? `All-in ${formatChips(maxRaiseTo)}` : `${opening ? "Bet" : "Raise to"} ${formatChips(raiseTo)}`}
          </button>
        )}
      </div>
      {canRaise && minRaiseTo !== maxRaiseTo && (
        <div className="raise-row">
          <input
            type="range"
            min={Number(minRaiseTo)}
            max={Number(maxRaiseTo)}
            step={Number(step)}
            value={Number(raiseTo)}
            onChange={(e) => setRaiseTo(clamp(BigInt(e.target.value)))}
            aria-label={opening ? "Bet amount" : "Raise to"}
            data-testid="raise-slider"
            style={{ "--range-fill": `${Number(raiseTo - minRaiseTo!) / Number(maxRaiseTo - minRaiseTo!) * 100}%` } as CSSProperties}
          />
          <input
            className="raise-input"
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(cleanGnot(e.target.value))}
            onBlur={() => setRaiseTo(clamp(parseGnot(text)))}
            onKeyDown={(e) => { if (e.key === "Enter") setRaiseTo(clamp(parseGnot(text))); }}
            aria-label="Amount (GNOT)"
            data-testid="raise-input"
          />
          <div className="presets">
            <button className={`chip-btn${activePreset === "min" ? " selected" : ""}`} aria-pressed={activePreset === "min"} onClick={() => setRaiseTo(minRaiseTo!)}>Min</button>
            <button className={`chip-btn${activePreset === "half" ? " selected" : ""}`} aria-pressed={activePreset === "half"} onClick={() => setRaiseTo(halfPot)}>½ pot</button>
            <button className={`chip-btn${activePreset === "pot" ? " selected" : ""}`} aria-pressed={activePreset === "pot"} onClick={() => setRaiseTo(potRaise)}>Pot</button>
            <button className={`chip-btn${activePreset === "allin" ? " selected" : ""}`} aria-pressed={activePreset === "allin"} onClick={() => setRaiseTo(maxRaiseTo)} data-testid="preset-allin">All-in</button>
          </div>
        </div>
      )}
      {!canRaise && <p className="small muted">You cannot raise: {stack <= toCall ? "a call puts you all-in" : "the betting was not reopened"}.</p>}
      <p className="small muted">In front of you this street: {formatChips(streetBet)}. Stack behind: {formatChips(stack)}.</p>
    </div>
  );
}

function VerifyBox({ v, runner }: { v: VerifySummary; runner: TableRunner }) {
  const h = runner.getSnapshot().table!.hand!;
  const who = (j: number) => runner.seatName(h.players[j]!.seat);
  if (v.ok) {
    return (
      <div className="verify verify-ok" data-testid="verify-ok">
        <strong>Verified.</strong> All {v.passes} deck passes match the seeds the players revealed: nobody could have known or steered the cards.
      </div>
    );
  }
  if (v.kind === "missing") {
    return (
      <div className="verify verify-bad" data-testid="verify-missing">
        <strong>Cannot verify</strong> {who(v.accused)}'s pass {v.seq + 1}: {v.reason}. This browser did not record that pass, so it neither accepts nor challenges.
      </div>
    );
  }
  const step = v.kind === "shuffle" ? "shuffle" : "re-key";
  return (
    <div className="verify verify-bad" role="alert" data-testid="verify-bad">
      <strong>Verification failed.</strong> {who(v.accused)}'s {step} (deck pass {v.seq + 1}) does not follow from their revealed seed at position {v.index}.
      <dl className="verify-detail">
        <dt>Input element</dt><dd className="mono">{trimHex(v.inHex)}</dd>
        <dt>Published output</dt><dd className="mono">{trimHex(v.outHex)}</dd>
        <dt>Check</dt><dd>{v.kind === "shuffle" ? "output ≠ input ^ e (mod P), with e derived from the seed" : "output ^ e ≠ input ^ k (mod P), with e and the card key k derived from the seed"}</dd>
      </dl>
    </div>
  );
}

function trimHex(h: string): string {
  const s = h.replace(/^0+/, "");
  return s.length > 24 ? `${s.slice(0, 12)}…${s.slice(-12)}` : s;
}

function SeatControls({ snap, runner }: { snap: RunnerSnapshot; runner: TableRunner }) {
  const t = snap.table!;
  const seat = snap.seat!;
  const h = t.hand;
  const live = !!h && h.phase !== "done";
  const inLiveHand = live && h!.players.some((p) => p.seat === snap.mySeat);
  const eligible = eligibleSeats(t);
  const canStart = !live && eligible.length >= 2 && !seat.waiting;
  const busted = !inLiveHand && seat.stack < t.bigBlind;
  const [topUp, setTopUp] = useState("");
  const room = t.maxBuyIn - seat.stack;

  return (
    <div className="seat-controls">
      {busted && <p className="warn-text small" data-testid="busted">You have {formatChips(seat.stack)} left, less than the big blind, so you are not dealt in. Top up or leave the table.</p>}
      {!live && eligible.length < 2 && <p className="small muted">Waiting for another player with chips to sit in.</p>}
      <div className="seat-buttons">
        {canStart && (
          <button className="btn btn-primary" disabled={!!snap.tx} onClick={() => void runner.startHand()} data-testid="start-hand">Deal next hand</button>
        )}
        {!inLiveHand && room > 0n && (
          <span className="topup">
            <input inputMode="decimal" placeholder={`Top up, max ${formatChips(room)}`} value={topUp} onChange={(e) => setTopUp(cleanGnot(e.target.value))} aria-label="Top-up amount (GNOT)" />
            <button className="btn btn-small" disabled={!!snap.tx || parseGnot(topUp) === 0n || parseGnot(topUp) > room} onClick={() => void runner.topUp(parseGnot(topUp)).then((ok) => ok && setTopUp(""))}>Top up</button>
          </span>
        )}
        <button className="btn btn-small btn-ghost" disabled={!!snap.tx} onClick={() => void runner.sitOut(!seat.sittingOut)} data-testid="sit-toggle">
          {seat.sittingOut ? "Sit back in" : "Sit out next hand"}
        </button>
        <button className="btn btn-small btn-ghost" disabled={!!snap.tx || seat.leaving} onClick={() => void runner.leave()} data-testid="leave">
          {seat.leaving ? "Leaving after this hand" : inLiveHand ? "Leave after this hand" : "Leave and cash out"}
        </button>
      </div>
    </div>
  );
}
