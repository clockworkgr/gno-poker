// Session keys: the wallet joins and forwards a gas allowance; the session key plays but cannot
// leave or top up; only the owner cashes out.

import { describe, expect, it } from "vitest";
import type { Bot } from "../src/bot.ts";
import { errorMessage } from "../src/chain.ts";
import { createTable, newBot, runBots } from "../src/runner.ts";
import { CallingStation, HandStrengthStrategy } from "../src/strategy.ts";
import { MoneyChecker, e2eEnv, writeResults } from "./helpers.ts";

const env = await e2eEnv("session");
const tableBots = new Map<number, Bot[]>();
const money = new MoneyChecker(env, tableBots);
await money.init();
env.history.onFinish = async (t, s) => {
  await money.check(`table ${t.id} hand ${s.handNo}`);
};

describe("session keys", () => {
  it("session key plays hands, cannot Leave or TopUp; the owner leaves and is paid", async () => {
    const tableId = await createTable(env, { maxPlayers: 2 });
    const allowance = 6_000_000n;
    const a = await newBot(env, { name: "via-session", tableId, strategy: new HandStrengthStrategy(), buyIn: 50_000n, sessionAllowance: allowance });
    const b = await newBot(env, { name: "direct", tableId, strategy: new CallingStation(), buyIn: 50_000n });
    tableBots.set(tableId, [a, b]);
    const session = a.cfg.session!;
    // The realm forwarded the allowance to the session address.
    expect(env.txlog.transfers({ from: env.realmAddress, to: session.address })).toBe(allowance);
    let t = await env.client.getTable(tableId);
    expect(t.seats[0]).toMatchObject({ owner: a.ownerAddress, session: session.address });

    await runBots([a, b], () => env.history.summaries.filter((s) => s.tableId === tableId).length >= 3, { timeoutMs: 5 * 60_000 });
    // Every in-hand transaction of bot a was signed by the session key, none by the owner.
    const aTx = env.txlog.records.filter((r) => r.ok && r.tableId === tableId && r.handNo !== undefined && (r.signer === session.address || r.signer === a.ownerAddress));
    expect(aTx.length).toBeGreaterThan(10);
    expect(aTx.every((r) => r.signer === session.address)).toBe(true);

    // Wait for a quiet moment between hands (bots stopped), then try owner-only calls with the session key.
    t = await env.client.getTable(tableId);
    const errs: string[] = [];
    for (const f of [() => env.client.leave(session, tableId), () => env.client.topUp(session, tableId, 1000n)]) {
      try {
        await f();
        errs.push("succeeded");
      } catch (e) {
        errs.push(errorMessage(e));
      }
    }
    expect(errs[0]).toMatch(/only the seat owner can leave/);
    expect(errs[1]).toMatch(/only the seat owner can top up/);
    t = await env.client.getTable(tableId);
    expect(t.seats.some((s) => s?.owner === a.ownerAddress)).toBe(true);

    // Finish the hand in progress (if any) and leave through the owners.
    await runBots([a, b], () => true, { leaveAtEnd: true, timeoutMs: 5 * 60_000 });
    t = await env.client.getTable(tableId);
    expect(t.seats.every((s) => s === null)).toBe(true);
    const paidA = env.txlog.transfers({ from: env.realmAddress, to: a.ownerAddress });
    expect(paidA).toBeGreaterThan(0n);
    expect(env.txlog.transfers({ from: env.realmAddress, to: session.address })).toBe(allowance); // nothing else to the session
    await money.check("end");
    expect(money.failures).toEqual([]);
    writeResults("session", env, { moneyChecks: money.checks, moneyFailures: money.failures });
  });
});
