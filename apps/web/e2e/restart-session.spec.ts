import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Starting again.
 *
 * The logo returns to the start screen and opens a new session. Two things are worth a browser
 * here, and both are about what happens *after* the click rather than during it:
 *
 *   - the start screen survives a reload, which means the remembered conversation was really
 *     forgotten rather than merely hidden. A restart that left the id in storage would look correct
 *     until the next reload pulled the old conversation back.
 *   - the next message opens a new conversation rather than appending to the one that was left,
 *     which is what "a new session" has to mean.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set; run this through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

/**
 * Start a conversation the account-free way: a scripted suggestion.
 *
 * Waits for the remembered id as well as for the message, because those are two different moments. The
 * message is drawn the instant it is sent — the client no longer waits for the node to echo it back —
 * while the id exists only once the node has created the conversation. Reading session storage as soon
 * as the message appears is racing that round trip, and a test that races is a test that passes on a
 * slow day and fails on a fast one.
 */
async function startConversation(page: Page, suggestion: string): Promise<void> {
  await page.locator(`[data-suggestion='${suggestion}']`).click();
  await expect(page.locator('[data-role="user"]')).toHaveCount(1, { timeout: 15_000 });
  await expect
    .poll(() => page.evaluate(() => window.sessionStorage.getItem("cc_conversation")), { timeout: 15_000 })
    .not.toBeNull();
}

test("the logo returns to the start screen, and the fresh start survives a reload", async ({ page }) => {
  await openApp(page);
  await startConversation(page, "cho tui xem biểu đồ");
  await expect(page.locator(".cc-empty")).toHaveCount(0);

  const remembered = await page.evaluate(() => window.sessionStorage.getItem("cc_conversation"));
  expect(remembered, "the conversation should have been remembered before the restart").not.toBeNull();

  await page.locator('[data-home="true"]').click();

  // Back at the start screen: the empty state is there and the conversation is not.
  await expect(page.locator(".cc-empty")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-role="user"]')).toHaveCount(0);
  await expect(page.locator("[data-suggestion]")).toHaveCount(4);

  // The remembered id is gone, so the restart is not undone by a reload.
  expect(await page.evaluate(() => window.sessionStorage.getItem("cc_conversation"))).toBeNull();
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".cc-empty")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-role="user"]')).toHaveCount(0);
});

test("the next message opens a new conversation rather than continuing the old one", async ({ page }) => {
  await openApp(page);
  await startConversation(page, "cho tui xem biểu đồ");
  const before = await page.evaluate(() => window.sessionStorage.getItem("cc_conversation"));

  await page.locator('[data-home="true"]').click();
  await expect(page.locator(".cc-empty")).toBeVisible({ timeout: 10_000 });

  await startConversation(page, "tạo note nhanh cho tui");
  const after = await page.evaluate(() => window.sessionStorage.getItem("cc_conversation"));

  expect(after).not.toBeNull();
  expect(after, "the second message should have opened a new conversation").not.toBe(before);
  // And the old timeline is not carried into the new one.
  await expect(page.locator('[data-role="user"]')).toHaveCount(1);
  await expect(page.locator(".cc-empty")).toHaveCount(0);
});
