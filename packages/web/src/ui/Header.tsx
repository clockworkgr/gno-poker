import { useApp } from "../App.tsx";
import { shortAddr } from "../config.ts";

export function Header({ onSettings }: { onSettings: () => void }) {
  const app = useApp();
  return (
    <header className="header">
      <a className="wordmark" href="#/" aria-label="Gno Poker lobby">
        <svg className="brand-mark" viewBox="0 0 40 40" width="38" height="38" aria-hidden="true">
          <circle cx="20" cy="20" r="18.5" fill="var(--felt-deep)" stroke="var(--brass)" />
          <circle cx="20" cy="20" r="14.5" fill="none" stroke="var(--brass)" strokeDasharray="2 7.1" />
          <path d="M20 10c4 4.3 8 7.2 8 10.5a3.9 3.9 0 0 1-6.6 2.9l1.4 4h-5.6l1.4-4a3.9 3.9 0 0 1-6.6-2.9c0-3.3 4-6.2 8-10.5z" fill="var(--brass)" />
        </svg>
        <span>Gno Poker</span>
      </a>
      <div className="header-right">
        <span className={`chain-dot ${app.chainOk ? "ok" : app.chainOk === false ? "bad" : ""}`} title={app.chainOk ? `Connected to ${app.settings.chainId} at block ${app.height}` : "Not connected"}>
          {app.settings.chainId}{app.height ? ` #${app.height}` : ""}
        </span>
        <button className={`wallet-chip ${app.wallet ? "" : "wallet-chip-empty"}`} onClick={app.openWallet} data-testid="wallet-button">
          {app.wallet ? (
            <>
              <span className={`wallet-kind wallet-kind-${app.wallet.kind}`}>{app.wallet.kind === "dev" ? "Dev key" : "Adena"}</span>
              <span className="mono">{shortAddr(app.walletAddress ?? "")}</span>
            </>
          ) : (
            "Connect wallet"
          )}
        </button>
        <button className="icon-btn" onClick={onSettings} aria-label="Settings" title="Settings">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm8.4 4.6.1-1.1-.1-1.1 2-1.6-2-3.4-2.4 1a8 8 0 0 0-1.9-1.1L15.7 3h-4l-.4 2.6a8 8 0 0 0-1.9 1.1l-2.4-1-2 3.4 2 1.6-.1 1.1.1 1.1-2 1.6 2 3.4 2.4-1a8 8 0 0 0 1.9 1.1l.4 2.6h4l.4-2.6a8 8 0 0 0 1.9-1.1l2.4 1 2-3.4-2-1.6z" /></svg>
        </button>
      </div>
    </header>
  );
}
