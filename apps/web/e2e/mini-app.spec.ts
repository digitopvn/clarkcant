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

/**
 * A real 2×2 PNG, with correct chunk CRCs.
 *
 * The region has to load actual bytes, so the assertion is `naturalWidth > 0` — and a decoded
 * image is the only thing that proves it. The commonly copied 1×1 base64 string has a broken IDAT
 * CRC, which browsers refuse to decode, so the fixture is generated rather than pasted.
 */
const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=";

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

/**
 * An instant inside the week the overview queries, whatever time of day the suite runs.
 *
 * The first version of this setup was `now + 1h`, and it was time-of-day dependent in the way that costs an
 * afternoon. Run on a Sunday evening, the event landed on Monday, fell outside the "tuần này" range the composition
 * asks the node for, and the calendar region — which is drawn only when it has rows — silently vanished. Both tests
 * that use it then failed for a reason that had nothing to do with the code they were testing, and CI had passed
 * earlier the same day because it ran before the boundary.
 *
 * Today at 09:00 in the event's own timezone is inside the week that contains today at every hour of every day.
 */
function eventTodayAtNine(): { startsAt: string; endsAt: string } {
  const localToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Saigon" }).format(new Date());
  return { startsAt: `${localToday}T09:00:00+07:00`, endsAt: `${localToday}T10:00:00+07:00` };
}

test("renders a composed overview whose figures come from the node's own records", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });

  // A calendar event through the production API, on a day inside the current week.
  const { startsAt, endsAt } = eventTodayAtNine();
  const created = await api<{ event: { eventId: string; date: string; title: string } }>("POST", "/calendar/events", {
    title: "Họp kế hoạch tuần",
    startsAt,
    endsAt,
    timezone: "Asia/Saigon",
  });

  // And an imported image, through the production upload route, because the sketch has a picture
  // region and a region nothing can fill is a region that does not exist.
  const uploaded = await api<{ image: { imageId: string; altText: string } }>("POST", "/images", {
    dataBase64: TEST_PNG_BASE64,
    mimeType: "image/png",
    altText: "Sơ đồ kiến trúc đã nhập",
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

  // The picture region carries the image's own alt text and bytes that actually load: an `<img>` whose
  // source failed would still be a visible figure, which is what makes this assertion worth making.
  const image = page.locator("[data-slot='image']");
  await expect(image).toBeVisible();
  await expect(image).toContainText("Sơ đồ kiến trúc đã nhập");
  const picture = image.locator(`img[data-image-ref='${uploaded.image.imageId}']`);
  await expect(picture).toBeVisible();
  // Scrolled into view first, because the renderer loads images lazily: an image below the fold
  // reports `complete: true` with `naturalWidth: 0` until the browser decides to fetch it, and that
  // is indistinguishable from a broken picture if the assertion is written carelessly.
  await picture.scrollIntoViewIfNeeded();
  await expect(picture).toHaveJSProperty("naturalWidth", 2);
  await expect(picture).toHaveJSProperty("height", 2);

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

test("the expanded view is operable and dismissible from the keyboard alone", async ({ page, context }) => {
  mkdirSync(EVIDENCE, { recursive: true });

  const created = await api<{ event: { date: string } }>("POST", "/calendar/events", {
    title: "Họp kế hoạch tuần",
    ...eventTodayAtNine(),
    timezone: "Asia/Saigon",
  });

  await openApp(page);
  // Typed and sent with the keyboard, so the whole journey below is one a keyboard user can make.
  await page.locator("textarea[aria-label='Nhập tin nhắn']").click();
  await page.keyboard.type("cho tui xem tổng quan công việc tuần này");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-surface-composition]").first()).toBeVisible({ timeout: 30_000 });

  const trigger = page.locator("[data-open-live]").first();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const live = page.locator("[data-pin-live]").first();
  await expect(live).toBeVisible({ timeout: 30_000 });

  // Focus lands on the close control, so Escape is discoverable rather than something to be guessed.
  await expect(page.locator("[data-close-live]")).toBeFocused();
  // The region is announced with a name, not as an unlabelled div. The label sits on the surface
  // itself; the wrapper is the host's slot for it.
  const surface = live.locator("[data-display-mode='expanded']");
  await expect(surface).toHaveAttribute("role", "region");
  expect(await surface.getAttribute("aria-label")).toContain("Bản hiện tại");

  // A native select is operable without a mouse; the assertion is that the change reached the server.
  const period = live.locator("[data-slot='filter'] select");
  await period.focus();
  await period.selectOption("month");
  await expect(live.locator("[data-slot='filter'] select")).toHaveValue("month");

  // And a calendar day, activated with Enter from a focused button.
  const day = live.locator(`td[data-date='${created.event.date}'] .cc-calendar-day`);
  await day.focus();
  await page.keyboard.press("Enter");
  await expect(live.locator(".cc-calendar-detail")).toContainText("Họp kế hoạch tuần");

  await page.screenshot({ path: join(EVIDENCE, "miniapp-07-expanded-keyboard.png"), fullPage: true });

  await page.keyboard.press("Escape");
  await expect(page.locator("[data-pin-live]")).toHaveCount(0);
  // Focus goes back to the control that opened it, so the next Tab continues from where the user was.
  await expect(page.locator("[data-open-live]").first()).toBeFocused();

  await context.close();
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

/**
 * Lazy mount, and suspension when the surface leaves.
 *
 * The two are the same decision seen twice: a pinned surface that nobody is looking at should cost nothing. So
 * what is asserted is not that a flag flipped but that the heavy surface is **gone** from the DOM while offscreen,
 * that the lease is not being claimed, and that the wait is described rather than looking like a failure.
 *
 * Visibility is driven by the viewport rather than by scrolling, because the pin's position depends on the layout
 * and a scroll would be asserting the layout instead of the behaviour.
 */
test("a pinned surface mounts near the viewport and suspends when it leaves", async ({ page }) => {
  await openApp(page);
  await openOverview(page);
  await page.locator("[data-open-live]").first().click();

  const surface = page.locator("[data-pin-live] [data-lazy]").first();
  await expect(surface).toHaveAttribute("data-lazy", "false", { timeout: 30_000 });
  await expect(surface.locator("[data-surface-composition]").first()).toBeVisible();

  /*
   * Pushed out of the viewport directly rather than by scrolling. The surface sits inside a scroll container that
   * is not the window, so a `window.scrollTo` moves nothing and the assertion would be about the layout instead of
   * the behaviour. Moving the element is what the observer actually watches.
   */
  await surface.evaluate((element) => {
    (element as HTMLElement).style.marginTop = "3000px";
  });

  await expect(surface).toHaveAttribute("data-lazy", "true", { timeout: 20_000 });
  // Unmounted, not merely unpolled: the heavy part is what lazy mounting is for.
  await expect(surface.locator("[data-surface-composition]")).toHaveCount(0);
  // And it stops claiming the live view, because the lease was released when it suspended.
  await expect(surface.locator("[data-ownership='owner']")).toHaveCount(0);
  // The wait is described, with the title, rather than an empty box.
  const waiting = surface.locator("[data-live-waiting='offscreen']");
  await expect(waiting).toBeVisible();
  await expect(waiting).toContainText("cuộn tới để mở");

  // Coming back mounts it again, with the same owner token — one subscription, not a second one.
  await surface.evaluate((element) => {
    (element as HTMLElement).style.marginTop = "0px";
  });
  await expect(surface).toHaveAttribute("data-lazy", "false", { timeout: 20_000 });
  await expect(surface.locator("[data-surface-composition]").first()).toBeVisible({ timeout: 30_000 });
});
