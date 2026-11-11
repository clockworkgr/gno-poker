// Honest play with mixed strategies: 2, 3 and 6 bots; money conserved after every hand.

import { afterAll, describe, expect, it } from "vitest";
import type { Bot } from "../src/bot.ts";
import { createTable, newBot, runBots } from "../src/runner.ts";
import { CallingStation, HandStrengthStrategy, RandomStrategy, seededRng } from "../src/strategy.ts";
import { MoneyChecker, e2eEnv, gasTable, writeResults } from "./helpers.ts";

const env = await e2eEnv("play");
const tableBots = new Map<number, Bot[]>();
const money = new MoneyChecker(env, tableBots);
await money.init();
env.history.onFinish = async (t, s) => {
  await money.check(`table ${t.id} hand ${s.handNo}`);
};

afterAll(() => {
  writeResults("play", env, { moneyChecks: money.checks, moneyFailures: money.failures });
  console.table(gasTable(env));
});

async function play(n: number, hands: number, opts: { sessionFor?: number[]; seed: number; buyIn?: bigint }) {
  const tableId = await createTable(env, { maxPlayers: Math.max(n, 2) });
  const strategies = [() => new HandStrengthStrategy(), () => new RandomStrategy(), () => new CallingStation()];
  const rng = seededRng(opts.seed);
  const bots: Bot[] = [];
  tableBots.set(tableId, bots);
  for (let i = 0; i < n; i++) {
    const strategy = strategies[i % strategies.length]!();
    const session = opts.sessionFor?.includes(i);
    bots.push(
      await newBot(env, {
        name: `p${n}-${i}-${strategy.name}`,
        tableId,
        strategy,
        rng,
        buyIn: opts.buyIn ?? 60_000n,
        onBust: "topup",
        maxTopUps: 10,
        ...(session ? { sessionAllowance: 8_000_000n, sessionRefill: { below: 3_000_000n, amount: 5_000_000n } } : {}),
      }),
    );
  }
  await money.check(`table ${tableId} seated`);
  const done = () => env.history.summaries.filter((s) => s.tableId === tableId).length >= hands;
  await runBots(bots, done, { timeoutMs: hands * 60_000, leaveAtEnd: true });
  await money.check(`table ${tableId} after leaving`);
  const t = await env.client.getTable(tableId);
  const summaries = env.history.summaries.filter((s) => s.tableId === tableId);
  return { tableId, table: t, bots, summaries };
}

describe("honest play", () => {
  it("heads-up: 20+ hands, one bot through a session key", async () => {
    const r = await play(2, 20, { sessionFor: [1], seed: 7 });
    expect(r.summaries.length).toBeGreaterThanOrEqual(20);
    expect(r.table.seats.every((s) => s === null)).toBe(true);
    for (const s of r.summaries) expect(s.result).not.toMatch(/CONVICTED|STALLED/);
    expect(money.failures).toEqual([]);
  });

  it("3 bots: 10+ hands", async () => {
    const r = await play(3, 10, { seed: 11 });
    expect(r.summaries.length).toBeGreaterThanOrEqual(10);
    expect(r.table.seats.every((s) => s === null)).toBe(true);
    expect(money.failures).toEqual([]);
  });

  it("6 bots: 6+ hands, two through session keys", async () => {
    const r = await play(6, 6, { seed: 13, sessionFor: [2, 5] });
    expect(r.summaries.length).toBeGreaterThanOrEqual(6);
    expect(r.table.seats.every((s) => s === null)).toBe(true);
    expect(money.failures).toEqual([]);
  });
});
