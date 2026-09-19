import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Controlling the application by voice, in a real browser.
 *
 * What is real here: Chromium's capture path, the page's own WebSocket to the node, the node's registry and its
 * matching rules, the audit record, the single-use confirmation token, and the one executor in the page that a click
 * also goes through.
 *
 * What is substituted: the provider. The node runs `CC_VOICE_FIXTURE=1`, so the sentence it is understood to have
 * heard is scripted through the fixture route rather than spoken. That route only exists on a node with a scripted
 * provider loaded - it answers 404 otherwise - so a real node has no way to be told what to say.
 *
 * ## What this suite does *not* prove
 *
 * The confirmation step of a spoken quit is proven at the socket seam instead
 * (`apps/runtime/test/voice-gateway.spec.ts`), not here. The fixture emits one utterance per second of audio and has
 * no way to be told to pause, so a journey that had to say a command and then "đồng ý" would be racing the second
 * utterance against the script change. A test that passes on a fast machine and fails on a slow one is worse than no
 * test, so this suite checks the half that is deterministic: that the spoken command asks rather than acts.
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

/** The sentence the node refuses when a command-shaped request matches nothing. Kept in step with the contract. */
const NOT_UNDERSTOOD = "Tôi chưa hiểu câu lệnh đó";

function token(): string {
  const path = join(DATA_DIR, "identity.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error(`no local token in ${path}`);
  }
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

/** Start a conversation, so a voice session has somewhere to record into and to answer. */
async function startConversation(page: Page): Promise<void> {
  await page.locator("[data-suggestion]").first().click();
  await expect(page.locator('[data-role="user"]')).toHaveCount(1, { timeout: 15_000 });
}

/**
 * Script what the node will be understood to have heard.
 *
 * Refused with a 404 on a node with no fixture loaded, which is asserted in the third test rather than assumed: the
 * gate is the point of the route, so it is worth a check of its own.
 */
async function scriptVoice(request: APIRequestContext, words: string): Promise<void> {
  const response = await request.post(`${GATEWAY}/voice-fixture/words`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { words },
  });
  expect(response.status()).toBe(200);
}

/** Open the voice screen and wait until the node has accepted the session and capture is open. */
async function openVoice(page: Page): Promise<void> {
  await page.locator('[data-voice-open="true"]').click();
  await expect(page.locator('[data-voice-state="listening"]')).toBeVisible({ timeout: 15_000 });
}

/** The Settings tab that is actually selected. Two ways of opening the panel are the same state when this matches. */
async function selectedTab(page: Page): Promise<string | null> {
  return page.locator('[role="tab"][data-selected="true"]').getAttribute("id");
}

test("a spoken command and the same click open Settings in the same state", async ({ page, request }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page);
  await startConversation(page);

  // The click first, so the two states are compared against the app's own control rather than against a fixture.
  await page.locator('[data-settings="true"]').click();
  await expect(page.locator('[role="tab"][data-selected="true"]')).toBeVisible({ timeout: 10_000 });
  const afterClick = await selectedTab(page);
  expect(afterClick).toBe("cc-tab-experience");
  await page.keyboard.press("Escape");
  await expect(page.locator('[role="tab"][data-selected="true"]')).toHaveCount(0);

  // The same opening, asked for out loud.
  await scriptVoice(request, "mở settings");
  await openVoice(page);

  await expect(page.locator('[role="tab"][data-selected="true"]')).toBeVisible({ timeout: 20_000 });
  expect(await selectedTab(page)).toBe(afterClick);
  await page.screenshot({ path: join(EVIDENCE, "voice-control-01-settings-by-voice.png"), fullPage: false });
});

test("a spoken tab change lands on the tab that was named", async ({ page, request }) => {
  await openApp(page);
  await startConversation(page);

  // What clicking that tab produces, for comparison.
  await page.locator('[data-settings="true"]').click();
  await page.locator("#cc-tab-extensions").click();
  const afterClick = await selectedTab(page);
  expect(afterClick).toBe("cc-tab-extensions");
  await page.keyboard.press("Escape");

  await scriptVoice(request, "đổi sang tab công cụ");
  await openVoice(page);

  await expect(page.locator("#cc-tab-extensions[data-selected='true']")).toBeVisible({ timeout: 20_000 });
  expect(await selectedTab(page)).toBe(afterClick);
});

test("a spoken quit asks instead of closing anything", async ({ page, request }) => {
  await openApp(page);
  await startConversation(page);

  await scriptVoice(request, "thoát ứng dụng");
  await openVoice(page);

  // The question arrives as the assistant's own sentence, and the application is untouched: the panel is shut, the
  // conversation is still on screen, and nothing was carried out.
  await expect(page.getByText(/xác nhận chứ/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[role="tab"][data-selected="true"]')).toHaveCount(0);
  await expect(page.locator('[data-voice-state="listening"]')).toBeVisible();

  // And the page was handed a question rather than permission: the executor reports that it did nothing.
  await expect(page.locator('[data-intent-notice="true"]')).toContainText("xác nhận", { timeout: 10_000 });
});

test("a command the registry does not know is refused and changes nothing", async ({ page, request }) => {
  await openApp(page);
  await startConversation(page);
  const before = page.url();

  await scriptVoice(request, "mở cửa sổ trời giúp tôi");
  await openVoice(page);

  await expect(page.getByText(NOT_UNDERSTOOD).first()).toBeVisible({ timeout: 20_000 });
  // Nothing happened: no panel, and the application is where it was.
  await expect(page.locator('[role="tab"][data-selected="true"]')).toHaveCount(0);
  expect(page.url()).toBe(before);
});

test("the fixture route is not there unless a scripted provider is loaded", async ({ page, request }) => {
  // The gate, checked rather than trusted. This suite runs against the fixture node, where the route exists; the
  // assertion that it is *unreachable* without one is a unit test on the seam, because a suite cannot start a second
  // kind of node to prove it.
  await openApp(page);
  const refused = await request.post(`${GATEWAY}/voice-fixture/words`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { words: "" },
  });
  expect(refused.status()).toBe(400);
  await expect(page.locator("text=Ready")).toBeVisible();
});
