#!/usr/bin/env node
// gno-poker bots CLI. Run with `node src/cli.ts <command> [flags]` (Node >= 24).

import { parseArgs } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";
import { CHEAT_KINDS, type CheatKind, STALL_STEPS, type StallStep } from "./cheats.ts";
import { type Env, connectEnv, createTable, moneySnapshot, newBot, runBots } from "./runner.ts";
import { STRATEGIES, seededRng, strategyByName } from "./strategy.ts";
import { FileStore } from "./store.ts";
import type { Bot } from "./bot.ts";

const USAGE = `Usage: gno-poker-bots <command> [flags]

Commands:
  create  Create a table (prints its id).
  run     Fund N fresh bots from the faucet, seat them and play.
  sit     Seat one bot at an existing table and play against whoever joins (e.g. a human in the web UI).
  tables  List tables.

Common flags:
  --rpc URL              Node RPC (default http://127.0.0.1:26657)
  --pkg PATH             Realm path (default gno.land/r/demo/poker)
  --faucet-mnemonic M    Funding account (default: gnodev test1)

run flags:
  --table ID             Use an existing table (default: create one)
  --bots N               Number of bots (default 2)
  --strategies a,b,...   Strategies, cycled over the bots (${Object.keys(STRATEGIES).join(", ")})
  --hands N              Stop after N finished hands, then leave (default: run until Ctrl-C)
  --session              Bots play through session keys with a gas allowance
  --buyin UGNOT          Buy-in (default 2x the table minimum)
  --seed N               Seed for the strategies' random choices
  --cheat KIND           First bot cheats: ${CHEAT_KINDS.join(", ")} (testing only)
  --stall STEP           First bot stalls once at: ${STALL_STEPS.join(", ")} (testing only)
  --small-blind, --big-blind, --max-players, --timeout-blocks, --window-blocks, --bond
                         new table parameters (also for create; buy-in is 20 to 100 big blinds)

sit flags:
  --table ID             Table to sit at (required)
  --strategy NAME        Strategy (default hand-strength)
  --key HEX              Owner private key (default: a fresh key funded from the faucet)
  --session              Play through a session key
  --buyin UGNOT          Buy-in (default 2x the table minimum)
  --store DIR            Where hand secrets are kept (default ~/.gno-poker-bots)
`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      rpc: { type: "string", default: "http://127.0.0.1:26657" },
      pkg: { type: "string" },
      "faucet-mnemonic": { type: "string" },
      table: { type: "string" },
      bots: { type: "string", default: "2" },
      strategies: { type: "string", default: "hand-strength,random,calling-station" },
      strategy: { type: "string", default: "hand-strength" },
      hands: { type: "string" },
      session: { type: "boolean", default: false },
      buyin: { type: "string" },
      seed: { type: "string" },
      cheat: { type: "string" },
      stall: { type: "string" },
      key: { type: "string" },
      store: { type: "string" },
      "small-blind": { type: "string", default: "1000" },
      "big-blind": { type: "string", default: "2000" },
      "max-players": { type: "string", default: "6" },
      "timeout-blocks": { type: "string", default: "30" },
      "window-blocks": { type: "string", default: "30" },
      bond: { type: "string", default: "10000" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(USAGE);
    return;
  }
  const env = await connectEnv({
    rpcUrl: values.rpc!,
    ...(values.pkg ? { pkgPath: values.pkg } : {}),
    ...(values["faucet-mnemonic"] ? { faucetMnemonic: values["faucet-mnemonic"] } : {}),
  });

  if (cmd === "create") {
    const id = await createTable(env, tableParams(values));
    console.log(id);
    return;
  }

  if (cmd === "tables") {
    for (const t of await env.client.listTables()) {
      console.log(`table ${t.id}: blinds ${t.smallBlind}/${t.bigBlind}, buy-in ${t.minBuyIn}-${t.maxBuyIn}, ${t.seated}/${t.maxPlayers} seated, hand ${t.handNo} ${t.phase}`);
    }
    return;
  }

  const ac = new AbortController();
  let bots: Bot[] = [];
  process.on("SIGINT", () => {
    if (bots.every((b) => b.isStopped) || ac.signal.aborted) process.exit(130);
    console.log("\nleaving after the current hand (Ctrl-C again to quit now)...");
    for (const b of bots) b.requestStop();
    ac.abort();
  });
  const wait = async () => {
    while (!bots.every((b) => b.isStopped)) await new Promise((r) => setTimeout(r, 300));
  };

  if (cmd === "run") {
    const tableId = values.table
      ? Number(values.table)
      : await createTable(env, tableParams(values));
    const table = await env.client.getTable(tableId);
    const challengesEnabled = await env.client.challengesEnabled();
    const names = values.strategies!.split(",").map((s) => s.trim());
    const n = Number(values.bots);
    const rng = seededRng(Number(values.seed ?? Date.now() % 2 ** 31));
    for (let i = 0; i < n; i++) {
      const strategy = strategyByName(names[i % names.length]!);
      bots.push(
        await newBot(env, {
          name: `bot${i + 1}-${strategy.name}`,
          tableId,
          strategy,
          buyIn: values.buyin ? BigInt(values.buyin) : table.minBuyIn * 2n,
          rng,
          challengesEnabled,
          ...(values.session ? { sessionAllowance: 5_000_000n, sessionRefill: { below: 2_000_000n, amount: 5_000_000n } } : {}),
          ...(i === 0 && values.cheat ? { cheat: values.cheat as CheatKind } : {}),
          ...(i === 0 && values.stall ? { stall: { step: values.stall as StallStep } } : {}),
        }),
      );
    }
    const target = values.hands ? Number(values.hands) : Infinity;
    let finished = 0;
    env.history.onFinish = async (t, s) => {
      if (t.id !== tableId) return;
      finished++;
      const m = await moneySnapshot(env);
      console.log(`  [hand ${s.handNo}: ${(s.ms / 1000).toFixed(1)}s; realm balance ${m.realmBalance}, stacks ${m.stacks}, pots ${m.pots}]`);
    };
    await runBots(bots, () => finished >= target || ac.signal.aborted, { timeoutMs: 24 * 3600_000, leaveAtEnd: true });
    await wait();
    printSummary(env);
    return;
  }

  if (cmd === "sit") {
    if (!values.table) throw new Error("--table is required");
    const tableId = Number(values.table);
    const table = await env.client.getTable(tableId);
    const strategy = strategyByName(values.strategy!);
    const name = `${strategy.name}-bot`;
    const bot = await newBot(env, {
      name,
      tableId,
      strategy,
      buyIn: values.buyin ? BigInt(values.buyin) : table.minBuyIn * 2n,
      challengesEnabled: await env.client.challengesEnabled(),
      store: new FileStore(join(values.store ?? join(homedir(), ".gno-poker-bots"), `${tableId}-${name}.json`)),
      fallbackDelayMs: 3000,
      onBust: "topup",
      maxTopUps: 1_000_000,
      ...(values.key ? { ownerKeyHex: values.key, fund: 0n } : {}),
      ...(values.session ? { sessionAllowance: 5_000_000n, sessionRefill: { below: 2_000_000n, amount: 5_000_000n } } : {}),
    });
    bots = [bot];
    console.log(`${name} (${bot.ownerAddress}) is seated at table ${tableId}; waiting for opponents. Ctrl-C to leave.`);
    await runBots(bots, () => ac.signal.aborted, { timeoutMs: 365 * 24 * 3600_000, leaveAtEnd: true });
    await wait();
    return;
  }
  throw new Error(`unknown command ${cmd}\n${USAGE}`);
}

function tableParams(v: Record<string, string | boolean | undefined>) {
  const bb = BigInt(v["big-blind"] as string);
  return {
    smallBlind: BigInt(v["small-blind"] as string),
    bigBlind: bb,
    minBuyIn: bb * 20n,
    maxBuyIn: bb * 100n,
    maxPlayers: Number(v["max-players"]),
    actionTimeoutBlocks: Number(v["timeout-blocks"]),
    challengeWindowBlocks: Number(v["window-blocks"]),
    challengeBond: BigInt(v.bond as string),
  };
}

function printSummary(env: Env): void {
  const s = env.history.summaries;
  if (!s.length) return;
  const avg = s.reduce((a, x) => a + x.ms, 0) / s.length;
  console.log(`\n${s.length} hands, ${(avg / 1000).toFixed(2)}s per hand on average`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
