// Owner wallet selection: Adena (real use) or an in-browser development key (local gnodev only).

import { AdenaSigner } from "./chain/adena.ts";
import { TEST1_MNEMONIC, keyPairFromMnemonic, keyPairFromPrivate } from "./chain/keys.ts";
import type { GnoRpc } from "./chain/rpc.ts";
import { LocalSigner, type WalletSigner } from "./chain/signer.ts";

export interface DevWalletConfig {
  source: "mnemonic" | "privateKey";
  mnemonic: string;
  index: number;
  privateKey: string;
}

export interface WalletPrefs {
  mode: "dev" | "adena" | null;
  dev: DevWalletConfig;
}

const KEY = "gno-poker:wallet";

export const DEFAULT_DEV: DevWalletConfig = { source: "mnemonic", mnemonic: TEST1_MNEMONIC, index: 0, privateKey: "" };

export function loadWalletPrefs(): WalletPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<WalletPrefs>;
      return { mode: p.mode ?? null, dev: { ...DEFAULT_DEV, ...(p.dev ?? {}) } };
    }
  } catch {
    // ignore
  }
  return { mode: null, dev: { ...DEFAULT_DEV } };
}

export function saveWalletPrefs(p: WalletPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}

export function devSigner(cfg: DevWalletConfig, rpc: GnoRpc, chainId: string): LocalSigner {
  const key = cfg.source === "privateKey" ? keyPairFromPrivate(cfg.privateKey) : keyPairFromMnemonic(cfg.mnemonic, cfg.index);
  return new LocalSigner({ key, rpc, chainId, kind: "dev" });
}

export async function connectWallet(p: WalletPrefs, rpc: GnoRpc, chainId: string): Promise<WalletSigner> {
  if (p.mode === "adena") return AdenaSigner.connect("Gno Poker", chainId);
  return devSigner(p.dev, rpc, chainId);
}
