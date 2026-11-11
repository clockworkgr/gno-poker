import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useApp } from "../App.tsx";
import { formatAmount, formatChips, formatGnot, shortAddr } from "../config.ts";
import { type RunnerSnapshot, TableRunner } from "../engine/runner.ts";
import { handStatus } from "../engine/status.ts";
import { ActionDock } from "./ActionDock.tsx";
import { Felt } from "./Felt.tsx";
import { JoinDialog } from "./JoinDialog.tsx";
import { SidePanel } from "./SidePanel.tsx";

export function TableView({ tableId }: { tableId: number }) {
  const app = useApp();
  const [runner, setRunner] = useState<TableRunner | null>(null);
  const settingsRef = useRef(app.settings);
  settingsRef.current = app.settings;

  useEffect(() => {
    const r = new TableRunner({
      tableId,
      rpc: app.rpc,
      client: app.client,
      protocol: app.protocol(),
      chainId: app.settings.chainId,
      realm: app.settings.realm,
      owner: app.wallet,
      ownerAddress: app.walletAddress,
      challengesEnabled: app.challengesEnabled,
      confirmChallenge: () => settingsRef.current.confirmChallenge,
      pollMs: () => settingsRef.current.pollMs,
    });
    r.start();
    setRunner(r);
    return () => r.stop();
    // The parent keys this view on table, wallet and connection, so these are stable for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!runner) return null;
  return <TableScreen runner={runner} />;
}

function TableScreen({ runner }: { runner: TableRunner }) {
  const app = useApp();
  const s: RunnerSnapshot = useSyncExternalStore(runner.subscribe, runner.getSnapshot);
  const [joining, setJoining] = useState(false);
  const t = s.table;

  if (!t) {
    return (
      <div className="table-loading">
        {s.error ? <p className="error-text">Could not load table {runner.o.tableId}: {s.error}</p> : <p className="muted">Loading table {runner.o.tableId}…</p>}
        <a href="#/" className="link">Back to tables</a>
      </div>
    );
  }

  const myIndex = s.view?.myIndex ?? (t.hand ? t.hand.players.findIndex((p) => p.seat === s.mySeat) : -1);
  const status = handStatus(t, myIndex, runner.seatName);
  const lowGas = s.sessionBalance !== null && s.seat?.session && s.sessionBalance < BigInt(app.settings.lowGasWarning || "0");
  const freeSeat = t.seats.some((x) => x === null);

  return (
    <div className="table-screen">
      <div className="table-bar">
        <a href="#/" className="back-link">Tables</a>
        <h1 className="table-title">
          Table {t.id} <span className="muted">{formatAmount(t.smallBlind)}/{formatChips(t.bigBlind)}</span>
        </h1>
        <div className="table-bar-right">
          {s.seat && s.seat.session && (
            <span className={`gas-chip ${lowGas ? "gas-low" : ""}`} title={`Session key ${s.sessionAddress ?? ""}`} data-testid="gas-chip">
              Gas {s.sessionBalance === null ? "…" : `${formatGnot(s.sessionBalance, 2)} GNOT`}
            </span>
          )}
          {s.mySeat < 0 && freeSeat && (
            <button className="btn btn-primary btn-small" onClick={() => (app.wallet ? setJoining(true) : app.openWallet())} data-testid="join-here">
              Take a seat
            </button>
          )}
        </div>
      </div>

      {s.notice && (
        <div className={`banner banner-${s.notice.tone}`} role="status">
          {s.notice.text} <button className="link" onClick={() => runner.clearNotice()}>Dismiss</button>
        </div>
      )}
      {s.sessionKeyMissing && (
        <div className="banner banner-error" role="alert">
          You are seated here, but this browser does not hold the seat's session key ({shortAddr(s.seat?.session ?? "")}), so it cannot shuffle, deal or bet for you. Open the table in the browser you joined from, or leave the table to cash out.
        </div>
      )}
      {s.view?.seedLost && t.hand && !["challenge", "done"].includes(t.hand.phase) && (
        <div className="banner banner-error" role="alert">
          This browser lost your secret seed for hand {t.hand.handNo}. You cannot finish this hand: when its deadline passes you will be timed out and lose your stack at this table.
        </div>
      )}
      {lowGas && (
        <div className="banner banner-warn" role="status">
          Your session key is low on gas ({formatGnot(s.sessionBalance ?? 0n, 2)} GNOT). Refill it from the Seat tab before it runs out, or your protocol steps will fail and you will be timed out.
        </div>
      )}

      <div className="table-layout">
        <div className="stage">
          <Felt snap={s} runner={runner} status={status} />
          <ActionDock snap={s} runner={runner} status={status} />
        </div>
        <SidePanel snap={s} runner={runner} />
      </div>

      {joining && (
        <JoinDialog table={t} onClose={() => setJoining(false)} onJoined={() => { setJoining(false); runner.loadSession(); void runner.tick(); void runner.refreshBalances(); }} />
      )}
    </div>
  );
}
