import { describe, expect, it } from "vitest";
import {
  type CheatHooks, type OwedAction, type TableState, HandSession, MemoryStore, PokerClient,
  boardPositions, holePositions,
} from "../src/index.ts";
import { FakeRealm } from "./fake-realm.ts";

interface Bot {
  index: number;
  address: string;
  store: MemoryStore;
  session: HandSession | null;
  cheat?: CheatHooks;
  /** Re-open the session from storage on every poll (simulates a page reload). */
  reopen?: boolean;
  actions: OwedAction["type"][];
}

async function playHand(n: number, opts: { cheatIndex?: number; reopenIndex?: number; cheat?: CheatHooks } = {}) {
  const addresses = Array.from({ length: n }, (_, i) => `g1player${i}`);
  const realm = new FakeRealm(addresses);
  const client = new PokerClient({ querier: realm });
  const swap = Array.from({ length: 52 }, (_, i) => i);
  [swap[0], swap[2 * n]] = [swap[2 * n]!, swap[0]!]; // move a board card into player 0's hole
  const bots: Bot[] = addresses.map((address, index) => ({
    index, address, store: new MemoryStore(), session: null, actions: [],
    ...(index === opts.cheatIndex ? { cheat: opts.cheat ?? { shuffleExtraPerm: () => swap } } : {}),
    reopen: index === opts.reopenIndex,
  }));

  let table: TableState = await client.getTable(1);
  for (let guard = 0; guard < 500 && table.hand!.phase !== "done"; guard++) {
    let progressed = false;
    for (const bot of bots) {
      table = await client.getTable(1);
      if (!bot.session || bot.reopen) {
        bot.session = await HandSession.open({ table, address: bot.address, store: bot.store, cheat: bot.cheat });
      }
      const s = bot.session!;
      await s.observe(table, () => client.getDeckB64(1));
      const a = await s.nextAction(table);
      if (a.type === "none" || a.type === "timeout" || a.type === "finalize") continue;
      bot.actions.push(a.type);
      const c = client.as(realm.signer(bot.index));
      switch (a.type) {
        case "submitShuffle": await c.submitShuffle(1, s.handNo, a.commitHex, a.deckB64); break;
        case "submitRekey": await c.submitRekey(1, s.handNo, a.deckB64); break;
        case "shareKeys": await c.shareKeys(1, s.handNo, a.keysHex); break;
        case "bet": await c.act(1, s.handNo, a.options.canCheck ? "check" : "call"); break;
        case "revealSeed": await c.revealSeed(1, s.handNo, a.seedHex); break;
        case "accept": await c.accept(1, s.handNo); break;
        case "challenge": await c.challenge(1, s.handNo, a.args); break;
      }
      await s.markSubmitted(a);
      progressed = true;
    }
    table = await client.getTable(1);
    if (!progressed && (table.hand!.phase as string) !== "done") throw new Error(`stuck in phase ${table.hand!.phase}`);
  }
  table = await client.getTable(1);
  return { realm, table, bots };
}

describe("HandSession against an in-memory realm", () => {
  it.each([2, 3])("plays an honest %i-player hand; opened cards equal official cards", async (n) => {
    const { table, bots } = await playHand(n, { reopenIndex: 1 });
    const h = table.hand!;
    expect(h.phase).toBe("done");
    expect(h.result!.convicted).toEqual([]);
    for (const bot of bots) {
      const s = bot.session!;
      const hole = holePositions(n, bot.index).map((p) => h.cards.get(p));
      expect(s.holeCards()).toEqual(hole);
      expect(s.boardCards()).toEqual(boardPositions(n).map((p) => h.cards.get(p)));
      expect(s.badPositions()).toEqual([]);
      expect(s.officialCards(table)).toEqual([...h.cards.values()]);
      expect(bot.actions).toContain("accept");
      expect(bot.actions).not.toContain("challenge");
      expect(s.recordedPasses().every(Boolean)).toBe(true);
    }
    // The reopened bot's seed and passes survived through the store.
    expect([...bots[1]!.store.data.keys()].some((k) => k.endsWith("/seed"))).toBe(true);
  });

  it("an honest player convicts a cheating last shuffler", async () => {
    const n = 3;
    const { table, bots } = await playHand(n, { cheatIndex: n - 1 });
    const h = table.hand!;
    expect(h.phase).toBe("done");
    expect(h.result!.convicted).toEqual([n - 1]);
    expect(bots[0]!.actions).toContain("challenge");
    // The cheat moved a board card into player 0's hole: what player 0 opened differs from the official card.
    const opened = bots[0]!.session!.holeCards()[0];
    expect(opened).toBe(h.cards.get(2 * n));
    expect(opened).not.toBe(h.cards.get(0));
  });

  it("a tampered rekey pass is challenged as a rekey fault", async () => {
    const { table, bots } = await playHand(2, {
      cheatIndex: 1,
      cheat: { tamperRekey: (_ctx, d) => [d[1]!, d[0]!, ...d.slice(2)] },
    });
    expect(table.hand!.result!.convicted).toEqual([1]);
    expect(bots[0]!.actions).toContain("challenge");
  });

  it("tampered card keys are published (the fake realm rejects them at reveal)", async () => {
    await expect(playHand(2, {
      cheatIndex: 1,
      cheat: { tamperCardKeys: (ctx, _pos, keys) => (ctx.step === "hole" ? keys.map((k, i) => (i === 0 ? k ^ 2n : k)) : null) },
    })).rejects.toThrow(/bad published key/);
  });

  it("seed is not regenerated once the commit is on-chain", async () => {
    const realm = new FakeRealm(["g1a", "g1b"]);
    const client = new PokerClient({ querier: realm });
    const store = new MemoryStore();
    let table = await client.getTable(1);
    const s = (await HandSession.open({ table, address: "g1a", store }))!;
    const a = await s.nextAction(table);
    expect(a.type).toBe("submitShuffle");
    if (a.type !== "submitShuffle") return;
    await client.submitShuffle(realm.signer(0), 1, 1, a.commitHex, a.deckB64);
    table = await client.getTable(1);
    const lost = (await HandSession.open({ table, address: "g1a", store: new MemoryStore() }))!;
    expect(lost.seedLost).toBe(true);
    const resumed = (await HandSession.open({ table, address: "g1a", store }))!;
    expect(resumed.commitHex).toBe(a.commitHex);
    expect(await HandSession.open({ table, address: "g1zzz", store })).toBeNull();
  });

  it("does not resend a submitted action", async () => {
    const realm = new FakeRealm(["g1a", "g1b"]);
    const client = new PokerClient({ querier: realm });
    const table = await client.getTable(1);
    const s = (await HandSession.open({ table, address: "g1a", store: new MemoryStore() }))!;
    const a = await s.nextAction(table);
    expect(a.type).toBe("submitShuffle");
    expect(await s.nextAction(table)).toEqual(a); // cached, same deck
    await s.markSubmitted(a);
    expect((await s.nextAction(table)).type).toBe("none");
  });

  it("suggests Timeout once the deadline passed", async () => {
    const realm = new FakeRealm(["g1a", "g1b"]);
    const client = new PokerClient({ querier: realm });
    realm.height = realm.deadline + 1;
    const table = await client.getTable(1);
    const s = (await HandSession.open({ table, address: "g1b", store: new MemoryStore() }))!;
    expect((await s.nextAction(table)).type).toBe("timeout");
  });
});
