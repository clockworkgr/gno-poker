import { GnoWallet } from "@gnolang/gno-js-client";
import { describe, expect, it } from "vitest";
import { type CallRequest, type PokerSigner, PokerClient, canonicalDeck, deckToBase64 } from "../src/index.ts";
import { addressOfPrivateKey, generateSessionKey } from "../src/gno.ts";

function recorder(data = "") {
  const calls: CallRequest[] = [];
  const signer: PokerSigner = {
    getAddress: async () => "g1test",
    call: async (req) => {
      calls.push(req);
      return { hash: "h", height: 1, data };
    },
  };
  return { calls, signer };
}

const querier = {
  evaluate: async (_p: string, expr: string) => {
    if (expr === "GetDeck(7)") return `(${JSON.stringify(deckToBase64(canonicalDeck()))} string)`;
    if (expr === "GetDeck(8)") return '("" string)';
    if (expr === "ListTables()") return '("[]" string)';
    if (expr === "ChallengesEnabled()") return "(false bool)";
    throw new Error(expr);
  },
};

describe("PokerClient", () => {
  it("finds the new table in the list when the wallet returns no call result", async () => {
    const row = (id: number, seated: number, bond: string) => ({
      id, smallBlind: "1000", bigBlind: "2000", minBuyIn: "40000", maxBuyIn: "200000", maxPlayers: 6,
      actionTimeoutBlocks: 30, challengeWindowBlocks: 30, challengeBond: bond, button: -1, handNo: 0, seated, phase: "",
    });
    const list = [row(1, 0, "10000"), row(2, 0, "10000"), row(3, 1, "10000"), row(4, 0, "99")];
    const q = { evaluate: async () => `(${JSON.stringify(JSON.stringify(list))} string)` };
    const params = {
      smallBlind: 1000n, bigBlind: 2000n, minBuyIn: 40000n, maxBuyIn: 200000n, maxPlayers: 6,
      actionTimeoutBlocks: 30, challengeWindowBlocks: 30, challengeBond: 10000n,
    };
    const c = new PokerClient({ querier: q, pkgPath: "gno.land/r/test/poker" });
    expect(await c.createTable(recorder("").signer, params)).toBe(2);
    await expect(c.createTable(recorder("").signer, { ...params, maxPlayers: 2 })).rejects.toThrow(/not found/);
  });

  it("formats transaction arguments as strings and attaches coins", async () => {
    const { calls, signer } = recorder("(42 uint64)");
    const c = new PokerClient({ querier, pkgPath: "gno.land/r/test/poker", gas: { Act: { gasWanted: 5n } } });
    const id = await c.createTable(signer, {
      smallBlind: 1000n, bigBlind: 2000n, minBuyIn: 40000n, maxBuyIn: 200000n, maxPlayers: 6,
      actionTimeoutBlocks: 30, challengeWindowBlocks: 30, challengeBond: 10000n,
    });
    expect(id).toBe(42);
    expect(calls[0]).toMatchObject({
      pkgPath: "gno.land/r/test/poker", func: "CreateTable", send: 0n,
      args: ["1000", "2000", "40000", "200000", "6", "30", "30", "10000"],
    });
    await c.join(signer, 42, 100000n, "g1session", 5000000n);
    expect(calls[1]).toMatchObject({ func: "Join", args: ["42", "g1session", "5000000"], send: 5100000n });
    await expect(c.join(signer, 42, 1n, "", 1n)).rejects.toThrow();
    await c.act(signer, 42, 3, "raise", 6000n);
    expect(calls[2]).toMatchObject({ func: "Act", args: ["42", "3", "raise", "6000"], gasWanted: 5n });
    await c.as(signer).act(42, 3, "call", 999n);
    expect(calls[3]!.args).toEqual(["42", "3", "call", "0"]);
    await c.challenge(signer, 42, 3, {
      accused: 2, kind: "rekey", index: 9, inB64: "IN", inProofHex: "aa", outB64: "OUT", outProofHex: "bb",
    }, 10000n);
    expect(calls[4]).toMatchObject({
      func: "Challenge", args: ["42", "3", "2", "rekey", "9", "IN", "aa", "OUT", "bb"], send: 10000n,
    });
    await c.as(signer).finalize(42, { gasFee: "7ugnot" });
    expect(calls[5]).toMatchObject({ func: "Finalize", args: ["42"], gasFee: "7ugnot" });
  });

  it("queries", async () => {
    const c = new PokerClient({ querier });
    expect(await c.getDeck(7)).toEqual(canonicalDeck());
    expect(await c.getDeck(8)).toBeNull();
    expect(await c.listTables()).toEqual([]);
    expect(await c.challengesEnabled()).toBe(false);
  });
});

describe("gno adapters", () => {
  it("generates session keys with g1 addresses", async () => {
    const k = await generateSessionKey();
    expect(k.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(k.address).toMatch(/^g1[02-9ac-hj-np-z]{38}$/);
    expect(await addressOfPrivateKey(k.privateKeyHex)).toBe(k.address);
  });

  it("derives the gnodev test1 address from its mnemonic", async () => {
    const w = await GnoWallet.fromMnemonic(
      "source bonus chronic canvas draft south burst lottery vacant surface solve popular case indicate oppose farm nothing bullet exhibit title speed wink action roast",
    );
    expect(await w.getAddress()).toBe("g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5");
  });
});
