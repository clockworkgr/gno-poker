// Additions made while integrating with the real realm: fees, deposits, canRaise, challenge args.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GAS, PokerClient, betOptions, buildChallengeArgs, canonicalDeck, elementFromBase64, feeForGas,
  fromHex, merkleRoot, newSeed, parseTableJSON, rekeyPass, shufflePass, storageDepositOf, verifyMerkleProof,
  P, deriveSecrets, modPow, type CallRequest,
} from "../src/index.ts";

describe("fees and gas", () => {
  it("feeForGas charges 1 ugnot per 1000 gas plus 10%", () => {
    expect(feeForGas(1_000_000n)).toBe("1100ugnot");
    expect(feeForGas(95_000_000n)).toBe("104500ugnot");
    expect(feeForGas(1n)).toBe("2ugnot");
    expect(feeForGas(1000n, { ugnot: 1n, gas: 1000n }, 0n)).toBe("1ugnot");
  });

  it("every default fee covers its gas at the genesis price", () => {
    for (const g of Object.values(DEFAULT_GAS)) {
      const fee = BigInt(g.gasFee.replace("ugnot", ""));
      expect(fee * 1000n).toBeGreaterThanOrEqual(g.gasWanted);
      expect(g.maxDeposit).toBeGreaterThan(0n);
    }
  });

  it("a gasWanted override gets a matching fee unless a fee is given", async () => {
    const calls: CallRequest[] = [];
    const signer = { getAddress: async () => "g1x", call: async (r: CallRequest) => (calls.push(r), { hash: "", height: 1, data: "" }) };
    const c = new PokerClient({ querier: { evaluate: async () => "" }, gas: { Act: { gasWanted: 50_000_000n } } });
    expect(c.gasFor("Act")).toMatchObject({ gasWanted: 50_000_000n, gasFee: "55000ugnot" });
    await c.act(signer, 1, 1, "check", 0n, { gasWanted: 2_000_000n });
    await c.act(signer, 1, 1, "check", 0n, { gasWanted: 2_000_000n, gasFee: "9ugnot", memo: "m" });
    expect(calls[0]).toMatchObject({ gasWanted: 2_000_000n, gasFee: "2200ugnot", maxDeposit: DEFAULT_GAS.Act.maxDeposit });
    expect(calls[1]).toMatchObject({ gasFee: "9ugnot", memo: "m" });
  });

  it("storageDepositOf nets locks and refunds", () => {
    expect(storageDepositOf([
      { "@type": "/tm.StorageDepositEvent", bytes_delta: "13312", fee_delta: "1331200ugnot" },
      { "@type": "/tm.StorageUnlockEvent", bytes_delta: "-100", fee_refund: "10000ugnot", refund_withheld: false },
      { "@type": "/tm.StorageUnlockEvent", bytes_delta: "-5", fee_refund: "500ugnot", refund_withheld: true },
      { "@type": "/bank.TransferEvent", from: "a", to: "b", coins: "5ugnot" },
    ])).toBe(1_321_200n);
  });
});

describe("canRaise", () => {
  const table = (canRaise?: boolean) => parseTableJSON({
    id: 1, smallBlind: "10", bigBlind: "20", minBuyIn: "400", maxBuyIn: "4000", maxPlayers: 3,
    actionTimeoutBlocks: 10, challengeWindowBlocks: 5, challengeBond: "100", height: 5, button: 0, handNo: 1,
    seats: [{ seat: 0, owner: "g1a", session: "", stack: "1700" }, null, null],
    hand: {
      handNo: 1, phase: "preflop", turn: 0, owing: [], deadline: 9, pot: "1100", currentBet: "400", minRaise: "280",
      players: [{ seat: 0, owner: "g1a", contributed: "300", streetBet: "300", acted: true, ...(canRaise === undefined ? {} : { canRaise }) }],
    },
  });
  it("is parsed when present and closes raising in betOptions", () => {
    expect(table(false).hand!.players[0]!.canRaise).toBe(false);
    expect(table().hand!.players[0]!.canRaise).toBeUndefined();
    expect(betOptions(table(false), 0).minRaiseTo).toBeNull();
    expect(betOptions(table(true), 0).minRaiseTo).toBe(680n);
    expect(betOptions(table(), 0).minRaiseTo).toBe(680n); // older realms: unknown, assume open
  });
});

describe("buildChallengeArgs", () => {
  it("builds verifiable arguments for any element, honest or not", () => {
    const seeds = [newSeed(), newSeed()];
    const d0 = shufflePass(canonicalDeck(), seeds[0]!);
    const d1 = shufflePass(d0, seeds[1]!);
    const r0 = rekeyPass(d1, seeds[0]!);
    const passes = [d0, d1, r0];
    const sh = buildChallengeArgs(2, passes, seeds[1]!, "shuffle", 1, 5);
    const sec = deriveSecrets(seeds[1]!);
    expect(verifyMerkleProof(merkleRoot(d0), elementFromBase64(sh.inB64), sec.perm[5]!, fromHex(sh.inProofHex))).toBe(true);
    expect(verifyMerkleProof(merkleRoot(d1), elementFromBase64(sh.outB64), 5, fromHex(sh.outProofHex))).toBe(true);
    expect(modPow(elementFromBase64(sh.inB64), sec.e, P)).toBe(elementFromBase64(sh.outB64)); // honest: not guilty
    const rk = buildChallengeArgs(2, passes, seeds[0]!, "rekey", 0, 3);
    expect(verifyMerkleProof(merkleRoot(r0), elementFromBase64(rk.outB64), 3, fromHex(rk.outProofHex))).toBe(true);
    expect(() => buildChallengeArgs(2, passes, seeds[1]!, "rekey", 1, 0)).toThrow(/recorded/);
  });
});
