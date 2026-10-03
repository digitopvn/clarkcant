import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * A conversation with several attached files reads none of them until one is downloaded.
 *
 * Opening a conversation used to read every attached file in full, only to give each card its Download link. Here three
 * files are sent in one message and every request the page makes for attachment bytes is counted: none when the
 * conversation opens, one for the card whose Download is pressed, and none for the others. The upload, the authenticated
 * read, the object URL and the browser's download are the production path; the only thing this file substitutes is a
 * node that holds back or refuses one read, to show the loading and failure states.
 *
 * Every file is fabricated here, so nothing on disk can be edited to make it pass.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set; run this suite through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const CONTENT_PATH = /^\/attachments\/([^/]+)\/content$/u;

const FILES = [
  { name: "mot.txt", mimeType: "text/plain", buffer: Buffer.from("tệp thứ nhất\n".repeat(2_000)) },
  { name: "hai.md", mimeType: "text/markdown", buffer: Buffer.from("# Tệp thứ hai\nnội dung.\n".repeat(2_000)) },
  { name: "ba.txt", mimeType: "text/plain", buffer: Buffer.from("tệp thứ ba\n".repeat(2_000)) },
] as const;

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
}

/** Every attachment id whose bytes the page asked the node for, in order. Reset by emptying the array. */
function recordAttachmentReads(page: Page): string[] {
  const reads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== GATEWAY) return;
    const match = CONTENT_PATH.exec(url.pathname);
    if (match !== null) reads.push(decodeURIComponent(match[1] ?? ""));
  });
  return reads;
}

/**
 * Lets one attachment's read wait until the test lets it go, or be refused as a node that cannot read the file would.
 * Every other read goes to the node untouched.
 */
async function controlReads(page: Page): Promise<{ hold: (id: string) => () => void; refuse: (id: string | undefined) => void }> {
  let held: { id: string; until: Promise<void> } | undefined;
  let refused: string | undefined;
  await page.route(
    (url) => url.origin === GATEWAY && CONTENT_PATH.test(url.pathname),
    async (route) => {
      const id = decodeURIComponent(CONTENT_PATH.exec(new URL(route.request().url()).pathname)?.[1] ?? "");
      if (held?.id === id) await held.until;
      if (refused === id) {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "the file could not be read" }) });
        return;
      }
      // A held read the page has since given up on (a stall it timed out) is aborted, and cannot be continued.
      await route.continue().catch(() => undefined);
    },
  );
  return {
    hold: (id) => {
      let release = (): void => undefined;
      held = { id, until: new Promise<void>((resolve) => (release = resolve)) };
      return () => {
        held = undefined;
        release();
      };
    },
    refuse: (id) => {
      refused = id;
    },
  };
}

function card(page: Page, filename: string) {
  return page.locator("[data-attachment-block]").filter({ hasText: filename });
}

async function cardId(page: Page, filename: string): Promise<string> {
  const id = await card(page, filename).getAttribute("data-attachment-id");
  if (id === null || id === "") throw new Error(`the card for ${filename} has no attachment id`);
  return id;
}

async function reopen(page: Page, reads: string[]): Promise<void> {
  reads.length = 0;
  await page.reload();
  await expect(page.locator("[data-composer]")).toBeVisible();
  await expect(page.locator("[data-attachment-block]")).toHaveCount(FILES.length, { timeout: 20_000 });
}

test("attachment cards read no bytes until one is downloaded, then read only that one, once", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: "dark" });
  const reads = recordAttachmentReads(page);
  const node = await controlReads(page);
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("[data-composer]")).toBeVisible();

  await page.locator("[data-attachment-input]").setInputFiles([...FILES]);
  await expect(page.locator('[data-attachment-chip][data-attachment-state="ready"]')).toHaveCount(FILES.length, { timeout: 20_000 });
  await page.locator("[data-composer]").click();
  await page.keyboard.type("xem ba tệp này");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-attachment-block]")).toHaveCount(FILES.length, { timeout: 20_000 });

  // Opened again: every card is drawn with its Download button, and no attachment is read.
  await reopen(page, reads);
  await page.waitForTimeout(1_500);
  expect(reads, "opening the conversation reads no attachment bytes").toEqual([]);
  await expect(page.locator("[data-attachment-download]")).toHaveCount(FILES.length);
  // No URL for the bytes is in the page: not the node's route, and no object URL either until one is asked for.
  const cards = await page.locator("[data-attachment-block]").evaluateAll((elements) => elements.map((element) => element.outerHTML).join(""));
  expect(cards).not.toContain("href=");
  expect(cards).not.toContain("blob:");
  expect(cards).not.toContain("/attachments/");

  // Pressed from the keyboard, the second card says the download is being prepared, keeps the focus, reads its file
  // once, and hands it to the browser's download under its own name.
  const second = card(page, FILES[1].name);
  const secondId = await cardId(page, FILES[1].name);
  const button = second.locator("[data-attachment-download]");
  await expect(button).toHaveAccessibleName(/^(?:Tải về|Download)$/u);
  const release = node.hold(secondId);
  await button.focus();
  expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle), "a focused Download button shows a ring").not.toBe("none");
  const download = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const status = second.locator("[data-attachment-status]");
  await expect(status).toHaveText(/^(?:Đang chuẩn bị tải về…|Preparing the download…)$/u);
  await expect(status).toHaveAttribute("role", "status");
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(button).toBeFocused();
  await expect(second.locator("progress, [role='progressbar']")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("lazy-attachment-preparing-dark.png") });
  // A second press while it is read changes nothing.
  await page.keyboard.press("Enter");
  await expect.poll(() => reads).toEqual([secondId]);
  release();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe(FILES[1].name);
  expect(readFileSync(await saved.path()).equals(FILES[1].buffer), "the downloaded bytes are the file that was attached").toBe(true);
  await expect(status).toHaveText("");
  await expect(button).toHaveAttribute("aria-disabled", "false");
  await expect(button).toBeFocused();
  await page.waitForTimeout(800);
  expect(reads, "only the card that was opened read its file, once").toEqual([secondId]);

  // Downloaded again from the same card: the bytes already read are handed over, with no second read.
  const again = page.waitForEvent("download");
  await button.click();
  expect((await again).suggestedFilename()).toBe(FILES[1].name);
  await page.waitForTimeout(500);
  expect(reads).toEqual([secondId]);

  // A file the node does not give: the card says what failed and what happens next, nothing is downloaded, the focus
  // stays on the button, which now offers to try again. Trying again reads that file once more and downloads it.
  await reopen(page, reads);
  const third = card(page, FILES[2].name);
  const thirdId = await cardId(page, FILES[2].name);
  node.refuse(thirdId);
  let downloads = 0;
  const countDownload = (): void => {
    downloads += 1;
  };
  page.on("download", countDownload);
  const retry = third.locator("[data-attachment-download]");
  await retry.focus();
  await page.keyboard.press("Enter");
  const failure = third.locator("[data-attachment-status]");
  await expect(failure).toHaveAttribute("data-attachment-status", "failed", { timeout: 15_000 });
  // An error, in the error tone, not muted like the size beside it.
  const tones = await third.evaluate((element) => ({
    failure: getComputedStyle(element.querySelector("[data-attachment-status]") as Element).color,
    size: getComputedStyle(element.querySelector(".cc-attachment-size") as Element).color,
  }));
  expect(tones.failure).not.toBe(tones.size);
  await expect(failure).toHaveText(
    /^(?:Không đọc được ba\.txt từ node\. Chưa có gì được tải về và cuộc hội thoại vẫn giữ nguyên; bấm Thử lại để thử lại\.|Could not read ba\.txt from the node\. Nothing was downloaded and the conversation is unchanged; press Try again to retry\.)$/u,
  );
  await expect(retry).toHaveAccessibleName(/^(?:Thử lại|Try again)$/u);
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute("aria-disabled", "false");
  await page.screenshot({ path: testInfo.outputPath("lazy-attachment-failed-dark.png") });
  await page.waitForTimeout(500);
  expect(downloads).toBe(0);
  expect(reads).toEqual([thirdId]);
  page.off("download", countDownload);

  node.refuse(undefined);
  const recovered = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  expect((await recovered).suggestedFilename()).toBe(FILES[2].name);
  await expect(failure).toHaveText("");
  await expect(retry).toHaveAccessibleName(/^(?:Tải về|Download)$/u);
  await expect(retry).toBeFocused();
  expect(reads, "a failed file is read again only because the person asked").toEqual([thirdId, thirdId]);

  // Light theme at a phone's width: a failure sentence wraps inside its card rather than widening the page.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  await reopen(page, reads);
  node.refuse(await cardId(page, FILES[0].name));
  await card(page, FILES[0].name).locator("[data-attachment-download]").click();
  await expect(card(page, FILES[0].name).locator("[data-attachment-status]")).toHaveAttribute("data-attachment-status", "failed", { timeout: 15_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("lazy-attachment-failed-390-light.png") });
  node.refuse(undefined);

  // A node that accepts the read and never starts answering: once the client's 30-second bound on the first response
  // passes, the card fails the same way, and Try again reads the file once more. The page's clock is driven, so the
  // suite does not wait the bound out.
  await reopen(page, reads);
  await page.clock.install();
  const stalled = card(page, FILES[2].name);
  const stalledId = await cardId(page, FILES[2].name);
  const letGo = node.hold(stalledId);
  const stalledButton = stalled.locator("[data-attachment-download]");
  await stalledButton.click();
  const stalledStatus = stalled.locator("[data-attachment-status]");
  await expect(stalledStatus).toHaveAttribute("data-attachment-status", "opening");
  await expect.poll(() => reads).toEqual([stalledId]);
  await page.clock.fastForward(30_000);
  await expect(stalledStatus).toHaveAttribute("data-attachment-status", "failed");
  await expect(stalledButton).toHaveAccessibleName(/^(?:Thử lại|Try again)$/u);
  await expect(stalledButton).toHaveAttribute("aria-disabled", "false");
  letGo();
  const afterStall = page.waitForEvent("download");
  await stalledButton.click();
  expect((await afterStall).suggestedFilename()).toBe(FILES[2].name);
  await expect(stalledStatus).toHaveText("");
  expect(reads, "a stalled read is read again only because the person asked").toEqual([stalledId, stalledId]);
});
