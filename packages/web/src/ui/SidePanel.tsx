import { useEffect, useRef, useState } from "react";
import { useApp } from "../App.tsx";
import { cleanGnot, formatAmount, formatChips, formatGnot, gnotInput, parseGnot } from "../config.ts";
import type { RunnerSnapshot, TableRunner } from "../engine/runner.ts";

type Tab = "log" | "fair" | "seat";

export function SidePanel({ snap, runner }: { snap: RunnerSnapshot; runner: TableRunner }) {
  const [tab, setTab] = useState<Tab>("log");
  return (
    <aside className="side" aria-label="Table information">
      <div className="tabs" role="tablist" aria-label="Table information">
        <button id="table-tab-log" role="tab" aria-controls="table-panel" aria-selected={tab === "log"} className={tab === "log" ? "on" : ""} onClick={() => setTab("log")} data-testid="tab-log">Hand log</button>
        <button id="table-tab-fair" role="tab" aria-controls="table-panel" aria-selected={tab === "fair"} className={tab === "fair" ? "on" : ""} onClick={() => setTab("fair")} data-testid="tab-fair">Why it's fair</button>
        <button id="table-tab-seat" role="tab" aria-controls="table-panel" aria-selected={tab === "seat"} className={tab === "seat" ? "on" : ""} onClick={() => setTab("seat")} data-testid="tab-seat">Seat</button>
      </div>
      <div id="table-panel" className="tab-body" role="tabpanel" aria-labelledby={`table-tab-${tab}`}>
        {tab === "log" && <Log snap={snap} />}
        {tab === "fair" && <Fair />}
        {tab === "seat" && <SeatTab snap={snap} runner={runner} />}
      </div>
    </aside>
  );
}

function Log({ snap }: { snap: RunnerSnapshot }) {
  const ref = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [snap.log.length]);
  if (!snap.log.length) return <p className="muted small">Events at this table appear here as they happen.</p>;
  let lastHand = -1;
  return (
    <ol className="log" ref={ref} data-testid="log" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {snap.log.map((e) => {
        const sep = e.handNo !== lastHand && e.kind === "hand";
        lastHand = e.handNo;
        return (
          <li key={e.id} className={`log-${e.kind}${sep ? " log-sep" : ""}`}>
            <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
            <span>{e.text}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Fair() {
  return (
    <div className="fair">
      <p>There is no dealer here. The players deal to each other, and the realm (the program on the chain) referees.</p>
      <ol>
        <li><strong>Everyone shuffles.</strong> Each player in turn shuffles the whole deck and locks every card with their own secret key. Nobody sees the order, because nobody holds all the keys.</li>
        <li><strong>Everyone re-locks.</strong> Each player then swaps their single lock for a separate key per card, so a card can be opened on its own.</li>
        <li><strong>Cards are dealt by sharing keys.</strong> To show you your hole cards, the others publish their keys for those two cards only. Board cards open the same way, for everyone at once.</li>
        <li><strong>Every secret comes out at the end.</strong> After the hand each player reveals the one random seed all their keys and their shuffle came from. Before the first shuffle they committed to it with a hash, so they cannot change it afterwards.</li>
        <li><strong>The realm settles from the seeds.</strong> It derives every card from the revealed seeds, ranks the hands and pays the pots. No one, including the last shuffler, can change what the chain computes.</li>
        <li><strong>Your browser checks everything.</strong> It recorded every deck pass as it happened and recomputes each one from the revealed seeds. If a player's deck does not match their seed, it sends a challenge: the realm checks that one card, and a cheater loses their entire stack to the other players.</li>
      </ol>
      <p>Stalling does not help either: a player who misses a deadline is checked or folded, and one who refuses to shuffle, share keys or reveal forfeits their stack.</p>
      <p className="muted small">Cryptography: commutative encryption (SRA) modulo a fixed 2048-bit safe prime, with each player's permutation and keys derived from a 32-byte seed by SHA-256.</p>
    </div>
  );
}

function SeatTab({ snap, runner }: { snap: RunnerSnapshot; runner: TableRunner }) {
  const app = useApp();
  const [amount, setAmount] = useState(gnotInput(BigInt(app.settings.gasAllowance || "0")));
  const t = snap.table;
  return (
    <div className="seat-tab">
      <dl className="kv">
        <dt>Your wallet</dt>
        <dd>{app.walletAddress ? <><span className="mono small">{app.walletAddress}</span><br />{snap.ownerBalance !== null ? `${formatGnot(snap.ownerBalance)} GNOT` : ""}</> : "Not connected"}</dd>
        {snap.seat && (
          <>
            <dt>Stack</dt>
            <dd>{formatChips(snap.seat.stack)}</dd>
          </>
        )}
        <dt>Session key</dt>
        <dd>
          {snap.sessionAddress ? (
            <>
              <span className="mono small" data-testid="session-address">{snap.sessionAddress}</span>
              <br />
              <span data-testid="session-balance">{snap.sessionBalance !== null ? `${formatGnot(snap.sessionBalance)} GNOT for gas` : "…"}</span>
            </>
          ) : (
            "None for this table in this browser"
          )}
        </dd>
        {snap.view && (
          <>
            <dt>This hand</dt>
            <dd>{snap.view.passesRecorded} of {snap.view.totalPasses} deck passes saved in this browser{snap.view.seedLost ? "; seed lost" : "; seed saved"}</dd>
          </>
        )}
        {t && (
          <>
            <dt>Table rules</dt>
            <dd className="small">
              Blinds {formatAmount(t.smallBlind)}/{formatChips(t.bigBlind)}, buy-in {formatAmount(t.minBuyIn)} to {formatChips(t.maxBuyIn)}. {t.actionTimeoutBlocks} blocks to act, {t.challengeWindowBlocks}-block challenge window, bond {formatChips(t.challengeBond)}. Challenges {app.challengesEnabled ? "enabled" : "disabled on this deployment"}.
            </dd>
          </>
        )}
      </dl>
      <p className="small muted">The session key signs shuffles, key shares and bets for you without pop-ups. It cannot withdraw your stack: only your wallet can leave and cash out.</p>
      {snap.sessionAddress && app.wallet && (
        <div className="refill">
          <label className="field">
            <span>Send gas to the session key (GNOT)</span>
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(cleanGnot(e.target.value))} />
          </label>
          <button className="btn btn-small" disabled={!!snap.tx || parseGnot(amount) === 0n} onClick={() => void runner.refillSession(parseGnot(amount))} data-testid="refill">Refill from wallet</button>
          <button className="btn btn-small btn-ghost" disabled={!!snap.tx || snap.mySeat >= 0} title={snap.mySeat >= 0 ? "Leave the table first" : ""} onClick={() => void runner.sweepSession()}>Return unused gas</button>
        </div>
      )}
      <label className="check small">
        <input type="checkbox" checked={app.settings.confirmChallenge} onChange={(e) => app.setSettings({ ...app.settings, confirmChallenge: e.target.checked })} />
        <span>Ask me before sending a challenge</span>
      </label>
    </div>
  );
}
