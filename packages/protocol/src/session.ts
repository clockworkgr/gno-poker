// HandSession: per-hand protocol state machine shared by bots and the UI.
//
// The caller polls GetTable, feeds the parsed state to observe() (which records deck passes)
// and asks nextAction() what is owed. Betting decisions stay with the caller.

import { fromHex, toHex } from "./bytes.ts";
import { canonicalDeck } from "./cards.ts";
import { type Deck, deckToBase64, openCard, parseDeck, rekeyPass, shufflePass } from "./deck.ts";
import { type SeedSecrets, deriveSecrets, newSeed } from "./derive.ts";
import {
  type ChallengeArgs,
  type DealStep,
  type VerifyResult,
  boardPositions,
  dealStepOfPhase,
  holePositions,
  keysOwed,
  officialCardsFromSeeds,
  totalPasses,
  verifyHand,
} from "./hand.ts";
import { merkleRootHex } from "./merkle.ts";
import type { KeyValueStore } from "./store.ts";
import { type BetOptions, type Phase, type TableState, betOptions, handIndexOf } from "./table.ts";

export interface CheatContext {
  n: number;
  myIndex: number;
  handNo: number;
  tableId: number;
}

/** Test-only hooks for a cheating bot. */
export interface CheatHooks {
  /** Permutation post-composed onto this player's shuffle pass (out'[i] = out[x[i]]). */
  shuffleExtraPerm?: (ctx: CheatContext) => readonly number[] | null | undefined;
  /** Replaces this player's honest rekey pass (return null/undefined to keep it). */
  tamperRekey?: (ctx: CheatContext, honest: Deck) => Deck | null | undefined;
  /**
   * Replaces the card keys this player publishes in a deal step (same order as `positions`;
   * return null/undefined to keep them).
   */
  tamperCardKeys?: (ctx: CheatContext & { step: DealStep }, positions: readonly number[], honest: readonly bigint[]) => readonly bigint[] | null | undefined;
}

export type OwedAction =
  | { type: "none"; reason: string }
  | { type: "submitShuffle"; id: string; commitHex: string; deckB64: string }
  | { type: "submitRekey"; id: string; deckB64: string }
  | { type: "shareKeys"; id: string; step: DealStep; positions: number[]; keysHex: string }
  | { type: "bet"; id: string; phase: Phase; options: BetOptions }
  | { type: "revealSeed"; id: string; seedHex: string }
  | { type: "accept"; id: string }
  | { type: "challenge"; id: string; args: ChallengeArgs }
  /** Nothing owed by us, but the deadline passed: anyone may call Timeout. */
  | { type: "timeout"; id: string }
  /** Challenge window over: anyone may call Finalize. */
  | { type: "finalize"; id: string };

export interface HandSessionOptions {
  table: TableState;
  /** Owner or session address of the local player. */
  address: string;
  store: KeyValueStore;
  /** Storage key prefix, e.g. the realm path. Default "gno-poker". */
  namespace?: string;
  /** Whether the realm has challenges enabled (ChallengesEnabled()). Default true. */
  challengesEnabled?: boolean;
  cheat?: CheatHooks;
}

export class HandSession {
  readonly tableId: number;
  readonly handNo: number;
  readonly n: number;
  readonly myIndex: number;
  readonly mySeat: number;
  /** Null when this hand's seed was lost (our commit is on-chain but the store has no seed). */
  readonly secrets: SeedSecrets | null;
  readonly challengesEnabled: boolean;

  private readonly store: KeyValueStore;
  private readonly prefix: string;
  private readonly cheat: CheatHooks | undefined;
  private readonly passes: (Deck | undefined)[];
  private readonly pending = new Map<string, Deck>(); // root hex -> deck we computed
  private readonly submitted: Set<string>;
  private readonly opened = new Map<number, number | null>();
  private computed: { id: string; action: OwedAction } | null = null;
  private verification: VerifyResult | null = null;

  private constructor(o: {
    table: TableState;
    myIndex: number;
    secrets: SeedSecrets | null;
    store: KeyValueStore;
    prefix: string;
    cheat: CheatHooks | undefined;
    challengesEnabled: boolean;
    passes: (Deck | undefined)[];
    submitted: Set<string>;
  }) {
    const h = o.table.hand!;
    this.tableId = o.table.id;
    this.handNo = h.handNo;
    this.n = h.players.length;
    this.myIndex = o.myIndex;
    this.mySeat = h.players[o.myIndex]!.seat;
    this.secrets = o.secrets;
    this.store = o.store;
    this.prefix = o.prefix;
    this.cheat = o.cheat;
    this.challengesEnabled = o.challengesEnabled;
    this.passes = o.passes;
    this.submitted = o.submitted;
  }

  /** Storage prefix for one hand. */
  static storagePrefix(namespace: string, tableId: number, handNo: number): string {
    return `${namespace}/${tableId}/${handNo}/`;
  }

  /**
   * Opens (or resumes) the session for the table's current hand. Returns null if there is no
   * hand or the address is not a player in it. Creates and persists a seed if none is stored
   * and our commit is not yet on-chain.
   */
  static async open(opts: HandSessionOptions): Promise<HandSession | null> {
    const h = opts.table.hand;
    if (!h) return null;
    const myIndex = handIndexOf(opts.table, opts.address);
    if (myIndex < 0) return null;
    const prefix = HandSession.storagePrefix(opts.namespace ?? "gno-poker", opts.table.id, h.handNo);
    const store = opts.store;

    let secrets: SeedSecrets | null = null;
    const storedSeed = await store.get(prefix + "seed");
    if (storedSeed) {
      secrets = deriveSecrets(fromHex(storedSeed));
    } else if (h.players[myIndex]!.commit === "" && h.phase === "shuffle") {
      const seed = newSeed();
      await store.set(prefix + "seed", toHex(seed));
      secrets = deriveSecrets(seed);
    }

    const n = h.players.length;
    const passes: (Deck | undefined)[] = new Array(totalPasses(n)).fill(undefined);
    for (let s = 0; s < passes.length; s++) {
      const b64 = await store.get(prefix + `pass/${s}`);
      if (b64) passes[s] = parseDeck(b64, false);
    }
    const sub = await store.get(prefix + "submitted");
    const submitted = new Set<string>(sub ? (JSON.parse(sub) as string[]) : []);

    return new HandSession({
      table: opts.table,
      myIndex,
      secrets,
      store,
      prefix,
      cheat: opts.cheat,
      challengesEnabled: opts.challengesEnabled ?? true,
      passes,
      submitted,
    });
  }

  get seedHex(): string | null {
    return this.secrets ? toHex(this.secrets.seed) : null;
  }
  get commitHex(): string | null {
    return this.secrets ? toHex(this.secrets.commit) : null;
  }
  get seedLost(): boolean {
    return this.secrets === null;
  }

  /** Recorded pass by deckSeq, if any. */
  pass(seq: number): Deck | undefined {
    return this.passes[seq];
  }
  /** Copy of all recorded passes by deckSeq. */
  recordedPasses(): (Deck | undefined)[] {
    return this.passes.slice();
  }

  private isCurrent(table: TableState): boolean {
    return !!table.hand && table.id === this.tableId && table.hand.handNo === this.handNo;
  }

  private async record(seq: number, deck: Deck): Promise<void> {
    if (this.passes[seq]) return;
    this.passes[seq] = deck;
    await this.store.set(this.prefix + `pass/${seq}`, deckToBase64(deck));
  }

  /**
   * Records every deck pass visible in this table state. `fetchDeckB64` is called (at most once)
   * when the latest pass is not yet recorded; it should return the GetDeck result.
   * Also opens our hole cards and the board once keys are available.
   */
  async observe(table: TableState, fetchDeckB64?: () => Promise<string>): Promise<void> {
    if (!this.isCurrent(table)) return;
    const h = table.hand!;
    const limit = Math.min(h.deckSeq, this.passes.length, h.roots.length);
    for (let s = 0; s < limit; s++) {
      if (this.passes[s]) continue;
      const own = this.pending.get(h.roots[s]!);
      if (own) await this.record(s, own);
    }
    if (limit > 0 && !this.passes[limit - 1] && fetchDeckB64) {
      const b64 = await fetchDeckB64();
      if (b64) {
        const deck = parseDeck(b64, false);
        const idx = h.roots.indexOf(merkleRootHex(deck));
        if (idx >= 0 && idx < this.passes.length) await this.record(idx, deck);
      }
    }
    this.openCards(table);
  }

  private keyFor(table: TableState, x: number, pos: number): bigint | null {
    if (x === this.myIndex) return this.secrets ? this.secrets.keys[pos]! : null;
    const hex = table.hand!.players[x]!.keys.get(pos);
    return hex ? BigInt("0x" + hex) : null;
  }

  private openCards(table: TableState): void {
    const final = this.passes[totalPasses(this.n) - 1];
    if (!final || !this.secrets) return;
    const positions = [...holePositions(this.n, this.myIndex), ...boardPositions(this.n)];
    for (const pos of positions) {
      if (this.opened.has(pos)) continue;
      const keys: bigint[] = [];
      for (let x = 0; x < this.n; x++) {
        const k = this.keyFor(table, x, pos);
        if (k === null) break;
        keys.push(k);
      }
      if (keys.length !== this.n) continue;
      this.opened.set(pos, openCard(final[pos]!, keys));
    }
  }

  /** Card at a position as opened from the final deck: index, null if it failed to decode, undefined if not yet open. */
  openedCard(pos: number): number | null | undefined {
    return this.opened.get(pos);
  }
  /** Our two hole cards (see openedCard for the value meaning). */
  holeCards(): (number | null | undefined)[] {
    return holePositions(this.n, this.myIndex).map((p) => this.opened.get(p));
  }
  /** The five board positions (see openedCard for the value meaning). */
  boardCards(): (number | null | undefined)[] {
    return boardPositions(this.n).map((p) => this.opened.get(p));
  }
  /** Positions that were opened but did not decode to a card: grounds for a challenge after reveal. */
  badPositions(): number[] {
    return [...this.opened.entries()].filter(([, c]) => c === null).map(([p]) => p);
  }

  /** Official cards by position from revealed seeds (null until every seed is revealed). */
  officialCards(table: TableState): number[] | null {
    const seeds = this.revealedSeeds(table);
    return seeds ? officialCardsFromSeeds(seeds) : null;
  }

  private revealedSeeds(table: TableState): Uint8Array[] | null {
    if (!this.isCurrent(table)) return null;
    const ps = table.hand!.players;
    if (ps.some((p) => p.seed === "")) return null;
    return ps.map((p) => fromHex(p.seed));
  }

  /** Verifies all passes against revealed seeds (cached). Null until every seed is revealed. */
  verify(table: TableState): VerifyResult | null {
    if (this.verification) return this.verification;
    const seeds = this.revealedSeeds(table);
    if (!seeds) return null;
    const h = table.hand!;
    const r = verifyHand({ seeds, passes: this.passes, roots: h.roots });
    if (r.ok || r.kind !== "missing") {
      // Fill reconstructed passes so later reads see them.
      r.passes.forEach((d, s) => {
        if (!this.passes[s]) this.passes[s] = d;
      });
    }
    this.verification = r;
    return r;
  }

  /**
   * Marks an action as successfully submitted (call after the tx is included). Prevents
   * re-sending it while the polled state catches up, and stops repeat challenges.
   */
  async markSubmitted(action: OwedAction): Promise<void> {
    if (action.type === "none" || action.type === "bet") return;
    this.submitted.add(action.id);
    await this.store.set(this.prefix + "submitted", JSON.stringify([...this.submitted]));
  }

  /** The protocol action owed by the local player now, building its arguments. */
  async nextAction(table: TableState): Promise<OwedAction> {
    if (!this.isCurrent(table)) return { type: "none", reason: "not the current hand" };
    const h = table.hand!;
    const me = this.myIndex;
    const n = this.n;
    const sec = this.secrets;
    const pre = `${this.tableId}:${this.handNo}`;
    const owing = h.owing.includes(me);
    const fresh = (a: OwedAction): OwedAction =>
      a.type !== "none" && this.submitted.has(a.id) ? { type: "none", reason: "submitted; waiting for chain" } : a;

    switch (h.phase) {
      case "shuffle":
      case "rekey": {
        if (h.turn !== me) break;
        if (!sec) return { type: "none", reason: "seed lost" };
        const shuffle = h.phase === "shuffle";
        const seq = shuffle ? me : n + me;
        if (h.deckSeq !== seq) return { type: "none", reason: `waiting for deckSeq ${seq}` };
        const id = `${pre}:${shuffle ? "shuffle" : "rekey"}`;
        if (this.submitted.has(id)) return { type: "none", reason: "submitted; waiting for chain" };
        if (this.computed?.id === id) return this.computed.action;
        const prev = seq === 0 ? canonicalDeck() : this.passes[seq - 1];
        if (!prev) return { type: "none", reason: `previous deck (pass ${seq - 1}) not recorded; call observe()` };
        let deck: Deck;
        if (shuffle) {
          const extra = this.cheat?.shuffleExtraPerm?.({ n, myIndex: me, handNo: this.handNo, tableId: this.tableId });
          deck = shufflePass(prev, sec.seed, extra ? { extraPerm: extra } : {});
        } else {
          deck = rekeyPass(prev, sec.seed);
          const tampered = this.cheat?.tamperRekey?.({ n, myIndex: me, handNo: this.handNo, tableId: this.tableId }, deck);
          if (tampered) deck = tampered;
        }
        this.pending.set(merkleRootHex(deck), deck);
        const deckB64 = deckToBase64(deck);
        const action: OwedAction = shuffle
          ? { type: "submitShuffle", id, commitHex: toHex(sec.commit), deckB64 }
          : { type: "submitRekey", id, deckB64 };
        this.computed = { id, action };
        return action;
      }
      case "deal_hole":
      case "deal_flop":
      case "deal_turn":
      case "deal_river": {
        if (!owing) break;
        if (!sec) return { type: "none", reason: "seed lost" };
        const step = dealStepOfPhase(h.phase)!;
        const positions = keysOwed(step, n, me);
        let keys: readonly bigint[] = positions.map((p) => sec.keys[p]!);
        const tampered = this.cheat?.tamperCardKeys?.({ n, myIndex: me, handNo: this.handNo, tableId: this.tableId, step }, positions, keys);
        if (tampered) {
          if (tampered.length !== positions.length) throw new Error("tamperCardKeys must return one key per position");
          keys = tampered;
        }
        const keysHex = keys.map((k) => k.toString(16).padStart(64, "0")).join("");
        return fresh({ type: "shareKeys", id: `${pre}:keys:${step}`, step, positions, keysHex });
      }
      case "preflop":
      case "flop":
      case "turn":
      case "river": {
        if (h.turn !== me) break;
        const p = h.players[me]!;
        return {
          type: "bet",
          id: `${pre}:act:${h.phase}:${h.currentBet}:${p.streetBet}:${p.acted}`,
          phase: h.phase,
          options: betOptions(table, me),
        };
      }
      case "reveal": {
        if (!owing) break;
        if (!sec) return { type: "none", reason: "seed lost" };
        return fresh({ type: "revealSeed", id: `${pre}:reveal`, seedHex: toHex(sec.seed) });
      }
      case "challenge": {
        if (h.players[me]!.accepted) break;
        const acceptAction = fresh({ type: "accept", id: `${pre}:accept` });
        if (!this.challengesEnabled) return acceptAction;
        const v = this.verify(table);
        if (!v) return { type: "none", reason: "waiting for all seeds" };
        if (v.ok) return acceptAction;
        if (v.kind === "missing") {
          // Cannot build a challenge and must not accept a hand we could not check.
          return { type: "none", reason: `cannot verify pass ${v.seq}: ${v.reason}` };
        }
        if (v.accused === me) return acceptAction;
        const c = fresh({ type: "challenge", id: `${pre}:challenge:${v.kind}:${v.accused}:${v.index}`, args: v.challenge });
        // A challenge that did not end the hand was judged not guilty; do not repeat it.
        return c.type === "none" ? acceptAction : c;
      }
      case "done":
        return { type: "none", reason: "hand done" };
    }

    if (h.deadline > 0 && table.height > h.deadline) {
      if (h.phase === "challenge") return { type: "finalize", id: `${pre}:finalize:${h.deadline}` };
      return { type: "timeout", id: `${pre}:timeout:${h.phase}:${h.deadline}` };
    }
    return { type: "none", reason: "nothing owed" };
  }

  /** Deletes everything stored for this hand. Call once the hand is finalized. */
  async discard(): Promise<void> {
    for (const k of await this.store.keys(this.prefix)) await this.store.delete(k);
  }
}

