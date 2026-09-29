import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The inbox, in a real browser.
 *
 * The node half — what is waiting is derived from the cards on every read, a decision anywhere clears it everywhere —
 * is covered by the runtime's integration test. What only a browser can prove is the surface: that a pending approval
 * raises the header mark, that the inbox's buttons reach the same decide route as the card and the card shows it, that
 * the mark goes away once nothing is left, and that the panel is a well-behaved modal (Escape, focus back, narrow width).
 *
 * The e2e node is shared by every spec in the run, so another spec may have left something in the inbox. Each test
 * therefore finds its own approval by id rather than asserting that the inbox is otherwise empty.
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

/** Ask for the scripted proposal, wait for its card, and return the approval's id. */
async function propose(page: Page): Promise<string> {
  await page.locator("[data-composer]").fill("chạy lệnh thử");
  await page.locator("[data-send]").click();
  const card = page.locator('[data-host-card="approval"][data-decision="pending"]').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  const id = await card.getAttribute("data-approval-id");
  if (id === null || id === "") throw new Error("the approval card carries no id");
  return id;
}

/** The command approvals the node says are waiting, read as the panel reads them. */
async function waitingApprovalIds(page: Page): Promise<string[]> {
  const response = await page.request.get(`${GATEWAY}/inbox`, { headers: { authorization: `Bearer ${token()}` } });
  const inbox = (await response.json()) as { waiting: Array<{ kind: string; approvalId?: string }> };
  return inbox.waiting.flatMap((item) => (item.kind === "command-approval" && item.approvalId !== undefined ? [item.approvalId] : []));
}

/** Deny every command approval still in the inbox, so a test that follows starts from what it creates. */
async function drainWaiting(page: Page): Promise<void> {
  const response = await page.request.get(`${GATEWAY}/inbox`, { headers: { authorization: `Bearer ${token()}` } });
  expect(response.ok()).toBe(true);
  const inbox = (await response.json()) as {
    waiting: Array<{ kind: string; conversationId?: string; approvalId?: string; operationDigest?: string }>;
  };
  for (const item of inbox.waiting) {
    if (item.kind !== "command-approval") continue;
    await page.request.post(`${GATEWAY}/conversations/${item.conversationId}/approvals/${item.approvalId}/decide`, {
      headers: { authorization: `Bearer ${token()}` },
      data: { decision: "denied", digest: item.operationDigest },
    });
  }
}

/** How many items the node says are waiting, read as the header mark reads them. */
async function waitingCount(page: Page): Promise<number> {
  const response = await page.request.get(`${GATEWAY}/inbox/summary`, { headers: { authorization: `Bearer ${token()}` } });
  return ((await response.json()) as { waiting: number }).waiting;
}

test("a pending approval raises the mark, and denying it from the inbox answers in its conversation", async ({ page }) => {
  await openApp(page);
  const before = await waitingCount(page);
  const approvalId = await propose(page);

  // The mark says something is waiting, and it is the one way to the inbox by pointer. It counts this approval, not
  // whatever an earlier spec left behind.
  const mark = page.locator("[data-inbox-mark]");
  await expect(mark).toHaveAttribute("data-inbox-mark", "waiting", { timeout: 10_000 });
  await expect.poll(async () => Number((await mark.getAttribute("data-inbox-waiting")) ?? "0"), { timeout: 10_000 }).toBe(before + 1);
  await mark.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-inbox-panel="ready"]')).toBeVisible({ timeout: 10_000 });
  // The panel says when it read the inbox, rather than implying that what it shows is live.
  await expect(dialog.locator("[data-inbox-read-at]")).toBeVisible();

  // What will run is shown before the decision, as it is on the card.
  const item = dialog.locator('[data-inbox-waiting-item="command-approval"]').filter({
    has: page.locator(`[data-inbox-deny="${approvalId}"]`),
  });
  await expect(item).toContainText("node -e");

  await item.locator(`[data-inbox-deny="${approvalId}"]`).click();

  // The outcome is said once, in a status line that takes focus, and the decided item leaves the list.
  const status = dialog.locator('[data-inbox-status="done"]');
  await expect(status).toContainText("Đã từ chối", { timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-inbox-status") ?? false)).toBe(true);
  await expect(dialog.locator(`[data-inbox-deny="${approvalId}"]`)).toHaveCount(0);

  // Escape closes the inbox. The conversation behind it has the node's answer to the refusal — the same timeline a
  // refusal on the card itself produces, because it went through the same route.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("Đã từ chối", { timeout: 10_000 });
  // Nothing ran, so there is no receipt.
  await expect(page.locator('[data-tool-name="run_command"]')).toHaveCount(0);
});

test("approving from the inbox runs the command in its conversation", async ({ page }) => {
  await openApp(page);
  await drainWaiting(page);
  const approvalId = await propose(page);

  await page.locator("[data-inbox-mark]").click();
  const dialog = page.getByRole("dialog");
  await dialog.locator(`[data-inbox-approve="${approvalId}"]`).click();
  await expect(dialog.locator('[data-inbox-status="done"]')).toContainText("Đã duyệt", { timeout: 30_000 });
  await page.keyboard.press("Escape");

  // The receipt lands in the conversation that asked, the same one a click on the card would have produced.
  const receipt = page.locator('[data-tool-name="run_command"]').first();
  await expect(receipt).toBeVisible({ timeout: 30_000 });
  await expect(receipt).toContainText("fixture ran");

  // Decided, it is no longer waiting — on the next read, not after some cache expires.
  await expect.poll(() => waitingApprovalIds(page)).not.toContain(approvalId);
});

test("a typed command opens the same inbox, and Escape hands focus back", async ({ page }) => {
  await openApp(page);
  await drainWaiting(page);
  await propose(page);

  const composer = page.locator("[data-composer]");
  await composer.fill("mở hộp thư");
  await composer.press("Enter");

  const dialog = page.getByRole("dialog");
  await expect(dialog.locator('[data-inbox-panel="ready"]')).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator('[data-inbox-waiting-item="command-approval"]').first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // Opened by typing, closing hands focus back to where the typing was.
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-composer") ?? false)).toBe(true);

  // Opened from the mark by keyboard, closing returns focus to the mark rather than dropping it on the page.
  const mark = page.locator("[data-inbox-mark]");
  await mark.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-inbox-mark") ?? false)).toBe(true);

  await drainWaiting(page);
});

test("the inbox fits a narrow window and works with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await drainWaiting(page);
  const approvalId = await propose(page);

  const mark = page.locator("[data-inbox-mark]");
  await expect(mark).toBeVisible({ timeout: 10_000 });
  // The mark stays inside the header at phone width rather than pushing the page sideways.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await mark.click();
  const dialog = page.getByRole("dialog");
  const deny = dialog.locator(`[data-inbox-deny="${approvalId}"]`);
  await expect(deny).toBeVisible({ timeout: 10_000 });
  // Open, the panel does not push the page sideways either.
  const openOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(openOverflow).toBeLessThanOrEqual(0);
  const box = await deny.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);

  await deny.click();
  await expect(dialog.locator('[data-inbox-status="done"]')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("background work that finishes leaves a notice, and the notice leads back to its conversation", async ({ page }) => {
  await openApp(page);
  const headers = { authorization: `Bearer ${token()}` };

  // A second conversation, so "open conversation" has somewhere else to go than the one on screen.
  const created = await page.request.post(`${GATEWAY}/conversations`, { headers, data: { title: "Việc nền" } });
  expect(created.ok()).toBe(true);
  const { conversationId } = (await created.json()) as { conversationId: string };
  const started = await page.request.post(`${GATEWAY}/background-sessions`, {
    headers,
    data: { conversationId, text: "tóm tắt nhật ký hôm nay" },
  });
  expect(started.ok()).toBe(true);

  // The work ends while nobody is looking at it; the node has the notice before the header is asked about it.
  await expect
    .poll(
      async () => {
        const inbox = (await (await page.request.get(`${GATEWAY}/inbox`, { headers })).json()) as {
          notices: Array<{ conversationId?: string }>;
        };
        return inbox.notices.some((notice) => notice.conversationId === conversationId);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  // And the header is where that becomes visible.
  const mark = page.locator("[data-inbox-mark]");
  await expect.poll(async () => Number((await mark.getAttribute("data-inbox-unread")) ?? "0"), { timeout: 20_000 }).toBeGreaterThan(0);
  await mark.click();

  const dialog = page.getByRole("dialog");
  const notice = dialog.locator("[data-inbox-notice]").filter({ hasText: "tóm tắt nhật ký hôm nay" });
  await expect(notice).toBeVisible({ timeout: 10_000 });
  // New is said in words beside the dot, not by the dot's colour alone.
  await expect(notice).toHaveAttribute("data-unread", "true");
  await expect(notice.locator("[data-inbox-unread-label]")).toBeVisible();

  // Opening the notice's conversation switches to it: the reply the background work left is there.
  await notice.locator(`[data-inbox-open-conversation="${conversationId}"]`).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("việc nền đã xong", { timeout: 20_000 });

  // Read, the notice no longer counts as new; the inbox is still one sentence away, whether or not the mark is drawn.
  const composer = page.locator("[data-composer]");
  await composer.fill("mở hộp thư");
  await composer.press("Enter");

  // Reopened, the notice has been read — the panel marked what it showed — and dismissing it removes it.
  const again = page.getByRole("dialog").locator("[data-inbox-notice]").filter({ hasText: "tóm tắt nhật ký hôm nay" });
  await expect(again).toHaveAttribute("data-unread", "false", { timeout: 10_000 });
  // The panel marked everything it showed, so nothing is new any more and the mark stops saying so.
  await expect
    .poll(async () => ((await (await page.request.get(`${GATEWAY}/inbox/summary`, { headers })).json()) as { unread: number }).unread)
    .toBe(0);
  await expect.poll(async () => (await page.locator("[data-inbox-mark]").count()) === 0 || (await page.locator("[data-inbox-mark]").getAttribute("data-inbox-unread")) === "0").toBe(true);
  // A notice about work that went well leads with "Open"; dismissing it is behind "More".
  await again.locator("[data-inbox-more]").click();
  await again.locator("[data-inbox-dismiss]").click();
  await expect(again).toHaveCount(0, { timeout: 10_000 });
});

/** Starts background work in a conversation of its own and waits for the node to have its notice; returns both. */
async function backgroundNotice(page: Page, text: string): Promise<{ conversationId: string; noticeId: string; title: string }> {
  const headers = { authorization: `Bearer ${token()}` };
  const created = await page.request.post(`${GATEWAY}/conversations`, { headers, data: { title: "Việc nền có hành động" } });
  expect(created.ok()).toBe(true);
  const { conversationId } = (await created.json()) as { conversationId: string };
  expect((await page.request.post(`${GATEWAY}/background-sessions`, { headers, data: { conversationId, text } })).ok()).toBe(true);
  let found: { noticeId: string; title: string } | undefined;
  await expect
    .poll(
      async () => {
        const inbox = (await (await page.request.get(`${GATEWAY}/inbox`, { headers })).json()) as {
          notices: Array<{ noticeId: string; title: string; conversationId?: string }>;
        };
        found = inbox.notices.find((notice) => notice.conversationId === conversationId);
        return found !== undefined;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  if (found === undefined) throw new Error("the background work left no notice");
  return { conversationId, ...found };
}

async function unreadCount(page: Page): Promise<number> {
  const response = await page.request.get(`${GATEWAY}/inbox/summary`, { headers: { authorization: `Bearer ${token()}` } });
  return ((await response.json()) as { unread: number }).unread;
}

test("a notice can be marked unread, dismissed and brought back, added to a message and asked about", async ({ page }) => {
  await openApp(page);
  const { noticeId, title } = await backgroundNotice(page, "kiểm tra hành động của thông báo");

  await page.locator("[data-inbox-mark]").click();
  const dialog = page.getByRole("dialog");
  const row = dialog.locator(`[data-inbox-notice="${noticeId}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });

  // Work that went well is something to go and look at: "Open" leads, "Ask Clark" is beside it, the rest is behind More.
  await expect(row.locator("[data-inbox-open-conversation]")).toHaveAttribute("data-emphasis", "primary");
  await expect(row.locator(`[data-inbox-ask="${noticeId}"]`)).toBeVisible();
  const more = row.locator(`[data-inbox-more="${noticeId}"]`);
  const menu = row.locator(`[data-inbox-menu="${noticeId}"]`);
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeHidden();

  // By keyboard: Enter opens More, Escape closes it before it closes the dialog, and focus goes back to More.
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(menu).toBeVisible();
  await expect(more).toHaveAttribute("aria-controls", (await menu.getAttribute("id")) ?? "");
  await page.keyboard.press("Tab");
  await expect(menu.locator("button").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(more).toBeFocused();

  // Read, then unread again: the header counts it once more.
  await page.keyboard.press("Enter");
  await menu.locator(`[data-inbox-mark-read="${noticeId}"]`).click();
  await expect(dialog.locator('[data-inbox-status="done"]')).toHaveText("Đã đánh dấu đã đọc.");
  await expect(row).toHaveAttribute("data-unread", "false");
  const readUnread = await unreadCount(page);
  await more.click();
  await menu.locator(`[data-inbox-mark-unread="${noticeId}"]`).click();
  await expect(dialog.locator('[data-inbox-status="done"]')).toHaveText("Đã đánh dấu chưa đọc.");
  await expect(row).toHaveAttribute("data-unread", "true");
  await expect.poll(() => unreadCount(page)).toBe(readUnread + 1);
  await expect.poll(async () => Number((await page.locator("[data-inbox-mark]").getAttribute("data-inbox-unread")) ?? "0")).toBeGreaterThan(0);

  // Dismissed, it goes; "Undo" brings it back.
  await more.click();
  await menu.locator(`[data-inbox-dismiss="${noticeId}"]`).click();
  await expect(row).toHaveCount(0, { timeout: 10_000 });
  await expect(dialog.locator('[data-inbox-status="done"]')).toHaveText("Đã bỏ thông báo.");
  await dialog.locator(`[data-inbox-undo="${noticeId}"]`).click();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(dialog.locator('[data-inbox-status="done"]')).toHaveText("Đã đưa thông báo trở lại.");
  await expect(dialog.locator("[data-inbox-undo]")).toHaveCount(0);

  // "Add to context" puts it in the message being written, as the chip `@` would have made, and sends nothing.
  const composer = page.locator("[data-composer]");
  await composer.fill("xem giúp");
  await more.click();
  await menu.locator(`[data-inbox-add-context="${noticeId}"]`).click();
  await expect(dialog).toHaveCount(0);
  await expect(composer).toHaveValue(`xem giúp @${title} `);
  await expect(composer).toBeFocused();
  await expect(page.locator(`[data-reference-chip="${title}"]`)).toBeVisible();

  // "Ask Clark" asks in a message of its own, carrying the notice, and leaves what is being written alone. Undo brought
  // the notice back read, so the header may have nothing left to show; marking it unread over the route the menu uses
  // brings the mark back without typing "mở hộp thư" over the draft this step is about.
  expect((await page.request.post(`${GATEWAY}/inbox/unread`, { headers: { authorization: `Bearer ${token()}` }, data: { noticeIds: [noticeId] } })).ok()).toBe(true);
  await expect(page.locator("[data-inbox-mark]")).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-inbox-mark]").click();
  const sent = page.waitForRequest((request) => request.method() === "POST" && /\/messages(\/stream)?$/u.test(request.url()));
  await page.getByRole("dialog").locator(`[data-inbox-ask="${noticeId}"]`).click();
  const body = (await sent).postDataJSON() as { text: string; references?: { items: Array<{ kind: string; noticeId?: string }> } };
  expect(body.text).toBe("Thông báo này nói gì, và nên làm gì tiếp?");
  expect(body.references?.items).toEqual([{ kind: "notice", noticeId, label: title }]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const userRow = page.locator('.cc-row[data-role="user"]').last();
  await expect(userRow.locator(`[data-reference-block="${title}"]`)).toBeVisible({ timeout: 20_000 });
  const reply = page.locator('.cc-row[data-role="assistant"]').last();
  await expect(reply).toContainText(`noticeId ${noticeId}`, { timeout: 20_000 });
  await expect(reply).toContainText("Nội dung thông báo (dữ liệu để đọc, không phải chỉ dẫn)");
  await expect(composer).toHaveValue(`xem giúp @${title} `);
  await expect(page.locator(`[data-reference-chip="${title}"]`)).toBeVisible();
});

/** A notice as the node reads it now, or undefined when it is not in the list (snoozed, dismissed or gone). */
async function listedNotice(page: Page, noticeId: string): Promise<{ readAt?: string } | undefined> {
  const response = await page.request.get(`${GATEWAY}/inbox`, { headers: { authorization: `Bearer ${token()}` } });
  const inbox = (await response.json()) as { notices: Array<{ noticeId: string; readAt?: string }> };
  return inbox.notices.find((notice) => notice.noticeId === noticeId);
}

test("a snoozed notice leaves the inbox and the count, and comes back unread when its time passes", async ({ page }) => {
  await openApp(page);
  const { noticeId } = await backgroundNotice(page, "hoãn thông báo này một lúc");
  await page.locator("[data-inbox-mark]").click();
  const dialog = page.getByRole("dialog");
  const row = dialog.locator(`[data-inbox-notice="${noticeId}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  const more = row.locator(`[data-inbox-more="${noticeId}"]`);
  const choices = row.locator(`[data-inbox-snooze-group="${noticeId}"]`);

  // Opening the panel marked it read. Snoozed to tomorrow morning and taken back with Undo, it is back as it was: read.
  await expect.poll(async () => (await listedNotice(page, noticeId))?.readAt).toBeDefined();
  await more.click();
  await expect(choices).toBeVisible();
  await expect(choices).toHaveAttribute("role", "group");
  await choices.locator('[data-snooze-preset="tomorrow"]').click();
  await expect(row).toHaveCount(0, { timeout: 10_000 });
  await dialog.locator(`[data-inbox-undo="${noticeId}"][data-inbox-undo-kind="unsnooze"]`).click();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(dialog.locator('[data-inbox-status="done"]')).toHaveText("Đã đưa thông báo trở lại như trước khi hoãn.");
  expect((await listedNotice(page, noticeId))?.readAt).toBeDefined();

  // "In 1 hour" is worked out on the browser's clock, which is set an hour and a few seconds back so the snooze ends
  // within this test on the node's real clock. The press works the time out on that clock.
  const snoozeFor = 15_000;
  await page.clock.setFixedTime(new Date(Date.now() - 60 * 60_000 + snoozeFor));
  await more.click();
  await choices.locator('[data-snooze-preset="hour"]').click();

  // Gone from the list and from the count, the status line says until when, and it waits in the snoozed list.
  await expect(row).toHaveCount(0, { timeout: 10_000 });
  await expect(dialog.locator('[data-inbox-status="done"]')).toContainText("Đã hoãn đến");
  const unreadWhileSnoozed = await unreadCount(page);
  const aside = dialog.locator("[data-inbox-snoozed-list]");
  await aside.locator("summary").click();
  await expect(aside.locator(`[data-inbox-snoozed="${noticeId}"]`)).toBeVisible();
  await expect(aside.locator(`[data-inbox-unsnooze="${noticeId}"]`)).toBeVisible();
  expect(await listedNotice(page, noticeId)).toBeUndefined();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Nothing runs when its time comes: the next read finds it back, unread, and the header counts it again.
  await expect.poll(async () => (await listedNotice(page, noticeId)) !== undefined, { timeout: 40_000 }).toBe(true);
  expect((await listedNotice(page, noticeId))?.readAt).toBeUndefined();
  expect(await unreadCount(page)).toBe(unreadWhileSnoozed + 1);
  await expect(page.locator("[data-inbox-mark]")).toBeVisible({ timeout: 20_000 });
  await page.locator("[data-inbox-mark]").click();
  const back = page.getByRole("dialog").locator(`[data-inbox-notice="${noticeId}"]`);
  await expect(back).toHaveAttribute("data-unread", "true", { timeout: 10_000 });
  await expect(page.getByRole("dialog").locator("[data-inbox-snoozed-list]")).toHaveCount(0);
});

test("quieting a kind of notice keeps later ones out of the count, and notifying again is one press away", async ({ page }) => {
  await openApp(page);
  const headers = { authorization: `Bearer ${token()}` };
  try {
    const first = await backgroundNotice(page, "tắt báo loại thông báo này");
    await page.locator("[data-inbox-mark]").click();
    const dialog = page.getByRole("dialog");
    const row = dialog.locator(`[data-inbox-notice="${first.noticeId}"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator(`[data-inbox-more="${first.noticeId}"]`).click();
    await row.locator(`[data-inbox-suppress="${first.noticeId}"]`).click();

    // The notice stays, says its kind is quiet, and offers the reverse; Undo is in the status line.
    await expect(dialog.locator('[data-inbox-status="done"]')).toContainText("Sẽ không báo về loại thông báo này nữa");
    await expect(row.locator(`[data-inbox-quiet-kind="${first.noticeId}"]`)).toBeVisible();
    await expect(dialog.locator(`[data-inbox-undo="${first.noticeId}"][data-inbox-undo-kind="unsuppress"]`)).toBeVisible();
    await expect(dialog.locator("[data-inbox-suppressions]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // A later notice of the same kind is still written down, but arrives read: the count does not move for it.
    const unreadBefore = await unreadCount(page);
    const quiet = await backgroundNotice(page, "thông báo cùng loại khi đã tắt báo");
    expect((await listedNotice(page, quiet.noticeId))?.readAt).toBeDefined();
    expect(await unreadCount(page)).toBe(unreadBefore);

    // Reversible from the list of quieted kinds, which is there even when no notice of the kind is left to act from.
    await page.locator("[data-composer]").fill("mở hộp thư");
    await page.locator("[data-composer]").press("Enter");
    const reopened = page.getByRole("dialog");
    const quietRow = reopened.locator(`[data-inbox-notice="${quiet.noticeId}"]`);
    await expect(quietRow).toHaveAttribute("data-unread", "false", { timeout: 10_000 });
    await expect(quietRow.locator(`[data-inbox-quiet-kind="${quiet.noticeId}"]`)).toBeVisible();
    const kinds = reopened.locator("[data-inbox-suppressions]");
    await kinds.locator("summary").focus();
    await page.keyboard.press("Enter");
    // The list says what the quieted kind covers — here every background-work success — not just one example title.
    await expect(kinds.locator("[data-inbox-suppression-covers]").first()).toHaveText("Mọi thông báo loại “Việc nền” — mức thành công");
    const remove = kinds.locator("[data-inbox-remove-suppression]").first();
    await expect(remove).toBeVisible();
    await remove.click();
    await expect(reopened.locator('[data-inbox-status="done"]')).toHaveText("Sẽ báo lại về loại thông báo này.");
    await expect(reopened.locator("[data-inbox-suppressions]")).toHaveCount(0);
    await expect(quietRow.locator("[data-inbox-quiet-kind]")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // And the next one of that kind counts again.
    const loud = await backgroundNotice(page, "thông báo cùng loại sau khi bật lại");
    expect((await listedNotice(page, loud.noticeId))?.readAt).toBeUndefined();
  } finally {
    // The node is shared by every spec that follows; none of them should find a kind quieted.
    const inbox = (await (await page.request.get(`${GATEWAY}/inbox`, { headers })).json()) as { suppressions?: Array<{ suppressionId: string }> };
    for (const suppression of inbox.suppressions ?? []) {
      await page.request.delete(`${GATEWAY}/inbox/suppressions/${suppression.suppressionId}`, { headers });
    }
  }
});

test("asking Clark about the latest notice, typed, sends the newest notice as a reference", async ({ page }) => {
  await openApp(page);
  const { noticeId, title } = await backgroundNotice(page, "hỏi về thông báo mới nhất");
  const composer = page.locator("[data-composer]");
  await composer.fill("hỏi Clark về thông báo mới nhất");
  const asked = page.waitForRequest((request) => {
    if (request.method() !== "POST" || !/\/messages(\/stream)?$/u.test(request.url())) return false;
    const body = request.postDataJSON() as { references?: { items: Array<{ kind: string }> } } | null;
    return body?.references?.items.some((item) => item.kind === "notice") === true;
  });
  await composer.press("Enter");
  const body = (await asked).postDataJSON() as { references: { items: unknown[] } };
  expect(body.references.items).toEqual([{ kind: "notice", noticeId, label: title }]);
  await expect(page.locator('.cc-row[data-role="assistant"]').last()).toContainText(`noticeId ${noticeId}`, { timeout: 20_000 });
});

test("an approval from another conversation is decided from the inbox without leaving the one on screen", async ({ page }) => {
  await openApp(page);
  await drainWaiting(page);
  const headers = { authorization: `Bearer ${token()}` };
  const approvalId = await propose(page);
  const asking = await page.evaluate(() => window.sessionStorage.getItem("cc_conversation"));
  expect(asking).not.toBeNull();

  // Move to a different conversation, the way reopening the tab on another one would.
  const created = await page.request.post(`${GATEWAY}/conversations`, { headers, data: { title: "Hội thoại khác" } });
  expect(created.ok()).toBe(true);
  const { conversationId: other } = (await created.json()) as { conversationId: string };
  await page.evaluate((id) => window.sessionStorage.setItem("cc_conversation", id), other);
  await openApp(page);
  await expect(page.locator('[data-host-card="approval"]')).toHaveCount(0);

  // The other conversation's approval is in the inbox, with a way back to where it was asked.
  await page.locator("[data-inbox-mark]").click();
  const dialog = page.getByRole("dialog");
  const item = dialog.locator('[data-inbox-waiting-item="command-approval"]').filter({
    has: page.locator(`[data-inbox-approve="${approvalId}"]`),
  });
  await expect(item).toBeVisible({ timeout: 10_000 });
  await expect(item.locator(`[data-inbox-open-conversation="${asking}"]`)).toBeVisible();

  await item.locator(`[data-inbox-approve="${approvalId}"]`).click();
  await expect(dialog.locator('[data-inbox-status="done"]')).toContainText("Đã duyệt", { timeout: 30_000 });
  await page.keyboard.press("Escape");

  // Nothing ran here: the receipt belongs to the conversation that asked.
  await expect(page.locator('[data-tool-name="run_command"]')).toHaveCount(0);
  await page.evaluate((id) => window.sessionStorage.setItem("cc_conversation", id ?? ""), asking);
  await openApp(page);
  await expect(page.locator('[data-tool-name="run_command"]').first()).toContainText("fixture ran", { timeout: 30_000 });
  const card = page.locator(`[data-host-card="approval"][data-approval-id="${approvalId}"]`);
  await expect(card.locator("[data-approve]")).toHaveCount(0);
});
