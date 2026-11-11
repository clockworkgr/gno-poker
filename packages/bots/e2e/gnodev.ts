// Starts and stops a gnodev node built from gno master (crypto/modexp is needed for challenges).

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Directory holding the master gno, gnodev and gnokey binaries ($GNO_MASTER_BIN, default <repo>/.gno-bin). */
export function gnoBinDir(): string {
  return process.env.GNO_MASTER_BIN ?? join(REPO_ROOT, ".gno-bin");
}

export interface GnodevHandle {
  rpcUrl: string;
  logPath: string;
  stop(): Promise<void>;
}

export interface GnodevOptions {
  port: number;
  /** Workspace (gnowork.toml) to load. Default <repo>/contracts. */
  workspace?: string;
  /** Packages to preload. Default the poker realm. */
  paths?: string[];
  logDir?: string;
}

export async function startGnodev(o: GnodevOptions): Promise<GnodevHandle> {
  const bin = join(gnoBinDir(), "gnodev");
  if (!existsSync(bin)) {
    throw new Error(`gnodev not found at ${bin}. Build gno master (scripts/build-gno.sh) or set GNO_MASTER_BIN.`);
  }
  const logDir = o.logDir ?? mkdtempSync(join(tmpdir(), "gno-poker-e2e-"));
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `gnodev-${o.port}.log`);
  const fd = openSync(logPath, "w");
  const args = [
    "local",
    "-C", o.workspace ?? join(REPO_ROOT, "contracts"),
    "-paths", (o.paths ?? ["gno.land/r/demo/poker"]).join(","),
    "-no-watch",
    "-no-web",
    "-empty-blocks",
    "-empty-blocks-interval", "1",
    "-node-rpc-listener", `127.0.0.1:${o.port}`,
  ];
  if (process.env.GNOROOT) args.push("-root", process.env.GNOROOT);
  const child: ChildProcess = spawn(bin, args, { stdio: ["ignore", fd, fd], detached: true });
  const rpcUrl = `http://127.0.0.1:${o.port}`;
  const stop = async () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    const t = Date.now();
    while (child.exitCode === null && Date.now() - t < 10_000) await new Promise((r) => setTimeout(r, 100));
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`gnodev exited with ${child.exitCode}; see ${logPath}`);
    try {
      const r = await fetch(`${rpcUrl}/status`);
      if (r.ok) {
        const st = (await r.json()) as { result?: { sync_info?: { latest_block_height?: string } } };
        if (Number(st.result?.sync_info?.latest_block_height ?? 0) >= 1) break;
      }
    } catch {
      // not up yet
    }
    if (Date.now() - t0 > 120_000) {
      await stop();
      throw new Error(`gnodev did not start in time; see ${logPath}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { rpcUrl, logPath, stop };
}
