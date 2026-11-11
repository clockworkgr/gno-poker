// Times one 52-card shuffle pass, one rekey pass, one card open and a full-hand verification.
import {
  type Deck,
  canonicalDeck, cardKeys, newSeed, openCard, rekeyPass, shufflePass, verifyHand,
} from "../src/index.ts";

function time<T>(label: string, f: () => T, reps = 3): T {
  let r!: T;
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) r = f();
  console.log(`${label}: ${((performance.now() - t0) / reps).toFixed(1)} ms`);
  return r;
}

const seeds = Array.from({ length: 6 }, () => newSeed());
const d0 = time("shuffle pass (52 x 256-bit exp)", () => shufflePass(canonicalDeck(), seeds[0]!));
const r0 = time("rekey pass (52 x 2048-bit exp)", () => rekeyPass(d0, seeds[0]!));
const keys = [cardKeys(seeds[0]!)[0]!];
time("open one card (1 key)", () => openCard(r0[0]!, keys), 10);

const passes: Deck[] = [];
let d = canonicalDeck();
for (const s of seeds) passes.push((d = shufflePass(d, s)));
for (const s of seeds) passes.push((d = rekeyPass(d, s)));
time("verifyHand, 6 players (12 passes)", () => verifyHand({ seeds, passes }), 1);
