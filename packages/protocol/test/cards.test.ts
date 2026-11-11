import { describe, expect, it } from "vitest";
import {
  CARD_ENCODINGS, P, canonicalDeck, cardIndex, cardLongName, cardName, cardRank, cardSuit,
  decodeCard, isQuadraticResidue, parseCard,
} from "../src/index.ts";

describe("cards", () => {
  it("52 distinct quadratic-residue encodings in range", () => {
    expect(CARD_ENCODINGS.length).toBe(52);
    expect(new Set(CARD_ENCODINGS).size).toBe(52);
    for (const m of CARD_ENCODINGS) {
      expect(m > 1n && m < P).toBe(true);
      expect(isQuadraticResidue(m)).toBe(true);
    }
  });

  it("decodes encodings back to indices", () => {
    canonicalDeck().forEach((m, c) => expect(decodeCard(m)).toBe(c));
    expect(decodeCard(12345n)).toBeNull();
  });

  it("rank, suit and names", () => {
    expect(cardRank(0)).toBe(0);
    expect(cardSuit(0)).toBe(0);
    expect(cardName(0)).toBe("2c");
    expect(cardName(12)).toBe("Ac");
    expect(cardName(13)).toBe("2d");
    expect(cardName(51)).toBe("As");
    expect(cardLongName(38)).toBe("Ace of hearts");
    expect(cardIndex(12, 3)).toBe(51);
    for (let c = 0; c < 52; c++) expect(parseCard(cardName(c))).toBe(c);
    expect(parseCard("10h")).toBe(cardIndex(8, 2));
    expect(() => parseCard("1x")).toThrow();
  });
});
