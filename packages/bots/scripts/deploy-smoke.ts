// Smoke test of a deployment: two bots (one through a session key) play a few hands and leave.
// Prints whether challenges are enabled and how many Accept txs were needed (0 when the realm
// finalizes at reveal, i.e. the --no-modexp variant).
//   node scripts/deploy-smoke.ts <rpc-url> <realm-path> [hands]
import { connectEnv, createTable, newBot, runBots } from "../src/runner.ts";
import { HandStrengthStrategy, RandomStrategy } from "../src/strategy.ts";
const [rpc, pkg, hands] = [process.argv[2]!, process.argv[3]!, Number(process.argv[4] ?? 3)];
const env = await connectEnv({ rpcUrl: rpc, pkgPath: pkg });
const enabled = await env.client.challengesEnabled();
console.log("ChallengesEnabled:", enabled);
const tableId = await createTable(env, {});
const bots = [
  await newBot(env, { name: "a", tableId, strategy: new HandStrengthStrategy(), challengesEnabled: enabled }),
  await newBot(env, { name: "b", tableId, strategy: new RandomStrategy(), challengesEnabled: enabled, sessionAllowance: 5_000_000n }),
];
await runBots(bots, () => env.history.summaries.length >= hands, { leaveAtEnd: true });
const count = (f: string) => env.txlog.records.filter((r) => r.ok && r.func === f).length;
console.log("hands", env.history.summaries.length, "RevealSeed", count("RevealSeed"), "Accept", count("Accept"), "Finalize", count("Finalize"));
console.log("realm balance", await env.querier.balance(env.realmAddress));
