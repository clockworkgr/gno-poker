// Timeouts: each kind of staller is resolved by another bot calling Timeout (protocol section 6).

import type { TableState } from "@gno-poker/protocol";
import { afterAll, describe, expect, it } from "vitest";
import type { Bot } from "../src/bot.ts";
import type { StallStep } from "../src/cheats.ts";
import { createTable, newBot, runBots } from "../src/runner.ts";
import { CallingStation } from "../src/strategy.ts";
import { Monitor, MoneyChecker, e2eEnv, writeResults } from "./helpers.ts";

const env = await e2eEnv("stall");
const tableBots = new Map<number, Bot[]>();
const money = new MoneyChecker(env, tableBots);
await money.init();
const doneTables = new Map<string, TableState>();
env.history.onFinish = async (t, s) => {
  doneTables.set(`${t.id}/${s.handNo}`, t);
  await money.check(`table ${t.id} hand ${s.handNo}`);
};
afterAll(() => writeResults("stall", env, { moneyChecks: money.checks, moneyFailures: money.failures }));

const TIMEOUT_BLOCKS = 5;

async function stallScenario(step: StallStep, players: number) {
  const tableId = await createTable(env, { maxPlayers: players, actionTimeoutBlocks: TIMEOUT_BLOCKS, challengeWindowBlocks: TIMEOUT_BLOCKS });
  const bots: Bot[] = [];
  tableBots.set(tableId, bots);
  for (let i = 0; i < players; i++) {
    const staller = i === players - 1;
    bots.push(
      await newBot(env, {
        name: staller ? `staller-${step}` : `honest-${i}`,
        tableId,
        strategy: new CallingStation(),
        buyIn: 60_000n,
        fallbackDelayMs: 2000,
        ...(staller ? { stall: { step } } : {}),
      }),
    );
  }
  const staller = bots[players - 1]!;
  const mon = new Monitor(env, tableId);
  mon.start();
  let hit: TableState | null = null;
  const done = () => {
    for (const [k, t] of doneTables) {
      if (!k.startsWith(`${tableId}/`)) continue;
      doneTables.delete(k);
      if (!hit && staller.notes.some((n) => n.startsWith(`stalled ${step} in hand ${t.hand!.handNo}`))) hit = t;
    }
    return hit !== null;
  };
  await runBots(bots, done, { timeoutMs: 10 * 60_000, leaveAtEnd: true });
  await mon.stop();
  await money.check(`table ${tableId} end`);
  const t = hit! as TableState;
  const h = t.hand!;
  const s = h.players.findIndex((p) => p.owner === staller.ownerAddress);
  const timeouts = env.txlog.records.filter((r) => r.ok && r.func === "Timeout" && r.tableId === tableId && r.handNo === h.handNo);
  return { tableId, t, h, s, staller, start: mon.startStacks.get(h.handNo)!, timeouts, bots };
}

function penaltyCredits(t: TableState, start: Map<string, bigint>, penalized: number[]): bigint[] {
  const h = t.hand!;
  const credits = h.players.map((p) => p.contributed);
  const recipients = h.players.map((_, j) => j).filter((j) => !penalized.includes(j));
  for (const j of penalized) {
    const amount = start.get(h.players[j]!.owner)!;
    credits[j] = 0n;
    const share = amount / BigInt(recipients.length);
    const rem = amount - share * BigInt(recipients.length);
    recipients.forEach((r, k) => (credits[r] = credits[r]! + share + (k === 0 ? rem : 0n)));
  }
  return credits;
}

describe("stallers are timed out", () => {
  for (const step of ["shuffle", "rekey", "keys", "reveal"] as const) {
    it(`${step} staller (3 players): hand aborted, staller's stack split, others refunded`, async () => {
      const r = await stallScenario(step, 3);
      const res = r.h.result!;
      expect(r.timeouts.length).toBeGreaterThanOrEqual(1);
      expect(r.timeouts.every((x) => x.signer !== r.staller.actor.address)).toBe(true);
      expect(res.aborted).toBe(true);
      expect(res.stallers).toEqual([r.s]);
      expect(r.h.players.map((p) => res.payouts.get(p.index))).toEqual(penaltyCredits(r.t, r.start, [r.s]));
      for (const p of r.h.players) {
        if (p.index === r.s) continue;
        expect(r.t.seats[p.seat]!.stack).toBe(r.start.get(p.owner)! - p.contributed + res.payouts.get(p.index)!);
      }
      expect(r.t.seats.some((x) => x?.owner === r.staller.ownerAddress)).toBe(false);
      expect(money.failures).toEqual([]);
    });
  }

  it("bet staller (heads-up): Timeout checks or folds for them and the hand goes on", async () => {
    const r = await stallScenario("bet", 2);
    const res = r.h.result!;
    expect(r.timeouts.length).toBeGreaterThanOrEqual(1);
    expect(res.stallers).toEqual([]);
    expect(res.convicted).toEqual([]);
    // Preflop the staller faced a bet (small blind) or could check (big blind): fold or check.
    const p = r.h.players[r.s]!;
    expect(p.folded || p.acted || r.h.board.length > 0).toBe(true);
    // Staller stays seated until the bots leave at the end.
    expect(r.t.seats.some((x) => x?.owner === r.staller.ownerAddress)).toBe(true);
    expect(money.failures).toEqual([]);
  });
});
