#!/usr/bin/env bash
# Deploys the poker packages to the Onyx testnet under the deploying key's address namespace:
#
#   gno.land/p/<g1addr>/poker/cards, gno.land/p/<g1addr>/poker/holdem, gno.land/r/<g1addr>/poker
#
#   scripts/deploy-onyx.sh              # key "mainclock" (g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm)
#   scripts/deploy-onyx.sh --wait       # also poll until all three packages are live
#   scripts/deploy-onyx.sh --dry-run    # stage and print the gnokey commands, send nothing
#   KEY=other scripts/deploy-onyx.sh    # another key; its address becomes the namespace
#
# Environment: KEY (gnokey key name, default mainclock), CHAIN_ID (default onyx-1),
#              REMOTE (default https://rpc.onyx.testnets.gno.land:443),
#              GNOKEY (gnokey binary; default ../gno-shots/tools/bin/gnokey-onyx if present, else
#              gnokey on PATH; it should match the network's release, since a gnokey from a newer
#              gno can sign transactions an older chain cannot decode),
#              GAS_WANTED, GAS_FEE, MAX_DEPOSIT (passed through to deploy.sh).
#
# Test files are left out (they only cost storage deposit). All three packages are submitted in
# one run without waiting for each to go live; live packages are skipped and inert ones
# (held for review) are submitted again, so the script can be rerun. If the chain has no crypto/modexp, the realm is deployed without
# challenges (see deploy.sh --no-modexp); otherwise with them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY="${KEY:-mainclock}"
CHAIN_ID="${CHAIN_ID:-onyx-1}"
REMOTE="${REMOTE:-https://rpc.onyx.testnets.gno.land:443}"
EXPECTED_ADDR="g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm"
DRYRUN=0
PASS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRYRUN=1 ;;
    --wait) PASS+=(--wait) ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 1 ;;
  esac
done

if [[ -z "${GNOKEY:-}" ]]; then
  if [[ -x "$ROOT/../gno-shots/tools/bin/gnokey-onyx" ]]; then GNOKEY="$ROOT/../gno-shots/tools/bin/gnokey-onyx"; else GNOKEY="gnokey"; fi
fi
export GNOKEY

ADDR="$("$GNOKEY" list | awk -v k="$KEY" '$2 == k { for (i = 1; i <= NF; i++) if ($i == "addr:") print $(i + 1) }')"
[[ -n "$ADDR" ]] || { echo "no key named $KEY in the gnokey keybase" >&2; exit 1; }
if [[ "$KEY" == mainclock && "$ADDR" != "$EXPECTED_ADDR" ]]; then
  echo "key mainclock is $ADDR, expected $EXPECTED_ADDR" >&2; exit 1
fi

query() { # query PATH DATA -> decoded response data, empty on error
  curl -s --max-time 20 "$REMOTE/abci_query?path=%22$1%22&data=%22$(printf '%s' "$2" | base64 | tr -d '\n')%22" |
    python3 -c 'import sys, json, base64
try:
    r = json.load(sys.stdin)["result"]["response"]["ResponseBase"]
    print("" if r.get("Error") else base64.b64decode(r["Data"] or b"").decode())
except Exception:
    print("")'
}

NETWORK="$(curl -s --max-time 20 "$REMOTE/status" | python3 -c 'import sys, json
try: print(json.load(sys.stdin)["result"]["node_info"]["network"])
except Exception: print("")')"
[[ "$NETWORK" == "$CHAIN_ID" ]] || { echo "$REMOTE reports chain '$NETWORK', expected $CHAIN_ID" >&2; exit 1; }

BALANCE="$(curl -s --max-time 20 "$REMOTE/abci_query?path=%22bank/balances/$ADDR%22" | python3 -c 'import sys, json, base64
try: print(base64.b64decode(json.load(sys.stdin)["result"]["response"]["ResponseBase"]["Data"] or b"").decode().strip("\""))
except Exception: print("")')"

EXTRA=(--no-tests)
if query vm/qfile crypto/modexp | grep -q 'modexp.gno'; then
  MODE="with challenges (crypto/modexp is available)"
else
  MODE="WITHOUT challenges (no crypto/modexp on this chain)"
  EXTRA=(--no-modexp)
fi
[[ $DRYRUN -eq 1 ]] && EXTRA+=(--dry-run)
[[ ${#PASS[@]} -gt 0 ]] && EXTRA+=("${PASS[@]}")

echo "chain:     $CHAIN_ID ($REMOTE)"
echo "key:       $KEY ($ADDR), balance ${BALANCE:-unknown}"
echo "realm:     gno.land/r/$ADDR/poker, $MODE"
echo "gnokey:    $GNOKEY"

if [[ $DRYRUN -eq 0 && -z "${GNOKEY_PASSWORD+x}" ]]; then
  read -r -s -p "Password for key $KEY: " GNOKEY_PASSWORD </dev/tty
  echo
  export GNOKEY_PASSWORD
fi

"$ROOT/scripts/deploy.sh" --namespace "$ADDR" --key "$KEY" --remote "$REMOTE" --chain-id "$CHAIN_ID" "${EXTRA[@]}"

if [[ $DRYRUN -eq 0 ]]; then
  echo
  echo "Web UI:  cd packages/web && pnpm dev --mode onyx     (settings in packages/web/.env.onyx)"
  echo "Bots:    node packages/bots/src/cli.ts tables --rpc $REMOTE --pkg gno.land/r/$ADDR/poker"
fi
