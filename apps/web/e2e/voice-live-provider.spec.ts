import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Live-provider test for voice (V17).
 *
 * This test uses the real Gemini Live model to verify that:
 * 1. The model can route a spoken command that does not match the deterministic registry
 * 2. The model decides to call `control_app` with the appropriate intent
 * 3. The app-intent decision reaches the renderer through the same wire frame a click uses
 * 4. The executor (`runAppIntent`) delivers the same result as a header button click
 *
 * This is an opt-in test that requires:
 * - `CC_LIVE_PROVIDER_TEST=1` environment variable on the node
 * - `GEMINI_API_KEY` to be present (either in environment or vault)
 *
 * Unlike the fixture-based tests (`apps/web/e2e/voice-agent-control.spec.ts`), this test
 * proves that a real model (Gemini Live) can understand and route a voice command correctly,
 * which is the missing piece for V17 to move from PARTIAL to PASS.
 *
 * The test is skipped (with a named reason) if the live provider is not available, so it
 * never breaks CI. It is not run by default in `pnpm verify` or `pnpm test:e2e`.
 *
 * Run with: `GEMINI_API_KEY=sk-... CC_LIVE_PROVIDER_TEST=1 pnpm test:live`
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const EVIDENCE = join(process.cwd(), "plans", "reports", "evidence");

const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

/**
 * Names of the things this test looks for before proceeding.
 * These are printed in skip reasons so a reader can tell what is missing.
 */
const LIVE_PROVIDER_TEST_ENV = "CC_LIVE_PROVIDER_TEST";
const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";

function token(): string {
  const path = join(DATA_DIR, "identity.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error(`no local token in ${path}`);
  }
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.route("**/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

async function startConversation(page: Page): Promise<void> {
  await page.locator("[data-suggestion]").first().click();
  await expect(page.locator('[data-role="user"]')).toHaveCount(1, { timeout: 15_000 });
}

/**
 * Script what the live model will be understood to have heard.
 *
 * This sends an utterance to the /voice-live/utterance endpoint for processing by the real Gemini Live
 * model. The model's response determines whether it calls `control_app`.
 *
 * Refused with 404 if the node is not running with CC_LIVE_PROVIDER_TEST=1, which means this test
 * properly fails if run against a node without the test flag explicitly enabled.
 */
async function scriptLiveVoice(request: APIRequestContext, words: string): Promise<void> {
  const response = await request.post(`${GATEWAY}/voice-live/utterance`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { words },
  });
  if (response.status() === 404) {
    throw new Error(
      `Voice live-provider test endpoint not found. Is the node running with ${LIVE_PROVIDER_TEST_ENV}=1?`,
    );
  }
  expect(response.status()).toBe(200);
}

async function openVoice(page: Page): Promise<void> {
  await page.locator('[data-voice-open="true"]').click();
  await expect(page.locator('[data-voice-state="listening"]')).toBeVisible({ timeout: 15_000 });
}

/**
 * The Settings tab that is actually selected. Two ways of opening the panel are the same state when this matches.
 */
async function selectedTab(page: Page): Promise<string | null> {
  return page.locator('[role="tab"][data-selected="true"]').getAttribute("id");
}

// Detect missing preconditions and decide whether to skip the suite
const skipReason = (() => {
  const liveProviderTestEnabled = process.env[LIVE_PROVIDER_TEST_ENV] === "1";
  const hasGeminiKey = process.env[GEMINI_API_KEY_ENV] !== undefined && process.env[GEMINI_API_KEY_ENV] !== "";

  if (!liveProviderTestEnabled) {
    return `${LIVE_PROVIDER_TEST_ENV} is not set to 1. Run with: ${LIVE_PROVIDER_TEST_ENV}=1 pnpm test:live`;
  }
  if (!hasGeminiKey) {
    return `${GEMINI_API_KEY_ENV} is not set. This test requires a real Gemini Live API key to be available in the environment or the node's vault.`;
  }
  return null;
})();

const shouldSkip = skipReason !== null;

test("a spoken settings-open command reaches control_app and lands on the same panel as a click", async ({
  page,
  request,
}) => {
  test.skip(shouldSkip, skipReason ?? undefined);

  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page);
  await startConversation(page);

  // Click Settings first so the two paths are compared against the app's own control.
  const clickedTab = await (async () => {
    await page.locator('[data-settings="true"]').click();
    await expect(page.locator('[role="tabpanel"]')).toBeVisible({ timeout: 10_000 });
    return selectedTab(page);
  })();

  // Go back to conversation and open voice
  await startConversation(page);
  await scriptLiveVoice(request, "mở cài đặt");
  await openVoice(page);

  // Wait for the real model to respond to the spoken command.
  // The model should decide to call `control_app` with `settings.open`.
  // The decision arrives as a `{type: "app-intent"}` wire frame on the voice socket,
  // which runAppIntent handles the same way it handles a click.
  await expect(page.locator('[role="tabpanel"]')).toBeVisible({ timeout: 30_000 });

  const voiceTab = await selectedTab(page);
  expect(voiceTab).toBe(clickedTab);
  await page.screenshot({ path: join(EVIDENCE, "voice-live-01-settings-parity.png"), fullPage: false });
});

test("a spoken home-navigation command reaches control_app", async ({ page, request }) => {
  test.skip(shouldSkip, skipReason ?? undefined);

  await openApp(page);
  await startConversation(page);

  // Click home button first for comparison
  await page.locator('[data-home="true"]').click();

  // Back to conversation and try voice
  await startConversation(page);
  await scriptLiveVoice(request, "quay về màn hình bắt đầu");
  await openVoice(page);

  // The model should understand this and call `control_app` with `nav.home`.
  // This results in a home navigation through `runAppIntent`, same as the click.
  // We assert that a new conversation chip appears (indicating home nav worked).
  await expect(page.locator("[data-suggestion]").first()).toBeVisible({ timeout: 30_000 });
});
