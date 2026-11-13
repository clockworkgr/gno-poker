# gno-poker

Trustless no-limit Texas Hold'em (2 to 6 players) as a gno realm. There is no dealer: players
shuffle and encrypt the deck in turn (SRA commutative encryption over a fixed 2048-bit prime),
deal by publishing per-card keys, and reveal their seeds after the hand. The realm derives every
card from the seeds, evaluates the showdown, and holds and pays out the ugnot stakes. A player whose
submitted deck does not match their seed can be proven guilty on-chain (`crypto/modexp`
spot-check) and loses their stack. Anyone can time out a staller.

- What and why: [docs/specs/gno-poker.md](docs/specs/gno-poker.md)
- Normative protocol and realm API: [docs/protocol.md](docs/protocol.md)

## Layout

| Path | What |
|---|---|
| `contracts/gno.land/p/demo/poker/cards` | Deck encoding, seed derivations, permutation, Merkle proofs |
| `contracts/gno.land/p/demo/poker/holdem` | Betting state machine, hand evaluation, side pots |
| `contracts/gno.land/r/demo/poker` | The realm. `verify.gno` is the only file using `crypto/modexp`; `verify_nomodexp.gno.txt` replaces it on networks without it |
| `packages/protocol` | `@gno-poker/protocol`: TypeScript crypto, deck, Merkle, verifier, `PokerClient`, `HandSession`; `@gno-poker/protocol/gno` adds the gno-js-client adapters |
| `packages/bots` | `@gno-poker/bots`: bot runner, strategies, cheating/stalling modes, CLI, end-to-end tests |
| `packages/web` | React web UI |
| `vectors/vectors.json` | Cross-language test vectors (written by the TypeScript code) |
| `scripts/` | Local node, deploy, gno build and vector tooling |

`gno.land/{p,r}/demo/poker` are placeholder paths; `scripts/deploy.sh` rewrites them.

## Prerequisites

- Node >= 24 and pnpm 12 (`corepack enable`), then `pnpm install`.
- A gno, gnodev and gnokey **built from gno master**: `crypto/modexp`, used by challenges and by the
  gno tests, does not exist in released gno. With a gno checkout next to this repo:

  ```sh
  GNO_SRC=../gno scripts/build-gno.sh   # builds into .gno-bin/
  ```

  Every script and the e2e suite look for the binaries in `$GNO_MASTER_BIN` (default `.gno-bin/`).
  The `gno`/`gnodev` from a release will not do.

## Tests

| Command | What |
|---|---|
| `pnpm test` | TypeScript unit tests (protocol and bots), no chain needed |
| `pnpm test:gno` | `gno test ./...` in `contracts/` with the master `gno` |
| `pnpm test:vectors` | Regenerates `vectors/vectors.json` from TypeScript, turns it into `cards/vectors_gen_test.gno` (`scripts/gen-vectors-gno.ts`) and runs it with gno |
| `pnpm e2e` | End-to-end: starts its own gnodev (master build, RPC port `$E2E_PORT`, default 36657), plays real hands with bots, stops the node |

The e2e suite (`packages/bots/e2e/`) covers: 2, 3 and 6 bots with mixed strategies (money is
checked after every hand: realm balance = sum of stacks, and stacks + cash-outs = buy-ins +
top-ups), the last-shuffler cheat, a bad rekey, a wrong card key, a false challenge, a staller at
each step (bet, shuffle, rekey, key share, reveal) and session keys. Gas per transaction type,
wall-clock and gas per hand per player, and the logs and hand histories are written to
`packages/bots/e2e-results/`. Set `E2E_RPC=http://host:port` to run against an already running
node instead, `E2E_VERBOSE=1` to print hand histories.

## Local node

```sh
scripts/start-local.sh               # RPC 127.0.0.1:26657, gnoweb on 127.0.0.1:8888
scripts/start-local.sh --port 36657 --no-web
```

It loads `contracts/` (the realm at `gno.land/r/demo/poker`) and produces a block every second so
that timeouts, counted in blocks, expire. The premined `test1` account funds the bots.

## Bots

```sh
cd packages/bots
node src/cli.ts run --rpc http://127.0.0.1:26657 --bots 3 --hands 20
node src/cli.ts run --bots 6 --strategies hand-strength,random,calling-station --session
node src/cli.ts create                                     # prints the new table id
node src/cli.ts sit --table 1 --strategy hand-strength     # wait for a human from the web UI
node src/cli.ts tables
node src/cli.ts --help
```

`run` creates a table (or uses `--table`), funds fresh bot keys from the faucet (`test1` by
default, `--faucet-mnemonic` otherwise), seats them and prints a hand history per hand. `--session`
makes the bots join through a session key with a gas allowance; the owner key refills the session
key when it runs low. `sit` seats one bot at an existing table, starts hands as soon as another
player is seated and leaves on Ctrl-C; its hand secrets are kept in `~/.gno-poker-bots/`.
Strategies: `calling-station`, `random` (every legal action, including all-in), `hand-strength`.
Bots started from different processes see each other's hands, but a process only prints the
histories of hands it saw finish. `--cheat last-shuffler|bad-rekey|wrong-card-key` and `--stall bet|shuffle|rekey|keys|reveal` make
the first bot misbehave (tests only).

## Deploy

```sh
scripts/deploy.sh --namespace myname --key mykey --remote rpc.example.org:26657 --chain-id test9
scripts/deploy.sh --namespace myname --key mykey ... --no-modexp   # network without crypto/modexp
```

The script copies `contracts/` to a temporary directory, rewrites the placeholder paths to
`gno.land/p/<namespace>/poker/...` and `gno.land/r/<namespace>/poker`, and publishes cards, holdem
and the realm with `gnokey maketx addpkg` (`--home` for the key directory, `--dry-run` to only
print the commands, `GNOKEY_PASSWORD` to pass the password on stdin). The three packages are
submitted in one run without waiting for each to go live, live packages are skipped and
inert ones (held for review) are submitted again; `--wait` polls until all three are live. `--no-modexp` deploys
`verify_nomodexp.gno.txt` as `verify.gno` and leaves out the `*_test.gno` files: challenges are
disabled and hands finalize at reveal, so the last-shuffler attack is open on such a deployment.
After deploying, `node packages/bots/scripts/deploy-smoke.ts <rpc-url> gno.land/r/<namespace>/poker`
plays three hands against it. Point bots and the UI at the new realm path (`--pkg`).

## Gas and costs

Measured on gnodev from gno master (gas price 1 ugnot per 1000 gas; the fee is charged on gas
wanted, not used):

| Transaction | Gas used | | Transaction | Gas used |
|---|---|---|---|---|
| SubmitShuffle | 74-76M | | RevealSeed | 8-27M (last revealer runs the showdown) |
| SubmitRekey | 74-75M | | Challenge | 28-30M |
| ShareKeys | 7.6-17.4M (grows with players) | | StartHand | 5.8-12.1M |
| Act | 6.6-9.4M | | Timeout | 6.6-7.5M |
| Accept | 5.6-7.6M | | Join / TopUp / Leave | 5-6.5M |

A heads-up hand costs each player about 170-250M gas (0.2-0.3 GNOT in fees) and takes 2-5 s on
gnodev; a 6-player hand about 5-10 s. Storage deposits (100 ugnot per byte) come on top: the first
deck pass of a table stores about 1.4 GNOT worth of state, and each hand's state (about 0.8 GNOT for
6 players) is paid by the players who write it and refunded to whoever starts the next hand, so a
session key needs a few GNOT and occasional refills. `DEFAULT_GAS` in
`packages/protocol/src/client.ts` holds the defaults with headroom.
