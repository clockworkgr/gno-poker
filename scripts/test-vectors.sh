#!/usr/bin/env bash
# Cross-language vectors: regenerate vectors/vectors.json from TypeScript, turn it into a gno test
# (contracts/gno.land/p/demo/poker/cards/vectors_gen_test.gno) and run it with gno master.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${GNO_MASTER_BIN:-$ROOT/.gno-bin}"
cd "$ROOT"
pnpm --filter @gno-poker/protocol vectors
node scripts/gen-vectors-gno.ts
cd contracts && "$BIN/gno" test ./gno.land/p/demo/poker/cards/ -run 'TestGeneratedVectors' -v 2>&1 | grep -E '^(=== RUN|--- (PASS|FAIL)|ok|FAIL)'
