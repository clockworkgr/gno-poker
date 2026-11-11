# @gno-poker/web

React + Vite + TypeScript client for the `gno.land/r/demo/poker` realm.

## Run locally

1. Start a gnodev built from gno master (the realm needs `crypto/modexp`), with empty blocks so
   deadlines advance:

   ```sh
   gnodev local -C ../../contracts -paths gno.land/r/demo/poker -no-watch -empty-blocks \
     -node-rpc-listener 127.0.0.1:46657 -no-web
   ```

2. `pnpm install` at the repo root, then in this package `pnpm dev` and open http://127.0.0.1:5174.
   Defaults come from `.env` (`VITE_GNO_RPC_URL`, `VITE_GNO_CHAIN_ID`, `VITE_POKER_REALM`) and can be
   changed in the app's settings.
3. Connect the development key (test1 mnemonic by default; local use only) or Adena.
4. For opponents: `node dev/autoplayer.ts --table <id> --bots 2` (always check/call; `--auto-start 2`
   deals hands by itself; `--cheat` and `--stall <phase>` exercise challenges and timeouts).

## Checks

- `pnpm typecheck`, `pnpm test` (unit tests), `pnpm build`.
- `pnpm e2e`: Playwright against the gnodev above (override with `E2E_RPC_URL`, `E2E_CHAIN_ID`);
  first run `npx playwright install chromium`. Screenshots land in `e2e/screenshots/`.

## Layout

- `src/chain/`: JSON-RPC client, transaction encoding and signing (no Node built-ins), Adena adapter.
- `src/engine/`: `ProtocolCore` (HandSession per hand, runs in `protocol.worker.ts`), `TableRunner`
  (polling, auto-sent protocol steps, single-flight transactions), IndexedDB store, session keys,
  hand log, status and pot helpers.
- `src/ui/`: lobby, table, action dock, side panel, dialogs.
