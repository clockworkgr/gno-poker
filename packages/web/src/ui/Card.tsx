import { cardLongName, cardRank, cardSuit } from "@gno-poker/protocol";

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
// Text presentation selector keeps the suits from rendering as emoji.
const SUITS = ["♣︎", "♦︎", "♥︎", "♠︎"];
const SUIT_CLASS = ["club", "diamond", "heart", "spade"];

export type CardValue = number | "bad" | null;

/** A playing card: face up (index 0..51), face down (null) or undecodable ("bad"). */
export function Card({ card, size = "md", empty, highlight }: { card: CardValue; size?: "sm" | "md" | "lg"; empty?: boolean; highlight?: boolean }) {
  if (empty) return <span className={`card card-${size} card-slot`} aria-hidden="true" />;
  if (card === null) return <span className={`card card-${size} card-back`} role="img" aria-label="Face-down card" />;
  if (card === "bad") return <span className={`card card-${size} card-bad`} role="img" aria-label="Card failed to decode" title="This card did not decode: grounds for a challenge after the hand">?</span>;
  const r = cardRank(card);
  const s = cardSuit(card);
  return (
    <span className={`card card-${size} suit-${SUIT_CLASS[s]}${highlight ? " card-hl" : ""}`} role="img" aria-label={cardLongName(card)} data-card={card}>
      <span className="card-face" key={card}>
        <span className="card-index">
          <span className="card-rank">{RANKS[r]}</span>
          <span className="card-suit">{SUITS[s]}</span>
        </span>
        <span className="card-pip" aria-hidden="true">{SUITS[s]}</span>
        <span className="card-corner" aria-hidden="true">{RANKS[r]}</span>
      </span>
    </span>
  );
}
