// Typed wrapper over the realm API (protocol section 7). Transport-agnostic: queries go through a
// RealmQuerier and transactions through a PokerSigner, so the same code serves bots (local key),
// the browser session key and an Adena adapter.

import { parseDeck, type Deck } from "./deck.ts";
import type { ChallengeArgs } from "./hand.ts";
import { parseGnoBool, parseGnoResults, parseGnoString } from "./gostring.ts";
import { parseTableJSON, parseTableListJSON, type TableState, type TableSummary } from "./table.ts";

export const DEFAULT_PKG_PATH = "gno.land/r/demo/poker";

/** Evaluates a read-only expression in a realm (vm/qeval) and returns the raw result text. */
export interface RealmQuerier {
  evaluate(pkgPath: string, expr: string): Promise<string>;
  /** Raw Render output (vm/qrender). Optional. */
  render?(pkgPath: string, path: string): Promise<string>;
}

/** One MsgCall. Every argument is passed as a string, as gno expects. */
export interface CallRequest {
  pkgPath: string;
  func: string;
  args: string[];
  /** ugnot attached to the call (0 = none). */
  send: bigint;
  /** Optional storage deposit limit, ugnot. */
  maxDeposit?: bigint;
  gasWanted: bigint;
  /** Fee coin string, e.g. "1000000ugnot". */
  gasFee: string;
  memo?: string;
}

export interface CallResult {
  hash: string;
  height: number;
  /** Raw result text, e.g. "(1 uint64)". "" if the function returns nothing. */
  data: string;
  gasUsed?: bigint;
  /** Events emitted by the transaction, as decoded JSON (when the signer reports them). */
  events?: GnoEvent[];
  /**
   * Net storage deposit charged to the caller in ugnot: locked minus refunded (negative when
   * the transaction freed realm storage). Undefined when the signer does not report it.
   */
  storageDeposit?: bigint;
}

/** One transaction event as the node reports it (JSON object with an "@type" field). */
export interface GnoEvent {
  "@type"?: string;
  [key: string]: unknown;
}

/** Sums StorageDepositEvent / StorageUnlockEvent amounts (ugnot): locked minus refunded. */
export function storageDepositOf(events: readonly GnoEvent[]): bigint {
  let total = 0n;
  for (const e of events) {
    const t = e["@type"] ?? "";
    const coin = (v: unknown): bigint => {
      const m = typeof v === "string" ? /^(\d+)ugnot$/.exec(v) : null;
      return m ? BigInt(m[1]!) : 0n;
    };
    if (t.endsWith("StorageDepositEvent")) total += coin(e.fee_delta);
    else if (t.endsWith("StorageUnlockEvent") && e.refund_withheld !== true) total -= coin(e.fee_refund);
  }
  return total;
}

/**
 * Anything that can sign and broadcast a MsgCall and wait for its inclusion.
 * Implementations: LocalKeySigner (in "@gno-poker/protocol/gno"); the web UI adds an Adena adapter.
 * Implementations must throw if the transaction fails.
 */
export interface PokerSigner {
  getAddress(): Promise<string>;
  call(req: CallRequest): Promise<CallResult>;
}

export interface GasSettings {
  gasWanted: bigint;
  gasFee: string;
  maxDeposit?: bigint;
}

export type TxName =
  | "CreateTable" | "Join" | "TopUp" | "Leave" | "SitOut" | "SitIn" | "StartHand"
  | "SubmitShuffle" | "SubmitRekey" | "ShareKeys" | "Act" | "RevealSeed" | "Accept"
  | "Challenge" | "Finalize" | "Timeout";

/**
 * Minimum gas price of gno.land chains at genesis (1 ugnot per 1000 gas). The fee of a transaction
 * is charged in full whatever the gas used, so gasWanted should stay close to the real need.
 */
export const DEFAULT_GAS_PRICE = { ugnot: 1n, gas: 1000n } as const;

/**
 * Fee for `gasWanted` at `price`, plus `marginPct` percent (default 10) so that a small rise of the
 * dynamic gas price does not reject the transaction. Returns e.g. "82500ugnot".
 */
export function feeForGas(gasWanted: bigint, price: { ugnot: bigint; gas: bigint } = DEFAULT_GAS_PRICE, marginPct = 10n): string {
  const base = (gasWanted * price.ugnot + price.gas - 1n) / price.gas;
  return `${(base * (100n + marginPct) + 99n) / 100n}ugnot`;
}

function gas(gasWanted: bigint, maxDeposit?: bigint): GasSettings {
  return maxDeposit === undefined ? { gasWanted, gasFee: feeForGas(gasWanted) } : { gasWanted, gasFee: feeForGas(gasWanted), maxDeposit };
}

/**
 * Defaults measured against the realm on a gnodev built from gno master (see README, "Gas"):
 * gasWanted is the largest observed use over 2 to 6 player tables plus headroom. maxDeposit caps the
 * storage deposit (100 ugnot per byte on gno.land): the first deck pass of a table stores 13312
 * bytes (about 1.4 GNOT), later passes overwrite it in place.
 */
export const DEFAULT_GAS: Record<TxName, GasSettings> = {
  CreateTable: gas(8_000_000n, 500_000n),
  Join: gas(9_000_000n, 500_000n),
  TopUp: gas(10_000_000n, 300_000n),
  Leave: gas(10_000_000n, 300_000n),
  SitOut: gas(8_000_000n, 300_000n),
  SitIn: gas(8_000_000n, 300_000n),
  StartHand: gas(20_000_000n, 3_000_000n),
  SubmitShuffle: gas(95_000_000n, 3_000_000n),
  SubmitRekey: gas(95_000_000n, 3_000_000n),
  ShareKeys: gas(26_000_000n, 500_000n),
  Act: gas(15_000_000n, 300_000n),
  RevealSeed: gas(40_000_000n, 1_500_000n),
  Accept: gas(12_000_000n, 300_000n),
  Challenge: gas(45_000_000n, 500_000n),
  Finalize: gas(12_000_000n, 300_000n),
  Timeout: gas(25_000_000n, 1_500_000n),
};

export interface CreateTableParams {
  smallBlind: bigint;
  bigBlind: bigint;
  minBuyIn: bigint;
  maxBuyIn: bigint;
  maxPlayers: number;
  actionTimeoutBlocks: number | bigint;
  challengeWindowBlocks: number | bigint;
  challengeBond: bigint;
}

export type BetAction = "fold" | "check" | "call" | "raise";

/** Per-call overrides. */
export type TxOptions = Partial<GasSettings> & { memo?: string };

type Id = number | bigint;

export interface PokerClientOptions {
  querier: RealmQuerier;
  pkgPath?: string;
  /** Overrides merged over DEFAULT_GAS. */
  gas?: Partial<Record<TxName, Partial<GasSettings>>>;
}

export class PokerClient {
  readonly pkgPath: string;
  readonly querier: RealmQuerier;
  private readonly gas: Record<TxName, GasSettings>;

  constructor(opts: PokerClientOptions) {
    this.querier = opts.querier;
    this.pkgPath = opts.pkgPath ?? DEFAULT_PKG_PATH;
    const gas = { ...DEFAULT_GAS };
    for (const [k, v] of Object.entries(opts.gas ?? {})) {
      const name = k as TxName;
      gas[name] = withFee(gas[name], v);
    }
    this.gas = gas;
  }

  /** Effective gas settings for a transaction (defaults merged with the constructor overrides). */
  gasFor(func: TxName): GasSettings {
    return { ...this.gas[func] };
  }

  // Queries

  private async evalString(expr: string): Promise<string> {
    return parseGnoString(await this.querier.evaluate(this.pkgPath, expr));
  }

  async listTables(): Promise<TableSummary[]> {
    return parseTableListJSON(await this.evalString("ListTables()"));
  }

  async getTable(tableId: Id): Promise<TableState> {
    return parseTableJSON(await this.evalString(`GetTable(${uint(tableId)})`));
  }

  /** Current deck as base64, or "" if the realm holds none. */
  async getDeckB64(tableId: Id): Promise<string> {
    return this.evalString(`GetDeck(${uint(tableId)})`);
  }

  /** Current deck parsed (without validation), or null if the realm holds none. */
  async getDeck(tableId: Id): Promise<Deck | null> {
    const b64 = await this.getDeckB64(tableId);
    return b64 === "" ? null : parseDeck(b64, false);
  }

  async challengesEnabled(): Promise<boolean> {
    return parseGnoBool(await this.querier.evaluate(this.pkgPath, "ChallengesEnabled()"));
  }

  async render(path = ""): Promise<string> {
    if (this.querier.render) return this.querier.render(this.pkgPath, path);
    return this.evalString(`Render(${JSON.stringify(path)})`);
  }

  // Transactions

  private async tx(signer: PokerSigner, func: TxName, args: string[], send: bigint, opts?: TxOptions): Promise<CallResult> {
    const { memo: _memo, ...o } = opts ?? {};
    const g = withFee(this.gas[func], o);
    const req: CallRequest = {
      pkgPath: this.pkgPath,
      func,
      args,
      send,
      gasWanted: g.gasWanted,
      gasFee: g.gasFee,
    };
    if (g.maxDeposit !== undefined) req.maxDeposit = g.maxDeposit;
    if (opts?.memo !== undefined) req.memo = opts.memo;
    return signer.call(req);
  }

  /** Creates a table and returns its id. */
  async createTable(signer: PokerSigner, p: CreateTableParams, opts?: TxOptions): Promise<number> {
    if (p.maxPlayers < 2 || p.maxPlayers > 6) throw new Error("maxPlayers must be 2..6");
    const r = await this.tx(signer, "CreateTable", [
      int(p.smallBlind), int(p.bigBlind), int(p.minBuyIn), int(p.maxBuyIn), int(p.maxPlayers),
      int(p.actionTimeoutBlocks), int(p.challengeWindowBlocks), int(p.challengeBond),
    ], 0n, opts);
    const vs = parseGnoResults(r.data);
    if (vs.length === 1) return Number(vs[0]!.value);
    // Some wallets (Adena) do not hand back the call's return value. The transaction succeeded,
    // so find the table in the list: the newest untouched one with these parameters.
    const match = (await this.listTables())
      .filter((t) => t.handNo === 0 && t.seated === 0 && t.maxPlayers === p.maxPlayers
        && t.smallBlind === BigInt(p.smallBlind) && t.bigBlind === BigInt(p.bigBlind)
        && t.minBuyIn === BigInt(p.minBuyIn) && t.maxBuyIn === BigInt(p.maxBuyIn)
        && t.actionTimeoutBlocks === Number(p.actionTimeoutBlocks)
        && t.challengeWindowBlocks === Number(p.challengeWindowBlocks)
        && t.challengeBond === BigInt(p.challengeBond))
      .reduce((best, t) => Math.max(best, t.id), 0);
    if (match === 0) throw new Error(`CreateTable: the transaction succeeded but the new table was not found (result "${r.data}")`);
    return match;
  }

  /**
   * Owner only. Sends `buyIn + gasAllowance` ugnot; the realm forwards `gasAllowance` to `session`.
   * Pass session "" (and gasAllowance 0) to act directly from the owner account.
   */
  async join(signer: PokerSigner, tableId: Id, buyIn: bigint, session: string, gasAllowance: bigint, opts?: TxOptions): Promise<CallResult> {
    if (session === "" && gasAllowance !== 0n) throw new Error("gasAllowance must be 0 without a session");
    return this.tx(signer, "Join", [uint(tableId), session, int(gasAllowance)], buyIn + gasAllowance, opts);
  }
  async topUp(signer: PokerSigner, tableId: Id, amount: bigint, opts?: TxOptions): Promise<CallResult> {
    return this.tx(signer, "TopUp", [uint(tableId)], amount, opts);
  }
  async leave(signer: PokerSigner, tableId: Id, opts?: TxOptions): Promise<CallResult> {
    return this.tx(signer, "Leave", [uint(tableId)], 0n, opts);
  }
  async sitOut(signer: PokerSigner, tableId: Id, opts?: TxOptions): Promise<CallResult> {
    return this.tx(signer, "SitOut", [uint(tableId)], 0n, opts);
  }
  async sitIn(signer: PokerSigner, tableId: Id, opts?: TxOptions): Promise<CallResult> {
    return this.tx(signer, "SitIn", [uint(tableId)], 0n, opts);
  }
  async startHand(signer: PokerSigner, tableId: Id, opts?: TxOptions): Promise<CallResult> {
    return this.tx(signer, "StartHand", [uint(tableId)], 0n, opts);
  }
  async submitShuffle(signer: PokerSigner, tableId: Id, handNo: Id, commitHex: string, deckB64: string, opts?: TxOptions): Promise<CallResult> {
    return this.tx(signer, "SubmitShuffle", [uint(tableId), uint(handNo), commitHex, deckB64], 0n, opts);
  }
  async submitRekey(signer: PokerSigner, tableId: Id, handNo: Id, deckB64: string, opts?: TxOptions): Promise<CallResult> {
    return this.tx(signer, "SubmitRekey", [uint(tableId), uint(handNo), deckB64], 0n, opts);
  }
  async shareKeys(signer: PokerSigner, tableId: Id, handNo: Id, keysHex: string, opts?: TxOptions): Promise<CallResult> {
    return this.tx(signer, "ShareKeys", [uint(tableId), uint(handNo), keysHex], 0n, opts);
  }
  /** For "raise", amount is the total street bet after the action; otherwise it is ignored (sent as 0). */
  async act(signer: PokerSigner, tableId: Id, handNo: Id, action: BetAction, amount: bigint = 0n, opts?: TxOptions): Promise<CallResult> {
    return this.tx(signer, "Act", [uint(tableId), uint(handNo), action, int(action === "raise" ? amount : 0n)], 0n, opts);
  }
  async revealSeed(signer: PokerSigner, tableId: Id, handNo: Id, seedHex: string, opts?: TxOptions): Promise<CallResult> {
    return this.tx(signer, "RevealSeed", [uint(tableId), uint(handNo), seedHex], 0n, opts);
  }
  async accept(signer: PokerSigner, tableId: Id, handNo: Id, opts?: TxOptions): Promise<CallResult> {
    return this.tx(signer, "Accept", [uint(tableId), uint(handNo)], 0n, opts);
  }
  /** `bond` > 0 attaches the bond in ugnot (must equal the table bond); 0 takes it from the table stack. */
  async challenge(signer: PokerSigner, tableId: Id, handNo: Id, c: ChallengeArgs, bond: bigint = 0n, opts?: TxOptions): Promise<CallResult> {
    return this.tx(signer, "Challenge", [
      uint(tableId), uint(handNo), int(c.accused), c.kind, int(c.index), c.inB64, c.inProofHex, c.outB64, c.outProofHex,
    ], bond, opts);
  }
  async finalize(signer: PokerSigner, tableId: Id, opts?: TxOptions): Promise<CallResult> {
    return this.tx(signer, "Finalize", [uint(tableId)], 0n, opts);
  }
  async timeout(signer: PokerSigner, tableId: Id, opts?: TxOptions): Promise<CallResult> {
    return this.tx(signer, "Timeout", [uint(tableId)], 0n, opts);
  }

  /** Binds a signer so calls read client.as(signer).act(...). */
  as(signer: PokerSigner): BoundPokerClient {
    return new BoundPokerClient(this, signer);
  }
}

type DropSigner<F> = F extends (signer: PokerSigner, ...rest: infer A) => infer R ? (...rest: A) => R : never;

/** PokerClient transaction methods with the signer pre-bound. */
export class BoundPokerClient {
  readonly createTable: DropSigner<PokerClient["createTable"]>;
  readonly join: DropSigner<PokerClient["join"]>;
  readonly topUp: DropSigner<PokerClient["topUp"]>;
  readonly leave: DropSigner<PokerClient["leave"]>;
  readonly sitOut: DropSigner<PokerClient["sitOut"]>;
  readonly sitIn: DropSigner<PokerClient["sitIn"]>;
  readonly startHand: DropSigner<PokerClient["startHand"]>;
  readonly submitShuffle: DropSigner<PokerClient["submitShuffle"]>;
  readonly submitRekey: DropSigner<PokerClient["submitRekey"]>;
  readonly shareKeys: DropSigner<PokerClient["shareKeys"]>;
  readonly act: DropSigner<PokerClient["act"]>;
  readonly revealSeed: DropSigner<PokerClient["revealSeed"]>;
  readonly accept: DropSigner<PokerClient["accept"]>;
  readonly challenge: DropSigner<PokerClient["challenge"]>;
  readonly finalize: DropSigner<PokerClient["finalize"]>;
  readonly timeout: DropSigner<PokerClient["timeout"]>;
  readonly client: PokerClient;
  readonly signer: PokerSigner;

  constructor(client: PokerClient, signer: PokerSigner) {
    this.client = client;
    this.signer = signer;
    this.createTable = (...a) => client.createTable(signer, ...a);
    this.join = (...a) => client.join(signer, ...a);
    this.topUp = (...a) => client.topUp(signer, ...a);
    this.leave = (...a) => client.leave(signer, ...a);
    this.sitOut = (...a) => client.sitOut(signer, ...a);
    this.sitIn = (...a) => client.sitIn(signer, ...a);
    this.startHand = (...a) => client.startHand(signer, ...a);
    this.submitShuffle = (...a) => client.submitShuffle(signer, ...a);
    this.submitRekey = (...a) => client.submitRekey(signer, ...a);
    this.shareKeys = (...a) => client.shareKeys(signer, ...a);
    this.act = (...a) => client.act(signer, ...a);
    this.revealSeed = (...a) => client.revealSeed(signer, ...a);
    this.accept = (...a) => client.accept(signer, ...a);
    this.challenge = (...a) => client.challenge(signer, ...a);
    this.finalize = (...a) => client.finalize(signer, ...a);
    this.timeout = (...a) => client.timeout(signer, ...a);
  }
}

function uint(x: Id): string {
  const v = BigInt(x);
  if (v < 0n) throw new Error("negative id");
  return v.toString();
}
function int(x: number | bigint): string {
  return BigInt(x).toString();
}
/** Merges overrides; a gasWanted override without a gasFee gets a fee recomputed for it. */
function withFee(base: GasSettings, o: Partial<GasSettings>): GasSettings {
  const v = stripUndefined(o);
  const merged = { ...base, ...v };
  if (v.gasWanted !== undefined && v.gasFee === undefined) merged.gasFee = feeForGas(v.gasWanted);
  return merged;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
