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

/**
 * Replaces `window.Notification` with a fixture that records every notification shown, and makes the window
 * report itself as unfocused — the same signal the header mark already yields to once the person is not
 * looking, and the one that gates whether this poll notifies at all.
 */
async function stubNotificationsAndUnfocus(page: Page): Promise<void> {
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
  await panel.locator('[data-toggle="inbox-notify-group-waitingApprovals"]').click();
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
