import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * A node newer than the app, as the screens see it. The node's answers are rewritten on their way to the page: a field
 * the app does not know is added where it reads tolerantly, and a value it does not know where it must refuse, with the
 * node claiming a newer Clark. What only a browser proves is that the inbox and the Memory tab say so.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");

const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const NEWER = "99.0.0";

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error("no local token in the e2e identity file");
  }
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
}

/** The node says it runs a newer Clark than this app. */
async function nodeIsNewer(page: Page): Promise<void> {
  await page.route(`${GATEWAY}/node`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { ...((await answer.json()) as object), clarkVersion: NEWER } });
  });
}

/** Rewrite the node's `GET /inbox` answer; everything else on the route reaches the node as it is. */
async function rewriteInbox(page: Page, change: (inbox: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  await page.route(`${GATEWAY}/inbox`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: change((await answer.json()) as Record<string, unknown>) });
  });
}

async function openInbox(page: Page) {
  await page.locator("[data-inbox-mark]").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openMemory(page: Page): Promise<void> {
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-memory").click();
  await expect(page.locator("#cc-tab-memory")).toHaveAttribute("data-selected", "true");
}

const AT = "2026-10-08T10:00:00.000Z";
const record = { memoryId: "mem_e2e_newer", kind: "preference", scope: "node", text: "Thích câu trả lời ngắn", sourceConversationId: "conv_e2e", at: AT };
const counts = { preference: 1, "project-fact": 0, decision: 0 };

test("the inbox says a newer node sent more than it shows", async ({ page }) => {
  await rewriteInbox(page, (inbox) => ({ ...inbox, digestAt: AT }));
  await openApp(page);
  const dialog = await openInbox(page);
  await expect(dialog.locator('[data-inbox-panel="ready"]')).toBeVisible({ timeout: 10_000 });
  await expect(dialog.locator("[data-inbox-node-newer]")).toContainText("Node này mới hơn ứng dụng này");
});

test("an inbox the app cannot read names the newer Clark and says nothing changed", async ({ page }) => {
  await nodeIsNewer(page);
  await rewriteInbox(page, (inbox) => ({ ...inbox, unread: -1 }));
  await openApp(page);
  const dialog = await openInbox(page);
  const failed = dialog.locator('[data-inbox-failed="true"]');
  await expect(failed).toBeVisible({ timeout: 10_000 });
  await expect(failed).toContainText("chưa có gì thay đổi");
  await expect(failed).toContainText(`Node đang chạy Clark ${NEWER}, mới hơn ứng dụng này`);
  await expect(failed).not.toContainText(/invalid|expected|zod/i);
});

/** A notice only this page sees: added to the node's `GET /inbox` answer, with the actions the test presses. */
function withNotice(notice: Record<string, unknown>): (inbox: Record<string, unknown>) => Record<string, unknown> {
  return (inbox) => ({ ...inbox, notices: [notice, ...(inbox.notices as unknown[])] });
}

test("an update whose answer the app cannot read is neither done nor failed, and points at the inbox", async ({ page }) => {
  const noticeId = "ntc_e2e_update_newer";
  await nodeIsNewer(page);
  await rewriteInbox(
    page,
    withNotice({
      noticeId,
      sourceKind: "package",
      category: "update",
      severity: "info",
      title: "Có bản cập nhật: com.example.newer",
      createdAt: AT,
      readAt: AT,
      subject: { kind: "package", packageId: "com.example.newer", version: "9.9.9", source: "npm" },
      actions: [{ id: "update", placement: "primary" }],
    }),
  );
  // The node took the update and answered with an outcome this app does not know.
  await page.route(`${GATEWAY}/inbox/notices/${noticeId}/actions/update`, (route) =>
    route.fulfill({ json: { noticeId, action: "update", outcome: "staged" } }),
  );
  await openApp(page);
  const dialog = await openInbox(page);
  await dialog.locator(`[data-inbox-update="${noticeId}"]`).click();
  const status = dialog.locator("[data-inbox-status]");
  await expect(status).toHaveAttribute("data-inbox-status", "unknown", { timeout: 10_000 });
  await expect(status).toContainText("Node đã trả lời, nhưng ứng dụng này không đọc được node đã làm gì.");
  await expect(status).toContainText(`Node đang chạy Clark ${NEWER}, mới hơn ứng dụng này`);
  await expect(status).toContainText("Hãy xem hộp thư để biết bản cập nhật đã được cài hay đang chờ bạn phê duyệt.");
});

test("a reconcile whose answer the app cannot read says the node recorded it", async ({ page }) => {
  const noticeId = "ntc_e2e_reconcile_newer";
  const effectId = "eff_e2e_reconcile_newer";
  await nodeIsNewer(page);
  await rewriteInbox(
    page,
    withNotice({
      noticeId,
      sourceKind: "worker",
      category: "alert",
      severity: "warning",
      title: "Chưa rõ thao tác đã có hiệu lực chưa",
      createdAt: AT,
      readAt: AT,
      actions: [
        { id: "reconcile-confirmed", placement: "primary", effectId },
        { id: "reconcile-failed", placement: "secondary", effectId },
      ],
    }),
  );
  // The node recorded the answer and replied with a task outcome this app does not know.
  await page.route(`${GATEWAY}/effects/${effectId}/reconcile`, (route) =>
    route.fulfill({ json: { effectId, taskId: "task_e2e", outcome: "confirmed", taskState: "done", settled: "settled-later", remainingUnknown: 0 } }),
  );
  await openApp(page);
  const dialog = await openInbox(page);
  await dialog.locator(`[data-inbox-reconcile="confirmed"][data-inbox-reconcile-effect="${effectId}"]`).click();
  const status = dialog.locator("[data-inbox-status]");
  await expect(status).toHaveAttribute("data-inbox-status", "done", { timeout: 10_000 });
  await expect(status).toContainText("Node đã ghi nhận câu trả lời của bạn, nhưng ứng dụng này không đọc được phần node trả lời thêm.");
  await expect(status).toContainText(`Node đang chạy Clark ${NEWER}, mới hơn ứng dụng này`);
});

test("the Memory tab says a newer node sent more than it shows", async ({ page }) => {
  await page.route(`${GATEWAY}/memory`, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: { items: [{ ...record, pinned: true }], counts, total: 1 } }) : route.continue(),
  );
  await openApp(page);
  await openMemory(page);
  await expect(page.locator(".cc-memory[data-memory-state='ready']")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-memory-node-newer]")).toContainText("Node này mới hơn ứng dụng này");
});

test("a memory list the app cannot read names the newer Clark", async ({ page }) => {
  await nodeIsNewer(page);
  await page.route(`${GATEWAY}/memory`, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: { items: [record], counts: { ...counts, habit: 0 } } }) : route.continue(),
  );
  await openApp(page);
  await openMemory(page);
  const failed = page.locator("[data-memory-state='failed']");
  await expect(failed).toBeVisible({ timeout: 20_000 });
  await expect(failed).toContainText(`Node đang chạy Clark ${NEWER}, mới hơn ứng dụng này`);
});
