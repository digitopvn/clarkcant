import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * Two servers are started: the headless node, and a production build of the web client
 * served from `vite preview`. The build is used rather than the dev server on purpose —
 * "it works in dev" is a weaker claim than "the artifact a user would receive works".
 *
 * The node's data directory is fixed so the test can read the bearer token the node
 * generates, which is the only way in.
 */
const DATA_DIR = ".data/e2e";
const NODE_PORT = 8765;
const WEB_PORT = 4173;

export default defineConfig({
  testDir: "./apps/web/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `node apps/runtime/src/main.ts --data-dir ${DATA_DIR} --port ${NODE_PORT} --label e2e-node`,
      url: `http://127.0.0.1:${NODE_PORT}/health`,
      reuseExistingServer: false,
      stdout: "pipe",
    },
    {
      command: `pnpm --filter @clarkcant/app-web run build && pnpm --filter @clarkcant/app-web exec vite preview --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "pipe",
    },
  ],
});
