// App settings (persisted per browser) and chain defaults from Vite env.

import type { GasSettings, TxName } from "@gno-poker/protocol";

export interface Settings {
  rpcUrl: string;
  chainId: string;
  realm: string;
  theme: "system" | "light" | "dark";
  /** Ask before sending a challenge after a failed verification. */
  confirmChallenge: boolean;
  pollMs: number;
  /** Default gas allowance forwarded to a new session key on Join, ugnot. */
  gasAllowance: string;
  /** Warn when the session key holds less than this, ugnot. */
  lowGasWarning: string;
}

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const DEFAULT_SETTINGS: Settings = {
  rpcUrl: env.VITE_GNO_RPC_URL || "http://127.0.0.1:26657",
  chainId: env.VITE_GNO_CHAIN_ID || "dev",
  realm: env.VITE_POKER_REALM || "gno.land/r/demo/poker",
  theme: "system",
  confirmChallenge: false,
  pollMs: 1000,
  gasAllowance: "5000000",
  lowGasWarning: "1000000",
};

const KEY = "gno-poker:settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // ignore
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

/**
 * Gas per transaction. Deck passes measured at about 75M gas on gnodev, Challenge about 29M,
 * RevealSeed up to 15M, other calls 4-9M; the minimum gas price is 1 ugnot per 1000 gas.
 * These are explicit until the protocol library ships measured defaults.
 */
function g(gas: number): GasSettings {
  return { gasWanted: BigInt(gas), gasFee: `${Math.ceil(gas / 1000)}ugnot` };
}

export const WEB_GAS: Record<TxName, GasSettings> = {
  CreateTable: g(15_000_000),
  Join: g(15_000_000),
  TopUp: g(12_000_000),
  Leave: g(15_000_000),
  SitOut: g(12_000_000),
  SitIn: g(12_000_000),
  StartHand: g(30_000_000),
  SubmitShuffle: g(95_000_000),
  SubmitRekey: g(95_000_000),
  // Grows with the number of keys: the hole deal of a 6-player hand (10 keys) used just over 15M.
  ShareKeys: g(40_000_000),
  Act: g(15_000_000),
  RevealSeed: g(35_000_000),
  Accept: g(30_000_000),
  Challenge: g(45_000_000),
  Finalize: g(40_000_000),
  Timeout: g(40_000_000),
};

/** Most a session key can spend on one protocol transaction, plus the first deck write's storage deposit. */
export const FIRST_DECK_DEPOSIT = 1_400_000n;

export function formatGnot(ugnot: bigint, digits = 3): string {
  const neg = ugnot < 0n;
  const v = neg ? -ugnot : ugnot;
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").slice(0, digits).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? "." + frac : ""}`;
}

/** A table amount (held in ugnot) as a bare GNOT number, exact to the ugnot. */
export function formatAmount(v: bigint): string {
  return formatGnot(v, 6);
}

/** A table amount (held in ugnot) shown in GNOT, with the unit. */
export function formatChips(v: bigint): string {
  return `${formatAmount(v)} GNOT`;
}

/** Keeps what a person may type for a GNOT amount: digits and one decimal point, at most 6 decimals. */
export function cleanGnot(text: string): string {
  const t = text.replace(/,/g, ".").replace(/[^\d.]/g, "");
  const dot = t.indexOf(".");
  if (dot < 0) return t;
  return t.slice(0, dot + 1) + t.slice(dot + 1).replace(/\./g, "").slice(0, 6);
}

/** Parses a typed GNOT amount into ugnot; empty or malformed input is 0. */
export function parseGnot(text: string): bigint {
  const t = cleanGnot(text);
  if (!/\d/.test(t)) return 0n;
  const [whole = "", frac = ""] = t.split(".");
  return BigInt(whole || "0") * 1_000_000n + BigInt(frac.padEnd(6, "0") || "0");
}

/** An ugnot amount as plain GNOT text for an input field (no thousands separators). */
export function gnotInput(ugnot: bigint): string {
  const frac = (ugnot % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${ugnot / 1_000_000n}${frac ? "." + frac : ""}`;
}

export function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 7)}…${a.slice(-4)}` : a;
}
