import { defineConfig } from "vitest/config";

// End-to-end suite: starts its own gnodev (master build), so files run one at a time.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    globalSetup: ["e2e/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30 * 60_000,
    hookTimeout: 5 * 60_000,
    reporters: ["verbose"],
  },
});
