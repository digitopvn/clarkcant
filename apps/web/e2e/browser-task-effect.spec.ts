import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * A browser task's submit that the page never answers, from the press to the person's answer.
 *
 * The scripted sentence stands in for the model and for the dispatch: the fixture model cannot call tools, so it creates
 * the task and its broker itself instead of going through `start_browser_task` and the dispatcher, which have their own
 * node-side tests. The node serves a form whose POST it never answers, the managed browser is the pack's real Playwright
 * driver, and every step goes through the broker a dispatched browser task gets, under the node's own policy. So the
 * unknown row, the task turning uncertain and the inbox notice are written by production calls. What this proves
 * end to end is that the lost submit is heard in the inbox with the browser's own wording, that it was sent once and a
 * second press was refused, and that the answer is the person's: recorded through the inbox, once, and never again.
 *
 * The e2e node is shared by every spec in the run, so the notice is found by the effect it offers to answer.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");

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
    throw new Error("no local token in the e2e identity file");
  }
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

interface ListedNotice {
  noticeId: string;
  title: string;
  body?: string;
  createdAt: string;
  actions?: Array<{ id: string; effectId?: string }>;
}

async function listedNotices(page: Page): Promise<ListedNotice[]> {
  const response = await page.request.get(`${GATEWAY}/inbox`, { headers: { authorization: `Bearer ${token()}` } });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { notices: ListedNotice[] }).notices;
}

test("a submit the page never answers is held as unknown, heard in the inbox, and answered by the person once", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  const before = new Set((await listedNotices(page)).map((notice) => notice.noticeId));

  const composer = page.locator("[data-composer]");
  await composer.fill("thử gửi đơn trên trang không phản hồi");
  await composer.press("Enter");
  // Pressed once, the answer never came, and pressing again was refused: the page received one submission.
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(
    "lần bấm gửi: chưa rõ kết quả; bấm lại: bị từ chối; trang đã nhận 1 lần gửi.",
    { timeout: 60_000 },
  );

  // One new notice, in the browser's words, offering the two answers for the unknown row.
  const fresh = (await listedNotices(page)).filter(
    (notice) => !before.has(notice.noticeId) && notice.actions?.some((action) => action.id === "reconcile-failed") === true,
  );
  expect(fresh).toHaveLength(1);
  const notice = fresh[0];
  if (notice === undefined) throw new Error("the lost submit left no notice offering an answer");
  expect(notice.title).toBe("Chưa rõ một thao tác đã có hiệu lực hay chưa");
  expect(notice.body).toContain("Thao tác bấm “Send application” trên 127.0.0.1:");
  expect(notice.body).not.toContain("““");
  expect(notice.body).toContain("đã được gửi đi nhưng trang không trả lời");
  expect(notice.body).toContain("Hãy kiểm tra trên trang đó");
  const effectId = notice.actions?.find((action) => action.id === "reconcile-failed")?.effectId;
  if (effectId === undefined) throw new Error("the notice names no effect to answer for");

  // The answer is a press in the inbox, the person's own.
  await composer.fill("mở hộp thư");
  await composer.press("Enter");
  const dialog = page.getByRole("dialog");
  const row = dialog.locator(`[data-inbox-notice="${notice.noticeId}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText("trang không trả lời");
  await expect(row.locator(`[data-inbox-reconcile-hint="${notice.noticeId}"]`)).toBeVisible();
  const recorded = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith(`/effects/${effectId}/reconcile`),
  );
  await row.locator(`[data-inbox-reconcile="failed"][data-inbox-reconcile-effect="${effectId}"]`).click();
  expect((await recorded).postDataJSON()).toMatchObject({ outcome: "failed", source: "click" });
  await expect(dialog.locator('[data-inbox-status="done"]')).toContainText("Đã ghi nhận là thao tác chưa có hiệu lực", {
    timeout: 20_000,
  });
  await expect(dialog.locator(`[data-inbox-notice="${notice.noticeId}"]`)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("Send application", { timeout: 20_000 });
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("chưa có hiệu lực");

  // Answered once, for good: a second answer is refused, and the notice does not come back.
  const again = await page.request.post(`${GATEWAY}/effects/${effectId}/reconcile`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { outcome: "confirmed" },
  });
  expect(again.status()).toBe(409);
  expect((await listedNotices(page)).map((listed) => listed.noticeId)).not.toContain(notice.noticeId);
});
