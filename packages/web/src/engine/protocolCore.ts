// The protocol side of a seat: owns the HandSession for the current hand, records deck passes,
// opens cards and decides what is owed. Runs inside a Web Worker (protocol.worker.ts) because
// building a deck pass and verifying a hand are hundreds of 2048-bit modexps; it is plain code so
// unit tests and the Node auto-player can use it directly.

import {
  type CheatHooks,
  type HandSession as HandSessionT,
  type KeyValueStore,
  type OwedAction,
  type TableState,
  HandSession,
  PokerClient,
  boardPositions,
  holePositions,
  parseTableJSON,
} from "@gno-poker/protocol";

export type VerifySummary =
  | { ok: true; passes: number }
  | { ok: false; kind: "shuffle" | "rekey"; accused: number; seq: number; index: number; inPos: number; inHex: string; outHex: string }
  | { ok: false; kind: "missing"; accused: number; seq: number; reason: string };

export interface SessionView {
  tableId: number;
  handNo: number;
  myIndex: number;
  n: number;
  seedLost: boolean;
  /** Card index per position; null = failed to decode; -1 = not open yet. */
  hole: number[];
  board: number[];
  badPositions: number[];
  action: OwedAction;
  verification: VerifySummary | null;
  passesRecorded: number;
  totalPasses: number;
}

export interface TickInput {
  tableJson: string;
  /** Address the seat acts with (session address). */
  address: string;
  namespace: string;
  challengesEnabled: boolean;
}

export interface CoreDeps {
  store: KeyValueStore;
  client: PokerClient;
  /** Dev-only cheating hooks for test opponents (dev/autoplayer.ts --cheat). Never set in the app. */
  cheat?: CheatHooks;
}

const enc = (c: number | null | undefined): number => (c === undefined ? -1 : c === null ? -2 : c);

/** Decoded card slot: a card index, "bad" for a failed decode, or null when not open. */
export function slotCard(v: number): number | "bad" | null {
  return v === -2 ? "bad" : v < 0 ? null : v;
}

export class ProtocolCore {
  private readonly deps: CoreDeps;
  private readonly sessions = new Map<string, HandSessionT>();
  private readonly cleaned = new Set<string>();

  constructor(deps: CoreDeps) {
    this.deps = deps;
  }

  private key(namespace: string, tableId: number): string {
    return `${namespace}|${tableId}`;
  }

  async tick(input: TickInput): Promise<SessionView | null> {
    const table = parseTableJSON(input.tableJson);
    const h = table.hand;
    if (!h) return null;
    const k = this.key(input.namespace, table.id);
    let s = this.sessions.get(k);
    if (s && s.handNo !== h.handNo) {
      if (s.handNo < h.handNo) await s.discard(); // previous hand was finalized before StartHand
      this.sessions.delete(k);
      s = undefined;
    }
    if (!s) {
      await this.cleanOld(input.namespace, table);
      const opened = await HandSession.open({
        table,
        address: input.address,
        store: this.deps.store,
        namespace: input.namespace,
        challengesEnabled: input.challengesEnabled,
        ...(this.deps.cheat ? { cheat: this.deps.cheat } : {}),
      });
      if (!opened) return null;
      s = opened;
      this.sessions.set(k, s);
    }
    await s.observe(table, () => this.deps.client.getDeckB64(table.id));
    const action = await s.nextAction(table);
    return this.view(s, table, action);
  }

  async submitted(namespace: string, tableId: number, handNo: number, action: OwedAction): Promise<void> {
    const s = this.sessions.get(this.key(namespace, tableId));
    if (s && s.handNo === handNo) await s.markSubmitted(action);
  }

  /** Removes stored data of hands older than the table's current hand (left over by a closed tab). */
  private async cleanOld(namespace: string, table: TableState): Promise<void> {
    const k = this.key(namespace, table.id);
    if (this.cleaned.has(k)) return;
    this.cleaned.add(k);
    const prefix = `${namespace}/${table.id}/`;
    for (const key of await this.deps.store.keys(prefix)) {
      const handNo = Number(key.slice(prefix.length).split("/")[0]);
      if (Number.isFinite(handNo) && handNo < table.handNo) await this.deps.store.delete(key);
    }
  }

  private view(s: HandSessionT, table: TableState, action: OwedAction): SessionView {
    const h = table.hand!;
    let verification: VerifySummary | null = null;
    if ((h.phase === "challenge" || h.phase === "done") && h.players.every((p) => p.seed !== "")) {
      const v = s.verify(table);
      if (v) verification = summarize(v, s.n);
    }
    const passes = s.recordedPasses();
    return {
      tableId: s.tableId,
      handNo: s.handNo,
      myIndex: s.myIndex,
      n: s.n,
      seedLost: s.seedLost,
      hole: holePositions(s.n, s.myIndex).map((p) => enc(s.openedCard(p))),
      board: boardPositions(s.n).map((p) => enc(s.openedCard(p))),
      badPositions: s.badPositions(),
      action,
      verification,
      passesRecorded: passes.filter(Boolean).length,
      totalPasses: passes.length,
    };
  }
}

function summarize(v: NonNullable<ReturnType<HandSessionT["verify"]>>, n: number): VerifySummary {
  if (v.ok) return { ok: true, passes: v.passes.length };
  if (v.kind === "missing") return { ok: false, kind: "missing", accused: v.accused, seq: v.seq, reason: v.reason };
  const c = v.challenge;
  const b64hex = (b: string) => {
    const bin = atob(b);
    let out = "";
    for (let i = 0; i < bin.length; i++) out += bin.charCodeAt(i).toString(16).padStart(2, "0");
    return out;
  };
  return {
    ok: false,
    kind: v.kind,
    accused: v.accused,
    seq: v.kind === "shuffle" ? v.accused : n + v.accused,
    index: v.index,
    inPos: v.kind === "shuffle" ? -1 : v.index,
    inHex: b64hex(c.inB64),
    outHex: b64hex(c.outB64),
  };
}
