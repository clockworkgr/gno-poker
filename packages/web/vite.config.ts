import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: true },
  server: {
    port: 5174,
    strictPort: true,
    // The e2e run must not be interrupted by a rebuild of the protocol library.
    watch: process.env.E2E ? { ignored: ["**/packages/protocol/dist/**"] } : {},
  },
  preview: { port: 5174, strictPort: true },
});
