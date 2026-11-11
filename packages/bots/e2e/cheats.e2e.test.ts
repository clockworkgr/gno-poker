// Security: cheaters are convicted, false challengers lose their bond.

import type { TableState } from "@gno-poker/protocol";
import { afterAll, describe, expect, it } from "vitest";
import type { Bot } from "../src/bot.ts";
import type { CheatKind } from "../src/cheats.ts";
import { createTable, newBot, runBots } from "../src/runner.ts";
import { CallingStation } from "../src/strategy.ts";
import { Monitor, MoneyChecker, e2eEnv, writeResults } from "./helpers.ts";

const env = await e2eEnv("cheats");
const tableBots = new Map<number, Bot[]>();
const money = new MoneyChecker(env, tableBots);
await money.init();
const doneTables = new Map<string, TableState>();
env.history.onFinish = async (t, s) => {
  doneTables.set(`${t.id}/${s.handNo}`, t);
  await money.check(`table ${t.id} hand ${s.handNo}`);
};
afterAll(() => writeResults("cheats", env, { moneyChecks: money.checks, moneyFailures: money.failures }));

interface Spec {
  name: string;
  cheat?: CheatKind;
  falseChallenge?: (handNo: number) => boolean;
}

/** Seats the bots (in order), plays until `until` matches a finished hand, then everyone leaves. */
async function scenario(specs: Spec[], until: (t: TableState) => boolean, maxHands = 6) {
  const tableId = await createTable(env, { maxPlayers: Math.max(2, specs.length), challengeWindowBlocks: 20 });
  const bots: Bot[] = [];
  tableBots.set(tableId, bots);
  for (const s of specs) {
    bots.push(
      await newBot(env, {
        name: s.name,
        tableId,
        strategy: new CallingStation(),
        buyIn: 60_000n,
        ...(s.cheat ? { cheat: s.cheat } : {}),
        ...(s.falseChallenge ? { falseChallenge: s.falseChallenge } : {}),
      }),
    );
  }
  const mon = new Monitor(env, tableId);
  mon.start();
  let hit: TableState | null = null;
  let hands = 0;
  const done = () => {
    for (const [k, t] of doneTables) {
      if (!k.startsWith(`${tableId}/`)) continue;
      doneTables.delete(k);
      hands++;
      if (!hit && until(t)) hit = t;
    }
    if (!hit && hands >= maxHands) throw new Error(`no matching hand in ${hands} hands`);
    return hit !== null;
  };
  await runBots(bots, done, { timeoutMs: 15 * 60_000, leaveAtEnd: true });
  await mon.stop();
  await money.check(`table ${tableId} end`);
  const t = hit! as TableState;
  const h = t.hand!;
  const idx = (b: Bot) => h.players.findIndex((p) => p.owner === b.ownerAddress);
  const start = mon.startStacks.get(h.handNo)!;
  return { tableId, t, h, bots, idx, start, mon };
}

/** Expected credits after conviction or stall (protocol sections 5 and 6). */
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

describe("cheaters and challenges", () => {
  it("last-shuffler cheat (3 players): detected after reveal, challenged, convicted, stack split", async () => {
    const r = await scenario(
      [{ name: "honest-A" }, { name: "honest-B" }, { name: "cheater", cheat: "last-shuffler" }],
      (t) => (t.hand?.result?.convicted.length ?? 0) > 0,
    );
    const cheater = r.bots[2]!;
    const c = r.idx(cheater);
    const res = r.h.result!;
    expect(c).toBe(r.h.players.length - 1); // the cheat only applies as last shuffler
    expect(res.aborted).toBe(true);
    expect(res.convicted).toEqual([c]);
    const guilty = res.challenges.filter((x) => x.guilty);
    expect(guilty).toHaveLength(1);
    expect(guilty[0]).toMatchObject({ accused: c, kind: "shuffle" });
    expect(guilty[0]!.challenger).not.toBe(c);
    // The attack worked: the cheater opened the victim's (hand index 0) official hole cards.
    const seen = cheater.opened.get(r.h.handNo)!;
    expect([seen.get(2 * c), seen.get(2 * c + 1)]).toEqual([r.h.cards.get(0), r.h.cards.get(1)]);
    // Bets refunded, cheater's whole stack split between the two others.
    const want = penaltyCredits(r.t, r.start, [c]);
    expect(r.h.players.map((p) => res.payouts.get(p.index))).toEqual(want);
    for (const p of r.h.players) {
      if (p.index === c) continue;
      expect(r.t.seats[p.seat]!.stack).toBe(r.start.get(p.owner)! - p.contributed + want[p.index]!);
    }
    expect(r.t.seats.some((s) => s?.owner === cheater.ownerAddress)).toBe(false);
    expect(env.txlog.transfers({ from: env.realmAddress, to: cheater.ownerAddress })).toBe(0n);
    expect(money.failures).toEqual([]);
  });

  it("bad rekey: challenged after reveal and convicted", async () => {
    const r = await scenario([{ name: "honest" }, { name: "bad-rekeyer", cheat: "bad-rekey" }], (t) => (t.hand?.result?.convicted.length ?? 0) > 0);
    const c = r.idx(r.bots[1]!);
    const res = r.h.result!;
    expect(res.convicted).toEqual([c]);
    expect(res.challenges.filter((x) => x.guilty)).toEqual([expect.objectContaining({ accused: c, kind: "rekey", index: 0 })]);
    expect(r.h.players.map((p) => res.payouts.get(p.index))).toEqual(penaltyCredits(r.t, r.start, [c]));
    expect(money.failures).toEqual([]);
  });

  it("wrong card key: convicted at reveal without a challenge", async () => {
    const r = await scenario([{ name: "honest" }, { name: "wrong-key", cheat: "wrong-card-key" }], (t) => (t.hand?.result?.convicted.length ?? 0) > 0);
    const c = r.idx(r.bots[1]!);
    const res = r.h.result!;
    expect(res.convicted).toEqual([c]);
    expect(res.challenges).toEqual([]);
    expect(r.h.players[c]!.revealed).toBe(true);
    // The victim could not open the card the wrong key was published for.
    const honest = r.bots[0]!;
    const opened = honest.opened.get(r.h.handNo)!;
    expect([...opened.values()]).toContain(null);
    expect(r.h.players.map((p) => res.payouts.get(p.index))).toEqual(penaltyCredits(r.t, r.start, [c]));
    expect(money.failures).toEqual([]);
  });

  it("false challenge: not guilty, the bond goes to the accused", async () => {
    const r = await scenario(
      [{ name: "accused" }, { name: "false-challenger", falseChallenge: () => true }],
      (t) => (t.hand?.result?.challenges.length ?? 0) > 0,
    );
    const ch = r.idx(r.bots[1]!);
    const acc = r.idx(r.bots[0]!);
    const res = r.h.result!;
    expect(res.aborted).toBe(false);
    expect(res.convicted).toEqual([]);
    expect(res.challenges).toEqual([{ challenger: ch, accused: acc, kind: "shuffle", index: 0, guilty: false }]);
    const t = await env.client.getTable(r.tableId);
    const bond = t.challengeBond;
    const final = (j: number) => r.start.get(r.h.players[j]!.owner)! - r.h.players[j]!.contributed + (res.payouts.get(j) ?? 0n);
    expect(r.t.seats[r.h.players[ch]!.seat]!.stack).toBe(final(ch) - bond);
    expect(r.t.seats[r.h.players[acc]!.seat]!.stack).toBe(final(acc) + bond);
    expect(money.failures).toEqual([]);
  });
});
