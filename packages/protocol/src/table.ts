// Typed view of the realm's JSON queries (protocol section 7).

export const PHASES = [
  "shuffle", "rekey", "deal_hole", "preflop", "deal_flop", "flop", "deal_turn", "turn",
  "deal_river", "river", "reveal", "challenge", "done",
] as const;
export type Phase = (typeof PHASES)[number];

export const BETTING_PHASES: readonly Phase[] = ["preflop", "flop", "turn", "river"];

export interface SeatState {
  seat: number;
  owner: string;
  /** Session address, or "" when the owner acts directly. */
  session: string;
  stack: bigint;
  sittingOut: boolean;
  leaving: boolean;
  waiting: boolean;
}

export interface HandPlayerState {
  /** Hand-player index (position in hand.players). */
  index: number;
  seat: number;
  owner: string;
  commit: string;
  contributed: bigint;
  streetBet: bigint;
  folded: boolean;
  allIn: boolean;
  acted: boolean;
  /**
   * Whether the realm would accept a bet or raise from this player now (protocol section 7).
   * Undefined when the realm does not report it (older deployments).
   */
  canRaise?: boolean;
  revealed: boolean;
  accepted: boolean;
  /** Revealed seed hex, "" until revealed. */
  seed: string;
  /** Published card keys by position, hex. */
  keys: Map<number, string>;
}

export interface ChallengeRecord {
  challenger: number;
  accused: number;
  kind: string;
  index: number;
  guilty: boolean;
}

export interface HandResult {
  aborted: boolean;
  /** Hand-player indices convicted (lost challenge or wrong published key). */
  convicted: number[];
  /** Hand-player indices that stalled a protocol step. */
  stallers: number[];
  /** Amount settlement adds to each hand player's stack, by hand index. */
  payouts: Map<number, bigint>;
  /** Hand category name by hand index, for players evaluated at showdown. */
  hands: Map<number, string>;
  challenges: ChallengeRecord[];
}

export interface HandState {
  handNo: number;
  phase: Phase;
  players: HandPlayerState[];
  /** Hand index expected to act in in-turn phases, else -1. */
  turn: number;
  /** Hand indices that still owe the current simultaneous step. */
  owing: number[];
  deadline: number;
  pot: bigint;
  currentBet: bigint;
  minRaise: bigint;
  deckSeq: number;
  /** Root of pass s, lowercase hex. */
  roots: string[];
  /** Board card indices (filled after reveal). */
  board: number[];
  /** Card index by position (filled after reveal). */
  cards: Map<number, number>;
  result: HandResult | null;
}

export interface TableState {
  id: number;
  smallBlind: bigint;
  bigBlind: bigint;
  minBuyIn: bigint;
  maxBuyIn: bigint;
  maxPlayers: number;
  actionTimeoutBlocks: number;
  challengeWindowBlocks: number;
  challengeBond: bigint;
  height: number;
  button: number;
  handNo: number;
  seats: (SeatState | null)[];
  hand: HandState | null;
}

export interface TableSummary {
  id: number;
  smallBlind: bigint;
  bigBlind: bigint;
  minBuyIn: bigint;
  maxBuyIn: bigint;
  maxPlayers: number;
  /** Number of occupied seats. */
  seated: number;
  handNo: number;
  /** Phase of the current or last hand, "" if none. */
  phase: string;
  actionTimeoutBlocks: number;
  challengeWindowBlocks: number;
  challengeBond: bigint;
  button: number;
}

type J = Record<string, unknown>;

function obj(v: unknown, what: string): J {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${what}: expected object`);
  return v as J;
}
function num(v: unknown, what: string): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
  throw new Error(`${what}: expected number`);
}
function amt(v: unknown, what: string): bigint {
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new Error(`${what}: expected decimal amount`);
}
function str(v: unknown, what: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new Error(`${what}: expected string`);
  return v;
}
function bool(v: unknown): boolean {
  return v === true;
}
function arr(v: unknown, what: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${what}: expected array`);
  return v;
}
function numMap<T>(v: unknown, what: string, f: (x: unknown) => T): Map<number, T> {
  const m = new Map<number, T>();
  if (v === undefined || v === null) return m;
  for (const [k, x] of Object.entries(obj(v, what))) m.set(num(k, `${what} key`), f(x));
  return m;
}

function parseSeat(v: unknown, i: number): SeatState | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, `seats[${i}]`);
  return {
    seat: o.seat === undefined ? i : num(o.seat, "seat"),
    owner: str(o.owner, "owner"),
    session: str(o.session, "session"),
    stack: amt(o.stack, "stack"),
    sittingOut: bool(o.sittingOut),
    leaving: bool(o.leaving),
    waiting: bool(o.waiting),
  };
}

function parsePlayer(v: unknown, i: number): HandPlayerState {
  const o = obj(v, `players[${i}]`);
  return {
    index: i,
    seat: num(o.seat, "seat"),
    owner: str(o.owner, "owner"),
    commit: str(o.commit, "commit").toLowerCase(),
    contributed: amt(o.contributed ?? "0", "contributed"),
    streetBet: amt(o.streetBet ?? "0", "streetBet"),
    folded: bool(o.folded),
    allIn: bool(o.allIn),
    acted: bool(o.acted),
    ...(typeof o.canRaise === "boolean" ? { canRaise: o.canRaise } : {}),
    revealed: bool(o.revealed),
    accepted: bool(o.accepted),
    seed: str(o.seed, "seed").toLowerCase(),
    keys: numMap(o.keys, "keys", (x) => str(x, "key").toLowerCase()),
  };
}

function parseHand(v: unknown): HandState | null {
  if (v === null || v === undefined) return null;
  const o = obj(v, "hand");
  const phase = str(o.phase, "phase") as Phase;
  if (!PHASES.includes(phase)) throw new Error(`unknown phase "${phase}"`);
  let result: HandResult | null = null;
  if (o.result !== null && o.result !== undefined) {
    const r = obj(o.result, "result");
    result = {
      aborted: bool(r.aborted),
      convicted: arr(r.convicted, "convicted").map((x) => num(x, "convicted")),
      stallers: arr(r.stallers, "stallers").map((x) => num(x, "stallers")),
      payouts: numMap(r.payouts, "payouts", (x) => amt(x, "payout")),
      hands: numMap(r.hands, "hands", (x) => str(x, "hand name")),
      challenges: arr(r.challenges, "challenges").map((x, i) => {
        const c = obj(x, `challenges[${i}]`);
        return {
          challenger: num(c.challenger, "challenger"),
          accused: num(c.accused, "accused"),
          kind: str(c.kind, "kind"),
          index: num(c.index, "index"),
          guilty: bool(c.guilty),
        };
      }),
    };
  }
  return {
    handNo: num(o.handNo, "handNo"),
    phase,
    players: arr(o.players, "players").map(parsePlayer),
    turn: o.turn === undefined ? -1 : num(o.turn, "turn"),
    owing: arr(o.owing, "owing").map((x) => num(x, "owing")),
    deadline: num(o.deadline ?? 0, "deadline"),
    pot: amt(o.pot ?? "0", "pot"),
    currentBet: amt(o.currentBet ?? "0", "currentBet"),
    minRaise: amt(o.minRaise ?? "0", "minRaise"),
    deckSeq: num(o.deckSeq ?? 0, "deckSeq"),
    roots: arr(o.roots, "roots").map((x) => str(x, "root").toLowerCase()),
    board: arr(o.board, "board").map((x) => num(x, "board")),
    cards: numMap(o.cards, "cards", (x) => num(x, "card")),
    result,
  };
}

/** Parses the GetTable JSON. */
export function parseTableJSON(json: string | unknown): TableState {
  const o = obj(typeof json === "string" ? JSON.parse(json) : json, "table");
  return {
    id: num(o.id, "id"),
    smallBlind: amt(o.smallBlind, "smallBlind"),
    bigBlind: amt(o.bigBlind, "bigBlind"),
    minBuyIn: amt(o.minBuyIn, "minBuyIn"),
    maxBuyIn: amt(o.maxBuyIn, "maxBuyIn"),
    maxPlayers: num(o.maxPlayers, "maxPlayers"),
    actionTimeoutBlocks: num(o.actionTimeoutBlocks, "actionTimeoutBlocks"),
    challengeWindowBlocks: num(o.challengeWindowBlocks, "challengeWindowBlocks"),
    challengeBond: amt(o.challengeBond, "challengeBond"),
    height: num(o.height, "height"),
    button: num(o.button, "button"),
    handNo: num(o.handNo, "handNo"),
    seats: arr(o.seats, "seats").map(parseSeat),
    hand: parseHand(o.hand),
  };
}

/** Parses the ListTables JSON. */
export function parseTableListJSON(json: string | unknown): TableSummary[] {
  return arr(typeof json === "string" ? JSON.parse(json) : json, "tables").map((v, i) => {
    const o = obj(v, `tables[${i}]`);
    return {
      id: num(o.id, "id"),
      smallBlind: amt(o.smallBlind, "smallBlind"),
      bigBlind: amt(o.bigBlind, "bigBlind"),
      minBuyIn: amt(o.minBuyIn, "minBuyIn"),
      maxBuyIn: amt(o.maxBuyIn, "maxBuyIn"),
      maxPlayers: num(o.maxPlayers, "maxPlayers"),
      seated: num(o.seated ?? 0, "seated"),
      handNo: num(o.handNo ?? 0, "handNo"),
      phase: str(o.phase, "phase"),
      actionTimeoutBlocks: num(o.actionTimeoutBlocks ?? 0, "actionTimeoutBlocks"),
      challengeWindowBlocks: num(o.challengeWindowBlocks ?? 0, "challengeWindowBlocks"),
      challengeBond: amt(o.challengeBond ?? "0", "challengeBond"),
      button: num(o.button ?? 0, "button"),
    };
  });
}

/** Hand index of the player whose owner or session address is `address`, or -1. */
export function handIndexOf(table: TableState, address: string): number {
  const h = table.hand;
  if (!h) return -1;
  return h.players.findIndex((p) => {
    if (p.owner === address) return true;
    const seat = table.seats[p.seat];
    return !!seat && seat.session !== "" && seat.session === address;
  });
}

export interface BetOptions {
  /** Amount needed to call (capped at the stack). */
  toCall: bigint;
  canCheck: boolean;
  /** Smallest legal total street bet for a raise or opening bet, or null if raising is impossible. */
  minRaiseTo: bigint | null;
  /** Largest total street bet (all-in). */
  maxRaiseTo: bigint;
  stack: bigint;
}

/** Betting options for hand player j from table state. */
export function betOptions(table: TableState, j: number): BetOptions {
  const h = table.hand;
  if (!h) throw new Error("no hand");
  const p = h.players[j];
  if (!p) throw new Error("bad hand index");
  const stack = table.seats[p.seat]?.stack ?? 0n;
  const owed = h.currentBet > p.streetBet ? h.currentBet - p.streetBet : 0n;
  const toCall = owed < stack ? owed : stack;
  const maxRaiseTo = p.streetBet + stack;
  const minStep = h.minRaise > 0n ? h.minRaise : table.bigBlind;
  let minRaiseTo: bigint | null = h.currentBet + minStep;
  // A short all-in does not reopen the betting for a player who already acted; the realm reports
  // that as canRaise=false.
  if (maxRaiseTo <= h.currentBet || p.canRaise === false) minRaiseTo = null;
  else if (minRaiseTo > maxRaiseTo) minRaiseTo = maxRaiseTo; // short all-in raise
  return { toCall, canCheck: owed === 0n, minRaiseTo, maxRaiseTo, stack };
}
