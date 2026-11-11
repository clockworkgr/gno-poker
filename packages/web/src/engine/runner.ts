// TableRunner drives one table for the local player: polls GetTable, feeds the protocol worker,
// sends owed protocol transactions with the session key, and exposes a snapshot for React.
//
// Double-send guard: at most one transaction is in flight at a time; a protocol action is marked
// submitted (persisted by HandSession) as soon as its transaction is included, and a failed action
// is retried at most MAX_AUTO_RETRIES times with back-off before it waits for the user.

import {
  type BetAction,
  type OwedAction,
  type PokerClient,
  type SeatState,
  type TableState,
  parseGnoString,
  parseTableJSON,
} from "@gno-poker/protocol";
import type { KeyPair } from "../chain/keys.ts";
import type { GnoRpc } from "../chain/rpc.ts";
import { LocalSigner, type WalletSigner } from "../chain/signer.ts";
import { type LogEntry, type LogKind, diffTable, seatLabel } from "./log.ts";
import type { SessionView, TickInput } from "./protocolCore.ts";
import { loadSessionKey } from "./sessionKeys.ts";
import { shortAddr } from "../config.ts";

export interface ProtocolPort {
  tick(input: TickInput): Promise<SessionView | null>;
  submitted(namespace: string, tableId: number, handNo: number, action: OwedAction): Promise<void>;
}

export interface RunnerOptions {
  tableId: number;
  rpc: GnoRpc;
  client: PokerClient;
  protocol: ProtocolPort;
  chainId: string;
  realm: string;
  owner: WalletSigner | null;
  ownerAddress: string | null;
  challengesEnabled: boolean;
  confirmChallenge: () => boolean;
  pollMs: () => number;
  /** Builds the signer for the stored session key (tests substitute a fake). */
  makeSessionSigner?: (k: KeyPair) => WalletSigner;
}

export interface TxState {
  label: string;
  func: string;
  startedAt: number;
}

export interface RunnerSnapshot {
  table: TableState | null;
  error: string | null;
  /** Seat index owned by the connected wallet, or -1. */
  mySeat: number;
  seat: SeatState | null;
  sessionAddress: string | null;
  /** Seated with a session key that is not stored in this browser. */
  sessionKeyMissing: boolean;
  view: SessionView | null;
  computing: boolean;
  tx: TxState | null;
  lastError: { message: string; func: string; at: number } | null;
  /** Owed action that failed MAX_AUTO_RETRIES times and waits for a manual retry. */
  stuck: OwedAction | null;
  /** Challenge waiting for the user's confirmation (when confirmChallenge is on). */
  pendingChallenge: OwedAction | null;
  sessionBalance: bigint | null;
  ownerBalance: bigint | null;
  log: LogEntry[];
  /** Id of the last bet we sent; controls stay locked until the owed bet changes. */
  sentBetId: string | null;
  /** Result of the last owner/session transaction started from the UI. */
  notice: { text: string; tone: "ok" | "warn" | "error"; at: number } | null;
}

const MAX_AUTO_RETRIES = 3;
const AUTO: OwedAction["type"][] = ["submitShuffle", "submitRekey", "shareKeys", "revealSeed", "accept"];

const LABELS: Record<string, string> = {
  submitShuffle: "Submitting your shuffle",
  submitRekey: "Submitting your re-key",
  shareKeys: "Sharing card keys",
  revealSeed: "Revealing your seed",
  accept: "Accepting the verified result",
  challenge: "Sending a challenge",
  timeout: "Calling timeout",
  finalize: "Finalizing the hand",
};

export class TableRunner {
  readonly o: RunnerOptions;
  private snap: RunnerSnapshot;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private ticking = false;
  private retick = false;
  private failures = new Map<string, { count: number; nextAt: number }>();
  private session: { signer: WalletSigner; address: string } | null = null;
  private logId = 1;
  private tickCount = 0;

  constructor(o: RunnerOptions) {
    this.o = o;
    this.snap = {
      table: null, error: null, mySeat: -1, seat: null, sessionAddress: null, sessionKeyMissing: false,
      view: null, computing: false, tx: null, lastError: null, stuck: null, pendingChallenge: null,
      sessionBalance: null, ownerBalance: null, log: this.loadLog(), sentBetId: null, notice: null,
    };
    this.logId = (this.snap.log[this.snap.log.length - 1]?.id ?? 0) + 1;
  }

  // The hand log survives a reload of the tab (sessionStorage; not shared between tabs).
  private get logKey(): string {
    return `gno-poker:log:${this.o.chainId}:${this.o.realm}:${this.o.tableId}`;
  }
  private loadLog(): LogEntry[] {
    try {
      const raw = sessionStorage.getItem(this.logKey);
      return raw ? (JSON.parse(raw) as LogEntry[]) : [];
    } catch {
      return [];
    }
  }
  private saveLog(): void {
    try {
      sessionStorage.setItem(this.logKey, JSON.stringify(this.snap.log));
    } catch {
      // quota or unavailable: the log is a convenience
    }
  }

  get namespace(): string {
    return `gno-poker/${this.o.chainId}/${this.o.realm}/${this.session?.address ?? "none"}`;
  }

  // React store plumbing
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): RunnerSnapshot => this.snap;
  private set(p: Partial<RunnerSnapshot>): void {
    this.snap = { ...this.snap, ...p };
    for (const l of this.listeners) l();
  }

  start(): void {
    this.stopped = false;
    this.loadSession();
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** (Re)reads the session key for this table from browser storage. */
  loadSession(): void {
    if (!this.o.ownerAddress) {
      this.session = null;
      return;
    }
    const k = loadSessionKey(this.o.chainId, this.o.realm, this.o.tableId, this.o.ownerAddress);
    const make = this.o.makeSessionSigner ?? ((key: KeyPair) => new LocalSigner({ key, rpc: this.o.rpc, chainId: this.o.chainId, kind: "session" }));
    this.session = k ? { signer: make(k.key), address: k.address } : null;
  }

  log(kind: LogKind, text: string, handNo = this.snap.table?.hand?.handNo ?? 0): void {
    const e: LogEntry = { id: this.logId++, at: Date.now(), handNo, kind, text };
    const log = [...this.snap.log, e];
    this.set({ log: log.length > 400 ? log.slice(-400) : log });
    this.saveLog();
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    await this.tick();
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), this.o.pollMs());
  }

  /** Polls now (coalesces with a tick in progress). */
  async tick(): Promise<void> {
    if (this.ticking) {
      this.retick = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.retick = false;
        await this.tickOnce();
      } while (this.retick && !this.stopped);
    } finally {
      this.ticking = false;
    }
  }

  seatName = (seat: number): string => {
    const s = this.snap.table?.seats[seat];
    if (seat === this.snap.mySeat) return "You";
    return s ? `${seatLabel(seat)} (${shortAddr(s.owner)})` : seatLabel(seat);
  };

  private async tickOnce(): Promise<void> {
    let raw: string;
    let table: TableState;
    try {
      raw = parseGnoString(await this.o.rpc.qeval(this.o.realm, `GetTable(${this.o.tableId})`));
      table = parseTableJSON(raw);
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const prev = this.snap.table;
    const mySeat = this.o.ownerAddress ? table.seats.findIndex((s) => s?.owner === this.o.ownerAddress) : -1;
    const seat = mySeat >= 0 ? table.seats[mySeat]! : null;
    if (seat && seat.session && (!this.session || this.session.address !== seat.session)) this.loadSession();
    const sessionKeyMissing = !!seat && seat.session !== "" && (!this.session || this.session.address !== seat.session);
    this.set({ table, error: null, mySeat, seat, sessionAddress: this.session?.address ?? null, sessionKeyMissing });

    for (const d of diffTable(prev, table, this.seatName)) this.log(d.kind, d.text, d.handNo);
    this.reportRemoval(prev, table);

    if (this.tickCount++ % 5 === 0) void this.refreshBalances();

    // Protocol work only when we hold the seat's session key and play this hand.
    const inHand = !!table.hand && !!this.session && table.hand.players.some((p) => p.seat === mySeat);
    if (!inHand || !this.session || sessionKeyMissing) {
      if (this.snap.view && (!table.hand || this.snap.view.handNo !== table.hand.handNo)) this.set({ view: null });
      return;
    }
    let view: SessionView | null;
    const computeSoon = table.hand && (table.hand.phase === "shuffle" || table.hand.phase === "rekey") && table.hand.players[table.hand.turn]?.seat === mySeat;
    if (computeSoon) this.set({ computing: true });
    try {
      view = await this.o.protocol.tick({ tableJson: raw, address: this.session.address, namespace: this.namespace, challengesEnabled: this.o.challengesEnabled });
    } catch (e) {
      this.set({ computing: false });
      this.setError("protocol", e);
      return;
    }
    this.set({ view, computing: false });
    if (view) await this.maybeSend(view, table);
  }

  private reportRemoval(prev: TableState | null, next: TableState): void {
    if (!prev || this.snap.mySeat >= 0 || !this.o.ownerAddress) return;
    const was = prev.seats.findIndex((s) => s?.owner === this.o.ownerAddress);
    if (was < 0) return;
    const h = next.hand;
    const j = h ? h.players.findIndex((p) => p.seat === was && p.owner === this.o.ownerAddress) : -1;
    if (h?.result && j >= 0 && h.result.convicted.includes(j)) {
      this.set({ notice: { text: "You were convicted of submitting a deck that does not match your seed and removed from the table. Your stack was split among the other players.", tone: "error", at: Date.now() } });
    } else if (h?.result && j >= 0 && h.result.stallers.includes(j)) {
      this.set({ notice: { text: "You missed a protocol deadline: the hand was aborted, your stack was forfeited to the other players and you were removed from the table.", tone: "error", at: Date.now() } });
    } else {
      this.set({ notice: { text: "You left the table; your stack was paid out to your wallet.", tone: "ok", at: Date.now() } });
    }
  }

  async refreshBalances(): Promise<void> {
    try {
      const [sb, ob] = await Promise.all([
        this.session ? this.o.rpc.balance(this.session.address) : Promise.resolve(null),
        this.o.ownerAddress ? this.o.rpc.balance(this.o.ownerAddress) : Promise.resolve(null),
      ]);
      this.set({ sessionBalance: sb, ownerBalance: ob });
    } catch {
      // keep the previous values
    }
  }

  private async maybeSend(view: SessionView, table: TableState): Promise<void> {
    const a = view.action;
    if (this.snap.tx) return;
    if (a.type === "challenge") {
      if (this.o.confirmChallenge()) {
        if (this.snap.pendingChallenge?.type !== "challenge" || (this.snap.pendingChallenge as { id: string }).id !== a.id) this.set({ pendingChallenge: a });
        return;
      }
    } else if (this.snap.pendingChallenge) {
      this.set({ pendingChallenge: null });
    }
    if (!AUTO.includes(a.type) && a.type !== "challenge") {
      if (this.snap.stuck && (a.type === "none" || (a as { id?: string }).id !== (this.snap.stuck as { id?: string }).id)) this.set({ stuck: null });
      return;
    }
    const id = (a as { id: string }).id;
    const f = this.failures.get(id);
    if (f && f.count >= MAX_AUTO_RETRIES) {
      if (this.snap.stuck !== a) this.set({ stuck: a });
      return;
    }
    if (f && Date.now() < f.nextAt) return;
    await this.sendProtocol(a, table.hand!.handNo);
  }

  /** Sends an owed protocol action with the session key. */
  private async sendProtocol(a: OwedAction, handNo: number): Promise<void> {
    if (!this.session || a.type === "none" || a.type === "bet") return;
    const c = this.o.client.as(this.session.signer);
    const t = this.o.tableId;
    const ok = await this.runTx(LABELS[a.type] ?? a.type, a.type, async () => {
      switch (a.type) {
        case "submitShuffle": return c.submitShuffle(t, handNo, a.commitHex, a.deckB64);
        case "submitRekey": return c.submitRekey(t, handNo, a.deckB64);
        case "shareKeys": return c.shareKeys(t, handNo, a.keysHex);
        case "revealSeed": return c.revealSeed(t, handNo, a.seedHex);
        case "accept": return c.accept(t, handNo);
        case "challenge": return c.challenge(t, handNo, a.args);
        case "timeout": return c.timeout(t);
        case "finalize": return c.finalize(t);
      }
    });
    if (ok) {
      this.failures.delete(a.id);
      await this.o.protocol.submitted(this.namespace, t, handNo, a);
      this.set({ stuck: null, pendingChallenge: a.type === "challenge" ? null : this.snap.pendingChallenge });
      if (a.type === "challenge") this.log("tx", `Challenge sent against player ${a.args.accused + 1}'s ${a.args.kind} pass at position ${a.args.index}`);
    } else {
      const f = this.failures.get(a.id) ?? { count: 0, nextAt: 0 };
      f.count++;
      f.nextAt = Date.now() + 2000 * f.count;
      this.failures.set(a.id, f);
    }
    void this.tick();
  }

  /** Runs one transaction with the single-flight guard; returns success. */
  private async runTx(label: string, func: string, fn: () => Promise<unknown>): Promise<boolean> {
    if (this.snap.tx) return false;
    this.set({ tx: { label, func, startedAt: Date.now() } });
    try {
      await fn();
      this.set({ tx: null, lastError: null });
      return true;
    } catch (e) {
      this.set({ tx: null });
      this.setError(func, e);
      return false;
    }
  }

  private setError(func: string, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.set({ lastError: { message, func, at: Date.now() } });
    this.log("error", message);
  }

  // ---- User actions ----

  /** Places a bet decision for the currently owed bet. */
  async act(action: BetAction, amount = 0n): Promise<boolean> {
    const v = this.snap.view;
    const a = v?.action;
    if (!this.session || !v || a?.type !== "bet" || this.snap.sentBetId === a.id) return false;
    this.set({ sentBetId: a.id });
    const c = this.o.client.as(this.session.signer);
    const ok = await this.runTx(action === "raise" ? "Raising" : action[0]!.toUpperCase() + action.slice(1) + "ing", "Act", () => c.act(this.o.tableId, v.handNo, action, amount));
    if (!ok) this.set({ sentBetId: null });
    void this.tick();
    return ok;
  }

  async retryStuck(): Promise<void> {
    const a = this.snap.stuck;
    if (!a || a.type === "none" || a.type === "bet") return;
    this.failures.delete(a.id);
    this.set({ stuck: null });
    await this.tick();
  }

  async confirmChallenge(): Promise<void> {
    const a = this.snap.pendingChallenge;
    const h = this.snap.table?.hand;
    if (!a || !h) return;
    await this.sendProtocol(a, h.handNo);
  }

  async timeoutOrFinalize(): Promise<void> {
    const a = this.snap.view?.action;
    const h = this.snap.table?.hand;
    if (!h) return;
    // Anyone may call these; use the session key when we have one, else the owner wallet.
    const signer = this.session?.signer ?? this.o.owner;
    if (!signer) return;
    const finalize = h.phase === "challenge";
    await this.runTx(finalize ? LABELS.finalize! : LABELS.timeout!, finalize ? "Finalize" : "Timeout", () =>
      finalize ? this.o.client.finalize(signer, this.o.tableId) : this.o.client.timeout(signer, this.o.tableId),
    );
    if (a && a.type !== "none" && a.type !== "bet") await this.o.protocol.submitted(this.namespace, this.o.tableId, h.handNo, a).catch(() => undefined);
    void this.tick();
  }

  async startHand(): Promise<boolean> {
    const signer = this.session?.signer ?? this.o.owner;
    if (!signer) return false;
    const ok = await this.runTx("Dealing a new hand", "StartHand", () => this.o.client.startHand(signer, this.o.tableId));
    void this.tick();
    return ok;
  }

  async sitOut(out: boolean): Promise<void> {
    const signer = this.session?.signer ?? this.o.owner;
    if (!signer) return;
    await this.runTx(out ? "Sitting out" : "Sitting in", out ? "SitOut" : "SitIn", () => (out ? this.o.client.sitOut(signer, this.o.tableId) : this.o.client.sitIn(signer, this.o.tableId)));
    void this.tick();
  }

  /** Owner only: pays out the stack (or marks leaving during a hand). */
  async leave(): Promise<boolean> {
    const owner = this.o.owner;
    if (!owner) return false;
    const live = !!this.snap.table?.hand && this.snap.table.hand.phase !== "done" && this.snap.table.hand.players.some((p) => p.seat === this.snap.mySeat);
    const ok = await this.runTx("Leaving the table", "Leave", () => this.o.client.leave(owner, this.o.tableId));
    if (ok) {
      this.set({ notice: { text: live ? "You will leave and be paid out when this hand is finalized." : "You left the table; your stack was paid out to your wallet.", tone: "ok", at: Date.now() } });
      this.log("tx", live ? "Leave requested: paid out when the hand is finalized" : "Left the table and cashed out");
    }
    void this.tick();
    void this.refreshBalances();
    return ok;
  }

  /** Owner only, between hands. */
  async topUp(amount: bigint): Promise<boolean> {
    const owner = this.o.owner;
    if (!owner) return false;
    const ok = await this.runTx("Topping up", "TopUp", () => this.o.client.topUp(owner, this.o.tableId, amount));
    void this.tick();
    return ok;
  }

  /** Owner sends more gas money to the session key. */
  async refillSession(amount: bigint): Promise<boolean> {
    const owner = this.o.owner;
    if (!owner || !this.session) return false;
    const to = this.session.address;
    const ok = await this.runTx("Refilling the session key", "Send", () => owner.send(to, amount));
    void this.refreshBalances();
    return ok;
  }

  /** Session key returns its unused gas allowance to the owner. */
  async sweepSession(): Promise<boolean> {
    if (!this.session || !this.o.ownerAddress) return false;
    const bal = await this.o.rpc.balance(this.session.address);
    const fee = 2000n;
    if (bal <= fee) return false;
    const signer = this.session.signer;
    const owner = this.o.ownerAddress;
    const ok = await this.runTx("Returning unused gas", "Send", () => signer.send(owner, bal - fee));
    if (ok) this.log("tx", "Returned the session key's unused gas allowance to your wallet");
    void this.refreshBalances();
    return ok;
  }

  clearNotice(): void {
    this.set({ notice: null });
  }
}
