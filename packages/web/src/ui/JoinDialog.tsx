import { useState } from "react";
import { useApp } from "../App.tsx";
import { cleanGnot, formatAmount, formatChips, formatGnot, gnotInput, parseGnot } from "../config.ts";
import { createSessionKey } from "../engine/sessionKeys.ts";
import { Dialog } from "./Dialog.tsx";

export interface JoinTarget {
  id: number;
  minBuyIn: bigint;
  maxBuyIn: bigint;
  bigBlind: bigint;
  smallBlind: bigint;
}

export function JoinDialog({ table, onClose, onJoined }: { table: JoinTarget; onClose: () => void; onJoined: () => void }) {
  const app = useApp();
  const mid = (table.minBuyIn + table.maxBuyIn) / 2n;
  const [buyIn, setBuyIn] = useState(gnotInput(mid - (mid % table.bigBlind)));
  const [allowance, setAllowance] = useState(gnotInput(BigInt(app.settings.gasAllowance || "0")));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const b = parseGnot(buyIn);
  const g = parseGnot(allowance);
  const invalid = b < table.minBuyIn || b > table.maxBuyIn ? `Buy-in must be between ${formatAmount(table.minBuyIn)} and ${formatChips(table.maxBuyIn)}.` : null;

  const join = async () => {
    if (!app.wallet || !app.walletAddress) return app.openWallet();
    setBusy(true);
    setError(null);
    try {
      // The key is stored before the transaction is sent, so it is never lost if the page closes mid-join.
      const sk = createSessionKey(app.settings.chainId, app.settings.realm, table.id, app.walletAddress);
      await app.client.join(app.wallet, table.id, b, sk.address, g);
      onJoined();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Take a seat at table ${table.id}`} onClose={onClose}>
      <p className="muted">Blinds {formatAmount(table.smallBlind)} / {formatChips(table.bigBlind)}. Your wallet signs this one transaction; it sends the buy-in to the table and a gas allowance to a new session key that plays for you.</p>
      <label className="field">
        <span>Buy-in (GNOT)</span>
        <input inputMode="decimal" value={buyIn} onChange={(e) => setBuyIn(cleanGnot(e.target.value))} data-testid="buyin" />
        <input type="range" min={Number(table.minBuyIn)} max={Number(table.maxBuyIn)} step={Number(table.bigBlind)} value={Number(b)} onChange={(e) => setBuyIn(gnotInput(BigInt(e.target.value)))} aria-label="Buy-in" />
        <span className="hint">{formatAmount(table.minBuyIn)} to {formatChips(table.maxBuyIn)}</span>
      </label>
      <label className="field">
        <span>Gas allowance for the session key (GNOT)</span>
        <input inputMode="decimal" value={allowance} onChange={(e) => setAllowance(cleanGnot(e.target.value))} data-testid="allowance" />
        <span className="hint">{formatGnot(g)} GNOT pays for about {Math.max(0, Math.floor(Number(g) / 400_000))} hands of protocol fees. The first shuffle at a new table also locks about 1.4 GNOT of storage deposit.</span>
      </label>
      <p className="total">Total from your wallet: <strong>{formatGnot(b + g)} GNOT</strong></p>
      {invalid && <p className="error-text">{invalid}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !!invalid} onClick={join} data-testid="confirm-join">
          {busy ? "Joining…" : app.wallet ? "Join table" : "Connect a wallet first"}
        </button>
      </div>
    </Dialog>
  );
}
