import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

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
 *
 * And a send still in flight from the conversation that was left ends without touching the new one: a reply running
 * there keeps its Stop button.
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
  // The node's own suggestions are pinned to empty, so the four written chips are the ones on screen.
  //
  // This suite is about those chips - it clicks one by its text and expects what that chip opens. Once the node
  // can offer suggestions drawn from what a person was actually doing, which chips appear depends on what
  // happens to be in .data/e2e, so a test clicking a chip by text would be testing the database.
  await page.route("**/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
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
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
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

test("a send from the conversation left behind does not end the reply running in the new one", async ({ page }) => {
  await openApp(page);
  // The first message's stream is held, so it is still in flight when the person starts over.
  let held: Route | undefined;
  await page.route("**/messages/stream", async (route) => {
    if (held === undefined) {
      held = route;
      return;
    }
    await route.continue();
  });
  const composer = page.locator("[data-composer]");
  await composer.fill("xin chào");
  const first = page.waitForRequest((request) => /\/messages\/stream$/u.test(new URL(request.url()).pathname));
  await composer.press("Enter");
  const firstRequest = await first;
  await expect.poll(() => held !== undefined).toBe(true);

  await page.locator('[data-home="true"]').click();
  await expect(page.locator(".cc-empty")).toBeVisible({ timeout: 10_000 });

  // A slow reply in the new conversation.
  await composer.fill("viết một câu trả lời thật dài");
  await composer.press("Enter");
  await expect(page.locator("[data-stop]")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Đoạn 2\./u).first()).toBeVisible({ timeout: 15_000 });

  // The old send now ends. The reply being written is still running, so Stop stays where it is.
  const finished = page.waitForEvent("requestfinished", (request) => request === firstRequest);
  await held?.continue();
  await finished;
  await page.waitForTimeout(500);
  await expect(page.locator("[data-stop]")).toBeVisible();
  await expect(page.locator("[data-send]")).toHaveCount(0);

  await page.locator("[data-stop]").click();
  await expect(page.locator('[data-role="assistant"]').last().locator("[data-model-note]")).toContainText(
    "Đã dừng theo yêu cầu",
    { timeout: 15_000 },
  );
  await expect(page.locator("[data-send]")).toBeVisible();
});
