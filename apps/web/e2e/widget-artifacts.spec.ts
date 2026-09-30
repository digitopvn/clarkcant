import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type FrameLocator, type Page } from "@playwright/test";

/**
 * A widget that holds files by reference, from the conversation.
 *
 * The broker, the routes, the frame session and the SDK each have their own tests; this is the journey between them, in
 * a browser, with a widget whose code is a package on disk. The person picks a file in host chrome — never inside the
 * frame — the widget reads it back in bounded chunks, writes a copy, and asks the host to save and attach it. The copy
 * then comes back as a file card the person can open and save.
 *
 * What only this can show: the question is asked outside the frame and answered by the person, a browser saves through
 * its own download, the web says that writing back over the original is a desktop thing, and nothing crossing the bridge
 * in either direction carries a place on disk.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

/** Larger than one read (256 KiB), so the widget has to come back for the rest. ASCII, so every slice is valid text. */
const PICKED_NAME = "bao-cao-lon.txt";
const PICKED_TEXT = `xin chao tu tep lon\n${"dong du lieu 0123456789\n".repeat(12_600)}`;
const COPY_TEXT = PICKED_TEXT.slice(0, 2_000).toUpperCase();

/** What a place on disk looks like in a message: a drive, a home directory, the node's data or blob directories. */
const PLACE = /(?<![A-Za-z])[A-Za-z]:(?:\\\\|\/)|\/(?:Users|home|tmp|var)\/|\.data(?:\\\\|\/)|blobs(?:\\\\|\/)|staging(?:\\\\|\/)|\.part\b/;

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
}

async function say(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill(text);
  await composer.press("Enter");
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/**
 * Every bridge message, recorded on both sides before any page script runs: the page hears what the widget sends, the
 * frame hears what the host answers. Serialized as it arrived, so a path anywhere in a message is found.
 */
async function recordBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = window as unknown as { __ccBridge: string[] };
    probe.__ccBridge = [];
    window.addEventListener("message", (event: MessageEvent) => {
      try {
        probe.__ccBridge.push(JSON.stringify(event.data));
      } catch {
        probe.__ccBridge.push("[unserializable]");
      }
    });
  });
}

async function bridgeMessages(page: Page): Promise<string[]> {
  const outer = await page.evaluate(() => (window as unknown as { __ccBridge?: string[] }).__ccBridge ?? []);
  const element = await page.locator("[data-pin-live] [data-widget-frame] iframe").elementHandle();
  const inner = (await (await element?.contentFrame())?.evaluate(() => (window as unknown as { __ccBridge?: string[] }).__ccBridge ?? [])) ?? [];
  return [...outer, ...inner];
}

async function openFileWidget(page: Page): Promise<FrameLocator> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await say(page, "widget tệp");
  const open = page.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });
  await open.click();
  await expect(page.locator("[data-pin-live] [data-widget-frame]")).toHaveAttribute("data-frame-status", "ready", {
    timeout: 20_000,
  });
  const frame = page.frameLocator("[data-pin-live] [data-widget-frame] iframe");
  await expect(frame.locator("[data-widget-ready]")).toHaveCount(1, { timeout: 20_000 });
  return frame;
}

test("a widget picks through host chrome, reads in chunks, and saves and attaches a copy it wrote", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await recordBridge(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const frame = await openFileWidget(page);

  // The host offered the extension in its init, which the widget can only know from that message.
  await expect(frame.locator("[data-artifact-available='true']")).toHaveCount(1);

  /*
   * The question is the host's, outside the frame. It names the widget asking and the kinds of file in words, and takes
   * the keyboard at its title — so a screen reader starts with who is asking, and Enter cannot pick by accident.
   */
  await frame.locator("[data-artifact-pick]").click();
  const pickPrompt = page.locator("[data-artifact-prompt='pick']");
  await expect(pickPrompt).toBeVisible();
  const pickTitle = pickPrompt.locator("[data-artifact-title]");
  await expect(pickTitle).toBeFocused();
  await expect(pickTitle).toHaveText(/^“.+” xin một tệp$/u);
  await expect(pickPrompt.locator("[data-artifact-accept]")).toContainText("tệp văn bản");
  await expect(pickPrompt.locator("[data-artifact-accept]")).not.toContainText("text/*");
  await page.screenshot({ path: testInfo.outputPath("artifact-pick-1280-dark.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: testInfo.outputPath("artifact-pick-1280-light.png"), fullPage: true });
  expect(await horizontalOverflow(page)).toBe(0);
  await page.emulateMedia({ colorScheme: "dark" });
  // One Tab reaches the choice; the title itself is not a stop in the tab order.
  await page.keyboard.press("Tab");
  await expect(pickPrompt.locator("[data-artifact-choose]")).toBeFocused();

  // Escape is the person saying no, and the widget hears "cancelled", not an error.
  await page.keyboard.press("Escape");
  await expect(pickPrompt).toHaveCount(0);
  await expect(frame.locator("[data-artifact-status='cancelled']")).toHaveCount(1);
  // Escape answered the question and did not also close the surface around it.
  await expect(page.locator("[data-pin-live] [data-widget-frame]")).toBeVisible();

  await frame.locator("[data-artifact-pick]").click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("[data-artifact-prompt='pick'] [data-artifact-choose]").click();
  await (await chooser).setFiles({ name: PICKED_NAME, mimeType: "text/plain", buffer: Buffer.from(PICKED_TEXT) });
  await expect(frame.locator("[data-artifact-status='picked']")).toHaveCount(1, { timeout: 20_000 });
  await expect(frame.locator(`[data-artifact-picked='${PICKED_NAME}']`)).toContainText("external");

  // Read back in bounded chunks: two reads for a file larger than one.
  await frame.locator("[data-artifact-read]").click();
  await expect(frame.locator("[data-artifact-status='read']")).toHaveCount(1, { timeout: 20_000 });
  const readLine = frame.locator("[data-artifact-read-bytes]");
  await expect(readLine).toHaveAttribute("data-artifact-read-bytes", String(Buffer.byteLength(PICKED_TEXT)));
  await expect(readLine).toHaveAttribute("data-artifact-read-chunks", "2");
  await expect(frame.locator("[data-artifact-read-text]")).toHaveAttribute("data-artifact-read-text", PICKED_TEXT.slice(0, 40));

  // A copy the widget writes and fixes.
  await frame.locator("[data-artifact-create]").click();
  await expect(frame.locator("[data-artifact-status='finalized']")).toHaveCount(1, { timeout: 20_000 });
  await expect(frame.locator("[data-artifact-copy='finalized']")).toContainText(`${String(COPY_TEXT.length)} byte`);

  // Save As is the host's. The web says replacing the original is a desktop thing, and saves through the download.
  await frame.locator("[data-artifact-export]").click();
  const savePrompt = page.locator("[data-artifact-prompt='export']");
  await expect(savePrompt).toBeVisible();
  await expect(savePrompt.locator("[data-artifact-web-original]")).toBeVisible();
  await expect(savePrompt.locator("[data-artifact-replace]")).toHaveCount(0);
  await expect(savePrompt.locator("[data-artifact-title]")).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("artifact-save-1280-dark.png"), fullPage: true });
  const download = page.waitForEvent("download");
  await savePrompt.locator("[data-artifact-save]").click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("ban-viet-hoa.txt");
  expect(readFileSync(await saved.path(), "utf8")).toBe(COPY_TEXT);
  await expect(frame.locator("[data-artifact-status='saved']")).toHaveCount(1, { timeout: 20_000 });
  // A browser only starts a download, so the person is told that — not that the file was saved somewhere.
  const notice = page.locator("[data-artifact-notice='info']");
  await expect(notice).toContainText("Đã bắt đầu tải xuống “ban-viet-hoa.txt”");
  await expect(notice).not.toContainText("Đã lưu");

  // Attaching puts the copy in the composer; the person sends it, and the reply reads its content.
  await frame.locator("[data-artifact-attach]").click();
  await expect(frame.locator("[data-artifact-status='attached']")).toHaveCount(1, { timeout: 20_000 });
  const chip = page.locator("[data-attachment-chip]").last();
  await expect(chip).toHaveAttribute("data-attachment-state", "ready");
  await expect(chip).toContainText("ban-viet-hoa.txt");
  await say(page, "đọc tệp này");
  await expect(page.getByText("XIN CHAO TU TEP LON").last()).toBeVisible({ timeout: 20_000 });

  // Nothing that crossed the bridge, in either direction, named a place.
  const messages = await bridgeMessages(page);
  expect(messages.some((message) => message.includes("artifact.request"))).toBe(true);
  expect(messages.some((message) => message.includes("artifact-result"))).toBe(true);
  expect(messages.filter((message) => PLACE.test(message))).toEqual([]);

  expect(await horizontalOverflow(page)).toBe(0);
});

test("the widget's file comes back as a card the person can open and save, in both themes and on a phone", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const frame = await openFileWidget(page);

  // A copy the card can point at: picked, read, written and fixed through the widget as above.
  await frame.locator("[data-artifact-pick]").click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("[data-artifact-prompt='pick'] [data-artifact-choose]").click();
  await (await chooser).setFiles({ name: PICKED_NAME, mimeType: "text/plain", buffer: Buffer.from(PICKED_TEXT) });
  await expect(frame.locator("[data-artifact-status='picked']")).toHaveCount(1, { timeout: 20_000 });
  await frame.locator("[data-artifact-read]").click();
  await expect(frame.locator("[data-artifact-status='read']")).toHaveCount(1, { timeout: 20_000 });
  await frame.locator("[data-artifact-create]").click();
  await expect(frame.locator("[data-artifact-status='finalized']")).toHaveCount(1, { timeout: 20_000 });

  const before = await page.locator("[data-widget-role='file']").count();
  await say(page, "đặt thẻ tệp của widget");
  await expect(page.locator("[data-widget-role='file']")).toHaveCount(before + 1, { timeout: 20_000 });
  const card = page.locator("[data-widget-role='file']").nth(before);
  await expect(card).toContainText("ban-viet-hoa.txt");

  // Open reads the artifact through the node, and shows its text as text.
  const open = card.locator("[data-file-open]");
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(card.locator("[data-file-preview='text'] pre")).toContainText("XIN CHAO TU TEP LON", { timeout: 20_000 });
  await expect(open).toHaveAttribute("aria-expanded", "true");

  // Save As through the browser's own download, named by the node.
  const download = page.waitForEvent("download");
  await card.locator("[data-file-save]").click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("ban-viet-hoa.txt");
  expect(readFileSync(await saved.path(), "utf8")).toBe(COPY_TEXT);
  await expect(card.locator("[data-file-save-state='ok']")).toContainText("Đã bắt đầu tải xuống “ban-viet-hoa.txt”");

  const overflow: Record<string, number> = {};
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme });
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`artifact-file-card-1280-${colorScheme}.png`), fullPage: true });
    overflow[`1280-${colorScheme}`] = await horizontalOverflow(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("artifact-file-card-390-light.png"), fullPage: true });
  overflow["390-light"] = await horizontalOverflow(page);
  const cardBox = await card.boundingBox();
  expect(cardBox === null ? Number.POSITIVE_INFINITY : cardBox.x + cardBox.width).toBeLessThanOrEqual(390);

  testInfo.annotations.push({ type: "horizontal-overflow", description: JSON.stringify(overflow) });
  expect(overflow).toEqual({ "1280-dark": 0, "1280-light": 0, "390-light": 0 });
});

test("the host's file questions fit a phone and both themes", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  const frame = await openFileWidget(page);

  await frame.locator("[data-artifact-pick]").click();
  const pickPrompt = page.locator("[data-artifact-prompt='pick']");
  await expect(pickPrompt).toBeVisible();
  const overflow: Record<string, number> = {};
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await pickPrompt.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`artifact-pick-390-${colorScheme}.png`), fullPage: true });
    overflow[`390-${colorScheme}`] = await horizontalOverflow(page);
  }
  const box = await pickPrompt.boundingBox();
  expect(box === null ? Number.POSITIVE_INFINITY : box.x + box.width).toBeLessThanOrEqual(390);
  await pickPrompt.locator("[data-artifact-cancel]").click();
  await expect(frame.locator("[data-artifact-status='cancelled']")).toHaveCount(1);

  // On a phone the widget's buttons wrap; it asks for its content's height, so its status line is inside the frame.
  const frameBox = await page.locator("[data-pin-live] [data-widget-frame] iframe").boundingBox();
  const statusBox = await frame.locator("[data-artifact-status]").boundingBox();
  expect(frameBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  if (frameBox !== null && statusBox !== null) {
    expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(frameBox.y + frameBox.height);
  }
  await page.locator("[data-pin-live] [data-widget-frame]").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("artifact-widget-390-dark.png"), fullPage: true });

  testInfo.annotations.push({ type: "horizontal-overflow", description: JSON.stringify(overflow) });
  expect(overflow).toEqual({ "390-light": 0, "390-dark": 0 });
});
