import { describe, expect, it } from "vitest";
import {
  type Deck, CANON_ROOT_HEX, P, allHolePositions, boardPositions, canonicalDeck, cardKeys,
  dealPositions, elementFromBase64, fromHex, holePositions, keysOwed, merkleRoot, merkleRootHex,
  modPow, newSeed, elementToBase64, merkleProof, officialCardsFromSeeds, openCard, permutation, publishedKeyMatches, rekeyPass,
  shuffleKey, shufflePass, toHex, verifyHand, verifyMerkleProof, cardKeyBytes,
} from "../src/index.ts";

interface Sim {
  seeds: Uint8Array[];
  passes: Deck[];
}

function simulate(n: number, extraPermFor?: { j: number; perm: number[] }): Sim {
  const seeds = Array.from({ length: n }, () => newSeed());
  const passes: Deck[] = [];
  let deck = canonicalDeck();
  for (let j = 0; j < n; j++) {
    const opts = extraPermFor?.j === j ? { extraPerm: extraPermFor.perm } : {};
    deck = shufflePass(deck, seeds[j]!, opts);
    passes.push(deck);
  }
  for (let j = 0; j < n; j++) {
    deck = rekeyPass(deck, seeds[j]!);
    passes.push(deck);
  }
  return { seeds, passes };
}

describe("positions and key obligations", () => {
  it("hole and board positions", () => {
    expect(holePositions(3, 2)).toEqual([4, 5]);
    expect(boardPositions(2)).toEqual([4, 5, 6, 7, 8]);
    expect(boardPositions(6)).toEqual([12, 13, 14, 15, 16]);
    expect(dealPositions("flop", 3)).toEqual([6, 7, 8]);
    expect(dealPositions("turn", 3)).toEqual([9]);
    expect(dealPositions("river", 3)).toEqual([10]);
    expect(allHolePositions(2)).toEqual([0, 1, 2, 3]);
  });

  it("keys owed", () => {
    expect(keysOwed("hole", 3, 1)).toEqual([0, 1, 4, 5]);
    expect(keysOwed("hole", 2, 0)).toEqual([2, 3]);
    expect(keysOwed("flop", 3, 1)).toEqual([6, 7, 8]);
    expect(keysOwed("river", 6, 5)).toEqual([16]);
    expect(() => keysOwed("hole", 7, 0)).toThrow();
    expect(() => keysOwed("hole", 3, 3)).toThrow();
  });
});

describe.each([2, 3, 6])("full simulated %i-player hand", (n) => {
  const sim = simulate(n);
  const final = sim.passes[2 * n - 1]!;
  const official = officialCardsFromSeeds(sim.seeds);
  const keys = sim.seeds.map((s) => cardKeys(s));

  // Published keys after every deal step, by position then player.
  const published = new Map<number, Map<number, bigint>>();
  for (const step of ["hole", "flop", "turn", "river"] as const) {
    for (let x = 0; x < n; x++) {
      for (const i of keysOwed(step, n, x)) {
        if (!published.has(i)) published.set(i, new Map());
        published.get(i)!.set(x, keys[x]![i]!);
      }
    }
  }

  it("official cards are a permutation", () => {
    expect(new Set(official).size).toBe(52);
  });

  it("every player opens exactly their own hole cards", () => {
    for (let j = 0; j < n; j++) {
      for (const pos of holePositions(n, j)) {
        const others = published.get(pos)!;
        expect(others.has(j)).toBe(false);
        expect(others.size).toBe(n - 1);
        const card = openCard(final[pos]!, [...others.values(), keys[j]![pos]!]);
        expect(card).toBe(official[pos]);
        // Without the owner's key the card does not decode.
        expect(openCard(final[pos]!, [...others.values()])).toBeNull();
      }
    }
  });

  it("everyone opens the board with published keys only", () => {
    for (const pos of boardPositions(n)) {
      const ks = published.get(pos)!;
      expect(ks.size).toBe(n);
      expect(openCard(final[pos]!, [...ks.values()])).toBe(official[pos]);
    }
  });

  it("verifier accepts honest passes", () => {
    const roots = sim.passes.map(merkleRootHex);
    const r = verifyHand({ seeds: sim.seeds, passes: sim.passes, roots });
    expect(r.ok).toBe(true);
  });
});

/** Mirrors the realm's challenge check (protocol section 5). */
function realmJudge(c: { kind: string; accused: number; index: number; inB64: string; inProofHex: string; outB64: string; outProofHex: string },
  seeds: Uint8Array[], roots: Uint8Array[]): "guilty" | "innocent" | "invalid" {
  const n = seeds.length;
  const s = c.kind === "shuffle" ? c.accused : n + c.accused;
  const inRoot = s === 0 ? fromHex(CANON_ROOT_HEX) : roots[s - 1]!;
  const outRoot = roots[s]!;
  const vin = elementFromBase64(c.inB64);
  const vout = elementFromBase64(c.outB64);
  const seed = seeds[c.accused]!;
  const inIndex = c.kind === "shuffle" ? permutation(seed)[c.index]! : c.index;
  if (!verifyMerkleProof(inRoot, vin, inIndex, fromHex(c.inProofHex))) return "invalid";
  if (!verifyMerkleProof(outRoot, vout, c.index, fromHex(c.outProofHex))) return "invalid";
  const e = shuffleKey(seed);
  if (c.kind === "shuffle") return modPow(vin, e, P) !== vout ? "guilty" : "innocent";
  const k = cardKeys(seed)[c.index]!;
  return modPow(vout, e, P) !== modPow(vin, k, P) ? "guilty" : "innocent";
}

describe("verifier", () => {
  it("pinpoints a last-shuffler extra permutation", () => {
    const n = 3;
    const extra = Array.from({ length: 52 }, (_, i) => i);
    [extra[5], extra[9]] = [extra[9]!, extra[5]!];
    const sim = simulate(n, { j: n - 1, perm: extra });
    const roots = sim.passes.map(merkleRoot);
    const r = verifyHand({ seeds: sim.seeds, passes: sim.passes, roots: roots.map(toHex) });
    expect(r.ok).toBe(false);
    if (r.ok || r.kind === "missing") throw new Error("unexpected");
    expect(r.kind).toBe("shuffle");
    expect(r.accused).toBe(n - 1);
    expect(r.index).toBe(5);
    expect(r.challenge).toMatchObject({ kind: "shuffle", accused: n - 1, index: 5 });
    expect(realmJudge(r.challenge, sim.seeds, roots)).toBe("guilty");
  });

  it("pinpoints a cheating first shuffler against CANON_ROOT", () => {
    const extra = Array.from({ length: 52 }, (_, i) => (i + 1) % 52);
    const sim = simulate(2, { j: 0, perm: extra });
    const roots = sim.passes.map(merkleRoot);
    const r = verifyHand({ seeds: sim.seeds, passes: sim.passes });
    if (r.ok || r.kind === "missing") throw new Error("expected mismatch");
    expect([r.kind, r.accused, r.index]).toEqual(["shuffle", 0, 0]);
    expect(realmJudge(r.challenge, sim.seeds, roots)).toBe("guilty");
  });

  it("pinpoints a bad rekey element", () => {
    const n = 3;
    const sim = simulate(n);
    // Player 1 corrupts position 17 of its rekey pass.
    const bad = sim.passes[n + 1]!.slice();
    bad[17] = (bad[17]! * 4n) % P;
    const passes = sim.passes.slice();
    passes[n + 1] = bad;
    // Later passes are computed honestly from the corrupted deck.
    passes[n + 2] = rekeyPass(bad, sim.seeds[2]!);
    const roots = passes.map(merkleRoot);
    const r = verifyHand({ seeds: sim.seeds, passes, roots: roots.map(toHex) });
    if (r.ok || r.kind === "missing") throw new Error("expected mismatch");
    expect([r.kind, r.accused, r.index]).toEqual(["rekey", 1, 17]);
    expect(realmJudge(r.challenge, sim.seeds, roots)).toBe("guilty");
  });

  it("a challenge against an honest pass is judged innocent", () => {
    const sim = simulate(2);
    const roots = sim.passes.map(merkleRoot);
    const prev = canonicalDeck();
    const pi = permutation(sim.seeds[0]!);
    const out = sim.passes[0]!;
    const i = 3;
    const c = {
      kind: "shuffle", accused: 0, index: i,
      inB64: elementToBase64(prev[pi[i]!]!), inProofHex: toHex(merkleProof(prev, pi[i]!)),
      outB64: elementToBase64(out[i]!), outProofHex: toHex(merkleProof(out, i)),
    };
    expect(realmJudge(c, sim.seeds, roots)).toBe("innocent");
    const r1 = sim.passes[2]!;
    const rc = {
      kind: "rekey", accused: 0, index: i,
      inB64: elementToBase64(sim.passes[1]![i]!), inProofHex: toHex(merkleProof(sim.passes[1]!, i)),
      outB64: elementToBase64(r1[i]!), outProofHex: toHex(merkleProof(r1, i)),
    };
    expect(realmJudge(rc, sim.seeds, roots)).toBe("innocent");
    expect(realmJudge({ ...rc, inProofHex: rc.outProofHex }, sim.seeds, roots)).toBe("invalid");
  });

  it("reconstructs unrecorded honest passes from roots", () => {
    const sim = simulate(3);
    const roots = sim.passes.map(merkleRootHex);
    const partial: (Deck | undefined)[] = sim.passes.slice();
    partial[1] = undefined;
    partial[4] = undefined;
    const r = verifyHand({ seeds: sim.seeds, passes: partial, roots });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.passes[4]).toEqual(sim.passes[4]);
  });

  it("reports a missing pass that cannot be reconstructed", () => {
    const extra = Array.from({ length: 52 }, (_, i) => 51 - i);
    const sim = simulate(2, { j: 1, perm: extra });
    const roots = sim.passes.map(merkleRootHex);
    const partial: (Deck | undefined)[] = sim.passes.slice();
    partial[1] = undefined;
    const r = verifyHand({ seeds: sim.seeds, passes: partial, roots });
    expect(r).toMatchObject({ ok: false, kind: "missing", seq: 1, accused: 1 });
    expect(verifyHand({ seeds: sim.seeds, passes: partial })).toMatchObject({ ok: false, kind: "missing" });
  });

  it("published key check", () => {
    const s = newSeed();
    expect(publishedKeyMatches(s, 3, toHex(cardKeyBytes(s, 3)))).toBe(true);
    expect(publishedKeyMatches(s, 4, toHex(cardKeyBytes(s, 3)))).toBe(false);
  });
});
