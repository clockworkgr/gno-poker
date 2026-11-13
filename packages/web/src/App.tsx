import { PokerClient } from "@gno-poker/protocol";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { GnoRpc } from "./chain/rpc.ts";
import type { WalletSigner } from "./chain/signer.ts";
import { type Settings, WEB_GAS, loadSettings, saveSettings } from "./config.ts";
import { ProtocolClient } from "./engine/protocolClient.ts";
import { Header } from "./ui/Header.tsx";
import { Lobby } from "./ui/Lobby.tsx";
import { SettingsDialog } from "./ui/SettingsDialog.tsx";
import { TableView } from "./ui/TableView.tsx";
import { WalletDialog } from "./ui/WalletDialog.tsx";
import { type WalletPrefs, connectWallet, loadWalletPrefs, saveWalletPrefs } from "./wallet.ts";

export interface AppCtx {
  settings: Settings;
  setSettings: (s: Settings) => void;
  rpc: GnoRpc;
  client: PokerClient;
  protocol: () => ProtocolClient;
  challengesEnabled: boolean;
  chainOk: boolean | null;
  chainError: string | null;
  height: number;
  wallet: WalletSigner | null;
  walletAddress: string | null;
  walletPrefs: WalletPrefs;
  openWallet: () => void;
  navigate: (route: string) => void;
}

const Ctx = createContext<AppCtx | null>(null);
export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("no app context");
  return c;
}

function readRoute(): string {
  return window.location.hash.replace(/^#/, "") || "/";
}

export function App() {
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const [walletPrefs, setWalletPrefs] = useState<WalletPrefs>(loadWalletPrefs);
  const [wallet, setWallet] = useState<WalletSigner | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [route, setRoute] = useState(readRoute);
  const [chain, setChain] = useState<{ ok: boolean | null; error: string | null; height: number; challenges: boolean }>({ ok: null, error: null, height: 0, challenges: true });

  const rpc = useMemo(() => new GnoRpc(settings.rpcUrl), [settings.rpcUrl]);
  const client = useMemo(() => new PokerClient({ querier: { evaluate: (p, e) => rpc.qeval(p, e) }, pkgPath: settings.realm, gas: WEB_GAS }), [rpc, settings.realm]);
  const protoRef = useRef<{ key: string; p: ProtocolClient } | null>(null);
  const protocol = useCallback(() => {
    const key = `${settings.rpcUrl}|${settings.realm}`;
    if (!protoRef.current || protoRef.current.key !== key) {
      protoRef.current?.p.terminate();
      protoRef.current = { key, p: new ProtocolClient(settings.rpcUrl, settings.realm) };
    }
    return protoRef.current.p;
  }, [settings.rpcUrl, settings.realm]);

  const setSettings = useCallback((s: Settings) => {
    setSettingsState(s);
    saveSettings(s);
  }, []);

  // Theme
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  // Route
  useEffect(() => {
    const on = () => setRoute(readRoute());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const navigate = useCallback((r: string) => {
    window.location.hash = r;
  }, []);

  // Chain health: chain id, height, challenges flag
  useEffect(() => {
    let stop = false;
    const check = async () => {
      try {
        const st = await rpc.status();
        let challenges = true;
        try {
          challenges = await client.challengesEnabled();
        } catch {
          // realm missing: reported below
        }
        if (stop) return;
        if (st.network !== settings.chainId) {
          setChain({ ok: false, error: `Node reports chain "${st.network}", settings say "${settings.chainId}".`, height: st.height, challenges });
        } else {
          setChain({ ok: true, error: null, height: st.height, challenges });
        }
      } catch (e) {
        if (!stop) setChain((c) => ({ ...c, ok: false, error: e instanceof Error ? e.message : String(e) }));
      }
    };
    void check();
    const t = setInterval(check, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [rpc, client, settings.chainId]);

  // Reconnect the saved wallet (dev wallet silently; Adena only when its extension is present).
  useEffect(() => {
    if (!walletPrefs.mode) return;
    let cancelled = false;
    connectWallet(walletPrefs, rpc, settings.chainId)
      .then(async (w) => {
        if (cancelled) return;
        setWallet(w);
        setWalletAddress(await w.getAddress());
      })
      .catch(() => {
        if (!cancelled) {
          setWallet(null);
          setWalletAddress(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [walletPrefs, rpc, settings.chainId]);

  const onWalletConnect = async (p: WalletPrefs) => {
    const w = await connectWallet(p, rpc, settings.chainId);
    setWalletPrefs(p);
    saveWalletPrefs(p);
    setWallet(w);
    setWalletAddress(await w.getAddress());
    setWalletOpen(false);
  };
  const onWalletDisconnect = () => {
    const p = { ...walletPrefs, mode: null };
    setWalletPrefs(p);
    saveWalletPrefs(p);
    setWallet(null);
    setWalletAddress(null);
    setWalletOpen(false);
  };

  const ctx: AppCtx = {
    settings, setSettings, rpc, client, protocol,
    challengesEnabled: chain.challenges, chainOk: chain.ok, chainError: chain.error, height: chain.height,
    wallet, walletAddress, walletPrefs, openWallet: () => setWalletOpen(true), navigate,
  };

  const tableMatch = /^\/table\/(\d+)/.exec(route);

  return (
    <Ctx.Provider value={ctx}>
      <div className={`app${tableMatch ? " app-table" : ""}`}>
        <Header onSettings={() => setSettingsOpen(true)} />
        {chain.ok === false && (
          <div className="banner banner-error" role="alert">
            Cannot use the node at {settings.rpcUrl}: {chain.error} <button className="link" onClick={() => setSettingsOpen(true)}>Change connection</button>
          </div>
        )}
        <main className="main">
          {tableMatch ? <TableView key={`${tableMatch[1]}|${walletAddress}|${settings.rpcUrl}|${settings.realm}`} tableId={Number(tableMatch[1])} /> : <Lobby />}
        </main>
      </div>
      {walletOpen && <WalletDialog prefs={walletPrefs} connected={!!wallet} onConnect={onWalletConnect} onDisconnect={onWalletDisconnect} onClose={() => setWalletOpen(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </Ctx.Provider>
  );
}
