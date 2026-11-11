// Adena browser-wallet adapter for the owner account (Join, TopUp, Leave, refilling the session key).
//
// Follows the injected API of the current Adena extension (window.adena: AddEstablish,
// GetAccount, GetNetwork, SwitchNetwork, DoContract). Adena estimates gas itself and does not take
// gas fields in DoContract, so the gas settings of a CallRequest are not forwarded.
// NOT exercised by the automated tests: it needs the extension installed.

import type { CallRequest, CallResult } from "@gno-poker/protocol";
import { fromBase64 } from "@gno-poker/protocol";
import { TxError, type WalletSigner } from "./signer.ts";
import { cleanLog } from "./rpc.ts";

interface AdenaResponse<T> {
  code: number;
  status: "success" | "failure" | string;
  type: string;
  message: string;
  data: T;
}

interface AdenaAccount {
  address: string;
  chainId?: string;
  coins?: string;
}

interface AdenaTxResult {
  hash?: string;
  height?: string;
  check_tx?: { ResponseBase?: { Error?: unknown; Log?: string } };
  deliver_tx?: { ResponseBase?: { Error?: unknown; Log?: string; Data?: string | null }; GasUsed?: string };
}

interface AdenaApi {
  AddEstablish(name: string): Promise<AdenaResponse<unknown>>;
  GetAccount(): Promise<AdenaResponse<AdenaAccount>>;
  GetNetwork?(): Promise<AdenaResponse<{ chainId: string; rpcUrl?: string }>>;
  SwitchNetwork?(chainId: string): Promise<AdenaResponse<unknown>>;
  DoContract(
    params: { messages: { type: string; value: Record<string, unknown> }[]; memo?: string },
    options?: { withNotification?: boolean; isVisibleResult?: boolean },
  ): Promise<AdenaResponse<AdenaTxResult>>;
}

function api(): AdenaApi | null {
  return ((globalThis as unknown as { adena?: AdenaApi }).adena) ?? null;
}

export function adenaAvailable(): boolean {
  return api() !== null;
}

export class AdenaSigner implements WalletSigner {
  readonly kind = "adena" as const;
  readonly address: string;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(address: string) {
    this.address = address;
  }

  /** Asks the extension for access and returns a signer for the selected account. */
  static async connect(appName: string, chainId?: string): Promise<AdenaSigner> {
    const a = api();
    if (!a) throw new Error("Adena wallet extension not found. Install Adena or use the development wallet.");
    const est = await a.AddEstablish(appName);
    if (est.status !== "success" && est.type !== "ALREADY_CONNECTED") {
      throw new Error(`Adena refused the connection: ${est.message || est.type}`);
    }
    if (chainId && a.GetNetwork && a.SwitchNetwork) {
      const net = await a.GetNetwork();
      if (net.status === "success" && net.data?.chainId !== chainId) {
        const sw = await a.SwitchNetwork(chainId);
        if (sw.status !== "success") {
          throw new Error(`Adena is on chain "${net.data?.chainId}", this app is configured for "${chainId}". Switch networks in Adena (${sw.message || sw.type}).`);
        }
      }
    }
    const acct = await a.GetAccount();
    if (acct.status !== "success" || !acct.data?.address) throw new Error(`Adena: cannot read the account (${acct.message || acct.type})`);
    return new AdenaSigner(acct.data.address);
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  call(req: CallRequest): Promise<CallResult> {
    return this.enqueue(req.func, {
      type: "/vm.m_call",
      value: {
        caller: this.address,
        send: req.send > 0n ? `${req.send}ugnot` : "",
        max_deposit: req.maxDeposit !== undefined && req.maxDeposit > 0n ? `${req.maxDeposit}ugnot` : "",
        pkg_path: req.pkgPath,
        func: req.func,
        args: req.args,
      },
    }, req.memo);
  }

  send(to: string, amount: bigint): Promise<CallResult> {
    return this.enqueue("Send", {
      type: "/bank.MsgSend",
      value: { from_address: this.address, to_address: to, amount: `${amount}ugnot` },
    });
  }

  private enqueue(func: string, message: { type: string; value: Record<string, unknown> }, memo?: string): Promise<CallResult> {
    const run = async (): Promise<CallResult> => {
      const a = api();
      if (!a) throw new TxError(func, "Adena extension not available", "", true);
      const params: { messages: { type: string; value: Record<string, unknown> }[]; memo?: string } = { messages: [message] };
      if (memo) params.memo = memo;
      const r = await a.DoContract(params, { withNotification: true, isVisibleResult: false });
      const d = r.data ?? {};
      const log = d.deliver_tx?.ResponseBase?.Log || d.check_tx?.ResponseBase?.Log || "";
      if (r.status !== "success" || d.deliver_tx?.ResponseBase?.Error || d.check_tx?.ResponseBase?.Error) {
        throw new TxError(func, cleanLog(log) || r.message || r.type || "rejected", log, false);
      }
      const data = d.deliver_tx?.ResponseBase?.Data;
      return {
        hash: d.hash ?? "",
        height: Number(d.height ?? 0),
        data: data ? new TextDecoder().decode(fromBase64(data)) : "",
        gasUsed: BigInt(d.deliver_tx?.GasUsed ?? "0"),
      };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}
