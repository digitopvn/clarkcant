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
  // The inbox is the host's own panel, so its approve and deny buttons are Clark's whatever a theme's button recipe says.
  await expect(dialog.locator('[data-inbox-panel="ready"]')).toHaveAttribute("data-owner", "host");

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

/**
 * An action whose outcome nobody saw leaves one notice that asks the person, and the answer is theirs to give.
 *
 * The scripted sentence leaves real rows: a task, an effect marked unknown by the call the command broker makes, and
 * the notice the node's own sweep writes. What the browser proves is the surface: the two answers are the row's
 * buttons with the warning before them, a press records through the person-only route, the notice goes, the
 * conversation hears how the task ended, and the same words typed open those buttons rather than record anything alone.
 */
async function leaveUnknownEffect(page: Page): Promise<{ effectId: string; noticeId: string }> {
  const composer = page.locator("[data-composer]");
  await composer.fill("thử thao tác không rõ kết quả");
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("chưa rõ nó có hiệu lực", { timeout: 20_000 });
  const headers = { authorization: `Bearer ${token()}` };
  const inbox = (await (await page.request.get(`${GATEWAY}/inbox`, { headers })).json()) as {
    notices: Array<{ noticeId: string; createdAt: string; actions?: Array<{ id: string; effectId?: string }> }>;
  };
  const asking = inbox.notices
    .flatMap((notice) => {
      const effectId = notice.actions?.find((action) => action.id === "reconcile-confirmed")?.effectId;
      return effectId === undefined ? [] : [{ noticeId: notice.noticeId, effectId, createdAt: notice.createdAt }];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const newest = asking[0];
  if (newest === undefined) throw new Error("the unknown effect left no notice offering an answer");
  return newest;
}

test("answering an unknown outcome from the inbox resolves its notice and tells the conversation", async ({ page }) => {
  await openApp(page);
  const { effectId, noticeId } = await leaveUnknownEffect(page);

  await page.locator("[data-composer]").fill("mở hộp thư");
  await page.locator("[data-composer]").press("Enter");
  const dialog = page.getByRole("dialog");
  const row = dialog.locator(`[data-inbox-notice="${noticeId}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  // The warning is said before the buttons, and the two answers are the row's own buttons, named for their notice.
  await expect(row.locator(`[data-inbox-reconcile-hint="${noticeId}"]`)).toBeVisible();
  const confirm = row.locator(`[data-inbox-reconcile="confirmed"][data-inbox-reconcile-effect="${effectId}"]`);
  await expect(confirm).toHaveText("Đã có hiệu lực");
  await expect(confirm).toHaveAttribute("aria-label", /^Ghi nhận là đã có hiệu lực: /u);
  await expect(row.locator(`[data-inbox-reconcile="failed"][data-inbox-reconcile-effect="${effectId}"]`)).toHaveText("Chưa có hiệu lực");

  // Reachable by keyboard like any other button on the row.
  await confirm.focus();
  await page.keyboard.press("Enter");

  await expect(dialog.locator('[data-inbox-status="done"]')).toContainText("Đã ghi nhận là thao tác đã có hiệu lực", { timeout: 20_000 });
  await expect(dialog.locator(`[data-inbox-notice="${noticeId}"]`)).toHaveCount(0);
  // Focus is not dropped on the page when the row it was on leaves.
  await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("bạn xác nhận “git push origin fixture” đã có hiệu lực", {
    timeout: 20_000,
  });

  // Answered once, for good: a second answer is refused, and the notice does not come back.
  const again = await page.request.post(`${GATEWAY}/effects/${effectId}/reconcile`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { outcome: "failed" },
  });
  expect(again.status()).toBe(409);
  const inbox = (await (await page.request.get(`${GATEWAY}/inbox`, { headers: { authorization: `Bearer ${token()}` } })).json()) as {
    notices: Array<{ noticeId: string }>;
  };
  expect(inbox.notices.map((notice) => notice.noticeId)).not.toContain(noticeId);
});

test("saying it did not take effect, typed, opens the inbox on the answer instead of recording it unasked", async ({ page }) => {
  await openApp(page);
  const { effectId, noticeId } = await leaveUnknownEffect(page);
  const reconciles: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/effects/${effectId}/reconcile`)) reconciles.push(request.postData() ?? "");
  });

  const composer = page.locator("[data-composer]");
  await composer.fill("chưa có hiệu lực");
  await composer.press("Enter");

  // An answer cannot be changed, so the sentence alone records nothing: it says which button answers, and opens the
  // inbox on it, where the warning stands before the buttons.
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(
    "Để ghi nhận “git push origin fixture” chưa có hiệu lực, bạn bấm “Chưa có hiệu lực”",
    { timeout: 20_000 },
  );
  const dialog = page.getByRole("dialog");
  const row = dialog.locator(`[data-inbox-notice="${noticeId}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.locator(`[data-inbox-reconcile-hint="${noticeId}"]`)).toBeVisible();
  expect(reconciles).toEqual([]);

  const recorded = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith(`/effects/${effectId}/reconcile`),
  );
  await row.locator(`[data-inbox-reconcile="failed"][data-inbox-reconcile-effect="${effectId}"]`).click();
  expect((await recorded).postDataJSON()).toMatchObject({ outcome: "failed", source: "click" });
  await expect(dialog.locator('[data-inbox-status="done"]')).toContainText("Đã ghi nhận là thao tác chưa có hiệu lực", { timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("bạn xác nhận “git push origin fixture” chưa có hiệu lực", {
    timeout: 20_000,
  });

  // With nothing left waiting, the same words are refused out loud rather than answered about something else.
  await composer.fill("chưa có hiệu lực");
  await composer.press("Enter");
  await expect(page.locator("[data-intent-notice]")).toContainText("Không có việc nào đang chờ", { timeout: 20_000 });
});

/** Every notice the node lists now, read as the panel reads them. */
async function listedNotices(page: Page): Promise<Array<{ noticeId: string; title: string; body?: string; conversationId?: string; severity: string }>> {
  const response = await page.request.get(`${GATEWAY}/inbox`, { headers: { authorization: `Bearer ${token()}` } });
  return ((await response.json()) as { notices: Array<{ noticeId: string; title: string; body?: string; conversationId?: string; severity: string }> }).notices;
}

test("dismissing the latest notification, typed, is done by the node on the notice it names, and says so", async ({ page }) => {
  await openApp(page);
  const { noticeId, title } = await backgroundNotice(page, "thông báo để bỏ bằng một câu");
  const actions: Array<{ path: string; source?: string }> = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/inbox/notices/")) {
      const source = (request.postDataJSON() as { source?: string } | null)?.source;
      actions.push({ path: new URL(request.url()).pathname, ...(source === undefined ? {} : { source }) });
    }
  });

  const composer = page.locator("[data-composer]");
  await composer.fill("bỏ thông báo mới nhất");
  await composer.press("Enter");

  // The read-back names the notice the node chose, so a person who hears the wrong one knows it, and says how long the
  // undo it promises lasts.
  const readBack = `Tôi bỏ thông báo “${title}” khỏi hộp thư nhé. Bạn có thể hoàn tác trong 5 phút.`;
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(readBack, { timeout: 20_000 });
  // Held by its words, since later replies become the last one.
  const reply = page.locator('[data-role="assistant"]', { hasText: readBack });
  // What the node answered, not the read-back again: it was done. Said in the conversation, directly under that reply,
  // with its Undo — not in a card over the page — and without taking focus from wherever the person is.
  const undoRow = page.locator(`[data-notice-undo-id="${noticeId}"]`);
  await expect(undoRow).toHaveAttribute("data-notice-undo", "offered", { timeout: 20_000 });
  await expect(undoRow).toContainText("Đã bỏ thông báo.");
  await expect(reply.locator("xpath=following-sibling::*[1]")).toHaveAttribute("data-notice-undo-id", noticeId);
  expect(await undoRow.evaluate((element) => getComputedStyle(element).position)).toBe("static");
  await expect(page.locator("[data-intent-notice]")).toHaveCount(0);
  const undo = undoRow.locator('[data-intent-undo="true"]');
  await expect(undo).toHaveAccessibleName("Hoàn tác bỏ thông báo");
  await expect(undo).not.toBeFocused();
  // Lined up with the reply's words and on one line with its Undo, close under the reply: part of it, not a centred
  // block of its own. Measured once both have finished arriving, since the entrance moves them.
  for (const settling of [reply, undoRow]) {
    await settling.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)).then(() => undefined));
  }
  const replyText =await reply.locator(".cc-assistant-body").boundingBox();
  const lineText = await undoRow.locator(".cc-notice-undo-text").boundingBox();
  const undoBox = await undo.boundingBox();
  const replyBox = await reply.boundingBox();
  const rowBox = await undoRow.boundingBox();
  if (replyText === null || lineText === null || undoBox === null || replyBox === null || rowBox === null) {
    throw new Error("the reply and its undo line are not laid out");
  }
  expect(Math.abs(lineText.x - replyText.x)).toBeLessThanOrEqual(2);
  expect(undoBox.x).toBeGreaterThan(lineText.x + lineText.width - 1);
  expect(Math.abs(undoBox.y + undoBox.height / 2 - (lineText.y + lineText.height / 2))).toBeLessThanOrEqual(4);
  expect(rowBox.y - (replyBox.y + replyBox.height)).toBeLessThanOrEqual(12);
  expect(actions).toEqual([{ path: `/inbox/notices/${noticeId}/actions/dismiss`, source: "chat" }]);
  await expect.poll(async () => (await listedNotices(page)).map((notice) => notice.noticeId)).not.toContain(noticeId);

  // The inbox shows the same state a press would have left: the notice is gone from the list.
  await composer.fill("mở hộp thư");
  await composer.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator('[data-inbox-panel="ready"]')).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator(`[data-inbox-notice="${noticeId}"]`)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The undo the read-back promised is a real control that stayed under its reply while the conversation moved on, it
  // works from the keyboard, and it brings the notice back. Focus lands on the line that says so, not on the page.
  await expect(reply.locator("xpath=following-sibling::*[1]")).toHaveAttribute("data-notice-undo-id", noticeId);
  await expect(undo).toBeVisible();
  await undo.focus();
  await page.keyboard.press("Enter");
  await expect(undoRow).toHaveAttribute("data-notice-undo", "restored", { timeout: 20_000 });
  await expect(undoRow).toContainText("Đã đưa thông báo trở lại hộp thư");
  await expect(undo).toHaveCount(0);
  await expect(undoRow.locator(".cc-notice-undo-text")).toBeFocused();
  expect(actions.at(-1)).toEqual({ path: `/inbox/notices/${noticeId}/actions/restore`, source: "click" });
  await expect.poll(async () => (await listedNotices(page)).map((notice) => notice.noticeId)).toContain(noticeId);
});

test("the Undo under a dismissal's reply says quietly when its five minutes have passed", async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  const { noticeId } = await backgroundNotice(page, "thông báo để hết thời gian hoàn tác");
  const composer = page.locator("[data-composer]");
  await composer.fill("bỏ thông báo mới nhất");
  await composer.press("Enter");
  const undoRow = page.locator(`[data-notice-undo-id="${noticeId}"]`);
  await expect(undoRow).toHaveAttribute("data-notice-undo", "offered", { timeout: 20_000 });

  // Still offered just before the window ends, gone with a quiet sentence just after it.
  await page.clock.fastForward(5 * 60_000 - 5_000);
  await expect(undoRow.locator('[data-intent-undo="true"]')).toBeVisible();
  await page.clock.fastForward(10_000);
  await expect(undoRow).toHaveAttribute("data-notice-undo", "expired");
  await expect(undoRow).toContainText("Hết thời gian hoàn tác");
  await expect(undoRow.locator('[data-intent-undo="true"]')).toHaveCount(0);
});

test("undoing a dismissal, said in words, brings back the notice most recently dismissed", async ({ page }) => {
  await openApp(page);
  const { noticeId, title } = await backgroundNotice(page, "thông báo để hoàn tác bằng một câu");
  const composer = page.locator("[data-composer]");
  await composer.fill("bỏ thông báo mới nhất");
  await composer.press("Enter");
  const undoRow = page.locator(`[data-notice-undo-id="${noticeId}"]`);
  await expect(undoRow).toHaveAttribute("data-notice-undo", "offered", { timeout: 20_000 });

  await composer.fill("hoàn tác bỏ thông báo");
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(`Tôi hoàn tác việc bỏ thông báo “${title}” nhé.`, { timeout: 20_000 });
  await expect(page.locator("[data-intent-notice]")).toContainText("Đã đưa thông báo trở lại.", { timeout: 20_000 });
  // The Undo left under the dismissal no longer offers what the sentence already did.
  await expect(undoRow).toHaveAttribute("data-notice-undo", "restored");
  await expect(undoRow.locator('[data-intent-undo="true"]')).toHaveCount(0);
  await expect.poll(async () => (await listedNotices(page)).map((notice) => notice.noticeId)).toContain(noticeId);
});

test("background work that failed is run again from its notice, and the new run reports for itself", async ({ page }) => {
  await openApp(page);
  // The fixture fails the first run of a request that says so, and runs the same words cleanly the second time.
  const { conversationId, noticeId } = await backgroundNotice(page, "đọc nhật ký hỏng lần đầu");
  await page.locator("[data-inbox-mark]").click();
  const dialog = page.getByRole("dialog");
  const row = dialog.locator(`[data-inbox-notice="${noticeId}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });

  // What the notice is for leads: trying it again, then asking Clark about it; opening it is behind More.
  const retry = row.locator(`[data-inbox-retry="${noticeId}"]`);
  await expect(retry).toHaveAttribute("data-emphasis", "primary");
  await expect(retry).toHaveAccessibleName(/^Chạy lại: /u);
  await expect(row.locator(`[data-inbox-ask="${noticeId}"]`)).toBeVisible();

  // By keyboard: the old notice leaves the list, the status says what happens next, and focus is not lost.
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.locator('[data-inbox-status="done"]')).toHaveText("Đang chạy lại việc này; kết quả sẽ báo trong hội thoại của nó.");
  await expect(row).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator(":focus")).toHaveCount(1);

  // The new run is new work with its own notice, in the same conversation, and this time it went well.
  await expect
    .poll(async () => (await listedNotices(page)).some((notice) => notice.conversationId === conversationId && notice.severity === "success"), {
      timeout: 20_000,
    })
    .toBe(true);
  expect((await listedNotices(page)).map((notice) => notice.noticeId)).not.toContain(noticeId);
});

test("a question nobody answered in time is asked again from its notice", async ({ page }) => {
  await openApp(page);
  const composer = page.locator("[data-composer]");
  await composer.fill("để một câu hỏi hết hạn");
  await composer.press("Enter");
  await expect(page.getByText("Fixture: tui đã hỏi một câu và để nó hết hạn").first()).toBeVisible({ timeout: 20_000 });
  const cards = page.locator('[data-host-card="question"]').filter({ hasText: "Chọn khu vực máy chủ cho bản thử." });
  await expect(cards).toHaveCount(1);

  let noticeId = "";
  await expect
    .poll(
      async () => {
        noticeId = (await listedNotices(page)).find((notice) => notice.body === "Chọn khu vực máy chủ cho bản thử.")?.noticeId ?? "";
        return noticeId;
      },
      { timeout: 20_000 },
    )
    .not.toBe("");
  await expect(page.locator("[data-inbox-mark]")).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-inbox-mark]").click();
  const dialog = page.getByRole("dialog");
  const row = dialog.locator(`[data-inbox-notice="${noticeId}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  const askAgain = row.locator(`[data-inbox-ask-again="${noticeId}"]`);
  await expect(askAgain).toHaveAttribute("data-emphasis", "primary");
  await expect(askAgain).toHaveAccessibleName("Hỏi lại câu hỏi: Chọn khu vực máy chủ cho bản thử.");

  await askAgain.click();
  const status = dialog.locator('[data-inbox-status="done"]');
  await expect(status).toHaveText("Đã hỏi lại trong hội thoại; câu hỏi mới đang chờ bạn trả lời ở trên.");
  await expect(row).toHaveCount(0, { timeout: 10_000 });
  // The new question waits in the section above, and in the conversation on screen as a card that can be answered.
  await expect(dialog.locator('[data-inbox-waiting-item="question"]').filter({ hasText: "Chọn khu vực máy chủ cho bản thử." })).toBeVisible({
    timeout: 10_000,
  });
  await page.keyboard.press("Escape");
  await expect(cards).toHaveCount(2, { timeout: 10_000 });
  await expect(cards.last()).toHaveAttribute("data-answered", "false");
  // The first card says what became of it rather than claiming an answer was recorded.
  await expect(cards.first()).toHaveAttribute("data-question-outcome", "asked-again");
  await expect(cards.first()).toContainText("trả lời ở câu hỏi mới");
  await expect(cards.last().locator('[data-question-option="sg"]')).toBeVisible();
});

test("an update notice updates through the install route, opens Settings to review, and skips a version undoably", async ({ page }) => {
  await openApp(page);
  const headers = { authorization: `Bearer ${token()}` };
  // Installed the way the other journeys that need a package install it: once, whichever spec ran first.
  const listed = (await (await page.request.get(`${GATEWAY}/packages`, { headers })).json()) as { packages: { packageId: string }[] };
  if (!listed.packages.some((entry) => entry.packageId === "com.example.notes")) {
    const installed = await page.request.post(`${GATEWAY}/packages/install`, {
      headers,
      data: { packageId: "com.example.notes", version: "1.0.0", localDigest: "sha256:notes-service-digest" },
    });
    expect(installed.ok(), `install answered ${String(installed.status())}: ${await installed.text()}`).toBe(true);
  }
  const composer = page.locator("[data-composer]");
  await composer.fill("kiểm tra bản cập nhật thử");
  await composer.press("Enter");
  await expect(page.getByText(/Fixture: đã kiểm tra bản cập nhật thử, [1-9]\d* gói có bản mới/u).first()).toBeVisible({ timeout: 20_000 });
  const noticeId =
    (await listedNotices(page)).find((notice) => notice.title === "Có bản cập nhật: com.example.notes" && notice.body?.includes("1.0.1") === true)
      ?.noticeId ?? "";
  expect(noticeId).not.toBe("");

  // The notice arrives in the conversation on screen, so it is read at once and raises no mark of its own: open the
  // inbox the way a person would here, by asking for it, so the journey does not lean on what earlier tests left waiting.
  const openInbox = async (): Promise<void> => {
    await composer.fill("mở hộp thư");
    await composer.press("Enter");
  };
  await openInbox();
  const dialog = page.getByRole("dialog");
  const row = dialog.locator(`[data-inbox-notice="${noticeId}"]`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  const update = row.locator(`[data-inbox-update="${noticeId}"]`);
  await expect(update).toHaveAttribute("data-emphasis", "primary");
  await expect(row.locator(`[data-inbox-review-update="${noticeId}"]`)).toBeVisible();

  // The scripted directory offered a version the real one does not list: the install route refuses it by name, and
  // the notice stays, because nothing was installed.
  await update.click();
  const failed = dialog.locator('[data-inbox-status="failed"]');
  // Said in the reader's language, as whole sentences: the node's English refusal never reaches the line.
  await expect(failed).toHaveText("Không cập nhật được: danh mục gói không có bản 1.0.1. Bản đang cài vẫn giữ nguyên.", { timeout: 20_000 });
  await expect(row).toBeVisible();

  // Skipping the version takes the notice out; Undo brings it back and the version is reported again.
  const more = row.locator(`[data-inbox-more="${noticeId}"]`);
  await more.click();
  const skip = row.locator(`[data-inbox-skip-version="${noticeId}"]`);
  await expect(skip).toHaveAttribute("aria-label", "Bỏ qua phiên bản này: Có bản cập nhật: com.example.notes");
  await skip.click();
  await expect(row).toHaveCount(0, { timeout: 10_000 });
  await expect(dialog.locator('[data-inbox-status="done"]')).toHaveText("Sẽ không báo về bản 1.0.1 nữa; bản mới hơn vẫn được báo.");
  const skipped = dialog.locator("[data-inbox-skipped-versions]");
  const skippedRow = skipped.locator('[data-inbox-skipped-version="package:com.example.notes@1.0.1"]');
  await expect(skipped).toBeVisible();
  await dialog.locator(`[data-inbox-undo="${noticeId}"]`).click();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(dialog.locator('[data-inbox-status="done"]')).toHaveText("Sẽ báo lại về bản này.");
  await expect(skippedRow).toHaveCount(0);

  // A skip outlasts the status line's Undo: it is listed with the quieted kinds, and taken back from there.
  await more.click();
  await skip.click();
  await expect(row).toHaveCount(0, { timeout: 10_000 });
  await skipped.locator("summary").click();
  await expect(skippedRow).toContainText("Gói “com.example.notes”, bản 1.0.1");
  const undoSkip = skippedRow.locator("[data-inbox-remove-skipped-version]");
  await expect(undoSkip).toHaveAttribute("aria-label", "Hoàn tác bỏ qua: Gói “com.example.notes”, bản 1.0.1");
  await undoSkip.click();
  await expect(dialog.locator('[data-inbox-status="done"]')).toHaveText("Sẽ báo lại về bản này.");
  await expect(skippedRow).toHaveCount(0);
  // The notice itself was dismissed by the skip; bring it back for the rest of the journey.
  expect((await page.request.post(`${GATEWAY}/inbox/notices/${noticeId}/restore`, { headers })).ok()).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await openInbox();
  await expect(row).toBeVisible({ timeout: 10_000 });

  // Review closes the inbox and opens Settings on the installed extensions.
  await row.locator(`[data-inbox-review-update="${noticeId}"]`).click();
  await expect(page.locator("#cc-tab-extensions")).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
  await expect(page.locator(`[data-installed-package='com.example.notes']`)).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator(`[data-inbox-notice="${noticeId}"]`)).toHaveCount(0);
});