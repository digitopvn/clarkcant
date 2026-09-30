import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * "Copy details" on a notice, in a real browser.
 *
 * What the summary says is held by the unit suite (`inbox-model.spec.ts`). What only a browser can prove is the rest: the
 * item is reached by keyboard behind "More", the clipboard really holds the notice's own fields with each hidden or bidi
 * character written as a marker, the result is said in the inbox's live region while focus stays on the button, and a
 * clipboard the browser refuses is said in words with the inbox left open.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");

const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

const COPIED = "Đã sao chép chi tiết thông báo.";
const COPY_FAILED =
  "Không sao chép được: trình duyệt không cho ghi vào bộ nhớ tạm. Hộp thư vẫn mở; bạn có thể bôi đen chữ của thông báo rồi tự sao chép.";

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token in the e2e identity file");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

interface StoredNotice {
  noticeId: string;
  title: string;
  body?: string;
  createdAt: string;
  conversationId?: string;
  subject?: { kind: string; workId?: string; conversationId?: string };
}

/** Background work that leaves a notice of its own, found by the conversation it ran in, as the node stored it. */
async function backgroundNotice(page: Page, text: string): Promise<StoredNotice> {
  const headers = { authorization: `Bearer ${token()}` };
  const created = await page.request.post(`${GATEWAY}/conversations`, { headers, data: { title: "Sao chép chi tiết" } });
  expect(created.ok()).toBe(true);
  const { conversationId } = (await created.json()) as { conversationId: string };
  expect((await page.request.post(`${GATEWAY}/background-sessions`, { headers, data: { conversationId, text } })).ok()).toBe(true);
  let found: StoredNotice | undefined;
  await expect
    .poll(
      async () => {
        const inbox = (await (await page.request.get(`${GATEWAY}/inbox`, { headers })).json()) as { notices: StoredNotice[] };
        found = inbox.notices.find((notice) => notice.conversationId === conversationId);
        return found !== undefined;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  if (found === undefined) throw new Error("the background work left no notice");
  return found;
}

/** Opens the inbox and "More" on one notice by keyboard, then tabs to "Copy details" and returns it, focused. */
async function reachCopyByKeyboard(page: Page, noticeId: string): Promise<{ dialog: Locator; row: Locator; menu: Locator; copy: Locator }> {
  await page.locator("[data-inbox-mark]").click();
  const dialog = page.getByRole("dialog");
  const row = dialog.locator(`[data-inbox-notice="${noticeId}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  const more = row.locator(`[data-inbox-more="${noticeId}"]`);
  const menu = row.locator(`[data-inbox-menu="${noticeId}"]`);
  const copy = menu.locator(`[data-inbox-copy-details="${noticeId}"]`);
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  // Tab through "More" until focus lands on it: it is a real button in the tab order, not a pointer-only control.
  for (let step = 0; step < 20 && !(await copy.evaluate((el) => el === document.activeElement)); step += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(copy).toBeFocused();
  await expect(copy).toHaveText("Sao chép chi tiết");
  return { dialog, row, menu, copy };
}

/** Every text the inbox's live region held, in order, from now on: to tell a new message from the same words left in place. */
async function recordLiveRegion(dialog: Locator): Promise<void> {
  await dialog.locator(".cc-inbox-status [role='status']").evaluate((region) => {
    const seen: string[] = [];
    (window as unknown as { liveRegionSeen: string[] }).liveRegionSeen = seen;
    new MutationObserver(() => seen.push(region.textContent ?? "")).observe(region, { childList: true, characterData: true, subtree: true });
  });
}

const liveRegionSeen = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { liveRegionSeen: string[] }).liveRegionSeen);

test("Copy details puts the notice's own fields on the clipboard, hidden characters as markers, and says so where focus stays", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page);
  // A right-to-left override and a zero-width space in the words the work was asked with, which the title repeats.
  const notice = await backgroundNotice(page, "kiểm tra sao chép \u202Egnp.exe\u200B xong");
  expect(notice.title).toContain("\u202E");
  if (notice.subject?.kind !== "background-work" || notice.subject.workId === undefined) throw new Error("the notice names no background work");

  const { dialog, menu, copy } = await reachCopyByKeyboard(page, notice.noticeId);
  // The live region is in the page before anything is said into it, so a screen reader is already listening.
  const region = dialog.locator(".cc-inbox-status [role='status']");
  await expect(region).toHaveCount(1);
  await expect(region).toHaveText("");
  // Empty, it takes no room in the panel, not even a gap: what follows it starts where the panel's content starts.
  const startsAt = await dialog.locator("[data-inbox-panel]").evaluate((panel) => {
    const next = panel.querySelector(".cc-inbox-status")?.nextElementSibling;
    if (next === null || next === undefined) return Number.NaN;
    return next.getBoundingClientRect().top - panel.getBoundingClientRect().top - Number.parseFloat(getComputedStyle(panel).paddingTop);
  });
  expect(Math.abs(startsAt)).toBeLessThanOrEqual(1);
  await recordLiveRegion(dialog);

  await page.keyboard.press("Enter");
  await expect(dialog.locator('[data-inbox-status="done"]')).toHaveText(COPIED);
  // Nothing on the node changed, so nothing moved: focus is still on the button, "More" is still open.
  await expect(copy).toBeFocused();
  await expect(menu).toBeVisible();

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // The system clipboard may store line breaks its own way (Windows writes CRLF), so lines are split on either.
  const lines = copied.split(/\r?\n/);
  expect(lines[0]).toBe("Thông báo: Việc nền đã xong: kiểm tra sao chép ⟨U+202E⟩gnp.exe⟨U+200B⟩ xong");
  expect(lines).toContain("Nguồn: Việc nền · Kết quả");
  expect(lines).toContain("Mức độ: Thành công");
  expect(lines).toContain(`Thời điểm: ${notice.createdAt}`);
  expect(lines.at(-1)).toBe(`Về: Việc nền · ${notice.subject.workId}`);
  // No character that would reorder or hide text, and nothing the notice does not show: not its id, not its conversation.
  expect(copied).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/);
  expect(copied).not.toContain(notice.noticeId);
  expect(copied).not.toContain(notice.conversationId ?? "no conversation");

  // A second press is a new message, not the same words left in place: the region is emptied, then says it again.
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await liveRegionSeen(page)).filter((text) => text === COPIED).length).toBe(2);
  const seen = await liveRegionSeen(page);
  expect(seen.slice(seen.indexOf(COPIED) + 1)).toContain("");
  await expect(copy).toBeFocused();
});

test("a clipboard the browser refuses is said in words, the inbox stays open, and only the latest press is said", async ({ page }) => {
  await openApp(page);
  const notice = await backgroundNotice(page, "kiểm tra sao chép bị từ chối");
  const { dialog, menu, copy } = await reachCopyByKeyboard(page, notice.noticeId);
  const failed = dialog.locator('[data-inbox-status="failed"]');

  // Refused as a browser refuses without permission or focus.
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Write permission denied.", "NotAllowedError")),
    });
  });
  await page.keyboard.press("Enter");
  await expect(failed).toHaveText(COPY_FAILED);
  await expect(dialog).toBeVisible();
  await expect(menu).toBeVisible();
  await expect(copy).toBeFocused();

  // A write that throws instead of rejecting says the same, rather than leaving the line empty.
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () => {
        throw new DOMException("Document is not focused.", "NotAllowedError");
      },
    });
  });
  await page.keyboard.press("Enter");
  await expect(dialog.locator('[data-inbox-status="done"]')).toHaveCount(0);
  await expect(failed).toHaveText(COPY_FAILED);

  // A page with no clipboard at all (an insecure origin) says the same too.
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
  await page.keyboard.press("Enter");
  await expect(failed).toHaveText(COPY_FAILED);
  await expect(dialog).toBeVisible();

  // A refusal that arrives late does not overwrite what a later press said: the first write is refused after the second
  // has already succeeded.
  await page.evaluate(() => {
    let calls = 0;
    const clipboard = {
      writeText: () => {
        calls += 1;
        return calls === 1
          ? new Promise<void>((_resolve, reject) => setTimeout(() => reject(new DOMException("late", "NotAllowedError")), 600))
          : Promise.resolve();
      },
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  });
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(dialog.locator('[data-inbox-status="done"]')).toHaveText(COPIED);
  await page.waitForTimeout(1_000);
  await expect(dialog.locator('[data-inbox-status="done"]')).toHaveText(COPIED);
  await expect(failed).toHaveCount(0);
});
