// Starts one gnodev for the whole e2e run (unless E2E_RPC points at a running node) and stops it.

import { join } from "node:path";
import { REPO_ROOT, startGnodev } from "./gnodev.ts";

declare module "vitest" {
  export interface ProvidedContext {
    rpcUrl: string;
  }
}

export default async function setup({ provide }: { provide: (key: "rpcUrl", value: string) => void }): Promise<() => Promise<void>> {
  if (process.env.E2E_RPC) {
    provide("rpcUrl", process.env.E2E_RPC);
    return async () => {};
  }
  const port = Number(process.env.E2E_PORT ?? 36657);
  const node = await startGnodev({ port, logDir: join(REPO_ROOT, "packages/bots/e2e-results") });
  console.log(`gnodev (master) on ${node.rpcUrl}, log ${node.logPath}`);
  provide("rpcUrl", node.rpcUrl);
  return async () => {
    await node.stop();
  };
}
