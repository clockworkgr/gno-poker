// Dev-only opponents for trying the web UI against a local gnodev: seats N auto-players at a
// table and plays every hand for them with HandSession (via ProtocolCore). They always check or
// call, run every protocol step, accept verified results and challenge bad ones.
//
//   node dev/autoplayer.ts --table 1 --bots 2 [--auto-start 2] [--rpc http://127.0.0.1:46657]
//
// Options:
//   --table <id>        table to sit at (required unless --create)
//   --create            create a table first (blinds 1000/2000, buy-in 40k..200k, 6 seats)
//   --bots <n>          number of auto-players (default 1)
//   --buyin <ugnot>     buy-in per bot (default: the table's max buy-in)
//   --auto-start <s>    start the next hand <s> seconds after the previous one ends (default off)
//   --timeouts          call Timeout/Finalize when a deadline passes (default off)
//   --cheat             bot 1 submits a wrong shuffle whenever it is the last shuffler (to test challenges)
//   --stall <phase>     bot 1 never acts in this phase, e.g. "reveal" (to test timeouts)
//   --index <k>         first account index derived from the test1 mnemonic (default 10)
//   --rpc, --chain, --realm   node and realm (defaults: 127.0.0.1:46657, dev, gno.land/r/demo/poker)
// On SIGINT/SIGTERM the bots call Leave (paid out now, or when the current hand is finalized).

import { type CheatHooks, type OwedAction, PokerClient, MemoryStore, parseGnoString, parseTableJSON, type TableState } from "@gno-poker/protocol";
import { TEST1_MNEMONIC, keyPairFromMnemonic } from "../src/chain/keys.ts";
import { GnoRpc } from "../src/chain/rpc.ts";
import { LocalSigner } from "../src/chain/signer.ts";
import { WEB_GAS } from "../src/config.ts";
import { ProtocolCore } from "../src/engine/protocolCore.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? "true" : v;
}

const rpcUrl = arg("rpc") ?? "http://127.0.0.1:46657";
const chainId = arg("chain") ?? "dev";
const realm = arg("realm") ?? "gno.land/r/demo/poker";
const nBots = Number(arg("bots") ?? 1);
const autoStart = arg("auto-start") ? Number(arg("auto-start")) : null;
const callTimeouts = arg("timeouts") === "true";
const indexBase = Number(arg("index") ?? 10);
const cheat = arg("cheat") === "true";
const stallPhase = arg("stall") ?? null;

const rpc = new GnoRpc(rpcUrl);
const client = new PokerClient({ querier: { evaluate: (p, e) => rpc.qeval(p, e) }, pkgPath: realm, gas: WEB_GAS });
const funder = new LocalSigner({ key: keyPairFromMnemonic(TEST1_MNEMONIC, 0), rpc, chainId });

const ts = () => new Date().toISOString().slice(11, 19);
const say = (who: string, msg: string) => console.log(`${ts()} [${who}] ${msg}`);

interface Bot {
  name: string;
  signer: LocalSigner;
  core: ProtocolCore;
  busy: boolean;
  failures: Map<string, number>;
  stall: string | null;
}

async function getTable(id: number): Promise<{ raw: string; table: TableState }> {
  const raw = parseGnoString(await rpc.qeval(realm, `GetTable(${id})`));
  return { raw, table: parseTableJSON(raw) };
}

async function main(): Promise<void> {
  let tableId = Number(arg("table") ?? 0);
  if (arg("create") === "true") {
    tableId = await client.createTable(funder, {
      smallBlind: 1000n, bigBlind: 2000n, minBuyIn: 40_000n, maxBuyIn: 200_000n, maxPlayers: 6,
      actionTimeoutBlocks: 60, challengeWindowBlocks: 30, challengeBond: 10_000n,
    });
    say("setup", `created table ${tableId}`);
  }
  if (!tableId) throw new Error("--table <id> or --create is required");
  let { table } = await getTable(tableId);
  const buyIn = arg("buyin") ? BigInt(arg("buyin")!) : table.maxBuyIn;

  const bots: Bot[] = [];
  for (let i = 0; i < nBots; i++) {
    const key = keyPairFromMnemonic(TEST1_MNEMONIC, indexBase + i);
    const signer = new LocalSigner({ key, rpc, chainId });
    const bal = await rpc.balance(key.address);
    const need = buyIn + 10_000_000n;
    if (bal < need) {
      await funder.send(key.address, need * 3n);
      say("setup", `funded bot${i + 1} ${key.address}`);
    }
    const cheatHooks: CheatHooks | undefined = cheat && i === 0
      ? {
          // Swap a board position with player 0's first hole card, but only as the last shuffler,
          // where nobody shuffles after it to hide the change.
          shuffleExtraPerm: (ctx) => {
            if (ctx.myIndex !== ctx.n - 1) return null;
            const x = Array.from({ length: 52 }, (_, k) => k);
            [x[0], x[2 * ctx.n]] = [x[2 * ctx.n]!, x[0]!];
            say(`bot${i + 1}`, `hand #${ctx.handNo}: CHEATING in the last shuffle`);
            return x;
          },
        }
      : undefined;
    const core = new ProtocolCore({ store: new MemoryStore(), client, ...(cheatHooks ? { cheat: cheatHooks } : {}) });
    const bot: Bot = { name: `bot${i + 1}`, signer, core, busy: false, failures: new Map(), stall: i === 0 ? stallPhase : null };
    bots.push(bot);
    ({ table } = await getTable(tableId));
    if (!table.seats.some((s) => s?.owner === key.address)) {
      await client.join(signer, tableId, buyIn, "", 0n);
      say(bot.name, `joined table ${tableId} as ${key.address}`);
    } else {
      say(bot.name, `already seated as ${key.address}`);
    }
  }

  let doneSince: number | null = null;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    say("setup", "leaving the table");
    for (const b of bots) {
      try {
        await client.leave(b.signer, tableId);
      } catch (e) {
        say(b.name, `leave: ${(e as Error).message}`);
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  for (;;) {
    if (stopping) return;
    let raw: string;
    try {
      ({ raw, table } = await getTable(tableId));
    } catch (e) {
      say("poll", (e as Error).message);
      await sleep(1000);
      continue;
    }
    await Promise.all(bots.map((b) => step(b, tableId, raw, table)));

    // Start the next hand when asked to.
    const live = table.hand && table.hand.phase !== "done";
    if (!live && autoStart !== null) {
      doneSince ??= Date.now();
      const eligible = table.seats.filter((s) => s && !s.sittingOut && !s.leaving && s.stack >= table.bigBlind).length;
      const starter = bots.find((b) => table.seats.some((s) => s?.owner === b.signer.address));
      if (eligible >= 2 && starter && Date.now() - doneSince >= autoStart * 1000) {
        try {
          await client.startHand(starter.signer, tableId);
          say(starter.name, `started hand #${table.handNo + 1}`);
        } catch (e) {
          say(starter.name, `start: ${(e as Error).message}`);
        }
        doneSince = null;
      }
    } else {
      doneSince = null;
    }
    await sleep(700);
  }
}

async function step(b: Bot, tableId: number, raw: string, table: TableState): Promise<void> {
  if (b.busy) return;
  b.busy = true;
  try {
    const view = await b.core.tick({ tableJson: raw, address: b.signer.address, namespace: `bot/${b.signer.address}`, challengesEnabled: true });
    if (!view) return;
    const a = view.action;
    if (b.stall && table.hand?.phase === b.stall) return;
    if (a.type === "none") return;
    if ((a.type === "timeout" || a.type === "finalize") && !callTimeouts) return;
    const id = a.id;
    if ((b.failures.get(id) ?? 0) >= 3) return;
    const c = client.as(b.signer);
    const h = view.handNo;
    try {
      switch (a.type) {
        case "submitShuffle": await c.submitShuffle(tableId, h, a.commitHex, a.deckB64); break;
        case "submitRekey": await c.submitRekey(tableId, h, a.deckB64); break;
        case "shareKeys": await c.shareKeys(tableId, h, a.keysHex); break;
        case "revealSeed": await c.revealSeed(tableId, h, a.seedHex); break;
        case "accept": await c.accept(tableId, h); break;
        case "challenge": await c.challenge(tableId, h, a.args); break;
        case "timeout": await c.timeout(tableId); break;
        case "finalize": await c.finalize(tableId); break;
        case "bet": {
          const act = a.options.canCheck ? "check" : "call";
          await c.act(tableId, h, act);
          say(b.name, `hand #${h} ${a.phase}: ${act}${act === "call" ? ` ${a.options.toCall}` : ""}`);
          break;
        }
      }
      if (a.type !== "bet") say(b.name, `hand #${h}: ${describe(a)}`);
      await b.core.submitted(`bot/${b.signer.address}`, tableId, h, a);
    } catch (e) {
      b.failures.set(id, (b.failures.get(id) ?? 0) + 1);
      say(b.name, `hand #${h}: ${a.type} failed: ${(e as Error).message}`);
    }
    void table;
  } catch (e) {
    say(b.name, `protocol: ${(e as Error).message}`);
  } finally {
    b.busy = false;
  }
}

function describe(a: OwedAction): string {
  switch (a.type) {
    case "shareKeys": return `shared keys (${a.step})`;
    case "challenge": return `challenged player ${a.args.accused + 1} ${a.args.kind} #${a.args.index}`;
    default: return a.type;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
