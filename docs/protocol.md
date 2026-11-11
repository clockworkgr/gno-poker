# Gno Poker protocol contract

Normative for the realm, the TypeScript protocol library, the bots and the web UI.
Read with `docs/specs/gno-poker.md`. If an implementation needs to deviate, change this file
first and say so in the hand-off report.

Notation: `||` is byte concatenation, `H` is SHA-256, integers are unsigned big-endian,
`u32be(x)` is 4 bytes, `byte(x)` is 1 byte. ASCII tags are written in quotes, without terminator.

## 1. Group and cards

- `P`: the RFC 3526 2048-bit MODP group (group 14) prime. `Q = (P-1)/2` is prime.
  Tests must assert that `P` and `Q` are probable primes.
- `CARD_LEN = 256` bytes. Every deck element is exactly 256 bytes, big-endian, left-padded.
- `DECK = 52` elements; a serialized deck is 13312 bytes (elements concatenated in position order).
- Card index `c` in 0..51: `rank = c % 13` (0 = Two .. 12 = Ace), `suit = c / 13`
  (0 clubs, 1 diamonds, 2 hearts, 3 spades).
- Plaintext encoding of card `c`:
  `x = H("gno-poker/card/v1" || byte(c) || byte(0)) || ... || H(... || byte(7))` (256 bytes),
  `m_c = (x mod P)^2 mod P`. All `m_c` are quadratic residues with no known multiplicative relations.
- The canonical deck `D_-1` is `[m_0 .. m_51]`.
- A valid deck element `v` satisfies `1 < v < P`. The realm rejects decks with other elements
  or with duplicate elements.
- Base64 (decks and single elements) is the standard alphabet with `=` padding and zero pad bits;
  the realm rejects any other form (whitespace, URL alphabet, missing padding).

## 2. Per-hand secret and derivations

Each player draws one random 32-byte `seed` per hand.

- `commit = H("gno-poker/commit/v1" || seed)`
- Shuffle key: `e = H("gno-poker/shufkey/v1" || seed)`, then `e[0] |= 0x80`, `e[31] |= 0x01`
  (256-bit, odd, so invertible mod `P-1`). `d = e^-1 mod (P-1)`, computed only off-chain.
- Card key for position `i`: `k_i = H("gno-poker/cardkey/v1" || seed || byte(i))`, same two bit tweaks.
- Permutation `perm(seed)`: Fisher-Yates over `a = [0..51]`.
  Stream: blocks `H("gno-poker/perm/v1" || seed || u32be(ctr))` for `ctr = 0, 1, ...`, consumed
  4 bytes at a time as u32 big-endian words.
  For `i = 51` down to `1`: `n = i+1`, `limit = floor(2^32 / n) * n`; draw words until `x < limit`;
  `j = x mod n`; swap `a[i], a[j]`. Result `pi = a`.

## 3. Merkle root of a deck

- 64 leaves. Leaf `i < 52` is `H(0x00 || element_i)`; leaves 52..63 are 32 zero bytes.
- Node is `H(0x01 || left || right)`. Root is the level with one node.
- Proof for index `i`: the 6 sibling hashes from leaf level upward, concatenated (192 bytes).
  At level `l` the sibling is on the right if bit `l` of `i` is 0.
- `CANON_ROOT` is the root of the canonical deck; the realm hardcodes it.

## 4. Hand protocol

Hand players are indexed `0..n-1` in seat order starting with the small blind
(heads-up: the button is the small blind and index 0).

### 4.1 Shuffle (in turn, j = 0..n-1)
Player `j` submits `commit_j` and deck `D_j` where
`D_j[i] = D_{j-1}[pi_j[i]] ^ e_j mod P`. The realm stores `root(D_j)` and `D_j` as the current deck.

### 4.2 Rekey (in turn, j = 0..n-1)
`R_-1 = D_{n-1}`. Player `j` submits `R_j[i] = R_{j-1}[i] ^ (d_j * k_{j,i}) mod P`.
The realm stores `root(R_j)` and `R_j` as the current deck. `F = R_{n-1}` is the final deck:
`F[i] = m_{card(i)} ^ (product over j of k_{j,i})`.

### 4.3 Positions
- Hole cards of hand player `j`: positions `2j` and `2j+1`.
- Board: positions `2n .. 2n+4` (flop = first three, then turn, then river). No burn cards.

### 4.4 Dealing
- Hole deal: every hand player `x` publishes `k_{x,i}` for every hole position `i` that is not their own.
- Flop / turn / river deal: every hand player, folded or not, publishes `k_{x,i}` for those positions.
- A card at position `i` is opened by raising `F[i]` to the inverse of every key on it and matching
  the result against `m_0..m_51`. This happens off-chain only.
- If betting is closed (all but one folded, or no further action possible because of all-ins), the
  remaining deals are skipped and the hand goes straight to reveal.

### 4.5 Reveal and settlement
- Every hand player, folded or not, reveals `seed`. The realm checks `commit`.
- The realm checks every card key published in 4.4 against `k_{x,i}` derived from the seed
  (hash only) inside that player's `RevealSeed`. A wrong key convicts that player at once, exactly
  like a lost challenge (section 5); the hand ends there and the others need not reveal.
- Official card at position `i`: `idx = i; for j = n-1 down to 0: idx = pi_j[idx]`; card index is `idx`.
- The realm evaluates the best five of seven for each non-folded player, builds side pots and
  records the result. Pots are built per contribution level of the live players; folded chips
  fall into the pots, and chips above the largest live contribution form a last pot that only the
  live player(s) at that level can win (uncalled bets return this way). In each pot all odd chips
  go to the first winner clockwise from the button (heads-up: the big blind before the button).
- The hand then enters the challenge window. It is finalized when every hand player has accepted
  or when the window has passed and someone calls finalize. With challenges disabled the hand is
  finalized at once.

## 5. Challenge

Only in the challenge window, only by a hand player. The bond is taken from attached ugnot if any
is sent (must equal the bond), otherwise from the challenger's table stack.

- Kind `shuffle`, accused `j`, index `i`:
  input element `in = D_{j-1}[pi_j[i]]` with proof under `root(D_{j-1})` (`CANON_ROOT` for `j = 0`),
  output element `out = D_j[i]` with proof under `root(D_j)`.
  Guilty iff `in ^ e_j mod P != out`.
- Kind `rekey`, accused `j`, index `i`:
  `in = R_{j-1}[i]` under `root(R_{j-1})` (`root(D_{n-1})` for `j = 0`), `out = R_j[i]` under `root(R_j)`.
  Guilty iff `out ^ e_j mod P != in ^ k_{j,i} mod P`.
- An invalid proof aborts the transaction (nothing changes).
- Guilty: every player's contribution to the hand is returned, the accused's whole stack is split
  equally among the other hand players (remainder to the lowest hand index), the accused is removed
  from the table, the bond is returned (an attached bond is sent back to the calling address; a
  stack bond is simply not taken). The pending showdown result is discarded.
- Not guilty: the bond goes to the accused's table stack; the window continues.
- The accused must not be the challenger. Bonds are settled within the transaction.

## 6. Timeouts

Deadlines are block heights: `deadline = height when the wait began + actionTimeoutBlocks`.
`Timeout` may be called by anyone once the deadline has passed (`height > deadline`).
A wait begins at `StartHand`, after every accepted shuffle, rekey or betting action, and when a
deal step or the reveal starts. In the challenge window (`deadline = start + challengeWindowBlocks`)
`Timeout` acts as `Finalize`.

- Betting: the player to act checks if that is legal, otherwise folds.
- Shuffle, rekey, deal key share, reveal: every player who still owes that step is a staller.
  The hand is aborted, contributions of non-stallers are returned, each staller's whole stack is
  split equally among the non-stalling hand players (remainder to the lowest hand index) and the
  staller is removed from the table.
- "Whole stack" (here and in section 5) is the stack at the start of the hand: the penalized
  player's contribution is refunded first and then taken with the rest of the stack.
- If every hand player stalls, nobody can receive a penalty: all contributions are refunded and all
  of them are removed from the table and paid out.

## 7. Realm API

Package path placeholder: `gno.land/r/demo/poker`. Pure libraries under `gno.land/p/demo/poker/...`.
Bytes cross the API as strings: 32-byte values and proofs as lowercase hex, decks and single
elements as standard base64. Amounts are ugnot as int64. A caller is authorized for a seat if it is
the seat's owner address or its session address; `Join`, `TopUp`, `Leave` are owner only.

Transactions (crossing functions; first parameter is `cur realm`):

| Function | Notes |
|---|---|
| `CreateTable(smallBlind, bigBlind, minBuyIn, maxBuyIn int64, maxPlayers int, actionTimeoutBlocks, challengeWindowBlocks, challengeBond int64) uint64` | 2 <= maxPlayers <= 6 |
| `Join(tableID uint64, session string, gasAllowance int64)` | Payable. Stack = sent - gasAllowance, within buy-in limits. `gasAllowance` is forwarded to `session`. Empty `session` means the owner acts directly and `gasAllowance` must be 0. Only ugnot, only from a direct user call. Takes the lowest free seat. An address (owner or session) may hold at most one seat per table; the session must differ from the owner. Joining during a hand seats the player for the next hand (`waiting`). |
| `TopUp(tableID uint64)` | Payable, between hands, up to max buy-in |
| `Leave(tableID uint64)` | Pays out the stack. During a hand the player is marked leaving and paid when the hand is finalized. |
| `SitOut(tableID uint64)` / `SitIn(tableID uint64)` | Takes effect from the next hand |
| `StartHand(tableID uint64)` | Any seated player; needs no hand in progress and at least 2 active players (not sitting out, not leaving) with a stack of at least the big blind. Moves the button to the next active seat clockwise (lowest active seat for the first hand), posts blinds. Seated players below the big blind are not dealt in. |
| `SubmitShuffle(tableID, handNo uint64, commitHex, deckB64 string)` | |
| `SubmitRekey(tableID, handNo uint64, deckB64 string)` | |
| `ShareKeys(tableID, handNo uint64, keysHex string)` | Concatenated 32-byte keys for the positions this caller owes in the current deal step, ascending position order |
| `Act(tableID, handNo uint64, action string, amount int64)` | `fold`, `check`, `call`, `raise`. For `raise`, `amount` is the player's total bet for the street after the action (also used for an opening bet). A raise or call that uses the whole stack is all-in. `amount` is ignored for other actions. A raise must exceed the current bet (an all-in for no more than the current bet is a `call`) and reach `currentBet + minRaise` unless all-in. A player who already acted on the street may raise again only if the bet grew by at least `minRaise` since their last action, so a short all-in does not reopen the betting unless several add up to a full raise. A full raise sets `minRaise` to its increment. |
| `RevealSeed(tableID, handNo uint64, seedHex string)` | |
| `Accept(tableID, handNo uint64)` | |
| `Challenge(tableID, handNo uint64, accused int, kind string, index int, inB64, inProofHex, outB64, outProofHex string)` | `kind` is `shuffle` or `rekey` |
| `Finalize(tableID uint64)` | After the challenge window |
| `Timeout(tableID uint64)` | Anyone |

Queries (non-crossing, return JSON strings unless noted):

| Function | Notes |
|---|---|
| `ListTables() string` | Array of table summaries: the scalar table fields of `GetTable` except `height`, plus `"seated"` (occupied seats) and `"phase"` (current or last hand, `""` if none) |
| `GetTable(tableID uint64) string` | Full table and current hand state (below) |
| `GetDeck(tableID uint64) string` | Latest deck pass of the current hand as plain base64 (not JSON); `""` before the first pass |
| `ChallengesEnabled() bool` | |
| `Render(path string) string` | Markdown for gnoweb: table list, and one table at `path = "<id>"` |

`GetTable` JSON (all amounts as decimal strings, heights as numbers):

```json
{
  "id": 1, "smallBlind": "1000", "bigBlind": "2000", "minBuyIn": "40000", "maxBuyIn": "200000",
  "maxPlayers": 6, "actionTimeoutBlocks": 30, "challengeWindowBlocks": 30, "challengeBond": "10000",
  "height": 1234, "button": 0, "handNo": 3,
  "seats": [ { "seat": 0, "owner": "g1...", "session": "g1...", "stack": "98000",
               "sittingOut": false, "leaving": false, "waiting": false } , null ],
  "hand": {
    "handNo": 3,
    "phase": "shuffle|rekey|deal_hole|preflop|deal_flop|flop|deal_turn|turn|deal_river|river|reveal|challenge|done",
    "players": [ { "seat": 0, "owner": "g1...", "commit": "hex", "contributed": "2000", "streetBet": "2000",
                   "folded": false, "allIn": false, "acted": false, "canRaise": false,
                   "revealed": false, "accepted": false,
                   "seed": "hex or empty", "keys": { "4": "hex", "5": "hex" } } ],
    "turn": 1, "owing": [1], "deadline": 1264,
    "pot": "3000", "currentBet": "2000", "minRaise": "2000",
    "deckSeq": 2, "roots": ["hex", "hex"],
    "board": [12, 5, 44], "cards": { "0": 17 },
    "result": { "aborted": false, "convicted": [], "stallers": [], "payouts": { "0": "5000" },
                "hands": { "0": "two pair" },
                "challenges": [ { "challenger": 0, "accused": 1, "kind": "shuffle", "index": 3, "guilty": false } ] }
  }
}
```

- `seats` has `maxPlayers` entries, `null` for an empty seat.
- `hand` is `null` when no hand was ever played; the last finished hand stays visible with phase `done`
  until the next one starts.
- `turn` is the hand-player index expected to act in in-turn phases (shuffle, rekey, betting), else -1.
  `owing` lists hand-player indices that still owe the current simultaneous step.
- `deckSeq` counts accepted deck passes (shuffle passes, then rekey passes); `roots[s]` is the root of pass `s`.
- `keys` maps position to the published card key.
- `canRaise` is true when the player may bet or raise now (betting phase, not folded, not all-in,
  chips beyond a call, and the betting is open for them per the `Act` rule on short all-ins).
  It does not depend on whose turn it is.
- `board` and `cards` (position to card index, all 52) are filled by the realm from seeds after reveal
  (`[]` and `{}` before); `board` lists all five board positions even if the hand ended earlier.
- `owing` is filled in deal steps (keys still owed) and in `reveal` (seeds still owed), else `[]`.
- A seat's `stack` excludes chips already contributed to the current hand.
- `result` is `null` until settlement. `convicted` and `stallers` are hand-player indices; `payouts` maps
  hand-player index to the amount settlement adds to that player's stack: pot winnings after a
  showdown (applied when the hand is finalized), or refund plus penalty share after an abort or
  conviction (0 for a penalized player). `hands` names each live player's best hand category. The realm may add further
  informational fields (`hands`, `challenges`); clients ignore unknown fields.
- The deadline has passed when `height > deadline`.

## 8. Client obligations

- Poll `GetTable` at least once per block while in a hand, and fetch `GetDeck` whenever `deckSeq`
  changes, keeping every pass. Only the roots remain on-chain afterwards, and a challenge needs the
  elements.
- After reveal, recompute every pass from the revealed seeds. On the first element that differs,
  send a challenge for that pass and index; otherwise accept.
- If a dealt card does not decode to one of the 52 encodings, keep the hand going (check or fold)
  and challenge after reveal.
- Keep the hand seed in durable local storage until the hand is finalized; losing it is a stall.

## 9. Realm implementation notes

- Non-payable calls reject attached coins.
- Only the latest deck pass is stored, in a per-table slot the next hand overwrites (so its storage
  deposit, about 1.4 GNOT, is paid once per table by the first shuffler of the first hand); roots,
  keys and seeds live in the per-hand state that `StartHand` replaces.
- With challenges disabled (`ChallengesEnabled() == false`) `Challenge` always fails and a hand goes
  from `reveal` straight to `done`.
- Storage deposits follow gno.land rules: the signer of a transaction locks the deposit for the bytes
  it adds and receives the refund for the bytes it frees. Per-hand state (roots, keys, seeds, the
  showdown result: about 0.8 GNOT for 6 players) is therefore paid by the players who write it and
  refunded to whoever calls `StartHand` for the next hand, which replaces it. Clients must keep a
  session key funded beyond the gas fees (bots refill it from the owner).
