// In-memory model of the realm's hand protocol (protocol.md sections 4, 5, 7), enough to drive
// HandSession and PokerClient end to end without a chain. Betting is reduced to check/call.

import {
  type CallRequest, type CallResult, type DealStep, type PokerSigner, type RealmQuerier,
  CANON_ROOT_HEX, P, cardKey, commitHex, deckToBase64, elementFromBase64, fromHex,
  keysOwed, merkleRoot, modPow, officialCardsFromSeeds, parseDeck, permutation, shuffleKey,
  verifyMerkleProof, boardPositions, toHex,
} from "../src/index.ts";

type Phase = string;

function goQuote(s: string): string {
  return JSON.stringify(s); // JSON escaping is a subset of Go escaping for this ASCII content
}

export class FakeRealm implements RealmQuerier {
  readonly addresses: string[];
  readonly n: number;
  height = 100;
  handNo = 1;
  phase: Phase = "shuffle";
  turn = 0;
  owing = new Set<number>();
  deadline = 0;
  deckSeq = 0;
  roots: Uint8Array[] = [];
  deckB64 = "";
  commits: string[];
  seeds: string[];
  keys: Map<number, string>[];
  acted: boolean[];
  accepted: boolean[];
  cards: number[] = [];
  convicted: number[] = [];
  challengesEnabled = true;
  log: string[] = [];

  constructor(addresses: string[]) {
    this.addresses = addresses;
    this.n = addresses.length;
    this.commits = addresses.map(() => "");
    this.seeds = addresses.map(() => "");
    this.keys = addresses.map(() => new Map());
    this.acted = addresses.map(() => false);
    this.accepted = addresses.map(() => false);
    this.deadline = this.height + 30;
  }

  signer(j: number): PokerSigner {
    return {
      getAddress: async () => this.addresses[j]!,
      call: async (req: CallRequest) => this.call(j, req),
    };
  }

  private setPhase(p: Phase, turn: number, owingAll: boolean): void {
    this.phase = p;
    this.turn = turn;
    this.owing = new Set(owingAll ? Array.from({ length: this.n }, (_, i) => i) : []);
    this.deadline = this.height + 30;
    this.acted = this.acted.map(() => false);
  }

  private call(j: number, req: CallRequest): CallResult {
    this.height++;
    const a = req.args;
    this.log.push(`${j}:${req.func}`);
    const need = (cond: boolean, msg: string) => {
      if (!cond) throw new Error(`${req.func}: ${msg}`);
    };
    if (req.func !== "Timeout" && req.func !== "Finalize") need(a[1] === String(this.handNo), "wrong hand");
    switch (req.func) {
      case "SubmitShuffle":
      case "SubmitRekey": {
        const shuffle = req.func === "SubmitShuffle";
        need(this.phase === (shuffle ? "shuffle" : "rekey") && this.turn === j, "not your turn");
        const deckB64 = shuffle ? a[3]! : a[2]!;
        const deck = parseDeck(deckB64); // validates
        if (shuffle) this.commits[j] = a[2]!;
        this.roots.push(merkleRoot(deck));
        this.deckB64 = deckToBase64(deck);
        this.deckSeq++;
        if (j + 1 < this.n) this.turn = j + 1;
        else if (shuffle) this.setPhase("rekey", 0, false);
        else this.setPhase("deal_hole", -1, true);
        break;
      }
      case "ShareKeys": {
        need(this.phase.startsWith("deal_") && this.owing.has(j), "not owing keys");
        const step = this.phase.slice(5) as DealStep;
        const pos = keysOwed(step, this.n, j);
        const hex = a[2]!;
        need(hex.length === pos.length * 64, "bad keys length");
        pos.forEach((p, k) => this.keys[j]!.set(p, hex.slice(64 * k, 64 * k + 64)));
        this.owing.delete(j);
        if (this.owing.size === 0) {
          const next: Record<string, string> = { deal_hole: "preflop", deal_flop: "flop", deal_turn: "turn", deal_river: "river" };
          this.setPhase(next[this.phase]!, 0, false);
        }
        break;
      }
      case "Act": {
        need(["preflop", "flop", "turn", "river"].includes(this.phase) && this.turn === j, "not your turn to act");
        need(a[2] === "check" || a[2] === "call", "fake realm only supports check/call");
        this.acted[j] = true;
        if (j + 1 < this.n) this.turn = j + 1;
        else {
          const next: Record<string, string> = { preflop: "deal_flop", flop: "deal_turn", turn: "deal_river", river: "reveal" };
          this.setPhase(next[this.phase]!, -1, true);
        }
        break;
      }
      case "RevealSeed": {
        need(this.phase === "reveal" && this.owing.has(j), "not owing reveal");
        const seed = fromHex(a[2]!);
        need(commitHex(seed) === this.commits[j], "commit mismatch");
        for (const [p, k] of this.keys[j]!) need(cardKey(seed, p).toString(16).padStart(64, "0") === k, "bad published key");
        this.seeds[j] = a[2]!;
        this.owing.delete(j);
        if (this.owing.size === 0) {
          this.cards = officialCardsFromSeeds(this.seeds.map(fromHex));
          if (this.challengesEnabled) this.setPhase("challenge", -1, false);
          else this.setPhase("done", -1, false);
        }
        break;
      }
      case "Accept": {
        need(this.phase === "challenge", "not in challenge window");
        this.accepted[j] = true;
        if (this.accepted.every(Boolean)) this.setPhase("done", -1, false);
        break;
      }
      case "Challenge": {
        need(this.phase === "challenge", "not in challenge window");
        const accused = Number(a[2]);
        const kind = a[3]!;
        const index = Number(a[4]);
        const s = kind === "shuffle" ? accused : this.n + accused;
        const inRoot = s === 0 ? fromHex(CANON_ROOT_HEX) : this.roots[s - 1]!;
        const seed = fromHex(this.seeds[accused]!);
        const inIndex = kind === "shuffle" ? permutation(seed)[index]! : index;
        const vin = elementFromBase64(a[5]!);
        const vout = elementFromBase64(a[7]!);
        need(verifyMerkleProof(inRoot, vin, inIndex, fromHex(a[6]!)), "bad in proof");
        need(verifyMerkleProof(this.roots[s]!, vout, index, fromHex(a[8]!)), "bad out proof");
        const e = shuffleKey(seed);
        const guilty = kind === "shuffle"
          ? modPow(vin, e, P) !== vout
          : modPow(vout, e, P) !== modPow(vin, cardKey(seed, index), P);
        if (guilty) {
          this.convicted.push(accused);
          this.setPhase("done", -1, false);
        }
        break;
      }
      default:
        throw new Error(`fake realm: unsupported ${req.func}`);
    }
    return { hash: `tx${this.height}`, height: this.height, data: "" };
  }

  tableJSON(): string {
    const revealedAll = this.seeds.every((s) => s !== "");
    const hand = {
      handNo: this.handNo,
      phase: this.phase,
      players: this.addresses.map((addr, i) => ({
        seat: i, owner: addr, commit: this.commits[i], contributed: "0", streetBet: "0",
        folded: false, allIn: false, acted: this.acted[i], revealed: this.seeds[i] !== "",
        accepted: this.accepted[i], seed: this.seeds[i],
        keys: Object.fromEntries(this.keys[i]!),
      })),
      turn: this.turn,
      owing: [...this.owing].sort(),
      deadline: this.deadline,
      pot: "0", currentBet: "0", minRaise: "2000",
      deckSeq: this.deckSeq,
      roots: this.roots.map((r) => toHex(r)),
      board: revealedAll ? boardPositions(this.n).map((p) => this.cards[p]) : [],
      cards: revealedAll ? Object.fromEntries(this.cards.map((c, p) => [String(p), c])) : {},
      result: this.phase === "done" ? { aborted: false, convicted: this.convicted, payouts: {} } : null,
    };
    return JSON.stringify({
      id: 1, smallBlind: "1000", bigBlind: "2000", minBuyIn: "40000", maxBuyIn: "200000",
      maxPlayers: 6, actionTimeoutBlocks: 30, challengeWindowBlocks: 30, challengeBond: "10000",
      height: this.height, button: 0, handNo: this.handNo,
      seats: [...this.addresses.map((addr, i) => ({ seat: i, owner: addr, session: "", stack: "100000",
        sittingOut: false, leaving: false, waiting: false })), ...Array(6 - this.n).fill(null)],
      hand,
    });
  }

  async evaluate(_pkgPath: string, expr: string): Promise<string> {
    if (expr === "GetTable(1)") return `(${goQuote(this.tableJSON())} string)`;
    if (expr === "GetDeck(1)") return `(${goQuote(this.deckB64)} string)`;
    if (expr === "ChallengesEnabled()") return `(${this.challengesEnabled} bool)`;
    throw new Error(`fake realm: unsupported query ${expr}`);
  }
}

