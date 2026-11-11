import { useState } from "react";
import { adenaAvailable } from "../chain/adena.ts";
import { keyPairFromMnemonic, keyPairFromPrivate } from "../chain/keys.ts";
import { type WalletPrefs, DEFAULT_DEV } from "../wallet.ts";
import { Dialog } from "./Dialog.tsx";

// The in-browser development key is offered only when the app is built or served with
// VITE_DEV_WALLET=1 (the browser tests do this). It is never shown otherwise.
const DEV_WALLET = import.meta.env.VITE_DEV_WALLET === "1";

export function WalletDialog({ prefs, connected, onConnect, onDisconnect, onClose }: {
  prefs: WalletPrefs;
  connected: boolean;
  onConnect: (p: WalletPrefs) => Promise<void>;
  onDisconnect: () => void;
  onClose: () => void;
}) {
  const [dev, setDev] = useState(prefs.dev);
  const [busy, setBusy] = useState<"adena" | "dev" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasAdena = adenaAvailable();

  let preview = "";
  try {
    preview = dev.source === "privateKey" ? (dev.privateKey ? keyPairFromPrivate(dev.privateKey).address : "") : keyPairFromMnemonic(dev.mnemonic, dev.index).address;
  } catch (e) {
    preview = "";
  }

  const go = async (mode: "adena" | "dev") => {
    setBusy(mode);
    setError(null);
    try {
      await onConnect({ mode, dev });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog title="Wallet" onClose={onClose}>
      <p className="muted">
        Your wallet signs only joining, topping up and leaving a table. Everything during play is signed by a
        session key this browser creates for each table.
      </p>
      <section className="wallet-option">
        <h3>Adena</h3>
        <p className="muted small">The Adena browser extension holds your account. Use this on a public network.</p>
        <button className="btn btn-primary" disabled={!hasAdena || busy !== null} onClick={() => go("adena")}>
          {busy === "adena" ? "Waiting for Adena…" : "Connect Adena"}
        </button>
        {!hasAdena && <p className="small muted">Adena is not installed in this browser.</p>}
      </section>
      {DEV_WALLET && <section className="wallet-option wallet-option-dev">
        <h3>Development key</h3>
        <p className="small warn-text">
          For a local gnodev only. The key is kept in this browser's storage in plain text; the default is the
          public test1 mnemonic.
        </p>
        <div className="seg" role="radiogroup" aria-label="Key source">
          <button role="radio" aria-checked={dev.source === "mnemonic"} className={dev.source === "mnemonic" ? "on" : ""} onClick={() => setDev({ ...dev, source: "mnemonic" })}>Mnemonic</button>
          <button role="radio" aria-checked={dev.source === "privateKey"} className={dev.source === "privateKey" ? "on" : ""} onClick={() => setDev({ ...dev, source: "privateKey" })}>Private key</button>
        </div>
        {dev.source === "mnemonic" ? (
          <>
            <label className="field">
              <span>Mnemonic</span>
              <textarea rows={3} value={dev.mnemonic} onChange={(e) => setDev({ ...dev, mnemonic: e.target.value })} spellCheck={false} />
            </label>
            <label className="field field-inline">
              <span>Account index</span>
              <input type="number" min={0} value={dev.index} onChange={(e) => setDev({ ...dev, index: Math.max(0, Number(e.target.value) || 0) })} data-testid="dev-index" />
            </label>
            <button className="link small" onClick={() => setDev({ ...DEFAULT_DEV, index: dev.index })}>Use the test1 mnemonic</button>
          </>
        ) : (
          <label className="field">
            <span>Private key (hex)</span>
            <input type="password" value={dev.privateKey} onChange={(e) => setDev({ ...dev, privateKey: e.target.value })} spellCheck={false} />
          </label>
        )}
        <p className="small">Address: <span className="mono">{preview || "invalid key"}</span></p>
        <button className="btn" disabled={!preview || busy !== null} onClick={() => go("dev")} data-testid="use-dev-wallet">
          Use development key
        </button>
      </section>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {connected && <button className="btn btn-ghost" onClick={onDisconnect}>Disconnect</button>}
    </Dialog>
  );
}
