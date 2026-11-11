import type { OwedAction } from "@gno-poker/protocol";
import type { SessionView, TickInput } from "./protocolCore.ts";

interface Base {
  id: number;
  rpcUrl: string;
  realm: string;
}

export type WorkerRequest =
  | (Base & { type: "tick"; input: TickInput })
  | (Base & { type: "submitted"; namespace: string; tableId: number; handNo: number; action: OwedAction });

export type WorkerResponse =
  | { id: number; ok: true; view: SessionView | null }
  | { id: number; ok: false; error: string };
