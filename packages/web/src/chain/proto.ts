// Minimal protobuf and amino-JSON encoding for the two TM2 messages the app sends
// (/vm.m_call and /bank.MsgSend). Field numbers follow gno's tm2/gno proto definitions,
// as generated in @gnolang/tm2-js-client and @gnolang/gno-js-client; test/tx.test.ts checks
// the output byte for byte against those libraries.

import { utf8 } from "@gno-poker/protocol";

class Writer {
  private chunks: number[] = [];

  varint(v: bigint): this {
    if (v < 0n) throw new Error("negative varint");
    while (v > 0x7fn) {
      this.chunks.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    this.chunks.push(Number(v));
    return this;
  }
  tag(field: number, wire: number): this {
    return this.varint(BigInt((field << 3) | wire));
  }
  bytes(field: number, b: Uint8Array): this {
    this.tag(field, 2).varint(BigInt(b.length));
    for (const x of b) this.chunks.push(x);
    return this;
  }
  string(field: number, s: string): this {
    return this.bytes(field, utf8(s));
  }
  /** proto3 semantics: empty strings are omitted. */
  optString(field: number, s: string): this {
    return s === "" ? this : this.string(field, s);
  }
  sint64(field: number, v: bigint): this {
    // zigzag
    const z = v >= 0n ? v << 1n : ((-v) << 1n) - 1n;
    return this.tag(field, 0).varint(z);
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export interface MsgCall {
  caller: string;
  send: string;
  max_deposit: string;
  pkg_path: string;
  func: string;
  args: string[];
}

export interface MsgSend {
  from_address: string;
  to_address: string;
  amount: string;
}

export type TxMsg = { type: "/vm.m_call"; value: MsgCall } | { type: "/bank.MsgSend"; value: MsgSend };

export interface TxFee {
  gasWanted: bigint;
  /** Single coin, e.g. "75000ugnot". */
  gasFee: string;
}

export interface TxSignature {
  pubKey: Uint8Array; // compressed secp256k1
  signature: Uint8Array; // r || s
}

export const PUBKEY_SECP256K1_TYPE = "/tm.PubKeySecp256k1";

function encodeMsgValue(m: TxMsg): Uint8Array {
  const w = new Writer();
  if (m.type === "/vm.m_call") {
    const v = m.value;
    w.optString(1, v.caller).optString(2, v.send).optString(3, v.max_deposit).optString(4, v.pkg_path).optString(5, v.func);
    for (const a of v.args) w.string(6, a);
  } else {
    const v = m.value;
    w.optString(1, v.from_address).optString(2, v.to_address).optString(3, v.amount);
  }
  return w.finish();
}

function encodeAny(typeUrl: string, value: Uint8Array): Uint8Array {
  const w = new Writer().optString(1, typeUrl);
  if (value.length > 0) w.bytes(2, value);
  return w.finish();
}

export function encodePubKeyAny(pubKey: Uint8Array): Uint8Array {
  return encodeAny(PUBKEY_SECP256K1_TYPE, new Writer().bytes(1, pubKey).finish());
}

/** Protobuf encoding of a std.Tx. */
export function encodeTx(msgs: TxMsg[], fee: TxFee, sigs: TxSignature[], memo: string): Uint8Array {
  const w = new Writer();
  for (const m of msgs) w.bytes(1, encodeAny(m.type, encodeMsgValue(m)));
  const fw = new Writer();
  if (fee.gasWanted !== 0n) fw.sint64(1, fee.gasWanted);
  fw.optString(2, fee.gasFee);
  w.bytes(2, fw.finish());
  for (const s of sigs) {
    const sw = new Writer().bytes(1, encodePubKeyAny(s.pubKey));
    if (s.signature.length > 0) sw.bytes(2, s.signature);
    w.bytes(3, sw.finish());
  }
  w.optString(4, memo);
  return w.finish();
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
  return out;
}

/** Parses "<amount><denom>" into the sign-doc coin list ("" or zero gives []). */
export function signCoins(coin: string): { denom: string; amount: string }[] {
  const t = coin.trim();
  if (t === "") return [];
  const m = /^(\d+)\s*([a-z/][a-z0-9_.:/-]{2,})$/.exec(t);
  if (!m) throw new Error(`invalid coin: ${coin}`);
  if (BigInt(m[1]!) === 0n) return [];
  return [{ denom: m[2]!, amount: BigInt(m[1]!).toString() }];
}

function msgJSON(m: TxMsg): Record<string, unknown> {
  if (m.type === "/vm.m_call") {
    const v = m.value;
    const o: Record<string, unknown> = {
      "@type": m.type,
      caller: v.caller,
      send: v.send,
      max_deposit: v.max_deposit,
      pkg_path: v.pkg_path,
      func: v.func,
    };
    if (v.args.length) o.args = v.args;
    return o;
  }
  return { "@type": m.type, ...m.value };
}

/** Amino-JSON sign bytes (sorted keys, Go's HTML escaping), as tm2-js-client produces them. */
export function signBytes(o: {
  chainId: string;
  accountNumber: string;
  sequence: string;
  fee: TxFee;
  msgs: TxMsg[];
  memo: string;
}): Uint8Array {
  const doc = {
    chain_id: o.chainId,
    account_number: o.accountNumber,
    sequence: o.sequence,
    fee: { amount: signCoins(o.fee.gasFee), gas: o.fee.gasWanted.toString(10) },
    msgs: o.msgs.map(msgJSON),
    memo: o.memo,
  };
  const s = JSON.stringify(sortKeys(doc)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return utf8(s);
}
