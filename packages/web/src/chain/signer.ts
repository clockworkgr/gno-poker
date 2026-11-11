// PokerSigner over a raw secp256k1 key: the dev wallet and the per-table session key.

import type { CallRequest, CallResult, PokerSigner } from "@gno-poker/protocol";
import { fromBase64 } from "@gno-poker/protocol";
import { type KeyPair, signData } from "./keys.ts";
import { encodeTx, signBytes, type TxFee, type TxMsg } from "./proto.ts";
import { GnoRpc, cleanLog } from "./rpc.ts";

/** A failed transaction. `message` carries the realm's panic text when there is one. */
export class TxError extends Error {
  readonly func: string;
  readonly log: string;
  /** True if the chain rejected the tx before execution (no fee charged). */
  readonly checkTx: boolean;
  constructor(func: string, reason: string, log: string, checkTx: boolean) {
    super(`${func}: ${reason}`);
    this.name = "TxError";
    this.func = func;
    this.log = log;
    this.checkTx = checkTx;
  }
}

/** Owner wallets can also move plain coins (refilling or sweeping a session key). */
export interface WalletSigner extends PokerSigner {
  readonly kind: "dev" | "adena" | "session";
  send(to: string, amount: bigint, fee?: TxFee): Promise<CallResult>;
}

export const SEND_FEE: TxFee = { gasWanted: 2_000_000n, gasFee: "2000ugnot" };

export class LocalSigner implements WalletSigner {
  readonly kind: "dev" | "session";
  readonly key: KeyPair;
  readonly rpc: GnoRpc;
  readonly chainId: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(o: { key: KeyPair; rpc: GnoRpc; chainId: string; kind?: "dev" | "session" }) {
    this.key = o.key;
    this.rpc = o.rpc;
    this.chainId = o.chainId;
    this.kind = o.kind ?? "dev";
  }

  get address(): string {
    return this.key.address;
  }

  async getAddress(): Promise<string> {
    return this.key.address;
  }

  call(req: CallRequest): Promise<CallResult> {
    const msg: TxMsg = {
      type: "/vm.m_call",
      value: {
        caller: this.key.address,
        send: req.send > 0n ? `${req.send}ugnot` : "",
        max_deposit: req.maxDeposit !== undefined && req.maxDeposit > 0n ? `${req.maxDeposit}ugnot` : "",
        pkg_path: req.pkgPath,
        func: req.func,
        args: req.args,
      },
    };
    return this.enqueue(req.func, [msg], { gasWanted: req.gasWanted, gasFee: req.gasFee }, req.memo ?? "");
  }

  send(to: string, amount: bigint, fee: TxFee = SEND_FEE): Promise<CallResult> {
    const msg: TxMsg = { type: "/bank.MsgSend", value: { from_address: this.key.address, to_address: to, amount: `${amount}ugnot` } };
    return this.enqueue("Send", [msg], fee, "");
  }

  /** Serializes transactions so account sequence numbers never race. */
  private enqueue(func: string, msgs: TxMsg[], fee: TxFee, memo: string): Promise<CallResult> {
    const run = () => this.broadcast(func, msgs, fee, memo);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async broadcast(func: string, msgs: TxMsg[], fee: TxFee, memo: string): Promise<CallResult> {
    const acct = await this.rpc.account(this.key.address);
    if (!acct) throw new TxError(func, `account ${this.key.address} has no funds on this chain`, "", true);
    const sb = signBytes({ chainId: this.chainId, accountNumber: acct.accountNumber, sequence: acct.sequence, fee, msgs, memo });
    const sig = signData(this.key.privateKey, sb);
    const tx = encodeTx(msgs, fee, [{ pubKey: this.key.publicKey, signature: sig }], memo);
    const r = await this.rpc.broadcastTxCommit(tx);
    if (r.check_tx.ResponseBase.Error) {
      const log = r.check_tx.ResponseBase.Log;
      throw new TxError(func, cleanLog(log) || "rejected by the node", log, true);
    }
    if (r.deliver_tx.ResponseBase.Error) {
      const log = r.deliver_tx.ResponseBase.Log;
      throw new TxError(func, cleanLog(log) || "transaction failed", log, false);
    }
    const data = r.deliver_tx.ResponseBase.Data;
    return {
      hash: r.hash,
      height: Number(r.height),
      data: data ? new TextDecoder().decode(fromBase64(data)) : "",
      gasUsed: BigInt(r.deliver_tx.GasUsed ?? "0"),
    };
  }
}
