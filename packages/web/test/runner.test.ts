// TableRunner + ProtocolCore against the protocol package's in-memory realm: a full hand with
// one runner seat and one bot seat, checking that every owed protocol action is sent exactly once
// (also under concurrent polling) and that a "reload" mid-hand (new runner and core on the same
// store) finishes the hand.
import { type CallRequest, MemoryStore, PokerClient, type TableState } from "@gno-poker/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { FakeRealm } from "../../protocol/test/fake-realm.ts";
import type { GnoRpc } from "../src/chain/rpc.ts";
import type { WalletSigner } from "../src/chain/signer.ts";
import { ProtocolCore } from "../src/engine/protocolCore.ts";
import { TableRunner } from "../src/engine/runner.ts";
import { createSessionKey } from "../src/engine/sessionKeys.ts";

class MapStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage = new MapStorage();
  g.sessionStorage = new MapStorage();
});

const OWNER = "g1player0";

function setup() {
  const realm = new FakeRealm([OWNER, "g1player1"]);
  const sk = createSessionKey("dev", "gno.land/r/demo/poker", 1, OWNER);
  // The fake realm has no session addresses; graft ours onto seat 0.
  const patched = {
    evaluate: async (pkg: string, expr: string) => {
      const raw = await realm.evaluate(pkg, expr);
      if (expr !== "GetTable(1)") return raw;
      const json = JSON.parse(JSON.parse(raw.slice(1, raw.lastIndexOf(" ")))) as { seats: ({ session: string } | null)[] };
      json.seats[0]!.session = sk.address;
      return `(${JSON.stringify(JSON.stringify(json))} string)`;
    },
  };
  const client = new PokerClient({ querier: patched });
  const rpc = { qeval: (p: string, e: string) => patched.evaluate(p, e), balance: async () => 5_000_000n } as unknown as GnoRpc;
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const sessionSigner: WalletSigner = {
    kind: "session",
    getAddress: async () => sk.address,
    call: async (req: CallRequest) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      try {
        calls.push(req.func);
        return await realm.signer(0).call(req);
      } finally {
        inFlight--;
      }
    },
    send: async () => { throw new Error("unused"); },
  };
  const store = new MemoryStore();
  const mkRunner = () => new TableRunner({
    tableId: 1, rpc, client, protocol: new ProtocolCore({ store, client }), chainId: "dev", realm: "gno.land/r/demo/poker",
    owner: null, ownerAddress: OWNER, challengesEnabled: true, confirmChallenge: () => false, pollMs: () => 1000,
    makeSessionSigner: () => sessionSigner,
  });
  const botCore = new ProtocolCore({ store: new MemoryStore(), client });
  const bot = client.as(realm.signer(1));
  const botStep = async () => {
    const raw = JSON.parse((await realm.evaluate("", "GetTable(1)")).replace(/^\(/, "").replace(/ string\)$/, "")) as string;
    const v = await botCore.tick({ tableJson: raw, address: "g1player1", namespace: "bot", challengesEnabled: true });
    if (!v) return;
    const a = v.action;
    switch (a.type) {
      case "submitShuffle": await bot.submitShuffle(1, 1, a.commitHex, a.deckB64); break;
      case "submitRekey": await bot.submitRekey(1, 1, a.deckB64); break;
      case "shareKeys": await bot.shareKeys(1, 1, a.keysHex); break;
      case "revealSeed": await bot.revealSeed(1, 1, a.seedHex); break;
      case "accept": await bot.accept(1, 1); break;
      case "bet": await bot.act(1, 1, a.options.canCheck ? "check" : "call"); break;
      default: return;
    }
    await botCore.submitted("bot", 1, 1, a);
  };
  return { realm, calls, mkRunner, botStep, maxInFlight: () => maxInFlight };
}

async function play(r: { runner: TableRunner }, botStep: () => Promise<void>, realm: FakeRealm, opts: { reloadAt?: string; mk?: () => TableRunner } = {}) {
  let reloaded = false;
  for (let i = 0; i < 300 && realm.phase !== "done"; i++) {
    // Several overlapping polls: the runner must still send each action once.
    await Promise.all([r.runner.tick(), r.runner.tick(), r.runner.tick()]);
    const snap = r.runner.getSnapshot();
    const a = snap.view?.action;
    if (a?.type === "bet") await r.runner.act(a.options.canCheck ? "check" : "call");
    await botStep();
    if (opts.reloadAt && !reloaded && realm.phase === opts.reloadAt && opts.mk) {
      r.runner.stop();
      r.runner = opts.mk();
      reloaded = true;
    }
  }
  return reloaded;
}

describe("TableRunner", () => {
  it("plays a hand sending each protocol step exactly once", async () => {
    const s = setup();
    const r = { runner: s.mkRunner() };
    r.runner.loadSession();
    await play(r, s.botStep, s.realm);
    expect(s.realm.phase).toBe("done");
    const count = (f: string) => s.calls.filter((c) => c === f).length;
    expect(count("SubmitShuffle")).toBe(1);
    expect(count("SubmitRekey")).toBe(1);
    expect(count("ShareKeys")).toBe(4); // hole, flop, turn, river
    expect(count("RevealSeed")).toBe(1);
    expect(count("Accept")).toBe(1);
    expect(count("Act")).toBe(4);
    expect(s.maxInFlight()).toBe(1);
    const snap = r.runner.getSnapshot();
    expect(snap.view?.verification).toEqual({ ok: true, passes: 4 });
    const t = snap.table as TableState;
    expect(snap.view?.hole).toEqual([t.hand!.cards.get(0), t.hand!.cards.get(1)]);
    expect(snap.log.some((e) => e.text.includes("You verified and accepted the result"))).toBe(true);
  });

  it("finishes the hand after a reload in the middle of dealing", async () => {
    const s = setup();
    const r = { runner: s.mkRunner() };
    r.runner.loadSession();
    const reloaded = await play(r, s.botStep, s.realm, { reloadAt: "flop", mk: () => { const x = s.mkRunner(); x.loadSession(); return x; } });
    expect(reloaded).toBe(true);
    expect(s.realm.phase).toBe("done");
    expect(s.realm.convicted).toEqual([]);
    expect(s.calls.filter((c) => c === "RevealSeed").length).toBe(1);
    expect(r.runner.getSnapshot().view?.verification?.ok).toBe(true);
  });
});
