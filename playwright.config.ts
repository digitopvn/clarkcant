import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

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
    /*
     * Every test starts as somebody who has already been through the first-run screen.
     *
     * That screen has its own test, which clears this state; the rest of the suite is about what the interface does
     * afterwards, and making each of them walk through it again would be a line of noise in eight spec files instead
     * of one here.
     */
    storageState: {
      cookies: [],
      origins: [{ origin: `http://127.0.0.1:${WEB_PORT}`, localStorage: [{ name: "cc_onboarded", value: "1" }] }],
    },
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
      // `CC_VOICE_FIXTURE` loads a scripted voice provider, so the browser-to-node path is exercised
      // for real without a provider account and without spending quota on every run. The adapter
      // that talks to the real provider is covered by unit tests instead, which is the only way
      // those two things can both be true.
      // `CC_MODEL_FIXTURE` replaces the model turn with a scripted one that composes a real surface
      // through the production pipeline. Two reasons it is set here rather than per-test: a composed
      // surface can only be produced by a turn, so without it the browser path that renders one could
      // never be exercised in CI; and a checked-out `.env` with provider keys in it must not turn
      // every local e2e run into a paid provider call.
      // `CC_SESSION_FIXTURE` answers a project-session request without spawning a worker. Starting
      // one for real needs a provider, takes far longer than a browser assertion should, and would
      // leave a session behind on whatever machine ran the suite.
      //
      // Passed through `env` rather than as a `VAR=value` prefix on the command. The prefix is shell
      // syntax, and this command is run by whatever shell the platform's test runner uses: on Windows
      // that is cmd.exe, which reads `CC_VOICE_FIXTURE=1` as a program name and refuses to start the
      // server at all. The suite was unrunnable there, which is a worse failure than a failing test —
      // it looks like an infrastructure problem and so nobody reads it as a missing verification.
      command: `node apps/runtime/src/main.ts --data-dir ${DATA_DIR} --port ${NODE_PORT} --label e2e-node`,
      env: {
        CC_VOICE_FIXTURE: "1",
        CC_MODEL_FIXTURE: "1",
        CC_SESSION_FIXTURE: "1",
        /*
         * A directory the install journey can resolve against. Without one the route refuses with NO_DIRECTORY, which
         * is the honest answer for a node nobody configured — but it would mean the only install journey a browser
         * could ever walk is the refusal.
         */
        CC_DIRECTORY_INDEX: join(process.cwd(), "apps", "web", "e2e", "fixtures", "directory.json"),
        /*
         * Where the app — and therefore the widget runtime bundle — is served from. A widget document is served by
         * the node but its runtime comes from the app, and the two are different origins in this suite. Without
         * this the injected bootstrap points at the node, where nothing serves that file.
         */
        CC_APP_ORIGIN: `http://127.0.0.1:${WEB_PORT}`,
        /*
         * Where the node may read the widget runtime bundle from. In production the node is deployed with the app it
         * serves; here the suite has just built it, and the frame imports that file from the node so the request is
         * same-origin for an opaque-origin document.
         */
        CC_WEB_DIST: join(process.cwd(), "apps", "web", "dist"),
      },
      url: `http://127.0.0.1:${NODE_PORT}/health`,
      reuseExistingServer: false,
      stdout: "pipe",
    },
    {
      // `corepack pnpm` rather than `pnpm`: the workspace pins pnpm 12 through `packageManager`, and a
      // globally installed older pnpm tries to switch to it and fails when its own managed copy is not
      // present. Going through Corepack asks for the pinned version directly.
      command: `corepack pnpm --filter @clarkcant/app-web run build && corepack pnpm --filter @clarkcant/app-web exec vite preview --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "pipe",
    },
  ],
});
