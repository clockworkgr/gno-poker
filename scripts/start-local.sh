#!/usr/bin/env bash
# Starts a local gnodev built from gno master with the poker packages loaded.
#
#   scripts/start-local.sh [--port 26657] [--web 8888 | --no-web] [extra gnodev flags...]
#
# Uses $GNO_MASTER_BIN/gnodev (default <repo>/.gno-bin/gnodev, see scripts/build-gno.sh); the
# released gnodev lacks crypto/modexp. Blocks are produced every second even without
# transactions, so timeouts (counted in blocks) can expire. The premined test1 account
# (mnemonic in packages/bots/src/chain.ts) funds the bots.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${GNO_MASTER_BIN:-$ROOT/.gno-bin}"
PORT=26657 WEB=(-web-listener 127.0.0.1:8888) EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --web) WEB=(-web-listener "127.0.0.1:$2"); shift 2 ;;
    --no-web) WEB=(-no-web); shift ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done
[[ -x "$BIN/gnodev" ]] || { echo "no gnodev at $BIN; run scripts/build-gno.sh or set GNO_MASTER_BIN" >&2; exit 1; }
ROOT_FLAG=()
[[ -n "${GNOROOT:-}" ]] && ROOT_FLAG=(-root "$GNOROOT")
exec "$BIN/gnodev" local -C "$ROOT/contracts" -paths gno.land/r/demo/poker -no-watch \
  -empty-blocks -empty-blocks-interval 1 -node-rpc-listener "127.0.0.1:$PORT" "${WEB[@]}" "${ROOT_FLAG[@]}" "${EXTRA[@]}"
