// Shared e2e plumbing: environment, table monitor, money invariants, gas and timing reports.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TableState } from "@gno-poker/protocol";
import { inject } from "vitest";
import type { Bot } from "../src/bot.ts";
import type { HandSummary } from "../src/history.ts";
import { type Env, connectEnv, moneySnapshot } from "../src/runner.ts";
import { sleep } from "../src/chain.ts";
import { REPO_ROOT } from "./gnodev.ts";

export const RESULTS_DIR = join(REPO_ROOT, "packages/bots/e2e-results");

export async function e2eEnv(name: string): Promise<Env> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const lines: string[] = [];
  const env = await connectEnv({
    rpcUrl: inject("rpcUrl"),
    log: (s) => {
      lines.push(s);
      if (process.env.E2E_VERBOSE) console.log(s);
    },
  });
  // Wait until the realm answers.
  for (let i = 0; ; i++) {
    try {
      await env.client.listTables();
      break;
    } catch (e) {
      if (i > 100) throw e;
      await sleep(300);
    }
  }
  const flush = () => writeFileSync(join(RESULTS_DIR, `${name}.log`), lines.join("\n") + "\n");
  const orig = env.log;
  env.log = (s) => {
    orig(s);
    if (lines.length % 50 === 0) flush();
  };
  process.on("exit", flush);
  (env as Env & { flushLog: () => void }).flushLog = flush;
  return env;
}

export function flushLog(env: Env): void {
  (env as Env & { flushLog?: () => void }).flushLog?.();
}

/** Remembers, per hand, every player's stack at the start of the hand (stack + contributed). */
export class Monitor {
  readonly startStacks = new Map<number, Map<string, bigint>>();
  readonly lastLive = new Map<number, TableState>();
  private stopFlag = false;
  private loop: Promise<void> | null = null;
  private readonly env: Env;
  private readonly tableId: number;
  constructor(env: Env, tableId: number) {
    this.env = env;
    this.tableId = tableId;
  }

  start(): void {
    this.loop = (async () => {
      while (!this.stopFlag) {
        try {
          this.observe(await this.env.client.getTable(this.tableId));
        } catch {
          // transient
        }
        await sleep(80);
      }
    })();
  }

  observe(t: TableState): void {
    const h = t.hand;
    if (!h || h.phase === "done") return;
    this.lastLive.set(h.handNo, t);
    if (this.startStacks.has(h.handNo)) return;
    const m = new Map<string, bigint>();
    for (const p of h.players) m.set(p.owner, (t.seats[p.seat]?.stack ?? 0n) + p.contributed);
    this.startStacks.set(h.handNo, m);
  }

  async stop(): Promise<void> {
    this.stopFlag = true;
    await this.loop;
  }
}

/**
 * Money invariants for one test file (all bots of the file, any number of tables):
 *  - realm balance - baseline == transfers in - transfers out (every realm transfer is recorded)
 *  - realm balance == sum of stacks + live pots over all tables
 *  - per table: stacks + pot + cash-outs of its bots == buy-ins + top-ups (+ attached bonds)
 */
export class MoneyChecker {
  readonly failures: string[] = [];
  checks = 0;
  baseline = 0n;
  baselineStacks = 0n;
  private readonly env: Env;
  private readonly botsByTable: Map<number, Bot[]>;
  constructor(env: Env, botsByTable: Map<number, Bot[]>) {
    this.env = env;
    this.botsByTable = botsByTable;
  }

  async init(): Promise<void> {
    const m = await moneySnapshot(this.env);
    this.baseline = m.realmBalance;
    this.baselineStacks = m.stacks + m.pots;
    if (m.realmBalance !== m.stacks + m.pots) this.failures.push(`baseline: realm balance ${m.realmBalance} != stacks ${m.stacks} + pots ${m.pots}`);
  }

  async check(label: string): Promise<void> {
    this.checks++;
    const env = this.env;
    const m = await moneySnapshot(env);
    if (m.realmBalance !== m.stacks + m.pots) this.failures.push(`${label}: realm balance ${m.realmBalance} != stacks ${m.stacks} + pots ${m.pots} (height ${m.height})`);
    if (m.realmBalance - this.baseline !== m.inflow - m.outflow) {
      this.failures.push(`${label}: realm balance change ${m.realmBalance - this.baseline} != recorded in ${m.inflow} - out ${m.outflow}`);
    }
    for (const [tableId, bots] of this.botsByTable) {
      const t = await env.client.getTable(tableId);
      let stacks = 0n;
      for (const s of t.seats) if (s) stacks += s.stack;
      const pot = t.hand && t.hand.phase !== "done" ? t.hand.pot : 0n;
      let cashouts = 0n;
      let paidIn = 0n;
      for (const b of bots) {
        cashouts += env.txlog.transfers({ from: env.realmAddress, to: b.ownerAddress });
        paidIn += b.buyIns + b.topUpTotal;
      }
      const attachedBonds = 0n;
      if (stacks + pot + cashouts !== paidIn + attachedBonds) {
        this.failures.push(`${label}: table ${tableId}: stacks ${stacks} + pot ${pot} + cash-outs ${cashouts} != buy-ins and top-ups ${paidIn}`);
      }
    }
  }
}

export interface GasRow {
  func: string;
  count: number;
  min: number;
  avg: number;
  max: number;
  failed: number;
}

export function gasTable(env: Env): GasRow[] {
  const by = new Map<string, { gas: number[]; failed: number }>();
  for (const r of env.txlog.records) {
    let e = by.get(r.func);
    if (!e) by.set(r.func, (e = { gas: [], failed: 0 }));
    if (r.ok) e.gas.push(Number(r.gasUsed));
    else e.failed++;
  }
  return [...by.entries()]
    .map(([func, { gas, failed }]) => ({
      func,
      count: gas.length,
      min: gas.length ? Math.min(...gas) : 0,
      avg: gas.length ? Math.round(gas.reduce((a, b) => a + b, 0) / gas.length) : 0,
      max: gas.length ? Math.max(...gas) : 0,
      failed,
    }))
    .sort((a, b) => a.func.localeCompare(b.func));
}

export function handRows(summaries: readonly HandSummary[]) {
  return summaries.map((s) => ({
    table: s.tableId,
    hand: s.handNo,
    seconds: +(s.ms / 1000).toFixed(2),
    players: s.players.length,
    gasPerPlayerM: Object.fromEntries(s.players.map((p) => [p.name, +(Number(s.gasByPlayer.get(p.index) ?? 0n) / 1e6).toFixed(1)])),
    txPerPlayer: Object.fromEntries(s.players.map((p) => [p.name, s.txCountByPlayer.get(p.index) ?? 0])),
    result: s.result,
  }));
}

export function writeResults(name: string, env: Env, extra: Record<string, unknown> = {}): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const data = {
    gas: gasTable(env),
    hands: handRows(env.history.summaries),
    ...extra,
  };
  writeFileSync(join(RESULTS_DIR, `${name}.json`), JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  flushLog(env);
}

/** Waits until `f` returns a value (not undefined), polling. */
export async function waitFor<T>(f: () => Promise<T | undefined> | T | undefined, timeoutMs = 120_000, what = "condition"): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() - t > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
