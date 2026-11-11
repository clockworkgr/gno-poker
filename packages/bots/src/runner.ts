// Wiring for running bots against a node: environment, funded bots, money checks.

import { type CreateTableParams, type GasSettings, type TxName, PokerClient, DEFAULT_PKG_PATH } from "@gno-poker/protocol";
import { GnoQuerier } from "@gno-poker/protocol/gno";
import { Bot, type BotConfig } from "./bot.ts";
import { RecordingSigner, TEST1_MNEMONIC, TxLog, newKey, pkgAddress, sleep } from "./chain.ts";
import { HistoryBook } from "./history.ts";
import type { Strategy } from "./strategy.ts";

export interface Env {
  rpcUrl: string;
  pkgPath: string;
  realmAddress: string;
  querier: GnoQuerier;
  client: PokerClient;
  txlog: TxLog;
  history: HistoryBook;
  faucet: RecordingSigner;
  log: (s: string) => void;
}

export interface EnvOptions {
  rpcUrl: string;
  pkgPath?: string;
  /** Mnemonic of the account that funds the bots. Default gnodev's test1. */
  faucetMnemonic?: string;
  gas?: Partial<Record<TxName, Partial<GasSettings>>>;
  log?: (s: string) => void;
}

export async function connectEnv(o: EnvOptions): Promise<Env> {
  const querier = await GnoQuerier.connect(o.rpcUrl);
  const pkgPath = o.pkgPath ?? DEFAULT_PKG_PATH;
  const txlog = new TxLog();
  const log = o.log ?? ((s: string) => console.log(s));
  return {
    rpcUrl: o.rpcUrl,
    pkgPath,
    realmAddress: pkgAddress(pkgPath),
    querier,
    client: new PokerClient({ querier, pkgPath, ...(o.gas ? { gas: o.gas } : {}) }),
    txlog,
    history: new HistoryBook(log),
    faucet: await RecordingSigner.fromMnemonic(querier, o.faucetMnemonic ?? TEST1_MNEMONIC, txlog),
    log,
  };
}

export const DEFAULT_TABLE: CreateTableParams = {
  smallBlind: 1000n,
  bigBlind: 2000n,
  minBuyIn: 40_000n,
  maxBuyIn: 200_000n,
  maxPlayers: 6,
  actionTimeoutBlocks: 30,
  challengeWindowBlocks: 30,
  challengeBond: 10_000n,
};

export async function createTable(env: Env, p: Partial<CreateTableParams> = {}): Promise<number> {
  const id = await env.client.createTable(env.faucet, { ...DEFAULT_TABLE, ...p });
  env.log(`created table ${id}`);
  return id;
}

export interface NewBotOptions extends Partial<Omit<BotConfig, "name" | "tableId" | "client" | "querier" | "owner" | "session" | "history" | "strategy">> {
  name: string;
  tableId: number;
  strategy: Strategy;
  /** Fund the owner with this much from the faucet. Default 50 GNOT. */
  fund?: bigint;
  /** Join through a fresh session key with this gas allowance (0/undefined: owner plays). */
  sessionAllowance?: bigint;
  /** Existing owner key (hex); a fresh one is generated otherwise. */
  ownerKeyHex?: string;
  /** Join right away. Default true. */
  join?: boolean;
}

export async function newBot(env: Env, o: NewBotOptions): Promise<Bot> {
  const ownerKey = o.ownerKeyHex ? { privateKeyHex: o.ownerKeyHex } : await newKey();
  const owner = await RecordingSigner.create(env.querier, ownerKey.privateKeyHex, env.txlog);
  const fund = o.fund ?? 50_000_000n;
  if (fund > 0n) await env.faucet.transfer(owner.address, fund);
  let session: RecordingSigner | undefined;
  if (o.sessionAllowance && o.sessionAllowance > 0n) {
    const sk = await newKey();
    session = await RecordingSigner.create(env.querier, sk.privateKeyHex, env.txlog);
    env.history.names.set(session.address, o.name);
  }
  env.history.names.set(owner.address, o.name);
  const { fund: _f, sessionAllowance, ownerKeyHex: _k, join, ...rest } = o;
  const bot = new Bot({
    ...rest,
    buyIn: o.buyIn ?? DEFAULT_TABLE.minBuyIn * 2n,
    client: env.client,
    querier: env.querier,
    owner,
    ...(session ? { session } : {}),
    history: env.history,
    log: o.log ?? env.log,
  });
  if (join !== false) await bot.join(sessionAllowance ?? 0n);
  return bot;
}

/** Realm money check: balance == escrow of every table, and in - out == escrow (from tx events). */
export interface MoneyCheck {
  height: number;
  realmBalance: bigint;
  stacks: bigint;
  pots: bigint;
  /** Transfers into / out of the realm seen in recorded transactions. */
  inflow: bigint;
  outflow: bigint;
}

export async function moneySnapshot(env: Env): Promise<MoneyCheck> {
  for (let attempt = 0; ; attempt++) {
    const h1 = await env.querier.height();
    const tables = await env.client.listTables();
    let stacks = 0n;
    let pots = 0n;
    for (const t of tables) {
      const full = await env.client.getTable(t.id);
      for (const s of full.seats) if (s) stacks += s.stack;
      const h = full.hand;
      // Chips of a hand stay escrowed until it is settled (finalize or abort).
      if (h && h.phase !== "done") pots += h.pot;
    }
    const realmBalance = BigInt(await env.querier.balance(env.realmAddress));
    const h2 = await env.querier.height();
    if (h1 === h2 || attempt >= 5) {
      return {
        height: h2,
        realmBalance,
        stacks,
        pots,
        inflow: env.txlog.transfers({ to: env.realmAddress }),
        outflow: env.txlog.transfers({ from: env.realmAddress }),
      };
    }
    await sleep(50);
  }
}

/** Starts every bot loop; resolves when `done()` returns true (then asks bots to leave) or on timeout. */
export async function runBots(
  bots: Bot[],
  done: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; leaveAtEnd?: boolean; checkMs?: number } = {},
): Promise<void> {
  const ac = new AbortController();
  const loops = bots.map((b) => b.run(ac.signal));
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  try {
    while (!(await done())) {
      if (Date.now() > deadline) throw new Error("runBots: timed out");
      if (bots.every((b) => b.isStopped)) throw new Error("runBots: all bots stopped before done");
      await sleep(opts.checkMs ?? 200);
    }
    if (opts.leaveAtEnd) {
      for (const b of bots) b.requestStop();
      const leaveDeadline = Date.now() + 120_000;
      while (!bots.every((b) => b.isStopped) && Date.now() < leaveDeadline) await sleep(200);
    }
  } finally {
    ac.abort();
    await Promise.allSettled(loops);
  }
}
