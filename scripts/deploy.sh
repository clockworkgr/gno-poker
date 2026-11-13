#!/usr/bin/env bash
# Publishes the poker packages with gnokey under a namespace of your choice.
#
#   scripts/deploy.sh --namespace NS --key KEYNAME [--remote HOST:PORT] [--chain-id ID]
#                     [--home GNOKEY_HOME] [--no-modexp] [--no-tests] [--wait] [--dry-run]
#
# The placeholder paths gno.land/p/demo/poker/... and gno.land/r/demo/poker are rewritten to
# gno.land/p/NS/poker/... and gno.land/r/NS/poker in a temporary copy of contracts/ (the sources
# are not modified). Deploy order: cards, holdem, then the realm.
#
# --no-modexp  for networks without crypto/modexp: verify.gno is replaced by verify_nomodexp.gno.txt
#              (challenges disabled, hands finalize at reveal) and *_test.gno files are left out
#              (the tests import crypto/modexp). Implies --no-tests.
# --no-tests   leave out *_test.gno files.
# --wait       after submitting, poll until every package is live (default: do not wait).
# --dry-run    prepare the copy and print the gnokey commands without running them.
#
# All packages are submitted one after the other without waiting for the previous one to go
# live, so a chain that holds new packages for review can review them together. Packages that
# are already live are skipped; a package that is on chain but not live (inert, held for
# review) is submitted again with the current sources. The script can be rerun after a failure. --remote takes host:port or a full http(s) URL.
#
# Environment: GNOKEY (gnokey binary; default $GNO_MASTER_BIN/gnokey, else gnokey on PATH),
#              GAS_WANTED (default 300000000 per package), GAS_FEE (default GAS_WANTED/1000 + 10%),
#              MAX_DEPOSIT (default 50000000ugnot per package).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NS="" KEY="" REMOTE="127.0.0.1:26657" CHAIN_ID="dev" HOME_DIR="" NOMODEXP=0 NOTESTS=0 DRYRUN=0 WAIT=0

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NS="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --remote) REMOTE="$2"; shift 2 ;;
    --chain-id) CHAIN_ID="$2"; shift 2 ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    --no-modexp) NOMODEXP=1; NOTESTS=1; shift ;;
    --no-tests) NOTESTS=1; shift ;;
    --wait) WAIT=1; shift ;;
    --dry-run) DRYRUN=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done
[[ -n "$NS" && -n "$KEY" ]] || { echo "--namespace and --key are required" >&2; usage 1; }
[[ "$NS" =~ ^[a-z][a-z0-9_]*$ ]] || { echo "namespace must be lowercase letters, digits and _" >&2; exit 1; }
# RPC_URL is used for status queries with curl; gnokey takes REMOTE as given.
case "$REMOTE" in http://*|https://*) RPC_URL="$REMOTE" ;; *) RPC_URL="http://$REMOTE" ;; esac

if [[ -z "${GNOKEY:-}" ]]; then
  if [[ -n "${GNO_MASTER_BIN:-}" && -x "$GNO_MASTER_BIN/gnokey" ]]; then GNOKEY="$GNO_MASTER_BIN/gnokey"
  elif [[ -x "$ROOT/.gno-bin/gnokey" ]]; then GNOKEY="$ROOT/.gno-bin/gnokey"
  else GNOKEY="gnokey"; fi
fi
GAS_WANTED="${GAS_WANTED:-300000000}"
GAS_FEE="${GAS_FEE:-$(( GAS_WANTED / 1000 * 11 / 10 ))ugnot}"
MAX_DEPOSIT="${MAX_DEPOSIT:-50000000ugnot}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gno-poker-deploy.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
cp -R "$ROOT/contracts/gno.land" "$WORK/"

if [[ $NOMODEXP -eq 1 ]]; then
  mv "$WORK/gno.land/r/demo/poker/verify_nomodexp.gno.txt" "$WORK/gno.land/r/demo/poker/verify.gno"
else
  rm -f "$WORK/gno.land/r/demo/poker/verify_nomodexp.gno.txt"
fi
if [[ $NOTESTS -eq 1 ]]; then
  find "$WORK/gno.land" \( -name '*_test.gno' -o -name '*_filetest.gno' \) -delete
fi

# Rewrite placeholder paths (imports, gnomod.toml module lines, comments).
find "$WORK/gno.land" -type f \( -name '*.gno' -o -name 'gnomod.toml' \) -print0 |
  xargs -0 perl -pi -e "s#gno\.land/p/demo/poker#gno.land/p/$NS/poker#g; s#gno\.land/r/demo/poker#gno.land/r/$NS/poker#g"
if grep -rq "demo/poker" "$WORK/gno.land"; then
  echo "placeholder paths left after rewrite:" >&2; grep -rn "demo/poker" "$WORK/gno.land" >&2; exit 1
fi

# Prints the package's status on chain ("live", "pending", ...), "none" if it is not there, or
# "unknown" if the node cannot say (older nodes without vm/qpkgmeta_json).
status() {
  curl -s --max-time 20 "$RPC_URL/abci_query?path=%22vm/qpkgmeta_json%22&data=%22$(printf '%s' "$1" | base64 | tr -d '\n')%22" 2>/dev/null |
    python3 -c 'import sys, json, base64
try:
    r = json.load(sys.stdin)["result"]["response"]["ResponseBase"]
    d = base64.b64decode(r["Data"] or b"").decode()
    if d:
        print(json.loads(d).get("status", "unknown"))
    else:
        log = (r.get("Log") or "").lower()
        print("unknown" if "unknown query" in log or "unexpected query" in log else "none")
except Exception:
    print("unknown")'
}

deploy() {
  local dir="$1" path="$2" s
  if [[ $DRYRUN -eq 0 ]]; then
    s="$(status "$path")"
    case "$s" in
      live) echo "==> $path: already live, skipped"; return ;;
      none|absent|unknown) ;;
      *) echo "==> $path: on chain but $s, submitting again" ;;
    esac
  fi
  local cmd=("$GNOKEY" maketx addpkg -pkgdir "$dir" -pkgpath "$path" -gas-wanted "$GAS_WANTED" -gas-fee "$GAS_FEE"
    -max-deposit "$MAX_DEPOSIT" -broadcast -chainid "$CHAIN_ID" -remote "$REMOTE")
  [[ -n "$HOME_DIR" ]] && cmd+=(-home "$HOME_DIR")
  cmd+=("$KEY")
  echo "==> $path ($(ls "$dir" | tr '\n' ' '))"
  if [[ $DRYRUN -eq 1 ]]; then echo "${cmd[*]}"; return; fi
  local rc=0
  if [[ -n "${GNOKEY_PASSWORD+x}" ]]; then
    printf '%s\n' "$GNOKEY_PASSWORD" | "${cmd[@]}" -insecure-password-stdin || rc=$?
  else
    "${cmd[@]}" || rc=$?
  fi
  if [[ $rc -ne 0 ]]; then
    echo "$path was not accepted. If the error is about an import that is not live yet, this chain" >&2
    echo "does not take a package before its dependencies are live: rerun this script once they are." >&2
    exit "$rc"
  fi
}

# Move the tree so that directory names match the new paths.
mkdir -p "$WORK/out/p/$NS" "$WORK/out/r/$NS"
mv "$WORK/gno.land/p/demo/poker" "$WORK/out/p/$NS/poker"
mv "$WORK/gno.land/r/demo/poker" "$WORK/out/r/$NS/poker"

deploy "$WORK/out/p/$NS/poker/cards" "gno.land/p/$NS/poker/cards"
deploy "$WORK/out/p/$NS/poker/holdem" "gno.land/p/$NS/poker/holdem"
deploy "$WORK/out/r/$NS/poker" "gno.land/r/$NS/poker"
[[ $DRYRUN -eq 1 ]] && exit 0

PATHS=("gno.land/p/$NS/poker/cards" "gno.land/p/$NS/poker/holdem" "gno.land/r/$NS/poker")
report() {
  ALL_LIVE=1
  local p s
  for p in "${PATHS[@]}"; do
    s="$(status "$p")"
    echo "    $p: $s"
    [[ "$s" == live || "$s" == unknown ]] || ALL_LIVE=0
  done
}
VARIANT="$([[ $NOMODEXP -eq 1 ]] && echo 'challenges disabled' || echo 'with crypto/modexp challenges')"
echo "submitted ($VARIANT). Status:"
report
if [[ $WAIT -eq 1 ]]; then
  while [[ $ALL_LIVE -eq 0 ]]; do
    sleep 30
    echo "waiting for all packages to be live:"
    report
  done
fi
if [[ $ALL_LIVE -eq 1 ]]; then
  echo "gno.land/r/$NS/poker is live"
else
  echo "not all packages are live yet; rerun this script to see the status (it resubmits whatever is not live)"
fi
