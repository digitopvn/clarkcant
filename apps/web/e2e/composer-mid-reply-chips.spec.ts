import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * Files attached while Clark is still answering.
 *
 * A message takes the files it carried with it when its reply ends. A file the person attached while that reply was
 * being written was not in the message, so it stays on the composer, ready for the next one, instead of vanishing with
 * the reply it had nothing to do with.
 *
 * The reply is the fixture's slow one (a piece every 150 ms), so there is time to attach a file in the middle of it,
 * and Stop ends it the way every stopped turn ends: a stored reply the send waits for.
 */

const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set; run this suite through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const LONG_REPLY = "viết một câu trả lời thật dài";

function token(): string {
  const parsed = JSON.parse(readFileSync(join(process.cwd(), ".data", "e2e", "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("the node's identity file has no local token");
  return parsed.localToken;
}

/** A one-pixel PNG: an image the fixture does not read back, so the message gets the slow reply. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AP//AAA=";
const IMAGE = { name: "anh.png", mimeType: "image/png", buffer: Buffer.from(PNG_BASE64, "base64") };
const TEXT = { name: "ghi-chu.md", mimeType: "text/markdown", buffer: Buffer.from("# Ghi chú\nnội dung thử.\n") };

function nextMessage(page: Page): Promise<Request> {
  return page.waitForRequest((request) => request.method() === "POST" && /\/messages\/stream$/u.test(new URL(request.url()).pathname));
}

function attachmentIds(request: Request): unknown {
  return (request.postDataJSON() as { attachmentIds?: unknown }).attachmentIds ?? [];
}

const chip = (page: Page, name: string) => page.locator(`[data-attachment-chip="${name}"]`);

test("a file attached while the reply is written stays on the composer when that reply ends", async ({ page }) => {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });

  await page.locator("[data-attachment-input]").setInputFiles([IMAGE]);
  await expect(chip(page, "anh.png")).toHaveAttribute("data-attachment-state", "ready");

  const composer = page.locator("[data-composer]");
  await composer.fill(LONG_REPLY);
  const sent = nextMessage(page);
  await composer.press("Enter");
  expect(attachmentIds(await sent)).toHaveLength(1);
  await expect(page.locator("[data-stop]")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Đoạn 3\./u).first()).toBeVisible({ timeout: 15_000 });

  // In the middle of the reply, the person attaches the file for their next message.
  await page.locator("[data-attachment-input]").setInputFiles([TEXT]);
  await expect(chip(page, "ghi-chu.md")).toHaveAttribute("data-attachment-state", "ready");
  await expect(page.locator("[data-stop]")).toBeVisible();

  await page.locator("[data-stop]").click();
  const reply = page.locator('[data-role="assistant"]').last();
  await expect(reply.locator("[data-model-note]")).toContainText("Đã dừng theo yêu cầu", { timeout: 15_000 });
  await expect(page.locator("[data-send]")).toBeVisible();

  // The image went with the message that carried it; the file attached meanwhile is still there, ready.
  await expect(chip(page, "anh.png")).toHaveCount(0);
  await expect(chip(page, "ghi-chu.md")).toHaveAttribute("data-attachment-state", "ready");
  await expect(page.locator("[data-attachments-kept]")).toHaveCount(0);

  // And the next message carries it.
  await composer.fill("đọc giúp tui tệp này");
  const next = nextMessage(page);
  await composer.press("Enter");
  expect(attachmentIds(await next)).toHaveLength(1);
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("nội dung thử", { timeout: 20_000 });
  await expect(page.locator("[data-attachment-chip]")).toHaveCount(0);
});
