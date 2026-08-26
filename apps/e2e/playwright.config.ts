import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DAEMON_PORT = 47710;
const UI_PORT = 5288;

// Fresh data dir per invocation so tests never see state from a previous run.
const E2E_DATA_DIR = mkdtempSync(join(tmpdir(), "devflow-e2e-data-"));

export default defineConfig({
  testDir: "./tests",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${UI_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `pnpm --filter @devflow/daemon exec tsx src/main.ts`,
      url: `http://127.0.0.1:${DAEMON_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DEVFLOW_DATA_DIR: process.env.DEVFLOW_E2E_DATA_DIR ?? E2E_DATA_DIR,
        DEVFLOW_HTTP_PORT: String(DAEMON_PORT),
        DEVFLOW_LOG_LEVEL: "warn",
        // Deterministic e2e: never let ambient API keys switch the provider off MOCK.
        DEVFLOW_PROVIDER: "MOCK",
      },
    },
    {
      command:
        "pnpm --filter @devflow/desktop exec vite build && pnpm --filter @devflow/desktop exec vite preview --port 5288 --strictPort",
      url: `http://localhost:${UI_PORT}/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
