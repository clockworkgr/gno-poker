// Web Worker hosting ProtocolCore, so deck passes, card opening and hand verification
// (2048-bit modexp) never block the UI thread.

import { PokerClient } from "@gno-poker/protocol";
import { GnoRpc } from "../chain/rpc.ts";
import { IndexedDbStore } from "./idbStore.ts";
import { ProtocolCore } from "./protocolCore.ts";
import type { WorkerRequest, WorkerResponse } from "./workerTypes.ts";

let core: ProtocolCore | null = null;
let configKey = "";
let queue: Promise<unknown> = Promise.resolve();
const store = new IndexedDbStore();

function ensure(rpcUrl: string, realm: string): ProtocolCore {
  const k = `${rpcUrl}|${realm}`;
  if (!core || k !== configKey) {
    const rpc = new GnoRpc(rpcUrl);
    const client = new PokerClient({ querier: { evaluate: (p, e) => rpc.qeval(p, e) }, pkgPath: realm });
    core = new ProtocolCore({ store, client });
    configKey = k;
  }
  return core;
}

async function handle(msg: WorkerRequest): Promise<WorkerResponse> {
  try {
    const c = ensure(msg.rpcUrl, msg.realm);
    if (msg.type === "tick") {
      const view = await c.tick(msg.input);
      return { id: msg.id, ok: true, view };
    }
    await c.submitted(msg.namespace, msg.tableId, msg.handNo, msg.action);
    return { id: msg.id, ok: true, view: null };
  } catch (e) {
    return { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  // One message at a time: a HandSession is not re-entrant.
  queue = queue.then(async () => {
    const res = await handle(msg);
    (self as unknown as Worker).postMessage(res);
  });
};
