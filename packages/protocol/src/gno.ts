// Adapters from the transport-agnostic client interfaces to @gnolang/gno-js-client.
// Exported as "@gno-poker/protocol/gno" so the pure protocol code does not pull in the chain client.

import { GnoJSONRPCProvider, GnoWallet } from "@gnolang/gno-js-client";
import { TransactionEndpoint } from "@gnolang/tm2-js-client";
import { fromBase64, fromHex, randomBytes, toHex, utf8 } from "./bytes.ts";
import { type CallRequest, type CallResult, type GnoEvent, type PokerSigner, type RealmQuerier, storageDepositOf } from "./client.ts";

function decodeData(b64: string | null | undefined): string {
  return b64 ? new TextDecoder().decode(fromBase64(b64)) : "";
}

/** RealmQuerier over a gno JSON-RPC provider. Also exposes the current block height. */
export class GnoQuerier implements RealmQuerier {
  readonly provider: GnoJSONRPCProvider;

  constructor(provider: GnoJSONRPCProvider) {
    this.provider = provider;
  }

  static async connect(rpcUrl: string): Promise<GnoQuerier> {
    return new GnoQuerier(await GnoJSONRPCProvider.create(rpcUrl));
  }

  async evaluate(pkgPath: string, expr: string): Promise<string> {
    // Same wire format as GnoProvider.evaluateExpression, decoded without Buffer.
    const r = await this.provider.abciQuery({ path: "vm/qeval", data: utf8(`${pkgPath}.${expr}`), height: 0, prove: false });
    return decodeData(r.response.ResponseBase.Data);
  }

  async render(pkgPath: string, path: string): Promise<string> {
    const r = await this.provider.abciQuery({ path: "vm/qrender", data: utf8(`${pkgPath}:${path}`), height: 0, prove: false });
    return decodeData(r.response.ResponseBase.Data);
  }

  async height(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  async balance(address: string, denom = "ugnot"): Promise<number> {
    return this.provider.getBalance(address, denom);
  }
}

/**
 * PokerSigner backed by a raw secp256k1 private key (bots, browser session key).
 * Calls are serialized so account sequence numbers never race.
 */
export class LocalKeySigner implements PokerSigner {
  readonly wallet: GnoWallet;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(wallet: GnoWallet) {
    this.wallet = wallet;
  }

  static async create(provider: GnoJSONRPCProvider | GnoQuerier, privateKey: Uint8Array | string): Promise<LocalKeySigner> {
    const key = typeof privateKey === "string" ? fromHex(privateKey) : privateKey;
    const wallet = await GnoWallet.fromPrivateKey(key);
    wallet.connect(provider instanceof GnoQuerier ? provider.provider : provider);
    return new LocalKeySigner(wallet);
  }

  /** From a BIP39 mnemonic (e.g. the gnodev test1 account). */
  static async fromMnemonic(provider: GnoJSONRPCProvider | GnoQuerier, mnemonic: string, accountIndex = 0): Promise<LocalKeySigner> {
    const wallet = await GnoWallet.fromMnemonic(mnemonic, { accountIndex });
    wallet.connect(provider instanceof GnoQuerier ? provider.provider : provider);
    return new LocalKeySigner(wallet);
  }

  getAddress(): Promise<string> {
    return this.wallet.getAddress();
  }

  call(req: CallRequest): Promise<CallResult> {
    const run = async (): Promise<CallResult> => {
      const funds = req.send > 0n ? new Map([["ugnot", toSafeNumber(req.send)]]) : undefined;
      const deposit = req.maxDeposit !== undefined && req.maxDeposit > 0n ? new Map([["ugnot", toSafeNumber(req.maxDeposit)]]) : undefined;
      let res;
      try {
        res = await this.wallet.callMethod(
          req.pkgPath,
          req.func,
          req.args,
          TransactionEndpoint.BROADCAST_TX_COMMIT,
          funds,
          deposit,
          { gas_wanted: req.gasWanted, gas_fee: req.gasFee },
        );
      } catch (e) {
        throw RealmCallError.wrap(req.func, e);
      }
      const events = parseEvents(res.deliver_tx.ResponseBase.Events);
      return {
        hash: res.hash,
        height: Number(res.height),
        data: decodeData(res.deliver_tx.ResponseBase.Data),
        gasUsed: BigInt(res.deliver_tx.GasUsed || "0"),
        events,
        storageDeposit: storageDepositOf(events),
      };
    };
    return this.enqueue(run);
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Sends ugnot to an address (bank MsgSend) and waits for inclusion. Serialized with call(). */
  transfer(to: string, amount: bigint, fee: { gasWanted: bigint; gasFee: string } = { gasWanted: 2_000_000n, gasFee: "2200ugnot" }): Promise<{ hash: string; height: number }> {
    return this.enqueue(async () => {
      try {
        const res = await this.wallet.transferFunds(
          to,
          new Map([["ugnot", toSafeNumber(amount)]]),
          TransactionEndpoint.BROADCAST_TX_COMMIT,
          { gas_wanted: fee.gasWanted, gas_fee: fee.gasFee },
        );
        return { hash: res.hash, height: Number(res.height) };
      } catch (e) {
        throw RealmCallError.wrap("transfer", e);
      }
    });
  }
}

/** A failed MsgCall. `log` holds the node's log (the realm panic message is in there). */
export class RealmCallError extends Error {
  readonly func: string;
  readonly log: string;
  constructor(func: string, message: string, log: string, cause: unknown) {
    super(message, { cause });
    this.name = "RealmCallError";
    this.func = func;
    this.log = log;
  }
  static wrap(func: string, e: unknown): RealmCallError {
    const base = e instanceof Error ? e.message : String(e);
    const log = typeof (e as { log?: unknown })?.log === "string" ? (e as { log: string }).log : "";
    const panic = /panic: ([^\n]*)/.exec(log)?.[1]?.trim();
    return new RealmCallError(func, panic ? `${func}: ${panic}` : `${func}: ${base}`, log, e);
  }
}

function parseEvents(raw: unknown): GnoEvent[] {
  if (Array.isArray(raw)) return raw as GnoEvent[];
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as GnoEvent[]) : [];
  } catch {
    return [];
  }
}

function toSafeNumber(x: bigint): number {
  if (x > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount too large");
  return Number(x);
}

export interface SessionKey {
  /** 32-byte secp256k1 private key, hex. Keep it secret; it can sign table actions. */
  privateKeyHex: string;
  address: string;
}

/** Generates a fresh random session key and its g1 address. */
export async function generateSessionKey(): Promise<SessionKey> {
  for (;;) {
    const key = randomBytes(32);
    try {
      const wallet = await GnoWallet.fromPrivateKey(key);
      return { privateKeyHex: toHex(key), address: await wallet.getAddress() };
    } catch {
      // Out-of-range scalar (probability ~2^-128); draw again.
    }
  }
}

/** Address of a private key. */
export async function addressOfPrivateKey(privateKey: Uint8Array | string): Promise<string> {
  const key = typeof privateKey === "string" ? fromHex(privateKey) : privateKey;
  return (await GnoWallet.fromPrivateKey(key)).getAddress();
}
