import { type TableSummary } from "@gno-poker/protocol";
import { useEffect, useState } from "react";
import { useApp } from "../App.tsx";
import { cleanGnot, formatAmount, formatChips, parseGnot } from "../config.ts";
import { JoinDialog } from "./JoinDialog.tsx";

const PHASE_LABEL: Record<string, string> = {
  "": "No hands yet", done: "Between hands", shuffle: "Shuffling", rekey: "Shuffling", deal_hole: "Dealing",
  preflop: "Pre-flop", deal_flop: "Dealing", flop: "Flop", deal_turn: "Dealing", turn: "Turn", deal_river: "Dealing",
  river: "River", reveal: "Showdown", challenge: "Verifying",
};

export function Lobby() {
  const app = useApp();
  const [tables, setTables] = useState<TableSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState<TableSummary | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const t = await app.client.listTables();
        if (!stop) {
          setTables(t);
          setError(null);
        }
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const timer = setInterval(load, 2500);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [app.client]);

  return (
    <div className="lobby">
      <section className="lobby-tables" aria-labelledby="tables-h">
        <div className="section-head">
          <span className="eyebrow">The open card room</span>
          <h1 id="tables-h">Tables</h1>
          <p className="muted">No dealer, no house. The deck is shuffled by the players at the table and every hand can be checked afterwards.</p>
          <div className="lobby-note"><span className="live-dot" aria-hidden="true" /> Texas Hold’em <span aria-hidden="true">·</span> Player shuffled <span aria-hidden="true">·</span> On-chain settlement</div>
        </div>
        {error && <p className="error-text">Could not load tables: {error}</p>}
        {tables === null && !error && <p className="muted">Loading tables…</p>}
        {tables?.length === 0 && <p className="empty">No tables yet. Open the first one.</p>}
        <div className="list-heading" aria-hidden="true"><span>Stakes / Buy-in</span><span>Players / Status</span></div>
        <ul className="table-list">
          {tables?.slice().reverse().map((t) => (
            <li key={t.id} className="table-row" data-testid={`table-row-${t.id}`}>
              <a className="table-row-main" href={`#/table/${t.id}`}>
                <span className="stakes">{formatAmount(t.smallBlind)}<span className="slash">/</span>{formatChips(t.bigBlind)}</span>
                <span className="table-meta">
                  <span className="table-name">Table {t.id}</span>
                  <span className="muted small">Buy-in {formatAmount(t.minBuyIn)} to {formatChips(t.maxBuyIn)}</span>
                </span>
                <span className="pips" aria-label={`${t.seated} of ${t.maxPlayers} seats taken`}>
                  {Array.from({ length: t.maxPlayers }, (_, i) => <span key={i} className={i < t.seated ? "pip on" : "pip"} />)}
                </span>
                <span className="phase small">{t.handNo > 0 ? `Hand ${t.handNo}: ` : ""}{PHASE_LABEL[t.phase] ?? t.phase}</span>
              </a>
              <button className="btn btn-small" disabled={t.seated >= t.maxPlayers} onClick={() => setJoining(t)} data-testid={`join-${t.id}`}>
                {t.seated >= t.maxPlayers ? "Full" : "Join"}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <CreateTable />
      {joining && (
        <JoinDialog table={joining} onClose={() => setJoining(null)} onJoined={() => { const id = joining.id; setJoining(null); app.navigate(`/table/${id}`); }} />
      )}
    </div>
  );
}

function CreateTable() {
  const app = useApp();
  const [f, setF] = useState({ sb: "0.001", bb: "0.002", min: "0.04", max: "0.2", players: "6", timeout: "40", window: "20", bond: "0.01" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const num = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v.replace(/\D/g, "") });
  const gnot = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: cleanGnot(v) });

  const create = async () => {
    if (!app.wallet) return app.openWallet();
    setBusy(true);
    setError(null);
    try {
      const id = await app.client.createTable(app.wallet, {
        smallBlind: parseGnot(f.sb), bigBlind: parseGnot(f.bb), minBuyIn: parseGnot(f.min), maxBuyIn: parseGnot(f.max),
        maxPlayers: Number(f.players), actionTimeoutBlocks: Number(f.timeout), challengeWindowBlocks: Number(f.window), challengeBond: parseGnot(f.bond),
      });
      app.navigate(`/table/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="create" aria-labelledby="create-h">
      <div className="create-heading"><span className="eyebrow">Make room for a good hand</span><h2 id="create-h">Open a table</h2></div>
      <div className="create-grid">
        <Num label="Small blind (GNOT)" value={f.sb} onChange={gnot("sb")} id="sb" decimal />
        <Num label="Big blind (GNOT)" value={f.bb} onChange={gnot("bb")} id="bb" decimal />
        <Num label="Minimum buy-in (GNOT)" value={f.min} onChange={gnot("min")} id="min" decimal />
        <Num label="Maximum buy-in (GNOT)" value={f.max} onChange={gnot("max")} id="max" decimal />
        <label className="field">
          <span>Seats</span>
          <select value={f.players} onChange={(e) => setF({ ...f, players: e.target.value })} data-testid="create-players">
            {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <Num label="Time to act (blocks)" value={f.timeout} onChange={num("timeout")} id="timeout" />
        <Num label="Challenge window (blocks)" value={f.window} onChange={num("window")} id="window" />
        <Num label="Challenge bond (GNOT)" value={f.bond} onChange={gnot("bond")} id="bond" decimal />
      </div>
      <p className="hint">A player who misses the time to act is checked or folded; one who stalls a shuffle or key share forfeits their stack.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <button className="btn btn-primary" disabled={busy} onClick={create} data-testid="create-table">{busy ? "Opening…" : app.wallet ? "Open table" : "Connect a wallet to open a table"}</button>
    </section>
  );
}

function Num({ label, value, onChange, id, decimal }: { label: string; value: string; onChange: (v: string) => void; id: string; decimal?: boolean }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input inputMode={decimal ? "decimal" : "numeric"} value={value} onChange={(e) => onChange(e.target.value)} data-testid={`create-${id}`} />
    </label>
  );
}
