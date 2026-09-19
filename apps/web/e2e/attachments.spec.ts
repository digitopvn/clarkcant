import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { ATTACHMENT_LIMITS } from "@clarkcant/contracts";

/**
 * Attaching files, in a real browser.
 *
 * This is the half a person sees: the chip, the refusal, the send, and the timeline afterwards — including
 * after a reload, which is what separates an attachment that was stored from one that was merely on screen.
 *
 * What this file deliberately does **not** claim is that a file's content reaches the model. The fixture
 * model runs `composeFromIntent` before the model turn and never sees the assembled prompt, so no browser
 * assertion could settle it. That evidence is `apps/runtime/test/attachment-in-turn.spec.ts`, at the adapter
 * seam where the prompt is observable; the two files are the two halves and neither stands alone.
 *
 * Every file here is fabricated on the spot. Nothing reads from disk, so the suite does not depend on a
 * fixture that could be edited later to make it pass.
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

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error("the node's identity file has no local token");
  }
  return parsed.localToken;
}

/** Open the app against the node this run started. The token is never logged or screenshotted. */
async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("[data-composer]")).toBeVisible();
}

/** A one-pixel PNG. Small enough to embed, real enough that a browser decodes it and reports a width. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AP//AAA=";

const TEXT = { name: "ghi-chu.md", mimeType: "text/markdown", buffer: Buffer.from("# Ghi chú\nnội dung thử.\n") };
const IMAGE = { name: "anh.png", mimeType: "image/png", buffer: Buffer.from(PNG_BASE64, "base64") };

/**
 * A file over the ceiling, built once for the whole file.
 *
 * Allocating and sending 26 MB is the slowest thing here, and two tests need it; making the buffer a shared
 * constant means the cost is paid once. Nothing is ever uploaded for it — the client refuses it from the
 * size alone — so the bytes never cross the wire.
 */
const OVERSIZED = {
  name: "to.txt",
  mimeType: "text/plain",
  buffer: Buffer.alloc(ATTACHMENT_LIMITS.maxBytes + 1024, 65),
};

async function attach(page: Page, files: readonly { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
  await page.locator("[data-attachment-input]").setInputFiles([...files]);
}

function chips(page: Page) {
  return page.locator("[data-attachment-chip]");
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("[data-composer]").click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

test("the attach button is enabled and offers a file input", async ({ page }) => {
  await openApp(page);

  await expect(page.locator("[data-attachment-input]")).toHaveCount(1);

  const button = page.locator('button[aria-label="Đính kèm"]');
  await expect(button).toBeEnabled();
  // The old button said the feature did not exist. A disabled control that still explains itself is what a
  // person would find and believe, so both halves are asserted rather than just the enabled state.
  await expect(button).not.toHaveAttribute("disabled", "");
  await expect(button).not.toHaveAttribute("title", "Chưa hỗ trợ đính kèm");

  // And the button opens the picker rather than nothing.
  await expect(button).toHaveAttribute("data-attachment-open", "true");
});

test("two attached files show chips with name, size and state", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page);
  await attach(page, [TEXT, IMAGE]);

  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(0)).toHaveAttribute("data-attachment-state", "ready");
  await expect(chips(page).nth(1)).toHaveAttribute("data-attachment-state", "ready");
  await expect(chips(page).nth(0)).toContainText("ghi-chu.md");
  await expect(chips(page).nth(1)).toContainText("anh.png");
  // A size a person reads: a number with a unit, not a raw byte count. Asserted as a shape rather than by
  // repeating the formatter's rules here, so the test says "this is a size" without becoming a second copy of
  // the code that decides what a size looks like.
  await expect(chips(page).nth(0).locator(".cc-chip-size")).toHaveText(/^\d+(\.\d+)? (B|KB|MB|GB)$/);
  await expect(chips(page).nth(1).locator(".cc-chip-size")).toHaveText(/^\d+(\.\d+)? (B|KB|MB|GB)$/);

  // Captured while composing, in the dark theme the design is drawn in first.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(EVIDENCE, "attachment-01-composer-dark.png") });
});

test("sending stores one attachment block per file in the timeline", async ({ page }) => {
  await openApp(page);
  await attach(page, [TEXT, IMAGE]);
  await expect(chips(page)).toHaveCount(2);
  await send(page, "xem hai tệp này");

  // Two blocks, one per file, in the message the person sent. Counted from the node's own timeline rather
  // than from the screen's optimistic view: the send replaces that view with what was stored.
  await expect(page.locator("[data-attachment-block]")).toHaveCount(2, { timeout: 20_000 });
  await expect(page.locator("[data-attachment-block][data-attachment-kind='image']")).toHaveCount(1);
});

/**
 * The issue's acceptance criterion for this feature, in one journey.
 *
 * "Attach two files, send, and the agent answers using the file's content" is what the issue asks the browser suite
 * to show, and the reload is the other half of it. The model here is the node's fixture, so what this proves is the
 * pipeline rather than a model's judgement: the file reached the node, the node made its content readable, and the
 * answer carries it. The fixture reads through the same helpers the turn's prompt and the `read_attachment` tool use,
 * which is what makes this the production wiring with the provider substituted rather than a second path.
 */
test("the agent answers using the content of an attached file", async ({ page }) => {
  await openApp(page);
  await attach(page, [TEXT, IMAGE]);
  await expect(chips(page)).toHaveCount(2);

  await send(page, "đọc giúp tui tệp này");

  // The text file's content is "# Ghi chú\nnội dung thử.\n". That marker is the part nothing but the file could
  // produce, which is what makes this a claim about the content rather than about the reply's shape.
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("nội dung thử", { timeout: 20_000 });

  // The other half of the criterion: both attachments are still in the timeline after a reload.
  await page.reload();
  await expect(page.locator("[data-composer]")).toBeVisible();
  await expect(page.locator("[data-attachment-block]")).toHaveCount(2, { timeout: 20_000 });
});

test("the attachments are still in the timeline after a reload", async ({ page }) => {
  await openApp(page);
  await attach(page, [TEXT, IMAGE]);
  await send(page, "rồi tải lại xem");
  await expect(page.locator("[data-attachment-block]")).toHaveCount(2, { timeout: 20_000 });

  // A reload with no conversation in memory: everything drawn afterwards comes from the stored message, which
  // is the whole reason the ref is on the block rather than in the tab's state.
  await page.reload();
  await expect(page.locator("[data-composer]")).toBeVisible();
  await expect(page.locator("[data-attachment-block]")).toHaveCount(2, { timeout: 20_000 });
  await expect(page.locator("[data-attachment-block]").nth(1)).toContainText("anh.png");
});

test("the image attachment renders as an image after reload", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page);
  await attach(page, [IMAGE]);
  await send(page, "ảnh này hiện ra chứ");
  await expect(page.locator("[data-attachment-block]")).toHaveCount(1, { timeout: 20_000 });
  await page.reload();

  const image = page.locator("[data-attachment-image='true']");
  await expect(image).toBeVisible({ timeout: 20_000 });
  // A real decode, not a frame with nothing in it: the bytes travelled through the authenticated route and
  // arrived as a blob URL the browser understands. A revoked or empty `src` measures zero here.
  const width = await image.evaluate((node) => (node as HTMLImageElement).naturalWidth);
  expect(width).toBeGreaterThan(0);

  await page.locator('[data-settings="true"]').click();
  await page.locator('[data-theme-choice="light"]').click();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(EVIDENCE, "attachment-02-timeline-light.png") });
});

test("an oversized file is refused on the chip with a stated reason", async ({ page }) => {
  await openApp(page);
  await attach(page, [OVERSIZED]);

  const chip = chips(page).first();
  await expect(chip).toHaveAttribute("data-attachment-state", "failed");
  // The node's own sentence, and it names the number, so the person can act on it rather than guess.
  await expect(chip).toContainText(String(ATTACHMENT_LIMITS.maxBytes));
  // Still on screen with a way to remove it: a chip that vanished would look like a click that did nothing.
  await expect(page.locator("[data-attachment-remove]").first()).toBeVisible();
});

test("a declined type is refused before any request is made", async ({ page }) => {
  let uploads = 0;
  await page.route("**/attachments", async (route) => {
    uploads += 1;
    await route.continue();
  });

  await openApp(page);
  await attach(page, [
    { name: "chay.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ") },
    { name: "hinh.txt", mimeType: "text/plain", buffer: Buffer.from("dữ liệu") },
  ]);

  await expect(chips(page).nth(0)).toHaveAttribute("data-attachment-state", "failed");
  await expect(chips(page).nth(1)).toHaveAttribute("data-attachment-state", "ready");
  // The claim is about the request, not about the chip: a refusal that still uploaded the executable, to have
  // the node refuse it, would have put the file on the network for nothing.
  expect(uploads).toBe(1);

  await page.unroute("**/attachments");
});

test("a chip can be removed before sending", async ({ page }) => {
  await openApp(page);
  await attach(page, [TEXT, IMAGE]);
  await expect(chips(page)).toHaveCount(2);

  await page.locator("[data-attachment-remove]").first().click();
  await expect(chips(page)).toHaveCount(1);

  await page.locator("[data-attachment-remove]").first().click();
  await expect(chips(page)).toHaveCount(0);

  // Nothing was sent, so nothing is in the timeline: removing a chip has to mean the file is not attached.
  await send(page, "không gửi tệp nào");
  await expect(page.locator("[data-attachment-block]")).toHaveCount(0);
});

test("a pasted image becomes a chip", async ({ page }) => {
  await openApp(page);

  // A paste from a clipboard is a file with a type and no name at all, which is the case the name derivation
  // exists for. The event is built inside the page as a real `ClipboardEvent`: `dispatchEvent` with a
  // `clipboardData` init makes an `Event` that happens to carry a property, and a handler reading
  // `clipboardData.files` deserves to be exercised by the shape a browser actually produces.
  await page.evaluate((base64: string) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([bytes], "", { type: "image/png" }));
    const target = document.querySelector("[data-composer-drop]");
    if (target === null) throw new Error("the composer has no drop target");
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
  }, PNG_BASE64);

  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toHaveAttribute("data-attachment-state", "ready");
  await expect(chips(page).first()).toContainText("pasted-");
  await expect(chips(page).first()).toContainText(".png");
});

test("a chip whose upload failed is not sent with the message", async ({ page }) => {
  await openApp(page);
  await attach(page, [TEXT, OVERSIZED]);
  await expect(chips(page).nth(0)).toHaveAttribute("data-attachment-state", "ready");
  await expect(chips(page).nth(1)).toHaveAttribute("data-attachment-state", "failed");

  await send(page, "chỉ gửi tệp hợp lệ");

  // One block, for the file that was stored. The refused file keeps its chip and its explanation, and the
  // message that went out carries neither its bytes nor a reference to them.
  await expect(page.locator("[data-attachment-block]")).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator("[data-attachment-block]").first()).toContainText("ghi-chu.md");
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toHaveAttribute("data-attachment-state", "failed");
});
