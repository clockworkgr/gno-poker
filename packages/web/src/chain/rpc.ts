// Tiny TM2 JSON-RPC client over fetch (works in the browser, in workers and in Node).

import { fromBase64, toBase64, utf8 } from "@gno-poker/protocol";

export interface AbciResponseBase {
  Error: unknown;
  Data: string | null;
  Log: string;
  Info?: string;
  Events?: unknown;
}

export interface BroadcastCommitResult {
  check_tx: { ResponseBase: AbciResponseBase; GasWanted?: string; GasUsed?: string };
  deliver_tx: { ResponseBase: AbciResponseBase; GasWanted?: string; GasUsed?: string };
  hash: string;
  height: string;
}

export class RpcError extends Error {
  readonly log: string;
  constructor(message: string, log = "") {
    super(message);
    this.name = "RpcError";
    this.log = log;
  }
}

let nextId = 1;

export class GnoRpc {
  readonly url: string;
  constructor(url: string) {
    this.url = url.replace(/\/+$/, "");
  }

  async call<T>(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.url + "/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        signal: ctl.signal,
      });
    } catch (e) {
      throw new RpcError(`cannot reach node at ${this.url}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new RpcError(`node returned HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string; data?: string } };
    if (body.error) throw new RpcError(`${method}: ${body.error.message ?? "error"}${body.error.data ? ` (${body.error.data})` : ""}`);
    return body.result as T;
  }

  /** Raw abci_query; returns decoded Data text. Throws with the node's log on error. */
  async abciQuery(path: string, data: Uint8Array = new Uint8Array()): Promise<string> {
    const r = await this.call<{ response: { ResponseBase: AbciResponseBase } }>("abci_query", {
      path,
      data: toBase64(data),
    });
    const base = r.response.ResponseBase;
    if (base.Error) throw new RpcError(cleanLog(base.Log) || "query failed", base.Log);
    return base.Data ? new TextDecoder().decode(fromBase64(base.Data)) : "";
  }

  async qeval(pkgPath: string, expr: string): Promise<string> {
    return this.abciQuery("vm/qeval", utf8(`${pkgPath}.${expr}`));
  }

  async qrender(pkgPath: string, path: string): Promise<string> {
    return this.abciQuery("vm/qrender", utf8(`${pkgPath}:${path}`));
  }

  async status(): Promise<{ network: string; height: number }> {
    const r = await this.call<{ node_info: { network: string }; sync_info: { latest_block_height: string } }>("status", {});
    return { network: r.node_info.network, height: Number(r.sync_info.latest_block_height) };
  }

  /** Account number and sequence; null if the account does not exist yet. */
  async account(address: string): Promise<{ accountNumber: string; sequence: string } | null> {
    const t = await this.abciQuery(`auth/accounts/${address}`);
    if (!t || t === "null") return null;
    const o = JSON.parse(t) as { BaseAccount?: { account_number: string; sequence: string } } | null;
    if (!o?.BaseAccount) return null;
    return { accountNumber: String(o.BaseAccount.account_number), sequence: String(o.BaseAccount.sequence) };
  }

  /** ugnot balance. */
  async balance(address: string, denom = "ugnot"): Promise<bigint> {
    const t = await this.abciQuery(`bank/balances/${address}`);
    const s = t.replace(/"/g, "");
    for (const coin of s.split(",")) {
      const m = /^(\d+)(.+)$/.exec(coin.trim());
      if (m && m[2] === denom) return BigInt(m[1]!);
    }
    return 0n;
  }

  async broadcastTxCommit(tx: Uint8Array): Promise<BroadcastCommitResult> {
    return this.call<BroadcastCommitResult>("broadcast_tx_commit", { tx: toBase64(tx) }, 90_000);
  }
}

/**
 * Extracts the human-readable reason from a TM2/gno error log: the realm's panic text when there
 * is one, otherwise the first meaningful line.
 */
export function cleanLog(log: string): string {
  if (!log) return "";
  log = log.replace(/; simulate with consensus maximum[^\n]*/g, "");
  const panic = /(?:^|\n)\s*(?:unhandled )?panic: ([^\n]*)/.exec(log);
  if (panic) return panic[1]!.trim();
  const trace = /\.go:\d+ - ([^\n]+)/.exec(log);
  if (trace) return trace[1]!.replace(/^VM panic: /, "").replace(/; simulate with .*$/, "").trim();
  const data = /Data: ([^\n]+)/.exec(log);
  if (data) return data[1]!.trim();
  const first = log.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("--="));
  return (first ?? log).slice(0, 300);
}
