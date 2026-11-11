// Chain plumbing for bots: connections, keys, a recording signer and realm addresses.

import { type CallRequest, type CallResult, type GnoEvent, type PokerSigner, fromHex } from "@gno-poker/protocol";
import { GnoQuerier, LocalKeySigner, RealmCallError, addressOfPrivateKey, generateSessionKey } from "@gno-poker/protocol/gno";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";

/** Mnemonic of gnodev's premined test1 account (g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5). */
export const TEST1_MNEMONIC =
  "source bonus chronic canvas draft south burst lottery vacant surface solve popular case indicate oppose farm nothing bullet exhibit title speed wink action roast";

/** Address of a package or realm: bech32("g", sha256("pkgPath:" + path)[:20]). */
export function pkgAddress(pkgPath: string): string {
  const h = sha256(new TextEncoder().encode("pkgPath:" + pkgPath)).slice(0, 20);
  return bech32.encode("g", bech32.toWords(h));
}

/** Parses "123ugnot" (the fee format). */
export function ugnotOf(coin: string): bigint {
  const m = /^(\d+)ugnot$/.exec(coin.trim());
  if (!m) throw new Error(`not a ugnot amount: ${coin}`);
  return BigInt(m[1]!);
}

/** Context a bot sets before a call so the record can be attributed to a hand. */
export interface CallTag {
  tableId?: number;
  handNo?: number;
  bot?: string;
}

export interface TxRecord extends CallTag {
  func: string;
  signer: string;
  ok: boolean;
  error?: string;
  gasWanted: bigint;
  gasUsed: bigint;
  fee: bigint;
  send: bigint;
  storageDeposit: bigint;
  events: GnoEvent[];
  height: number;
  ms: number;
  at: number;
}

/** Shared sink for every transaction sent through RecordingSigners. */
export class TxLog {
  readonly records: TxRecord[] = [];
  add(r: TxRecord): void {
    this.records.push(r);
  }
  /** Sum of TransferEvents from `from` to `to` (either may be undefined = any). */
  transfers(opts: { from?: string; to?: string }): bigint {
    let total = 0n;
    for (const r of this.records) {
      for (const e of r.events) {
        if (!(e["@type"] ?? "").endsWith("TransferEvent")) continue;
        if (opts.from !== undefined && e.from !== opts.from) continue;
        if (opts.to !== undefined && e.to !== opts.to) continue;
        total += coinsUgnot(e.coins);
      }
    }
    return total;
  }
}

function coinsUgnot(v: unknown): bigint {
  if (typeof v === "string") {
    let t = 0n;
    for (const part of v.split(",")) {
      const m = /^(\d+)ugnot$/.exec(part.trim());
      if (m) t += BigInt(m[1]!);
    }
    return t;
  }
  if (Array.isArray(v)) {
    let t = 0n;
    for (const c of v as { denom?: string; amount?: string | number }[]) if (c.denom === "ugnot") t += BigInt(c.amount ?? 0);
    return t;
  }
  return 0n;
}

/** PokerSigner that records every call (gas, fee, deposit, events) into a TxLog. */
export class RecordingSigner implements PokerSigner {
  readonly inner: LocalKeySigner;
  readonly address: string;
  readonly log: TxLog;
  tag: CallTag = {};

  private constructor(inner: LocalKeySigner, address: string, log: TxLog) {
    this.inner = inner;
    this.address = address;
    this.log = log;
  }

  static async create(q: GnoQuerier, privateKeyHex: string, log: TxLog): Promise<RecordingSigner> {
    const inner = await LocalKeySigner.create(q, privateKeyHex);
    return new RecordingSigner(inner, await inner.getAddress(), log);
  }

  static async fromMnemonic(q: GnoQuerier, mnemonic: string, log: TxLog, accountIndex = 0): Promise<RecordingSigner> {
    const inner = await LocalKeySigner.fromMnemonic(q, mnemonic, accountIndex);
    return new RecordingSigner(inner, await inner.getAddress(), log);
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async call(req: CallRequest): Promise<CallResult> {
    const t0 = Date.now();
    const base = {
      ...this.tag,
      func: req.func,
      signer: this.address,
      gasWanted: req.gasWanted,
      fee: ugnotOf(req.gasFee),
      send: req.send,
      at: t0,
    };
    try {
      const r = await this.inner.call(req);
      this.log.add({
        ...base,
        ok: true,
        gasUsed: r.gasUsed ?? 0n,
        storageDeposit: r.storageDeposit ?? 0n,
        events: r.events ?? [],
        height: r.height,
        ms: Date.now() - t0,
      });
      return r;
    } catch (e) {
      this.log.add({
        ...base,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        gasUsed: 0n,
        storageDeposit: 0n,
        events: [],
        height: 0,
        ms: Date.now() - t0,
      });
      throw e;
    }
  }

  async transfer(to: string, amount: bigint): Promise<void> {
    const t0 = Date.now();
    const fee = { gasWanted: 2_000_000n, gasFee: "2200ugnot" };
    let ok = true;
    let error: string | undefined;
    try {
      await this.inner.transfer(to, amount, fee);
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      this.log.add({
        ...this.tag,
        func: "transfer",
        signer: this.address,
        ok,
        ...(error !== undefined ? { error } : {}),
        gasWanted: fee.gasWanted,
        gasUsed: 0n,
        fee: ugnotOf(fee.gasFee),
        send: amount,
        storageDeposit: 0n,
        // MsgSend emits a TransferEvent, but no realm is involved: record it so balances add up.
        events: ok ? [{ "@type": "/bank.TransferEvent", from: this.address, to, coins: `${amount}ugnot` }] : [],
        height: 0,
        ms: Date.now() - t0,
        at: t0,
      });
    }
  }
}

/** A fresh random key with its address. */
export async function newKey(): Promise<{ privateKeyHex: string; address: string }> {
  return generateSessionKey();
}

export async function addressOf(privateKeyHex: string): Promise<string> {
  return addressOfPrivateKey(fromHex(privateKeyHex));
}

/** Short message of a realm error (the panic text when there is one). */
export function errorMessage(e: unknown): string {
  if (e instanceof RealmCallError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
