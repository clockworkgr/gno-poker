// The hand-rolled encoder must produce byte-identical transactions and sign bytes to the
// official gno JS clients (used here in Node only, where their Node built-ins are available).
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { MsgCall, MsgSend, decodeTxMessages } from "@gnolang/gno-js-client";
import { PubKeySecp256k1, Tx, Wallet, uint8ArrayToBase64 } from "@gnolang/tm2-js-client";
import { describe, expect, it } from "vitest";
import { TEST1_MNEMONIC, addressOfPubKey, keyPairFromMnemonic, keyPairFromPrivate, signData } from "../src/chain/keys.ts";
import { encodeTx, signBytes, type TxMsg } from "../src/chain/proto.ts";
import { cleanLog } from "../src/chain/rpc.ts";

const call: TxMsg = {
  type: "/vm.m_call",
  value: { caller: "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5", send: "5000ugnot", max_deposit: "", pkg_path: "gno.land/r/demo/poker", func: "Act", args: ["1", "3", "raise", "4000"] },
};
const send: TxMsg = { type: "/bank.MsgSend", value: { from_address: "g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5", to_address: "g1us8428u2a5satrlxzagqqa5m6vmuze025anjlj", amount: "100ugnot" } };

describe("keys", () => {
  it("derives the gnodev test1 address from its mnemonic", () => {
    expect(keyPairFromMnemonic(TEST1_MNEMONIC, 0).address).toBe("g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5");
  });
  it("matches tm2-js-client for other account indices", async () => {
    for (const i of [1, 7]) {
      const w = await Wallet.fromMnemonic(TEST1_MNEMONIC, { accountIndex: i });
      expect(keyPairFromMnemonic(TEST1_MNEMONIC, i).address).toBe(await w.getAddress());
    }
  });
  it("round-trips a private key", () => {
    const k = keyPairFromMnemonic(TEST1_MNEMONIC, 3);
    expect(keyPairFromPrivate(k.privateKey).address).toBe(k.address);
    expect(addressOfPubKey(k.publicKey)).toBe(k.address);
  });
});

describe("transaction encoding", () => {
  it("matches tm2-js-client's protobuf Tx for MsgCall and MsgSend", () => {
    const k = keyPairFromMnemonic(TEST1_MNEMONIC, 0);
    const sig = new Uint8Array(64).fill(7);
    for (const m of [call, send]) {
      const mine = encodeTx([m], { gasWanted: 95_000_000n, gasFee: "95000ugnot" }, [{ pubKey: k.publicKey, signature: sig }], "memo");
      const value = m.type === "/vm.m_call" ? MsgCall.encode(m.value).finish() : MsgSend.encode(m.value).finish();
      const theirs = Tx.encode({
        messages: [{ type_url: m.type, value }],
        fee: { gas_wanted: 95_000_000n, gas_fee: "95000ugnot" },
        signatures: [{ pub_key: { type_url: "/tm.PubKeySecp256k1", value: PubKeySecp256k1.encode({ key: k.publicKey }).finish() }, signature: sig, session_addr: "" }],
        memo: "memo",
      }).finish();
      expect(uint8ArrayToBase64(mine)).toBe(uint8ArrayToBase64(theirs));
    }
  });

  it("produces the same sign bytes and a valid signature as the tm2 Wallet", async () => {
    const k = keyPairFromMnemonic(TEST1_MNEMONIC, 0);
    const w = await Wallet.fromMnemonic(TEST1_MNEMONIC, { accountIndex: 0 });
    let captured: Uint8Array | null = null;
    const signer = w.getSigner();
    const orig = signer.signData.bind(signer);
    signer.signData = async (d: Uint8Array) => {
      captured = d;
      return orig(d);
    };
    w.connect({
      getStatus: async () => ({ node_info: { network: "dev" } }),
      getAccount: async () => ({ BaseAccount: { account_number: "5", sequence: "12" } }),
    } as never);
    const fee = { gas_wanted: 15_000_000n, gas_fee: "15000ugnot" };
    const signed = await w.signTransaction(
      { messages: [{ type_url: call.type, value: MsgCall.encode(call.value).finish() }], fee, signatures: [], memo: "" },
      decodeTxMessages,
    );
    const mine = signBytes({ chainId: "dev", accountNumber: "5", sequence: "12", fee: { gasWanted: 15_000_000n, gasFee: "15000ugnot" }, msgs: [call], memo: "" });
    expect(new TextDecoder().decode(mine)).toBe(new TextDecoder().decode(captured!));
    const mySig = signData(k.privateKey, mine);
    expect(secp256k1.verify(mySig, sha256(mine), k.publicKey, { prehash: false })).toBe(true);
    expect(signed.signatures[0]!.signature.length).toBe(64);
  });
});

describe("cleanLog", () => {
  it("extracts the realm panic", () => {
    const log = "--= Error =--\nData: errors.FmtError{}\nMsg Traces:\n    0  gno/tm2/pkg/errors/errors.go:103 - VM panic: buy-in must be between 1 and 2 ugnot\nStacktrace:\npanic: buy-in must be between 1 and 2 ugnot\nJoin at x.gno:202\n";
    expect(cleanLog(log)).toBe("buy-in must be between 1 and 2 ugnot");
  });
  it("falls back to the first trace message", () => {
    const log = "--= Error =--\nData: std.OutOfGasError{abciError:std.abciError{}}\nMsg Traces:\n    0  gno/tm2/pkg/std/errors.go:120 - gas used (313675) exceeds tx's gas wanted (100000) during operation: DepthSet; simulate with consensus maximum (10000000000) to get real transaction usage\n";
    expect(cleanLog(log)).toBe("gas used (313675) exceeds tx's gas wanted (100000) during operation: DepthSet");
  });
});
