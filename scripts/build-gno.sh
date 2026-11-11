#!/usr/bin/env bash
# Builds gno, gnokey and gnodev from a gno master checkout into <repo>/.gno-bin (or $GNO_MASTER_BIN).
# crypto/modexp (needed for challenges) only exists on gno master.
#
#   GNO_SRC=../gno scripts/build-gno.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${GNO_SRC:-$ROOT/../gno}"
OUT="${GNO_MASTER_BIN:-$ROOT/.gno-bin}"
[[ -d "$SRC/gnovm" ]] || { echo "gno checkout not found at $SRC (set GNO_SRC)" >&2; exit 1; }
[[ -d "$SRC/gnovm/stdlibs/crypto/modexp" ]] || echo "warning: $SRC has no crypto/modexp; challenges will not build" >&2
mkdir -p "$OUT"
( cd "$SRC/gnovm" && go build -o "$OUT/gno" ./cmd/gno )
( cd "$SRC/gno.land" && go build -o "$OUT/gnokey" ./cmd/gnokey )
( cd "$SRC/contribs/gnodev" && go build -o "$OUT/gnodev" . )
echo "built into $OUT: $(ls "$OUT" | tr '\n' ' ')"
