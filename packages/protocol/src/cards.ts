import { bigIntToBytes, bytesToBigInt, concatBytes, toHex, utf8 } from "./bytes.ts";
import { P } from "./group.ts";
import { sha256 } from "./hash.ts";

export const DECK_SIZE = 52;
export const CARD_LEN = 256;
export const DECK_BYTES = DECK_SIZE * CARD_LEN;

export const RANK_CHARS = "23456789TJQKA";
export const SUIT_CHARS = "cdhs";
export const RANK_NAMES = ["Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Jack", "Queen", "King", "Ace"] as const;
export const SUIT_NAMES = ["clubs", "diamonds", "hearts", "spades"] as const;

export type Rank = number; // 0 = Two .. 12 = Ace
export type Suit = number; // 0 clubs, 1 diamonds, 2 hearts, 3 spades

export function cardRank(c: number): Rank {
  return c % 13;
}
export function cardSuit(c: number): Suit {
  return Math.floor(c / 13);
}
export function cardIndex(rank: Rank, suit: Suit): number {
  if (rank < 0 || rank > 12 || suit < 0 || suit > 3) throw new Error("invalid rank or suit");
  return suit * 13 + rank;
}
/** Short name such as "As", "Td", "2c". */
export function cardName(c: number): string {
  assertCard(c);
  return RANK_CHARS[cardRank(c)]! + SUIT_CHARS[cardSuit(c)]!;
}
/** Long name such as "Ace of spades". */
export function cardLongName(c: number): string {
  assertCard(c);
  return `${RANK_NAMES[cardRank(c)]} of ${SUIT_NAMES[cardSuit(c)]}`;
}
/** Parses "As", "td", "10h". */
export function parseCard(s: string): number {
  const t = s.trim();
  const rs = t.slice(0, -1).toUpperCase().replace("10", "T");
  const r = RANK_CHARS.indexOf(rs);
  const su = SUIT_CHARS.indexOf(t.slice(-1).toLowerCase());
  if (rs.length !== 1 || r < 0 || su < 0) throw new Error(`invalid card "${s}"`);
  return cardIndex(r, su);
}
function assertCard(c: number): void {
  if (!Number.isInteger(c) || c < 0 || c >= DECK_SIZE) throw new Error(`invalid card index ${c}`);
}

/** m_c = (x mod P)^2 mod P with x = H(tag||c||0) || ... || H(tag||c||7). */
export function cardEncoding(c: number): bigint {
  assertCard(c);
  const tag = utf8("gno-poker/card/v1");
  const blocks: Uint8Array[] = [];
  for (let k = 0; k < 8; k++) blocks.push(sha256(tag, new Uint8Array([c, k])));
  const x = bytesToBigInt(concatBytes(...blocks)) % P;
  return (x * x) % P;
}

/** Plaintext encodings m_0..m_51. */
export const CARD_ENCODINGS: readonly bigint[] = Object.freeze(
  Array.from({ length: DECK_SIZE }, (_, c) => cardEncoding(c)),
);

/** The canonical deck D_-1 = [m_0 .. m_51]. */
export function canonicalDeck(): bigint[] {
  return CARD_ENCODINGS.slice();
}

const DECODE = new Map<string, number>(CARD_ENCODINGS.map((m, c) => [m.toString(16), c]));

/** Card index whose encoding equals the element, or null. */
export function decodeCard(element: bigint | Uint8Array): number | null {
  const v = typeof element === "bigint" ? element : bytesToBigInt(element);
  return DECODE.get(v.toString(16)) ?? null;
}

export function encodingHex(c: number): string {
  return toHex(bigIntToBytes(cardEncoding(c), CARD_LEN));
}
