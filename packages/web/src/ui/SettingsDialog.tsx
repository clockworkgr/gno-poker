import { useState } from "react";
import { useApp } from "../App.tsx";
import { DEFAULT_SETTINGS, cleanGnot, gnotInput, parseGnot, type Settings } from "../config.ts";
import { Dialog } from "./Dialog.tsx";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [s, setS] = useState<Settings>(app.settings);
  // Stored in ugnot, edited in GNOT.
  const [gasAllowance, setGasAllowance] = useState(gnotInput(BigInt(app.settings.gasAllowance || "0")));
  const [lowGasWarning, setLowGasWarning] = useState(gnotInput(BigInt(app.settings.lowGasWarning || "0")));
  const save = () => {
    app.setSettings({ ...s, gasAllowance: parseGnot(gasAllowance).toString(), lowGasWarning: parseGnot(lowGasWarning).toString(), pollMs: Math.max(300, Number(s.pollMs) || 1000) });
    onClose();
  };
  return (
    <Dialog title="Settings" onClose={onClose}>
      <fieldset className="fields">
        <legend>Network</legend>
        <label className="field"><span>RPC URL</span><input value={s.rpcUrl} onChange={(e) => setS({ ...s, rpcUrl: e.target.value })} /></label>
        <label className="field"><span>Chain ID</span><input value={s.chainId} onChange={(e) => setS({ ...s, chainId: e.target.value })} /></label>
        <label className="field"><span>Realm path</span><input value={s.realm} onChange={(e) => setS({ ...s, realm: e.target.value })} /></label>
      </fieldset>
      <fieldset className="fields">
        <legend>Play</legend>
        <label className="check">
          <input type="checkbox" checked={s.confirmChallenge} onChange={(e) => setS({ ...s, confirmChallenge: e.target.checked })} data-testid="confirm-challenge" />
          <span>Ask me before sending a challenge when verification fails</span>
        </label>
        <label className="field field-inline"><span>Gas allowance for a new seat (GNOT)</span><input inputMode="decimal" value={gasAllowance} onChange={(e) => setGasAllowance(cleanGnot(e.target.value))} /></label>
        <label className="field field-inline"><span>Warn when the session key holds less than (GNOT)</span><input inputMode="decimal" value={lowGasWarning} onChange={(e) => setLowGasWarning(cleanGnot(e.target.value))} /></label>
        <label className="field field-inline"><span>Poll interval (ms)</span><input inputMode="numeric" value={s.pollMs} onChange={(e) => setS({ ...s, pollMs: Number(e.target.value.replace(/\D/g, "")) })} /></label>
      </fieldset>
      <fieldset className="fields">
        <legend>Appearance</legend>
        <div className="seg" role="radiogroup" aria-label="Theme">
          {(["system", "light", "dark"] as const).map((t) => (
            <button key={t} role="radio" aria-checked={s.theme === t} className={s.theme === t ? "on" : ""} onClick={() => setS({ ...s, theme: t })} data-testid={`theme-${t}`}>
              {t === "system" ? "Match system" : t === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="dialog-actions">
        <button className="btn btn-ghost" onClick={() => setS({ ...DEFAULT_SETTINGS, theme: s.theme })}>Reset to defaults</button>
        <button className="btn btn-primary" onClick={save} data-testid="save-settings">Save</button>
      </div>
    </Dialog>
  );
}
