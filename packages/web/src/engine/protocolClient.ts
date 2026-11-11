// Main-thread proxy to the protocol worker.

import type { OwedAction } from "@gno-poker/protocol";
import type { SessionView, TickInput } from "./protocolCore.ts";
import type { WorkerRequest, WorkerResponse } from "./workerTypes.ts";

type Body = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, "id" | "rpcUrl" | "realm"> : never) : never;

type Pending = { resolve: (v: SessionView | null) => void; reject: (e: Error) => void };

export class ProtocolClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly rpcUrl: string;
  private readonly realm: string;

  constructor(rpcUrl: string, realm: string) {
    this.rpcUrl = rpcUrl;
    this.realm = realm;
    this.worker = new Worker(new URL("./protocol.worker.ts", import.meta.url), { type: "module", name: "gno-poker-protocol" });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const r = ev.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r.view);
      else p.reject(new Error(r.error));
    };
    this.worker.onerror = (ev) => {
      const err = new Error(`protocol worker failed: ${ev.message}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private post(req: Body): Promise<SessionView | null> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id, rpcUrl: this.rpcUrl, realm: this.realm } as WorkerRequest);
    });
  }

  tick(input: TickInput): Promise<SessionView | null> {
    return this.post({ type: "tick", input });
  }

  async submitted(namespace: string, tableId: number, handNo: number, action: OwedAction): Promise<void> {
    await this.post({ type: "submitted", namespace, tableId, handNo, action });
  }

  terminate(): void {
    this.worker.terminate();
  }
}
