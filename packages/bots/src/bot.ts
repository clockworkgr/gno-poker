// A poker bot: joins a table, drives HandSession through every hand, bets through a strategy.

import {
  type KeyValueStore,
  type OwedAction,
  type PokerClient,
  type TableState,
  type TxName,
  type TxOptions,
  HandSession,
  MemoryStore,
  buildChallengeArgs,
  cardName,
  fromHex,
  handIndexOf,
} from "@gno-poker/protocol";
import type { GnoQuerier } from "@gno-poker/protocol/gno";
import { type RecordingSigner, errorMessage, sleep } from "./chain.ts";
import { type CheatKind, type StallStep, cheatHooks } from "./cheats.ts";
import type { HistoryBook } from "./history.ts";
import { type Strategy, CallingStation, toRealmAction } from "./strategy.ts";

export interface BotConfig {
  name: string;
  tableId: number;
  client: PokerClient;
  querier: GnoQuerier;
  /** Wallet account: joins, tops up, leaves. Also plays when there is no session key. */
  owner: RecordingSigner;
  /** Session key that signs every in-hand transaction (optional). */
  session?: RecordingSigner;
  strategy: Strategy;
  history: HistoryBook;
  log?: (line: string) => void;
  /** Buy-in used for joining and topping up. */
  buyIn: bigint;
  /** What to do when the stack drops below the big blind between hands. Default "topup". */
  onBust?: "topup" | "leave" | "stay";
  /** Top-ups allowed before leaving instead. Default 3. */
  maxTopUps?: number;
  /** Start hands automatically. Default true. */
  autoStart?: boolean;
  /** Delay before the designated player (lowest eligible seat) starts the next hand. Default 400 ms. */
  startDelayMs?: number;
  /** Delay before a non-designated player starts a hand or calls Timeout/Finalize. Default 4000 ms. */
  fallbackDelayMs?: number;
  /** Refill the session key from the owner when its balance falls below `below`. */
  sessionRefill?: { below: bigint; amount: bigint };
  pollMs?: number;
  rng?: () => number;
  challengesEnabled?: boolean;
  store?: KeyValueStore;
  // Misbehaviour (tests only).
  cheat?: CheatKind;
  /** Hands the cheat applies to (default all). */
  cheatHands?: (handNo: number) => boolean;
  /** Send a challenge against an honest pass in the challenge window of matching hands. */
  falseChallenge?: (handNo: number) => boolean;
  /** Stop acting at this step, in the first hand where it arises (or only in `hand`). */
  stall?: { step: StallStep; hand?: number };
}

const ACTION_STEP: Partial<Record<OwedAction["type"], StallStep>> = {
  bet: "bet",
  submitShuffle: "shuffle",
  submitRekey: "rekey",
  shareKeys: "keys",
  revealSeed: "reveal",
};

export class Bot {
  readonly cfg: BotConfig;
  readonly name: string;
  readonly store: KeyValueStore;
  private hs: HandSession | null = null;
  private stalledHand: number | null = null;
  private stallLogged = new Set<string>();
  private readonly falseChallenged = new Set<number>();
  private idleSince = 0;
  private overdueSince = new Map<string, number>();
  private backoffUntil = 0;
  private readonly failedBets = new Set<string>();
  private readonly gasBoost = new Map<TxName, bigint>();
  private topUps = 0;
  private stopping = false;
  private stopped = false;
  /** Seat gone (left or removed by the realm). */
  gone = false;
  /** Cards this bot opened, by hand number (position -> card). */
  readonly opened = new Map<number, Map<number, number | null>>();
  /** Notes from cheats and checks, for tests. */
  readonly notes: string[] = [];
  buyIns = 0n;
  topUpTotal = 0n;
  allowanceTotal = 0n;

  constructor(cfg: BotConfig) {
    this.cfg = cfg;
    this.name = cfg.name;
    this.store = cfg.store ?? new MemoryStore();
  }

  get actor(): RecordingSigner {
    return this.cfg.session ?? this.cfg.owner;
  }
  get ownerAddress(): string {
    return this.cfg.owner.address;
  }

  private log(s: string): void {
    (this.cfg.log ?? ((l: string) => console.log(l)))(`[${this.name}] ${s}`);
  }

  private tag(handNo: number | undefined): void {
    for (const s of [this.cfg.owner, this.cfg.session]) {
      if (s) s.tag = { tableId: this.cfg.tableId, bot: this.name, ...(handNo !== undefined ? { handNo } : {}) };
    }
  }

  /** Joins the table, through the session key when one is configured. */
  async join(gasAllowance = 0n): Promise<void> {
    const c = this.cfg;
    this.tag(undefined);
    const session = c.session ? c.session.address : "";
    await c.client.join(c.owner, c.tableId, c.buyIn, session, c.session ? gasAllowance : 0n);
    this.buyIns += c.buyIn;
    this.allowanceTotal += c.session ? gasAllowance : 0n;
    this.log(`joined table ${c.tableId} with ${c.buyIn} ugnot${c.session ? ` via session ${session} (gas allowance ${gasAllowance})` : ""}`);
  }

  /** Asks the bot to leave between hands and stop. */
  requestStop(): void {
    this.stopping = true;
  }
  get isStopped(): boolean {
    return this.stopped;
  }

  /** Polls and plays until stopped (or the signal aborts). */
  async run(signal?: AbortSignal): Promise<void> {
    const poll = this.cfg.pollMs ?? 150;
    while (!this.stopped && !signal?.aborted) {
      try {
        const table = await this.cfg.client.getTable(this.cfg.tableId);
        await this.tick(table);
      } catch (e) {
        this.log(`error: ${errorMessage(e)}`);
        await sleep(1000);
      }
      await sleep(poll);
    }
  }

  private seatIndex(table: TableState): number {
    return table.seats.findIndex((s) => s !== null && s.owner === this.ownerAddress);
  }

  /** One step: inspects the table state and sends at most one transaction. */
  async tick(table: TableState): Promise<void> {
    if (Date.now() < this.backoffUntil) return;
    const seat = this.seatIndex(table);
    const h = table.hand;
    if (seat < 0) {
      if (!this.gone) {
        this.gone = true;
        this.log(`no longer seated at table ${table.id}`);
      }
      this.stopped = this.stopping || this.gone;
      if (h && h.phase === "done") {
        await this.cfg.history.finish(table, this.cfg.owner.log.records);
        await this.endHand(table);
      }
      return;
    }
    if (h && h.phase !== "done") {
      if (handIndexOf(table, this.actor.address) >= 0) await this.playHand(table);
      this.idleSince = 0;
      return;
    }
    if (h && h.phase === "done") {
      await this.cfg.history.finish(table, this.cfg.owner.log.records);
      await this.endHand(table);
    }
    await this.betweenHands(table, seat);
  }

  /**
   * Sends one transaction. On "out of gas" the gas for that function is doubled for later calls
   * (up to 16x the default), so an underestimated default does not stall the bot.
   */
  private async send(handNo: number | undefined, what: TxName, f: (o?: TxOptions) => Promise<unknown>): Promise<boolean> {
    this.tag(handNo);
    const boost = this.gasBoost.get(what) ?? 1n;
    try {
      await f(boost > 1n ? { gasWanted: this.cfg.client.gasFor(what).gasWanted * boost } : undefined);
      return true;
    } catch (e) {
      const msg = errorMessage(e);
      this.log(`${what} failed: ${msg}`);
      this.backoffUntil = Date.now() + 500;
      if (/out of gas/i.test(msg) && boost < 16n) {
        this.gasBoost.set(what, boost * 2n);
        this.log(`raising gas for ${what} to ${boost * 2n}x the default`);
      }
      if (/insufficient (funds|coins)/i.test(msg) && this.cfg.session) {
        try {
          await this.maybeRefillSession(true);
        } catch (e2) {
          this.log(`session refill failed: ${errorMessage(e2)}`);
        }
      }
      return false;
    }
  }

  private async betweenHands(table: TableState, seat: number): Promise<void> {
    const c = this.cfg;
    const s = table.seats[seat]!;
    if (s.leaving) return;
    if (this.stopping) {
      // If a hand started just before, the realm only marks the seat leaving: keep playing it.
      // The bot stops once the seat is gone (see tick).
      if (await this.send(undefined, "Leave", (o) => c.client.leave(c.owner, c.tableId, o))) {
        this.log(`leaving table ${c.tableId} with ${s.stack} ugnot`);
      }
      return;
    }
    if (s.stack < table.bigBlind) {
      const policy = c.onBust ?? "topup";
      if (policy === "topup" && this.topUps < (c.maxTopUps ?? 3)) {
        let amount = c.buyIn - s.stack;
        if (s.stack + amount > table.maxBuyIn) amount = table.maxBuyIn - s.stack;
        if (amount > 0n && (await this.send(undefined, "TopUp", (o) => c.client.topUp(c.owner, c.tableId, amount, o)))) {
          this.topUps++;
          this.topUpTotal += amount;
          this.log(`busted (stack ${s.stack}), topped up ${amount}`);
        }
        return;
      }
      if (policy !== "stay") {
        if (await this.send(undefined, "Leave", (o) => c.client.leave(c.owner, c.tableId, o))) {
          this.log(`busted (stack ${s.stack}), leaving the table`);
        }
      }
      return;
    }
    if (c.autoStart === false) return;
    const eligible = table.seats
      .map((x, i) => ({ x, i }))
      .filter(({ x }) => x !== null && !x.sittingOut && !x.leaving && x.stack >= table.bigBlind);
    if (eligible.length < 2 || s.sittingOut) return;
    const designated = eligible[0]!.i === seat;
    const now = Date.now();
    if (!this.idleSince) this.idleSince = now;
    // The designated starter waits a moment so that bots in other processes see the finished hand.
    if (now - this.idleSince < (designated ? (c.startDelayMs ?? 400) : (c.fallbackDelayMs ?? 4000))) return;
    await this.maybeRefillSession();
    const next = table.handNo + 1;
    if (await this.send(next, "StartHand", (o) => c.client.startHand(this.actor, c.tableId, o))) {
      this.cfg.history.start(c.tableId, next);
      this.idleSince = 0;
    }
  }

  /**
   * Tops the session key up from the owner when its balance is low. Session keys pay fees and
   * storage deposits; deposits for per-hand state are refunded to whoever starts the next hand,
   * so a session key that rarely starts hands slowly drains (see protocol.md section 9).
   */
  private async maybeRefillSession(force = false): Promise<void> {
    const c = this.cfg;
    if (!c.session) return;
    const refill = c.sessionRefill ?? { below: 3_000_000n, amount: 5_000_000n };
    const bal = BigInt(await c.querier.balance(c.session.address));
    if (!force && bal >= refill.below) return;
    if (force && bal >= refill.below * 2n) return;
    const amount = refill.amount;
    this.tag(undefined);
    await c.owner.transfer(c.session.address, amount);
    this.log(`refilled session key with ${amount} ugnot (balance was ${bal})`);
  }

  private async endHand(table: TableState): Promise<void> {
    const hs = this.hs;
    if (!hs || !table.hand || table.hand.handNo !== hs.handNo) return;
    this.hs = null;
    await hs.discard();
  }

  private stallActive(handNo: number, step: StallStep): boolean {
    const st = this.cfg.stall;
    if (!st || st.step !== step) return false;
    if (st.hand !== undefined) return st.hand === handNo;
    if (this.stalledHand === null) this.stalledHand = handNo;
    return this.stalledHand === handNo;
  }

  private async playHand(table: TableState): Promise<void> {
    const c = this.cfg;
    const h = table.hand!;
    if (!this.hs || this.hs.handNo !== h.handNo) {
      if (this.hs) await this.hs.discard(); // missed the end of the previous hand
      const cheat = c.cheat
        ? cheatHooks(c.cheat, {
            ...(c.cheatHands ? { onlyHand: c.cheatHands } : {}),
            onApply: (what) => {
              this.notes.push(what);
              this.log(`CHEAT ${what}`);
            },
          })
        : undefined;
      this.hs = await HandSession.open({
        table,
        address: this.actor.address,
        store: this.store,
        namespace: `bot/${this.name}`,
        challengesEnabled: c.challengesEnabled ?? true,
        ...(cheat ? { cheat } : {}),
      });
      if (!this.hs) return;
      c.history.start(c.tableId, h.handNo);
      await this.maybeRefillSession();
    }
    const hs = this.hs;
    await hs.observe(table, () => c.client.getDeckB64(c.tableId));
    this.recordOpened(hs);
    let a = await hs.nextAction(table);

    const step = ACTION_STEP[a.type];
    if (step && this.stallActive(h.handNo, step)) {
      const k = `${h.handNo}:${step}`;
      if (!this.stallLogged.has(k)) {
        this.stallLogged.add(k);
        this.log(`STALL hand ${h.handNo}: not sending ${a.type}`);
        this.notes.push(`stalled ${step} in hand ${h.handNo}`);
        c.history.add(c.tableId, h.handNo, `${this.name} stalls (${step})`);
      }
      return;
    }

    if (h.phase === "challenge" && c.falseChallenge?.(h.handNo) && !this.falseChallenged.has(h.handNo) && a.type === "accept") {
      this.falseChallenged.add(h.handNo);
      const v = hs.verify(table);
      if (v && v.ok) {
        const n = h.players.length;
        const accused = (hs.myIndex + 1) % n;
        const args = buildChallengeArgs(n, v.passes, fromHex(h.players[accused]!.seed), "shuffle", accused, 0);
        c.history.add(c.tableId, h.handNo, `${this.name} challenges ${c.history.nameOf(h.players[accused]!.owner)}'s shuffle at index 0 (false accusation)`);
        if (await this.send(h.handNo, "Challenge", (o) => c.client.challenge(this.actor, c.tableId, h.handNo, args, 0n, o))) {
          this.notes.push(`false challenge sent in hand ${h.handNo}`);
          this.log(`sent a false challenge against player ${accused}`);
        }
        return;
      }
    }

    switch (a.type) {
      case "none":
        return;
      case "submitShuffle":
        if (await this.send(h.handNo, "SubmitShuffle", (o) => c.client.submitShuffle(this.actor, c.tableId, hs.handNo, a.commitHex, a.deckB64, o))) await hs.markSubmitted(a);
        return;
      case "submitRekey":
        if (await this.send(h.handNo, "SubmitRekey", (o) => c.client.submitRekey(this.actor, c.tableId, hs.handNo, a.deckB64, o))) await hs.markSubmitted(a);
        return;
      case "shareKeys":
        if (await this.send(h.handNo, "ShareKeys", (o) => c.client.shareKeys(this.actor, c.tableId, hs.handNo, a.keysHex, o))) await hs.markSubmitted(a);
        return;
      case "revealSeed":
        if (await this.send(h.handNo, "RevealSeed", (o) => c.client.revealSeed(this.actor, c.tableId, hs.handNo, a.seedHex, o))) await hs.markSubmitted(a);
        return;
      case "accept":
        if (await this.send(h.handNo, "Accept", (o) => c.client.accept(this.actor, c.tableId, hs.handNo, o))) await hs.markSubmitted(a);
        return;
      case "challenge": {
        const args = a.args;
        c.history.add(c.tableId, h.handNo, `${this.name} challenges ${c.history.nameOf(h.players[args.accused]!.owner)}'s ${args.kind} pass at index ${args.index}`);
        if (await this.send(h.handNo, "Challenge", (o) => c.client.challenge(this.actor, c.tableId, hs.handNo, args, 0n, o))) {
          await hs.markSubmitted(a);
          this.notes.push(`challenged ${args.kind} of player ${args.accused} index ${args.index} in hand ${h.handNo}`);
        }
        return;
      }
      case "timeout":
      case "finalize": {
        if (!this.overdueOk(table, a.id)) return;
        const what: TxName = a.type === "timeout" ? "Timeout" : "Finalize";
        const ok = await this.send(h.handNo, what, (o) => (a.type === "timeout" ? c.client.timeout(this.actor, c.tableId, o) : c.client.finalize(this.actor, c.tableId, o)));
        if (ok) {
          await hs.markSubmitted(a);
          if (a.type === "timeout") c.history.add(c.tableId, h.handNo, `${this.name} calls Timeout in ${h.phase} (deadline ${h.deadline}, height ${table.height})`);
          else c.history.add(c.tableId, h.handNo, `${this.name} finalizes after the challenge window`);
        }
        return;
      }
      case "bet": {
        const strategy = this.failedBets.has(a.id) ? new CallingStation() : c.strategy;
        const hole = hs.holeCards();
        const board = hs.boardCards().filter((x): x is number => typeof x === "number");
        const decision = strategy.decide({
          table,
          phase: a.phase,
          me: hs.myIndex,
          options: a.options,
          hole,
          board: board.slice(0, a.phase === "preflop" ? 0 : a.phase === "flop" ? 3 : a.phase === "turn" ? 4 : 5),
          bigBlind: table.bigBlind,
          live: h.players.filter((p) => !p.folded).length,
          rng: c.rng ?? Math.random,
        });
        const act = toRealmAction(decision, a.options);
        const allIn = act.action === "raise" ? act.amount === a.options.maxRaiseTo : act.action === "call" && a.options.toCall >= a.options.stack;
        const text =
          act.action === "raise"
            ? `${h.currentBet === 0n ? "bets" : "raises to"} ${act.amount}`
            : act.action === "call"
              ? `calls ${a.options.toCall}`
              : act.action === "check"
                ? "checks"
                : "folds";
        const holeTxt = hole.map((x) => (typeof x === "number" ? cardName(x) : x === null ? "XX" : "??")).join(" ");
        if (await this.send(h.handNo, "Act", (o) => c.client.act(this.actor, c.tableId, hs.handNo, act.action, act.amount, o))) {
          c.history.add(c.tableId, h.handNo, `${a.phase.padEnd(7)} ${this.name} [${holeTxt}] ${text}${allIn ? " (all-in)" : ""}`);
        } else {
          this.failedBets.add(a.id);
        }
        return;
      }
    }
  }

  /** Designated caller sends at once; others wait fallbackDelayMs after the deadline passed. */
  private overdueOk(table: TableState, id: string): boolean {
    const h = table.hand!;
    const owing = new Set<number>(h.owing);
    if (h.turn >= 0) owing.add(h.turn);
    const designated = h.players.findIndex((_, j) => !owing.has(j));
    const me = handIndexOf(table, this.actor.address);
    if (me === designated) return true;
    const now = Date.now();
    const since = this.overdueSince.get(id) ?? now;
    this.overdueSince.set(id, since);
    return now - since >= (this.cfg.fallbackDelayMs ?? 4000);
  }

  private recordOpened(hs: HandSession): void {
    let m = this.opened.get(hs.handNo);
    if (!m) this.opened.set(hs.handNo, (m = new Map()));
    for (let p = 0; p < 52; p++) {
      if (m.has(p)) continue;
      const v = hs.openedCard(p);
      if (v !== undefined) {
        m.set(p, v);
        if (v === null) this.log(`hand ${hs.handNo}: position ${p} did not decode to a card`);
      }
    }
  }
}
