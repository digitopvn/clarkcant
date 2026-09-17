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
/**
 * Dedicated ports for this suite.
 *
 * They are deliberately not the ports a developer runs the app on. Sharing them meant the
 * only way to run the browser suite was to stop the dev servers first, and reusing whatever
 * happened to answer on the port was worse: Playwright will happily adopt a server pointed at
 * a different data directory, so the suite ran against the dev node and failed on a missing
 * identity file — which reads like a test bug rather than the wrong server. Override with
 * `CC_E2E_NODE_PORT` and `CC_E2E_WEB_PORT` when those ports are taken.
 */
const NODE_PORT = Number(process.env.CC_E2E_NODE_PORT ?? 8876);
const WEB_PORT = Number(process.env.CC_E2E_WEB_PORT ?? 4273);

// Published so a test can point the client at the node this run started, rather than at the
// default the client would otherwise assume.
process.env.CC_E2E_NODE_PORT = String(NODE_PORT);
process.env.CC_E2E_WEB_PORT = String(WEB_PORT);

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
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // A synthetic microphone and an auto-accepted permission prompt. Without these the voice
          // spec cannot run at all in CI, and a voice feature verified only by hand is a voice
          // feature verified only when someone remembers to.
          args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
        },
      },
    },
  ],
  webServer: [
    {
      // CC_VOICE_FIXTURE loads a scripted voice provider, so the browser-to-node path is exercised
      // for real without a provider account and without spending quota on every run. The adapter
      // that talks to the real provider is covered by unit tests instead, which is the only way
      // those two things can both be true.
      command: `CC_VOICE_FIXTURE=1 node apps/runtime/src/main.ts --data-dir ${DATA_DIR} --port ${NODE_PORT} --label e2e-node`,
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
