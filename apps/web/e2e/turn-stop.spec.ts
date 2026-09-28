import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Stopping the reply being written.
 *
 * The claim worth a browser is what the person sees after pressing Stop: the reply stops growing, what it had
 * already written stays on screen with a label saying it was stopped rather than an error, and the composer is
 * ready for the next message. A button that only changed its own glyph would pass none of that.
 *
 * The fixture node has no provider, so the one scripted part is a provider that writes a piece every 150 ms for about
 * a minute. The turn around it is the production model turn, so the stop travels the real route and the real
 * interrupt, and the label is the one every stopped turn ends with.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set; run this through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const LONG_REPLY = "viết một câu trả lời thật dài";

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

async function startLongReply(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill(LONG_REPLY);
  await composer.press("Enter");
  // Send has become Stop, in the same place, and the reply is visibly being written.
  await expect(page.locator("[data-stop]")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Đoạn 3\./).first()).toBeVisible({ timeout: 15_000 });
}

async function expectStoppedAndQuiet(page: Page): Promise<void> {
  const reply = page.locator('[data-role="assistant"]').last();
  await expect(reply.locator("[data-model-note]")).toContainText("Đã dừng theo yêu cầu", { timeout: 15_000 });
  // What was written before the stop is kept, and it is not presented as a failure.
  await expect(reply).toContainText("Đoạn 1.");
  await expect(reply).not.toContainText("Không gọi được model");

  // Nothing arrives after the stop: the provider would have written about seven more pieces in this second.
  const atStop = await reply.innerText();
  await page.waitForTimeout(1_000);
  expect(await reply.innerText()).toBe(atStop);

  // Stop has turned back into Send, and the next message can be written straight away.
  await expect(page.locator("[data-stop]")).toHaveCount(0);
  await expect(page.locator("[data-send]")).toBeVisible();
  await expect(page.locator("textarea[aria-label='Nhập tin nhắn']")).toBeFocused();
}

test("pressing Stop ends the reply, keeps what it wrote with a stopped label, and nothing more arrives", async ({
  page,
}) => {
  await startLongReply(page);
  await page.locator("[data-stop]").click();
  await expectStoppedAndQuiet(page);
});

test("Escape in the composer stops the reply the same way", async ({ page }) => {
  await startLongReply(page);
  await page.locator("textarea[aria-label='Nhập tin nhắn']").press("Escape");
  await expectStoppedAndQuiet(page);
});

test("typing \"dừng lại\" while the reply is being written stops it, and the sentence is not left in the composer", async ({
  page,
}) => {
  await startLongReply(page);
  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.fill("dừng lại");
  await composer.press("Enter");
  await expectStoppedAndQuiet(page);
  await expect(composer).toHaveValue("");
});

test("an ordinary sentence typed while the reply is being written stays in the composer and does not stop it", async ({
  page,
}) => {
  await startLongReply(page);
  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.fill("thêm ví dụ nhé");
  await composer.press("Enter");
  // Still being written, and the sentence is kept for when it ends.
  await expect(page.locator("[data-stop]")).toBeVisible();
  await expect(composer).toHaveValue("thêm ví dụ nhé");
  await page.locator("[data-stop]").click();
  await expect(page.locator("[data-send]")).toBeVisible({ timeout: 15_000 });
  await expect(composer).toHaveValue("thêm ví dụ nhé");
});
