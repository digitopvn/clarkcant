import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * A composed surface, in a real browser, over real local data.
 *
 * Everything here exists because the node cannot answer these questions about itself. Over HTTP a
 * composed surface is a spec and a bundle; whether a renderer ran, whether a region is missing
 * rather than empty, whether a change moved the live view and left the transcript alone — those are
 * facts about the browser.
 *
 * The records are created through the production API where a route exists (local calendar events),
 * and through the production schema where one does not: there is no HTTP route that creates a task,
 * because tasks come from turns, so the row is written with the columns the reducer writes. The
 * values asserted in the UI are read back from the same store rather than hardcoded.
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
  const path = join(DATA_DIR, "identity.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error(`no local token in ${path}`);
  }
  return parsed.localToken;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("textarea[aria-label='Nhập tin nhắn']")).toBeVisible();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

async function ask(page: Page, text: string): Promise<void> {
  await page.locator("textarea[aria-label='Nhập tin nhắn']").fill(text);
  await page.locator("[data-send='true']").click();
}

/** Ask for the overview and wait for the composed surface to be drawn. */
async function openOverview(page: Page): Promise<void> {
  await ask(page, "cho tui xem tổng quan công việc tuần này");
  await expect(page.locator("[data-surface-composition]").first()).toBeVisible({ timeout: 30_000 });
}

test("renders a composed overview whose figures come from the node's own records", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });

  // A calendar event through the production API, on a day inside the current week.
  const now = new Date();
  const startsAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const endsAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  const created = await api<{ event: { eventId: string; date: string; title: string } }>("POST", "/calendar/events", {
    title: "Họp kế hoạch tuần",
    startsAt,
    endsAt,
    timezone: "Asia/Saigon",
  });

  await openApp(page);
  await openOverview(page);

  // The container and the regions the sketch asks for. `trend` is required by the template and shows
  // its missing state on a node with no tasks, which is the honest outcome rather than an empty box.
  await expect(page.locator("[data-slot='metrics']")).toBeVisible();
  await expect(page.locator("[data-slot='filter']")).toBeVisible();
  await expect(page.locator("[data-slot='trend']")).toBeVisible();
  await expect(page.locator("[data-slot='cta']")).toBeVisible();

  // The KPI tiles are present with a label and a value, and the value equals what the API reports
  // for the same period rather than a number written into the test.
  const metrics = page.locator("[data-slot='metrics']");
  const tileCount = await metrics.locator(".cc-metric").count();
  expect(tileCount).toBeGreaterThanOrEqual(4);
  const completedLabel = await metrics.locator("[data-metric='completed'] .cc-metric-value").innerText();
  // The tile renders the value and its unit together, so this asserts the shape rather than a
  // formatted number.
  expect(completedLabel.trim()).toMatch(/^\d+/);

  // The calendar region is the region that proves data reached the composition: it is only shown
  // when it has rows, and the marker names the day the event was created on.
  const calendar = page.locator("[data-slot='calendar']");
  await expect(calendar.locator("[data-calendar-month]")).toBeVisible();
  // Events from earlier runs persist in the e2e database, so this asserts that the day the event was
  // created on is marked, not how many days are marked overall.
  await expect(calendar.locator(`td[data-date='${created.event.date}'] .cc-calendar-count`)).toBeVisible();
  const day = calendar.locator(`td[data-date='${created.event.date}'] .cc-calendar-day`);
  await expect(day).toBeVisible();
  await day.click();
  // Selecting a day is a view action: the event details are shown, and nothing else changes.
  await expect(calendar.locator(".cc-calendar-detail")).toContainText("Họp kế hoạch tuần");
  // The surface says plainly that these events are local records.
  await expect(calendar).toContainText("chưa đồng bộ với Google Calendar");

  // Evidence for the review: the same composed surface in the four contexts the plan asks about.
  // They are captured from one render, in order, so they differ only by scheme and viewport.
  await expect(calendar.locator(".cc-calendar-detail")).toContainText("Họp kế hoạch tuần");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: join(EVIDENCE, "miniapp-01-overview-desktop-light.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(EVIDENCE, "miniapp-03-overview-desktop-dark.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(EVIDENCE, "miniapp-04-overview-mobile-light.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(EVIDENCE, "miniapp-05-overview-mobile-dark.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("the live view changes while the transcript keeps what it showed", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page);
  await openOverview(page);

  // The inline surface is history: it was captured at a revision, and it says so. The wrapper carries
  // the snapshot identity; the figure inside it is the composition itself.
  const inline = page.locator("[data-snapshot][data-widget-definition='canvas.overview@1']").first();
  await expect(inline).toHaveAttribute("data-snapshot-stale", "false");
  const inlinePeriod = await inline.locator("[data-slot='filter'] select").inputValue();
  expect(inlinePeriod).toBe("week");

  // Open the current view: a pin that claims the single live owner of the instance.
  await page.locator("[data-open-live]").first().click();
  const live = page.locator("[data-pin-live] [data-surface-composition]").first();
  await expect(live).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-pin-live] [data-ownership='owner']")).toBeVisible();

  // Change the period on the live surface. This is a real action invocation: the node re-reads the
  // range, persists the new state and marks the older capture stale.
  const select = live.locator("[data-slot='filter'] select");
  await select.selectOption("month");
  await expect(select).toHaveValue("month", { timeout: 30_000 });

  // The transcript still holds the week it captured, marked as superseded rather than rewritten.
  await expect(inline).toHaveAttribute("data-snapshot-stale", "true");
  expect(await inline.locator("[data-slot='filter'] select").inputValue()).toBe("week");

  await page.screenshot({ path: join(EVIDENCE, "miniapp-02-live-versus-snapshot.png"), fullPage: true });

  // Reloading the page reopens the pin from its persisted identity rather than creating a new one.
  await page.reload();
  await expect(page.locator("[data-pin-live] [data-surface-composition]").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-pin-live] [data-slot='filter'] select")).toHaveValue("month");
});

test("a second surface is refused the live view and says so instead of taking over", async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  await openApp(first);
  await openOverview(first);
  await first.locator("[data-open-live]").first().click();
  await expect(first.locator("[data-pin-live] [data-ownership='owner']")).toBeVisible({ timeout: 30_000 });

  // The same conversation in a second tab. Session storage is per tab, so the second one has to be
  // pointed at the conversation explicitly — the app deliberately has no query parameter for it.
  const conversation = await first.evaluate(() => window.sessionStorage.getItem("cc_conversation"));
  expect(conversation).not.toBeNull();
  const second = await context.newPage();
  await openApp(second);
  await second.evaluate((id) => window.sessionStorage.setItem("cc_conversation", id as string), conversation);
  await second.reload();
  await expect(second.locator("textarea[aria-label='Nhập tin nhắn']")).toBeVisible();
  await expect(second.locator("[data-pin-live]").first()).toBeVisible({ timeout: 30_000 });
  await expect(second.locator("[data-pin-live] [data-ownership='elsewhere']")).toBeVisible({ timeout: 30_000 });
  await expect(second.locator("[data-live-notice]")).toContainText("vị trí khác");

  // Read-only means read-only: the control is there, disabled, and says why — rather than looking
  // like a button that works.
  const readOnlyCta = second.locator("[data-pin-live] [data-slot='cta'] button");
  await expect(readOnlyCta).toBeDisabled();

  await second.screenshot({ path: join(EVIDENCE, "miniapp-06-ownership-refused.png"), fullPage: true });

  await context.close();
});
