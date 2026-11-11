import { defineConfig, devices } from "@playwright/test";

// The e2e tests need a gnodev (built from gno master) serving the poker realm (see README.md):
//   gnodev local -C ../../contracts -paths gno.land/r/demo/poker -no-watch -empty-blocks \
//     -node-rpc-listener 127.0.0.1:46657
// Override the node with E2E_RPC_URL. The dev server is started (or reused) automatically.
const port = Number(process.env.E2E_PORT ?? 5184);

export default defineConfig({
  testDir: "e2e",
  timeout: 15 * 60_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 960 } } }],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    env: { E2E: "1", VITE_DEV_WALLET: "1", VITE_GNO_RPC_URL: process.env.E2E_RPC_URL ?? "http://127.0.0.1:46657", VITE_GNO_CHAIN_ID: process.env.E2E_CHAIN_ID ?? "dev" },
  },
});
