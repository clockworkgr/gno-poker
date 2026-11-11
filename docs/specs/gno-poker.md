# Gno Poker
Status: draft · Date: 2026-11-11

## Summary
A trustless online Texas Hold'em game implemented as a gno realm, using the approach researched in `../pokertests` and partly built in `../casino`: SRA commutative encryption plus a seed-determined shuffle with commit-reveal. Unlike casino, which only relays decks and leaves betting as a stub, this version is a complete playable game: the realm runs the full hand lifecycle, holds ugnot stakes and pays out. It ships with TypeScript bots and a React web UI. It is for players who want poker without a trusted dealer, and for us as an end-to-end proof of the mental-poker design on gno.

## Goals
- Complete hand lifecycle on-chain: shuffle, deal, betting, showdown, payout.
- No-limit Texas Hold'em for 2 to 6 players on persistent cash tables.
- Real stakes in native ugnot, held and paid out by the realm.
- The realm determines the outcome itself, with no modexp in a normal hand.
- A cheater who submits a deck that does not match their committed seed can be proven guilty on-chain and loses their stack.
- Stalling players cannot lock funds.
- Bots that play whole hands, and a web UI humans can play in.

## Non-goals
- Rake or any house fee.
- Other variants (fixed-limit, Omaha, tournaments, sit-and-go).
- Tables above 6 players.
- Hiding folded or mucked cards after a hand.
- An indexer or event-driven client feed.
- A gas relayer or sponsored transactions.
- A pure-gno big-integer fallback for modexp.

## Users and flows
- **Player (web UI)**: connects Adena, joins a table with a ugnot buy-in, plays hands, leaves and cashes out between hands.
- **Bot**: a Node process doing the same through the shared protocol library.
- **Anyone**: may trigger a timeout once a deadline has passed.

Hand flow:
1. Each player commits a seed hash and submits their encrypted, shuffled deck in turn; then each re-keys the deck in turn.
2. Cards are dealt by players sharing the per-card keys needed for each dealt position.
3. Betting rounds follow no-limit rules with blinds and side pots.
4. After the hand every player reveals their seed. The realm derives all cards from the seeds, evaluates hands and computes the payout.
5. Payout is held for a challenge window, then finalized.

## Design

### Realm
- Persistent cash tables: stacks carry across hands, the button rotates, players join free seats, leave and cash out between hands.
- Table creator sets small blind, big blind and min/max buy-in.
- Settlement derives every card from the revealed seeds applied to the public starting deck. No modexp in the normal path.
- Fresh seeds and keys every hand; everything is public after the hand.

### Cryptography
- SRA commutative encryption over one fixed 2048-bit safe prime hardcoded in the realm.
- Cards are encoded as quadratic residues.
- Shuffle order is determined by the committed seed.

### Deck data
- Realm state holds only the latest deck, read by the next player through a query, plus a hash of every pass.
- Challenges carry the relevant cards with Merkle proofs against those hashes.

### Challenges
- Opened during the challenge window by naming a card position in a pass.
- The realm checks that one card with `crypto/modexp` using the accused's revealed secrets.
- Proven mismatch: the hand's bets are refunded and the cheater's whole table stack is split among the other players.
- The challenger posts a bond, lost if the check passes.

### Timeouts
- Gno has no end-blocker, so anyone may call a timeout function after a deadline.
- Stalled bet: auto-check or auto-fold.
- Stalled protocol step (shuffle, key share, seed reveal): hand aborted, staller forfeits to the other players.

### Session keys
- The wallet signs Join and authorizes a browser-generated session key for that table.
- The session key signs protocol and betting transactions and can never withdraw.
- Join carries an extra gas allowance which the realm forwards to the session address.

### Clients
- Bots: plain TypeScript on Node, ported from `casino/bots`.
- Web UI: React + Vite + TypeScript with Adena.
- Both share one protocol library (SRA, shuffle, Merkle, realm calls).
- State is read by polling JSON-returning realm queries; no indexer.

## Decisions
| Decision | Alternatives rejected | Why |
|---|---|---|
| Complete playable game | Realm only; parity port of casino | Proves the whole flow, finishes casino's stubs |
| Hold'em, 2 to 6 players | Heads-up only; up to 9-10 | Real tables without the cost of full ring |
| Seeds decide, modexp only on challenge | Verify everything always; seeds only; void on flag | Zero modexp normally, yet the last-shuffler attack is provable |
| Full reveal after each hand | Reveal on showdown only; keys only | Simplest and fully auditable |
| Cheater loses stack, bonded challenger | No bond; void hand only | Deterrent without free griefing |
| Fixed 2048-bit safe prime, QR card encoding | 1024-bit; player-proposed prime | No weak or composite modulus, no on-chain primality check |
| Latest deck in state, hash per pass | All passes in state; events only | Bounded storage, no indexer needed |
| Phase-dependent timeout penalty | Auto-fold plus refund; none | A refund on stall is a free option after a bad flop |
| Native ugnot buy-in | GRC20; play chips | Matches casino, exercises real payouts |
| Persistent cash table | Sit-and-go; single hand per game | Real poker feel |
| No-limit, blinds, no rake | Rake; fixed-limit | Smallest rule set that is real poker |
| Session key delegated by wallet | Popup per tx; burner only | Playable without leaving funds in a browser key |
| Join forwards gas allowance | Separate funding tx; relayer | One signature, no extra service |
| Poll realm queries | tx-indexer events; both | Runs against a bare node |
| React + Vite + TypeScript | Vue; Svelte | User preference |
| Testnet without modexp: challenges disabled | Wait for modexp; pure-gno bigint | Public demo early |

## Failure modes and recovery
- Player stalls a bet: timeout call auto-checks or auto-folds.
- Player stalls a protocol step or refuses to reveal a seed: timeout call aborts the hand and the staller forfeits.
- Submitted deck does not match the committed seed: challenge, modexp spot-check, slash.
- False challenge: bond lost.
- Network without `crypto/modexp`: challenge path disabled; the last-shuffler attack is open there.
- Observability: realm queries and `Render()`; nothing else in v1.

## Security and privacy
- A commitment proves knowledge of a seed, not that the submitted deck used it; the challenge path is what closes that gap.
- Session keys cannot withdraw; only the wallet account can cash out.
- All cards of a hand, including folded hands and the undealt deck, are public after the hand.
- Real ugnot is at risk on any deployment.

## Testing and acceptance criteria
- Gno unit tests for the rules: hand ranking, side pots, betting state machine, permutation from seed, timeouts.
- Bots (2 to 6) play full hands end to end on gnodev with stacks conserved to the ugnot.
- A cheating bot runs the last-shuffler attack, an honest bot challenges, the realm convicts and slashes; a false challenge loses its bond.
- Cross-language vectors: fixed seeds and keys give identical permutations, card encodings and Merkle roots in gno and TypeScript.

## Rollout
1. Local gnodev built from `../gno` master, where `crypto/modexp` exists. v1 is accepted here.
2. Current public testnet under the user's own namespace. If it lacks `crypto/modexp`, deploy with challenges disabled.
- Rollback: not discussed.

## Assumptions
- Shuffle PRNG is a sha256-based stream, replacing Mulberry32 (pokertests) and Go `math/rand` (casino), so gno and TypeScript agree exactly.
- One 32-byte secret per player per hand; the permutation, the shuffle key and per-card keys are all derived from it by hashing, so a single reveal opens everything.
- The prime is the RFC 3526 2048-bit MODP group.
- Gno has no build flags, so "challenges disabled" is a deploy-time variant of one realm file that does not import `crypto/modexp`.
- "Staller forfeits" means the staller's whole table stack, split among the other players in the hand; other players' bets are refunded.
- The bond may be taken from the challenger's table stack, so a session key can challenge.
- All players may accept a result to skip the rest of the challenge window.
- Deadlines are measured in block height.
- Clients must observe every deck pass as it happens, since only its hash is kept afterwards.
- Development uses placeholder paths `gno.land/r/demo/poker` and `gno.land/p/demo/poker/*`.
- Byte-level protocol details are in `docs/protocol.md`.

## Open questions
- Which namespace and which testnet, exactly?
- Does that testnet have `crypto/modexp`?
- Numeric parameters: action timeout, challenge window, bond size, gas allowance. Provisional defaults are per-table creation parameters.
- Should seat order or shuffle order be randomized to dilute last-shuffler advantage where challenges are disabled?
