import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The OS/web notification for #171, in a real browser.
 *
 * What only a browser can prove: that turning off one notification group leaves the other's notification
 * showing and the disabled one's silent, that the browser's own permission prompt is what turns the web
 * channel on rather than the background poll assuming it, and that nothing a notification shows carries a
 * secret or a raw command. `window.Notification` is stubbed rather than real: a headless browser's own
 * notification permission cannot be granted from a test, and the point here is the node's and the client's
 * own logic, not the browser's permission UI.
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

interface FakeNotification {
  title: string;
  body: string;
}

/** Replaces `window.Notification` with a fixture that records every notification shown. */
async function stubNotifications(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as unknown as { __ccNotifications: FakeNotification[] };
    scope.__ccNotifications = [];

    class StubNotification {
      static permission: NotificationPermission = "default";
      static requestPermission(): Promise<NotificationPermission> {
        StubNotification.permission = "granted";
        return Promise.resolve("granted");
      }
      onclick: (() => void) | null = null;
      title: string;
      body: string;
      constructor(title: string, options?: { body?: string }) {
        this.title = title;
        this.body = options?.body ?? "";
        scope.__ccNotifications.push({ title: this.title, body: this.body });
      }
    }

    (window as unknown as { Notification: unknown }).Notification = StubNotification;
  });
}

/**
 * Stubs the notification API, and makes the window report itself as unfocused — the same signal the header mark
 * already yields to once the person is not looking, and the one that gates whether this poll notifies at all.
 */
async function stubNotificationsAndUnfocus(page: Page): Promise<void> {
  await stubNotifications(page);
  await page.addInitScript(() => {
    // The hook treats a window with no focus the same as one that is hidden: the in-app mark can no longer be
    // assumed seen, so a poll is allowed to notify outside the app.
    document.hasFocus = () => false;
  });
}

async function shownNotifications(page: Page): Promise<FakeNotification[]> {
  return page.evaluate(() => (window as unknown as { __ccNotifications: FakeNotification[] }).__ccNotifications);
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
}

/** Turns on web notifications from Settings → Control, the same steps the first test does by hand. */
async function enableWebNotifications(page: Page): Promise<void> {
  await page.locator('[data-settings="true"]').click();
  await page.locator("#cc-tab-control").click();
  const panel = page.locator("#cc-tabpanel-control");
  await expect(panel).toBeVisible();
  const webToggle = panel.locator('[data-toggle="inbox-notify-web"] input[type="checkbox"]');
  await panel.locator('[data-toggle="inbox-notify-web"]').click();
  await expect(webToggle).toBeChecked({ timeout: 10_000 });
  // Every test here shares one node, and its preferences persist: a group another test turned off stays off,
  // so both groups are put back on rather than assumed on.
  for (const group of ["waitingApprovals", "backgroundResults"]) {
    const toggle = panel.locator(`[data-toggle="inbox-notify-group-${group}"] input[type="checkbox"]`);
    if (!(await toggle.isChecked())) {
      await panel.locator(`[data-toggle="inbox-notify-group-${group}"]`).click();
      await expect(toggle).toBeChecked({ timeout: 10_000 });
    }
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
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

/** Deny every command approval still in the inbox, so this test's own waiting item is the only new one. */
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

test("disabling a group silences its notification, the other group's still shows, and neither carries a secret", async ({
  page,
}) => {
  await stubNotificationsAndUnfocus(page);
  await openApp(page);
  await drainWaiting(page);

  // Turn on web notifications and turn off the waiting-approvals group, both from Settings → Control.
  await page.locator('[data-settings="true"]').click();
  await page.locator("#cc-tab-control").click();
  const panel = page.locator("#cc-tabpanel-control");
  await expect(panel).toBeVisible();

  // The visible track covers the input, so the click goes to the label a person actually presses.
  const webToggle = panel.locator('[data-toggle="inbox-notify-web"] input[type="checkbox"]');
  await panel.locator('[data-toggle="inbox-notify-web"]').click();
  // Not optimistic: the control only shows on, once the node has confirmed the write the permission prompt allowed.
  await expect(webToggle).toBeChecked({ timeout: 10_000 });

  const waitingToggle = panel.locator('[data-toggle="inbox-notify-group-waitingApprovals"] input[type="checkbox"]');
  // The node's preferences outlive a run, so the group may already be off; only an on group is switched off.
  if (await waitingToggle.isChecked()) {
    await panel.locator('[data-toggle="inbox-notify-group-waitingApprovals"]').click();
  }
  await expect(waitingToggle).not.toBeChecked({ timeout: 10_000 });

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A fresh command approval: waitingApprovals is the disabled group, so this must never reach a notification.
  await propose(page);

  // A second conversation's background work finishing: backgroundResults is still enabled.
  const headers = { authorization: `Bearer ${token()}` };
  const created = await page.request.post(`${GATEWAY}/conversations`, { headers, data: { title: "Việc nền" } });
  expect(created.ok()).toBe(true);
  const { conversationId } = (await created.json()) as { conversationId: string };
  const started = await page.request.post(`${GATEWAY}/background-sessions`, {
    headers,
    data: { conversationId, text: "dọn thư mục tải về cho thông báo" },
  });
  expect(started.ok()).toBe(true);

  // The poll that delivers this runs on the same 5-second cadence as the header mark; two cycles is generous.
  await expect
    .poll(async () => (await shownNotifications(page)).some((entry) => entry.title.includes("dọn thư mục tải về")), {
      timeout: 20_000,
    })
    .toBe(true);

  const notifications = await shownNotifications(page);
  // The enabled group notified; the disabled one never produced an entry at all, and nothing shown names the
  // command the approval would have run.
  expect(notifications.some((entry) => entry.title.includes("Lệnh cần bạn duyệt") || entry.body.includes("node -e"))).toBe(
    false,
  );
  for (const entry of notifications) {
    expect(entry.title).not.toContain("node -e");
    expect(entry.body).not.toContain("node -e");
  }

  await drainWaiting(page);
});

test("a notification for a waiting item never carries its command or a secret-shaped token", async ({ page }) => {
  await stubNotificationsAndUnfocus(page);
  await openApp(page);
  await drainWaiting(page);
  await enableWebNotifications(page);

  // An obviously fake token, in the exact shape `redactSecrets` matches (`prefixed-token`: token-<8+ chars>) —
  // never a real credential, and deliberately not the `sk-` shape a real OpenAI key would have, which is also
  // the shape `no-committed-secrets` scans every tracked file for. It sits in both a command-approval's
  // `command` (which the notification body must never show at all, real secret or not) and a task-approval's
  // `description` (which does reach the body, redacted).
  const FAKE_TOKEN = "token-fakeTestSecret1234567890";
  const now = new Date();
  const soon = new Date(now.getTime() + 900_000);
  await page.route(`${GATEWAY}/inbox`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    // The gateway is a different origin from the page, so the stand-in answer needs the same CORS header the
    // real node sends, or the browser drops it before the client ever reads it.
    const origin = route.request().headers().origin ?? "*";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": origin, vary: "origin" },
      body: JSON.stringify({
        waiting: [
          {
            kind: "command-approval",
            approvalId: "fixture-secret-cmd",
            conversationId: "fixture-conv",
            description: "Chạy lệnh thử (fixture) để kiểm tra ẩn secret",
            command: `echo "token=${FAKE_TOKEN}"`,
            operationDigest: "sha256:fixture-secret-cmd",
            requestedAt: now.toISOString(),
            expiresAt: soon.toISOString(),
          },
          {
            kind: "task-approval",
            approvalId: "fixture-secret-task",
            taskId: "fixture-task",
            description: `Cần gửi báo cáo có chứa token=${FAKE_TOKEN}, xin duyệt`,
            operationDigest: "sha256:fixture-secret-task",
            effectCategory: "external-write",
            requestedAt: now.toISOString(),
            expiresAt: soon.toISOString(),
          },
        ],
        notices: [],
        unread: 2,
        snoozed: [],
        suppressions: [],
        readAt: now.toISOString(),
      }),
    });
  });

  await expect.poll(async () => (await shownNotifications(page)).length, { timeout: 20_000 }).toBeGreaterThan(0);

  const notifications = await shownNotifications(page);
  expect(notifications.length).toBeGreaterThan(0);
  for (const entry of notifications) {
    expect(entry.title).not.toContain(FAKE_TOKEN);
    expect(entry.body).not.toContain(FAKE_TOKEN);
    expect(entry.title).not.toContain("echo");
    expect(entry.body).not.toContain("echo");
  }

  await page.unroute(`${GATEWAY}/inbox`);
  await drainWaiting(page);
});

test("no notification appears while the window is focused, since the in-app mark already covers it", async ({ page }) => {
  // Deliberately calls `stubNotifications` and not `stubNotificationsAndUnfocus`: this proves the opposite case,
  // where the window is (as Playwright leaves it) focused and the in-app inbox mark is already the person's
  // signal, so the poll must not also push an OS/web notification.
  await stubNotifications(page);
  await openApp(page);
  await drainWaiting(page);
  await enableWebNotifications(page);

  await propose(page);

  // Two poll cycles is the same generous window the other tests give the 5-second cadence; nothing should ever
  // arrive because `documentHidden` stays `false` for a focused window.
  await page.waitForTimeout(12_000);
  expect(await shownNotifications(page)).toHaveLength(0);

  await drainWaiting(page);
});

/**
 * Opens Settings → Control. The Settings button is reached from the keyboard: with a desktop bridge present the
 * window's drag region covers the header, so a pointer click there lands on the chrome, as it would in the real shell.
 */
async function openControlSettings(page: Page): Promise<void> {
  await page.locator('[data-settings="true"]').focus();
  await page.keyboard.press("Enter");
  await page.locator("#cc-tab-control").click();
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function notifyCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __ccNotifyCalls: number }).__ccNotifyCalls);
}

test("a desktop notification the OS refused is reported beside the OS toggle, and clears once the OS accepts one again", async ({
  page,
}) => {
  // A stand-in desktop bridge: enough for the client to treat this window as desktop chrome, with a `notify`
  // that answers the way the main process does when the OS has no notification support.
  await page.addInitScript(() => {
    const scope = window as unknown as { __ccNotifyAnswer: unknown; __ccNotifyCalls: number; clarkcant: unknown };
    scope.__ccNotifyAnswer = { ok: false, reason: "unsupported", refused: "this OS does not support notifications" };
    scope.__ccNotifyCalls = 0;
    scope.clarkcant = {
      setCompactMode: () => Promise.resolve({ ok: true }),
      notify: () => {
        scope.__ccNotifyCalls += 1;
        return Promise.resolve(scope.__ccNotifyAnswer);
      },
      onNotificationClicked: () => () => undefined,
    };
    document.hasFocus = () => false;
  });
  await openApp(page);
  await drainWaiting(page);

  await openControlSettings(page);
  const panel = page.locator("#cc-tabpanel-control");
  await expect(panel).toBeVisible();
  const osToggle = panel.locator('[data-toggle="inbox-notify-os"] input[type="checkbox"]');
  if (!(await osToggle.isChecked())) {
    await panel.locator('[data-toggle="inbox-notify-os"]').click();
    await expect(osToggle).toBeChecked({ timeout: 10_000 });
  }
  const group = panel.locator('[data-toggle="inbox-notify-group-waitingApprovals"] input[type="checkbox"]');
  if (!(await group.isChecked())) {
    await panel.locator('[data-toggle="inbox-notify-group-waitingApprovals"]').click();
    await expect(group).toBeChecked({ timeout: 10_000 });
  }
  // Both toggles read back as checked, so the saved preferences have loaded and the status row can render.
  await expect(osToggle).toBeChecked();
  const status = panel.locator('[data-inbox-notify-os-status="unsupported"]');
  await expect(status).toHaveCount(0);

  await closeSettings(page);
  await propose(page);

  // Settings is reopened while the poll delivers, so the status arrives in the surface the person is looking at.
  await openControlSettings(page);
  await expect(status).toBeVisible({ timeout: 20_000 });
  await expect(status).toContainText(/inbox|hộp thư/i);

  // A notification the OS accepts clears the status: it reports the latest attempt, not a stale one.
  await page.evaluate(() => {
    (window as unknown as { __ccNotifyAnswer: unknown }).__ccNotifyAnswer = { ok: true };
  });
  await closeSettings(page);
  const callsBefore = await notifyCalls(page);
  await drainWaiting(page);
  await propose(page);
  // The accepted notification must actually have been attempted, or a missing status would prove nothing.
  await expect.poll(() => notifyCalls(page), { timeout: 20_000 }).toBeGreaterThan(callsBefore);
  await openControlSettings(page);
  await expect(osToggle).toBeChecked();
  await expect(panel.locator("[data-inbox-notify-os-status]")).toHaveCount(0);

  await closeSettings(page);
  await drainWaiting(page);
});

type ClickScope = {
  __ccNotifyInputs: Array<{ title: string; body: string; target?: string }>;
  __ccNotificationClicked?: (payload?: { target?: unknown }) => void;
};

/** What a click on the shell's notification sends the renderer, as the preload passes it on. */
async function clickDesktopNotification(page: Page, target: unknown): Promise<void> {
  await page.evaluate((payload) => {
    const scope = window as unknown as ClickScope;
    if (scope.__ccNotificationClicked === undefined) throw new Error("nothing subscribed to notification clicks");
    scope.__ccNotificationClicked(payload);
  }, { target });
}

test("clicking a desktop notification opens the inbox on the item it was about, and says so once that item is gone", async ({ page }) => {
  // A stand-in desktop bridge that records what each notification carried and keeps the click subscription, so the
  // test can click a notification the way the main process reports one.
  await page.addInitScript(() => {
    const scope = window as unknown as ClickScope & { clarkcant: unknown };
    scope.__ccNotifyInputs = [];
    scope.clarkcant = {
      setCompactMode: () => Promise.resolve({ ok: true }),
      notify: (input: { title: string; body: string; target?: string }) => {
        scope.__ccNotifyInputs.push(input);
        return Promise.resolve({ ok: true });
      },
      onNotificationClicked: (callback: (payload?: { target?: unknown }) => void) => {
        scope.__ccNotificationClicked = callback;
        return () => {
          if (scope.__ccNotificationClicked === callback) delete scope.__ccNotificationClicked;
        };
      },
    };
    document.hasFocus = () => false;
  });
  await openApp(page);
  await drainWaiting(page);

  await openControlSettings(page);
  const panel = page.locator("#cc-tabpanel-control");
  await expect(panel).toBeVisible();
  for (const toggleId of ["inbox-notify-os", "inbox-notify-group-waitingApprovals"]) {
    const input = panel.locator(`[data-toggle="${toggleId}"] input[type="checkbox"]`);
    if (!(await input.isChecked())) {
      await panel.locator(`[data-toggle="${toggleId}"]`).click();
      await expect(input).toBeChecked({ timeout: 10_000 });
    }
  }
  await closeSettings(page);

  const approvalId = await propose(page);
  const target = `command-approval:${approvalId}`;
  // The notification names the item by id only: its title and body never carry the command.
  await expect
    .poll(async () => (await page.evaluate(() => (window as unknown as ClickScope).__ccNotifyInputs)).some((input) => input.target === target), {
      timeout: 20_000,
    })
    .toBe(true);
  for (const input of await page.evaluate(() => (window as unknown as ClickScope).__ccNotifyInputs)) {
    expect(`${input.title} ${input.body}`).not.toContain("node -e");
    if (input.target !== undefined) expect(input.target).toMatch(/^(notice|question|command-approval|capability-approval|install-approval|task-approval):[A-Za-z0-9._:@/-]{1,160}$/u);
  }

  await clickDesktopNotification(page, target);
  const dialog = page.getByRole("dialog");
  const row = dialog.locator(`[data-inbox-waiting-key="${target}"]`);
  await expect(row).toHaveAttribute("data-inbox-target", "true", { timeout: 10_000 });
  // Keyboard and screen-reader users land on the item, not at the top of the list — on the row itself, named for what
  // it is, and never on its Approve button, which would leave one keypress between a glance and a decision.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-inbox-waiting-key") ?? document.activeElement?.tagName ?? ""))
    .toBe(target);
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute("aria-label", /^Đang chờ bạn: /u);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("LI");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Decided elsewhere meanwhile: the click still opens the inbox, and says what became of the item.
  await drainWaiting(page);
  await clickDesktopNotification(page, target);
  const gone = dialog.locator('[data-inbox-status="failed"]');
  await expect(gone).toHaveText("Mục mà thông báo trỏ tới không còn trong hộp thư; có thể nó đã được xử lý ở nơi khác.", { timeout: 10_000 });
  await expect(dialog.locator('[data-inbox-target="true"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // A target the grammar does not allow is dropped: the inbox opens at the top, pointed at nothing.
  await clickDesktopNotification(page, `${"java"}script:alert(1)`);
  await expect(dialog.locator('[data-inbox-panel="ready"]')).toBeVisible({ timeout: 10_000 });
  await expect(dialog.locator('[data-inbox-target="true"]')).toHaveCount(0);
  await expect(dialog.locator('[data-inbox-status="failed"]')).toHaveCount(0);
  await closeSettings(page);
});
