import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page, type Request } from "@playwright/test";

import { DEFAULT_EXECUTION_POLICY_CONFIG } from "@clarkcant/contracts";

/**
 * Files on the composer when a command answers instead of Clark.
 *
 * A command the host answers ("mở settings", `/thinking high`) carries no files, so the node attaches them to nothing.
 * The composer keeps them for the next message and says why they are still there, rather than clearing them as if
 * they had been sent. Leaving the conversation drops them, through the same restart the header's button runs: they belong
 * to the conversation left behind. A command that does not run, such as a declined delete, leaves them where they were.
 */

const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set; run this suite through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

function token(): string {
  const parsed = JSON.parse(readFileSync(join(process.cwd(), ".data", "e2e", "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("the node's identity file has no local token");
  return parsed.localToken;
}

const NOTE = /Lệnh không mang theo tệp/u;
const FILE = { name: "ghi-chu.md", mimeType: "text/markdown", buffer: Buffer.from("# Ghi chú\nnội dung thử.\n") };

async function openWithFile(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("[data-composer]")).toBeVisible();
  await page.locator("[data-attachment-input]").setInputFiles([FILE]);
  await expect(page.locator('[data-attachment-chip][data-attachment-state="ready"]')).toHaveCount(1);
}

function nextMessage(page: Page): Promise<Request> {
  return page.waitForRequest((request) => request.method() === "POST" && /\/messages\/stream$/u.test(new URL(request.url()).pathname));
}

/** Types into the composer with the keyboard and sends with Enter, answering the request the send made. */
async function say(page: Page, text: string): Promise<Request> {
  const composer = page.locator("[data-composer]");
  await composer.focus();
  await expect(composer).toBeFocused();
  await page.keyboard.type(text);
  const sent = nextMessage(page);
  await page.keyboard.press("Enter");
  const request = await sent;
  await request.response();
  return request;
}

/** The files a message carried; a message with none leaves the field out. */
function attachmentIds(request: Request): unknown {
  return (request.postDataJSON() as { attachmentIds?: unknown }).attachmentIds ?? [];
}

async function openSettingsByTyping(page: Page): Promise<void> {
  const request = await say(page, "mở settings");
  expect(attachmentIds(request)).toHaveLength(1);
  const settings = page.getByRole("dialog", { name: "Cài đặt" });
  await expect(settings).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
}

test("a command that answers keeps the file chip for the next message and says why", async ({ page }) => {
  await openWithFile(page);
  await openSettingsByTyping(page);

  // The chip is still there, ready to send, with the note beside it.
  await expect(page.locator('[data-attachment-chip="ghi-chu.md"]')).toHaveAttribute("data-attachment-state", "ready");
  const note = page.locator("[data-attachments-kept]");
  await expect(note).toHaveText(NOTE);
  await expect(note).toHaveAttribute("role", "status");
  await expect(page.locator("[data-composer]")).toHaveValue("");

  // The next message carries the file, and the chip and note go with it.
  const request = await say(page, "đọc giúp tui tệp này");
  expect(attachmentIds(request)).toHaveLength(1);
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("nội dung thử", { timeout: 20_000 });
  await expect(page.locator("[data-attachment-chip]")).toHaveCount(0);
  await expect(note).toHaveCount(0);
});

test("removing the kept file takes the note with it", async ({ page }) => {
  await openWithFile(page);
  await openSettingsByTyping(page);
  await expect(page.locator("[data-attachments-kept]")).toHaveText(NOTE);

  const remove = page.locator("[data-attachment-remove]");
  await remove.focus();
  await expect(remove).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-attachment-chip]")).toHaveCount(0);
  await expect(page.locator("[data-attachments-kept]")).toHaveCount(0);
});

test("a command that opens a new conversation does not carry the files into it", async ({ page }) => {
  await openWithFile(page);
  await openSettingsByTyping(page);
  await expect(page.locator("[data-attachment-chip]")).toHaveCount(1);
  const before = await page.evaluate(() => sessionStorage.getItem("cc_conversation"));
  expect(before).not.toBeNull();

  await say(page, "về màn hình bắt đầu");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("cc_conversation"))).toBeNull();
  await expect(page.locator("[data-attachment-chip]")).toHaveCount(0);
  await expect(page.locator("[data-attachments-kept]")).toHaveCount(0);

  // The first message of the new conversation carries no file from the one left behind.
  const request = await say(page, "xin chào");
  expect(attachmentIds(request)).toEqual([]);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("cc_conversation"))).not.toBe(before);
});

test("starting over from the header does not carry kept files either", async ({ page }) => {
  await openWithFile(page);
  await openSettingsByTyping(page);
  await expect(page.locator("[data-attachment-chip]")).toHaveCount(1);

  await page.getByRole("button", { name: /Bắt đầu lại/u }).click();
  await expect(page.locator("[data-attachment-chip]")).toHaveCount(0);
  await expect(page.locator("[data-attachments-kept]")).toHaveCount(0);
});

async function setPolicy(request: APIRequestContext, mode: "guarded" | "autonomous"): Promise<void> {
  const result = await request.put(`${GATEWAY}/preferences/execution.policy`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, mode } },
  });
  expect(result.ok()).toBe(true);
}

test("a slash command with a file keeps the chip, and the next message carries it", async ({ page }) => {
  await openWithFile(page);
  try {
    const request = await say(page, "/thinking high");
    expect(attachmentIds(request)).toHaveLength(1);
    // The host answered it: the level changed, and no user message holds the file.
    await expect(page.locator(".cc-row").filter({ hasText: /high/u }).last()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-attachment-block]")).toHaveCount(0);
    await expect(page.locator('[data-attachment-chip="ghi-chu.md"]')).toHaveAttribute("data-attachment-state", "ready");
    await expect(page.locator("[data-attachments-kept]")).toHaveText(NOTE);

    const next = await say(page, "đọc giúp tui tệp này");
    expect(attachmentIds(next)).toHaveLength(1);
    await expect(page.locator("[data-attachment-block]")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator("[data-attachment-chip]")).toHaveCount(0);
  } finally {
    // Back to the model's default, so the rest of the suite runs as it always has.
    await say(page, "/thinking default");
  }
});

test("a delete the person declines keeps the files on the composer", async ({ page, request }) => {
  await setPolicy(request, "guarded");
  try {
    await openWithFile(page);
    const sent = await say(page, "xoá hội thoại này");
    expect(attachmentIds(sent)).toHaveLength(1);
    const question = page.getByRole("region", { name: "Policy yêu cầu xác nhận xoá" });
    await expect(question).toBeVisible();
    await question.getByRole("button", { name: "Giữ hội thoại" }).click();
    await expect(question).toHaveCount(0);

    await expect(page.locator('[data-attachment-chip="ghi-chu.md"]')).toHaveAttribute("data-attachment-state", "ready");
    await expect(page.locator("[data-attachments-kept]")).toHaveText(NOTE);
    expect(await page.evaluate(() => sessionStorage.getItem("cc_conversation"))).not.toBeNull();
  } finally {
    await setPolicy(request, "autonomous");
  }
});