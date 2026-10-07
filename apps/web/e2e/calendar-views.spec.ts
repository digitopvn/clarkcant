import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { BOTTOM_FOLLOW_SLACK_PX } from "../../../packages/conversation-client/src/follow-bottom.ts";

/**
 * The calendar's month, week and agenda views, placed in the conversation over sample events.
 *
 * The browser runs in New York while the calendar is set to Ho Chi Minh City, and the clock is fixed at 10:30 on
 * 7 October there (23:30 on the 6th in New York). So a view that placed events or "now" by the browser's own timezone
 * would put the night deploy and today on the wrong day, and these tests would see it. What only a browser can say is
 * what a person does with the calendar: switch views, walk days and events with the keyboard, select an event and read
 * its details, find the calendar as they left it after a reload, see the node's refusal when a page asks for an event it
 * no longer holds, and use it all on a phone.
 *
 * Each event is named by its key: the row's own id and when it starts, so a row that repeats an id is still its own event.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

/** 10:30 on 7 October 2026 in Ho Chi Minh City, which is 23:30 on the 6th in New York. */
const NOW = new Date("2026-10-07T03:30:00Z");

test.use({ timezoneId: "America/New_York" });

/** The sample events by their keys: the row's id and where it starts. */
const STANDUP = "evt_standup@2026-10-05T02:00:00.000Z";
const DEPLOY = "evt_deploy@2026-10-06T15:00:00.000Z";
const OFFSITE = "evt_offsite@2026-10-07";
const BERLIN = "evt_berlin@2026-10-08T08:00:00.000Z";
/** Written as 14:00 with no offset, which is 14:00 in Ho Chi Minh City, the calendar's timezone: 07:00 UTC. */
const LOCAL = "evt_local@2026-10-09T07:00:00.000Z";
const REVIEW = "evt_review@2026-10-12T15:00:00.000Z";
const HOLIDAY = "evt_holiday@2026-10-20";
const LUNCH = "evt_lunch@2026-10-20T05:00:00.000Z";

const event = (key: string): string => `[data-calendar-event='${key}']`;
const selectedEvent = (key: string): string => `[data-calendar-selected-event='${key}']`;

type Which = "" | "tuần" | "lịch trình";

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
}

function authorized(): Record<string, string> {
  return { authorization: `Bearer ${token()}` };
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
}

async function say(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill(text);
  await composer.press("Enter");
}

const CALENDARS = "[data-widget-role='calendar']:has([data-calendar-view])";

/** Ask the fixture model for a calendar, and return it by position so a later one cannot move the locator. */
async function place(page: Page, which: Which): Promise<Locator> {
  const before = await page.locator(CALENDARS).count();
  await say(page, `đặt lịch mẫu${which === "" ? "" : ` ${which}`}`);
  await expect(page.locator(CALENDARS)).toHaveCount(before + 1, { timeout: 20_000 });
  return page.locator(CALENDARS).nth(before);
}

/** Which conversation the page is in, read from the requests the page itself makes for it. */
function watchConversation(page: Page): () => string {
  let conversationId = "";
  page.on("request", (request) => {
    const match = /\/conversations\/([^/?]+)\/(?:timeline|messages)/u.exec(request.url());
    if (match !== null) conversationId = decodeURIComponent(match[1] ?? "");
  });
  return () => {
    if (conversationId === "") throw new Error("the page has not asked the node for a conversation yet");
    return conversationId;
  };
}

async function instanceOf(calendar: Locator): Promise<string> {
  const instanceId = await calendar.evaluate((element) => element.closest("[data-widget-instance]")?.getAttribute("data-widget-instance") ?? "");
  expect(instanceId, "the calendar is drawn for an instance").not.toBe("");
  return instanceId;
}

/** The view the node holds for an instance, read from the conversation's timeline. */
async function heldView(page: Page, conversationId: string, instanceId: string): Promise<unknown> {
  const response = await page.request.get(`${GATEWAY}/conversations/${encodeURIComponent(conversationId)}/timeline?after=0`, {
    headers: authorized(),
  });
  expect(response.ok(), "the node gives the conversation's timeline").toBe(true);
  const timeline = (await response.json()) as { instances?: { instanceId: string; state?: Record<string, unknown> }[] };
  return timeline.instances?.find((instance) => instance.instanceId === instanceId)?.state ?? {};
}

async function focused(page: Page, attribute: string): Promise<string | null> {
  return page.evaluate((name) => document.activeElement?.getAttribute(name) ?? null, attribute);
}

/**
 * Whether the transcript kept still over two frames, and where it is against its bottom: at it, near enough that the
 * client follows the bottom when the transcript changes, or away from it.
 */
async function transcriptMotion(page: Page): Promise<{ still: boolean; bottom: "at" | "following" | "away" }> {
  return page.evaluate(async (slack) => {
    const scroller = document.querySelector(".cc-scroll");
    if (scroller === null) return { still: false, bottom: "away" as const };
    const before = scroller.scrollTop;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const fromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    return { still: scroller.scrollTop === before, bottom: fromBottom <= 1 ? ("at" as const) : fromBottom <= slack ? ("following" as const) : ("away" as const) };
  }, BOTTOM_FOLLOW_SLACK_PX);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test("the month view places events by the calendar's timezone, walks days from the keyboard, and keeps a selected event", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.clock.setFixedTime(NOW);
  const conversation = watchConversation(page);
  await openApp(page);
  const before = await page.locator(CALENDARS).count();
  const calendar = await place(page, "");

  // The events are a sample and the calendar says so; they are not local records, so it does not claim they are.
  await expect(calendar.locator(".cc-freshness[data-freshness='sample']")).toHaveCount(1);
  await expect(calendar.getByText("chưa đồng bộ với Google Calendar")).toHaveCount(0);
  await expect(calendar.locator("[data-calendar-view-button='month']")).toHaveAttribute("aria-pressed", "true");
  const month = calendar.locator("table[data-calendar-month='2026-10']");
  await expect(month).toBeVisible();

  // Today is the 7th in Ho Chi Minh City, though it is still the 6th where the browser is.
  await expect(month.locator("td[data-today='true']")).toHaveAttribute("data-date", "2026-10-07");
  await expect(month.locator("td[data-date='2026-10-07'] .cc-calendar-day")).toHaveAttribute("aria-current", "date");
  await expect(calendar.locator("[data-calendar-now-text]")).toHaveText("Bây giờ: 2026-10-07 10:30 (Asia/Ho_Chi_Minh)");

  // The night deploy is on the 6th and the 7th; the three-day offsite ends on the 9th, the day before its end date.
  const count = (date: string) => month.locator(`td[data-date='${date}'] .cc-calendar-count`);
  await expect(count("2026-10-06")).toHaveText("1");
  await expect(count("2026-10-07")).toHaveText("2");
  await expect(count("2026-10-08")).toHaveText("2");
  // The 9th has the offsite's last day and the meeting written with no offset, read in the calendar's timezone.
  await expect(count("2026-10-09")).toHaveText("2");
  await expect(count("2026-10-10")).toHaveCount(0);
  // The review that ends at midnight is on the 12th only.
  await expect(count("2026-10-12")).toHaveText("1");
  await expect(count("2026-10-13")).toHaveCount(0);

  // One day is the way in; the arrow keys walk the days and Enter selects one.
  const entry = month.locator(".cc-calendar-day[tabindex='0']");
  await expect(entry).toHaveCount(1);
  await expect(entry).toHaveAttribute("data-calendar-day", "2026-10-07");
  await entry.focus();
  await page.keyboard.press("ArrowDown");
  expect(await focused(page, "data-calendar-day")).toBe("2026-10-14");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  expect(await focused(page, "data-calendar-day")).toBe("2026-10-08");
  await page.keyboard.press("Enter");
  const detail = calendar.locator(".cc-calendar-detail");
  await expect(detail).toHaveAttribute("data-selected-date", "2026-10-08");
  await expect(detail.locator(event(OFFSITE))).toContainText("ngày 2/3");
  await expect(detail.locator(event(BERLIN))).toContainText("15:00–16:00");

  // An event written in Berlin shows the calendar's time and its own.
  await detail.locator(event(BERLIN)).click();
  const selected = calendar.locator(selectedEvent(BERLIN));
  await expect(selected).toContainText("Gọi với Berlin");
  await expect(selected).toContainText("2026-10-08 15:00–16:00");
  await expect(selected.locator("[data-calendar-source-zone='Europe/Berlin']")).toHaveText("Theo giờ gốc (Europe/Berlin): 2026-10-08 10:00–11:00");

  // The node keeps the view, which is what voice and inspect_ui read.
  const instanceId = await instanceOf(calendar);
  await expect
    .poll(() => heldView(page, conversation(), instanceId), { timeout: 10_000 })
    .toEqual({ view: "month", selectedDate: "2026-10-08", selectedEventId: BERLIN });

  // After a reload the calendar opens as it was left.
  await openApp(page);
  const again = page.locator(CALENDARS).nth(before);
  await expect(again.locator(selectedEvent(BERLIN))).toBeVisible({ timeout: 20_000 });

  // Escape clears the event, and the node forgets it too.
  await again.locator(event(BERLIN)).focus();
  await page.keyboard.press("Escape");
  await expect(again.locator("[data-calendar-selected-event]")).toHaveCount(0);
  await expect.poll(() => heldView(page, conversation(), instanceId), { timeout: 10_000 }).toEqual({ view: "month", selectedDate: "2026-10-08" });
});

test("the week view shows all-day and overnight events on each of their days, with now among today's events", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.setFixedTime(NOW);
  const conversation = watchConversation(page);
  await openApp(page);
  const before = await page.locator(CALENDARS).count();
  const calendar = await place(page, "tuần");

  await expect(calendar.locator("[data-calendar-view='week']")).toBeVisible();
  await expect(calendar.locator("[data-calendar-view-button='week']")).toHaveAttribute("aria-pressed", "true");
  const week = calendar.locator("ol[data-calendar-week-of='2026-10-05']");
  await expect(week.locator("li.cc-calendar-week-day")).toHaveCount(7);
  const day = (date: string) => week.locator(`li[data-date='${date}']`);

  await expect(day("2026-10-05").locator(event(STANDUP))).toContainText("09:00–10:00");
  await expect(day("2026-10-06").locator(event(DEPLOY))).toContainText("từ 22:00");
  await expect(day("2026-10-07").locator(event(DEPLOY))).toContainText("đến 02:00");
  const offsite = day("2026-10-07").locator(event(OFFSITE));
  await expect(offsite).toContainText("Cả ngày");
  await expect(offsite).toContainText("ngày 1/3");
  await expect(day("2026-10-09").locator(event(OFFSITE))).toContainText("ngày 3/3");
  await expect(day("2026-10-10").locator("[data-calendar-event]")).toHaveCount(0);
  await expect(day("2026-10-10")).toContainText("Không có sự kiện");
  // An all-day event is striped as well as labelled, so it is not told apart by colour alone.
  const stripe = await offsite.evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(stripe).toContain("repeating-linear-gradient");

  // Now is on today only, after the deploy that ended at 02:00.
  await expect(week.locator("[data-calendar-now]")).toHaveCount(1);
  // A week's day is narrow, so the line shows only the time, on one line; the whole label is what is read out.
  const now = day("2026-10-07").locator("[data-calendar-now]");
  await expect(now.locator(".cc-sr-only")).toHaveText("Bây giờ 10:30");
  await expect(now.locator("[aria-hidden='true']")).toHaveText("10:30");
  await expect(now).toHaveAttribute("title", "Bây giờ 10:30");
  const lines = await now.locator("[aria-hidden='true']").evaluate((element) => {
    const style = getComputedStyle(element);
    return element.getBoundingClientRect().height / Number.parseFloat(style.lineHeight === "normal" ? style.fontSize : style.lineHeight);
  });
  expect(lines, "the time beside the now line does not wrap").toBeLessThan(1.6);
  const order = await day("2026-10-07").locator(".cc-calendar-events > li").evaluateAll((items) =>
    items.map((item) => item.querySelector("[data-calendar-event]")?.getAttribute("data-calendar-event") ?? (item.hasAttribute("data-calendar-now") ? "now" : "")),
  );
  expect(order).toEqual([OFFSITE, DEPLOY, "now"]);

  // Up and Down walk the events; Enter selects one.
  await day("2026-10-05").locator(event(STANDUP)).focus();
  await page.keyboard.press("ArrowDown");
  expect(await focused(page, "data-calendar-event")).toBe(DEPLOY);
  await page.keyboard.press("Enter");
  await expect(calendar.locator(selectedEvent(DEPLOY))).toContainText("2026-10-06 22:00 → 2026-10-07 02:00");
  // It runs four hours across midnight, which is not two days.
  await expect(calendar.locator(selectedEvent(DEPLOY)).locator("[data-calendar-lasts]")).toHaveText("Kéo dài 4 giờ");
  await expect(calendar.locator(selectedEvent(DEPLOY))).not.toContainText("Kéo dài 2 ngày");
  // Left and Right walk the days of the week from their headings.
  await day("2026-10-06").locator("[data-calendar-day]").focus();
  await page.keyboard.press("ArrowRight");
  expect(await focused(page, "data-calendar-day")).toBe("2026-10-07");

  // The next week follows the selected day, and the review that ends at midnight stays on its own day.
  await calendar.locator("[data-calendar-week='next']").click();
  const next = calendar.locator("ol[data-calendar-week-of='2026-10-12']");
  await expect(next).toBeVisible();
  await expect(next.locator(`li[data-date='2026-10-12'] ${event(REVIEW)}`)).toContainText("22:00–00:00");
  await expect(next.locator("li[data-date='2026-10-13'] [data-calendar-event]")).toHaveCount(0);
  await expect(next.locator("[data-calendar-now]")).toHaveCount(0);

  const instanceId = await instanceOf(calendar);
  await expect
    .poll(() => heldView(page, conversation(), instanceId), { timeout: 10_000 })
    .toEqual({ view: "week", selectedDate: "2026-10-13" });
  await openApp(page);
  await expect(page.locator(CALENDARS).nth(before).locator("ol[data-calendar-week-of='2026-10-12']")).toBeVisible({ timeout: 20_000 });
});

test("the agenda lists the month's days with events, marks now, and switches views from the same calendar", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.clock.setFixedTime(NOW);
  await openApp(page);
  const calendar = await place(page, "lịch trình");

  const agenda = calendar.locator("ol[data-calendar-agenda='2026-10']");
  await expect(agenda).toBeVisible();
  const dates = await agenda.locator("li.cc-calendar-agenda-day").evaluateAll((items) => items.map((item) => item.getAttribute("data-date")));
  expect(dates).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-20"]);
  await expect(agenda.locator("li[data-date='2026-10-07'] [data-calendar-now]")).toHaveText("Bây giờ 10:30");
  const holiday = agenda.locator("li[data-date='2026-10-20'] [data-calendar-event]");
  await expect(holiday).toHaveCount(2);
  await expect(holiday.nth(0)).toContainText("Cả ngày");
  await expect(holiday.nth(1)).toContainText("12:00–13:00");

  // The keyboard walks every event in the agenda, from the first to the last.
  await agenda.locator("[data-calendar-event]").first().focus();
  await page.keyboard.press("End");
  expect(await focused(page, "data-calendar-event")).toBe(LUNCH);
  await page.keyboard.press("ArrowUp");
  expect(await focused(page, "data-calendar-event")).toBe(HOLIDAY);
  await page.keyboard.press("Space");
  await expect(calendar.locator(selectedEvent(HOLIDAY))).toContainText("2026-10-20, cả ngày");

  // The same calendar switches to the week and month views, keeping the selected day.
  await calendar.locator("[data-calendar-view-button='week']").click();
  await expect(calendar.locator("ol[data-calendar-week-of='2026-10-19']")).toBeVisible();
  await calendar.locator("[data-calendar-view-button='month']").click();
  await expect(calendar.locator("td[data-date='2026-10-20'] .cc-calendar-day")).toHaveAttribute("aria-pressed", "true");
  await expect(calendar.locator(selectedEvent(HOLIDAY))).toBeVisible();
});

test("a page that asks for an event the node no longer holds is told so in the person's language", async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.setFixedTime(NOW);
  await openApp(page);
  const calendar = await place(page, "");
  await calendar.locator("td[data-date='2026-10-06'] .cc-calendar-day").click();
  await expect(calendar.locator(`.cc-calendar-detail ${event(DEPLOY)}`)).toBeVisible();

  // The rows are replaced from another conversation, so this page still draws the deploy it was given.
  const created = await page.request.post(`${GATEWAY}/conversations`, { headers: authorized(), data: { title: "Dữ liệu lịch" } });
  expect(created.ok()).toBe(true);
  const other = ((await created.json()) as { conversationId: string }).conversationId;
  const sent = await page.request.post(`${GATEWAY}/conversations/${encodeURIComponent(other)}/messages`, {
    headers: authorized(),
    data: { text: "bỏ sự kiện đêm khỏi lịch mẫu" },
  });
  expect(sent.ok()).toBe(true);
  await expect
    .poll(async () => {
      const response = await page.request.get(`${GATEWAY}/conversations/${encodeURIComponent(other)}/timeline?after=0`, { headers: authorized() });
      return JSON.stringify(await response.json()).includes("không còn sự kiện đêm");
    }, { timeout: 20_000 })
    .toBe(true);

  await calendar.locator(`.cc-calendar-detail ${event(DEPLOY)}`).click();
  // Said in the person's language; the node's English sentence is for the model and the logs.
  await expect(calendar.locator("[data-calendar-message]")).toHaveText(
    "Lịch không giữ được lựa chọn này vì dữ liệu sự kiện đã đổi. Lịch đang hiện lại chế độ xem đã lưu.",
    { timeout: 20_000 },
  );
  // The refused selection is undrawn, and the calendar is drawn over the events the node holds.
  await expect(calendar.locator("[data-calendar-selected-event]")).toHaveCount(0);
  await expect(calendar.locator("td[data-date='2026-10-06'] .cc-calendar-count")).toHaveCount(0, { timeout: 20_000 });
  await expect(calendar.locator("td[data-date='2026-10-07'] .cc-calendar-count")).toHaveText("1");
});

test("an event written with no offset is at its time in the calendar's timezone, in the browser as on the node", async ({ browser }) => {
  test.setTimeout(120_000);
  // Neither the calendar's Ho Chi Minh City nor where the node runs: a browser that read the time as its own would put
  // the meeting at 14:00 in Los Angeles, name it by another start, and the node would refuse it.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/Los_Angeles" });
  const page = await context.newPage();
  try {
    await page.clock.setFixedTime(NOW);
    const conversation = watchConversation(page);
    await openApp(page);
    const calendar = await place(page, "");
    await calendar.locator("td[data-date='2026-10-09'] .cc-calendar-day").click();
    const local = calendar.locator(`.cc-calendar-detail ${event(LOCAL)}`);
    await expect(local).toContainText("14:00–15:00");
    await local.click();
    await expect(calendar.locator(selectedEvent(LOCAL))).toContainText("2026-10-09 14:00–15:00");

    // The node reads the same row the same way, so it keeps the selection rather than refusing it.
    const instanceId = await instanceOf(calendar);
    await expect
      .poll(() => heldView(page, conversation(), instanceId), { timeout: 10_000 })
      .toEqual({ view: "month", selectedDate: "2026-10-09", selectedEventId: LOCAL });
    await expect(calendar.locator("[data-calendar-message]")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
test("a month that does not exist is refused with the host's reason, and no calendar is drawn", async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  const before = await page.locator(CALENDARS).count();
  await say(page, "đặt lịch mẫu tháng sai");
  await expect(page.getByText('props.month "2026-13" is not a month in YYYY-MM form').last()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(CALENDARS)).toHaveCount(before);
});

test("the calendar adds no motion of its own when motion is reduced", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.setFixedTime(NOW);
  await openApp(page);
  const calendar = await place(page, "tuần");
  for (const selector of ["[data-calendar-event]", "[data-calendar-now]", "[data-calendar-view-button]"]) {
    const motion = await calendar.locator(selector).first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { animation: style.animationName, transition: style.transitionDuration };
    });
    expect(motion.animation, selector).toBe("none");
    expect(motion.transition.split(",").every((part) => Number.parseFloat(part) === 0), selector).toBe(true);
  }
});

test("the library previews the week and agenda fixtures through the production renderer, usable without a node", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  // The fixture selector belongs to the developer's Lab, where each fixture can be previewed in turn.
  await expect(page.locator("#cc-tab-developer")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-developer").click();
  await page.locator("[data-widget-library-open='develop']").click();
  await expect(page.locator("[data-widget-library='true']")).toHaveAttribute("data-widget-library-mode", "develop");
  await page.locator("[data-widget-card='canvas.calendar@1']").click();
  await expect(page.locator("[data-widget-lab-controls='true']")).toBeVisible({ timeout: 20_000 });
  const preview = page.locator("[data-widget-preview='canvas.calendar@1']");
  await expect(preview).toBeVisible({ timeout: 20_000 });

  await page.locator("[data-widget-lab-fixture='true']").selectOption("calendar.week");
  await expect(preview.locator("[data-calendar-view='week']")).toBeVisible();
  await expect(preview.locator(".cc-freshness[data-freshness='sample']")).toHaveCount(1);
  await expect(preview.locator("ol[data-calendar-week-of='2026-09-14']")).toBeVisible();
  await expect(preview.locator(selectedEvent("cal-release@2026-09-16T20:30:00.000Z"))).toBeVisible();
  // The offsite ends the day before its end date, and is drawn on each of its three days.
  await expect(preview.locator(event("cal-offsite@2026-09-15"))).toHaveCount(3);

  await page.locator("[data-widget-lab-fixture='true']").selectOption("calendar.agenda");
  await expect(preview.locator("[data-calendar-view='agenda']")).toBeVisible();
  await expect(preview.locator("[data-widget-unavailable='true']")).toHaveCount(0);
  // The views switch in the preview as they do in the conversation.
  await preview.locator("[data-calendar-view-button='month']").click();
  await expect(preview.locator("table[data-calendar-month]")).toBeVisible();
});

test("the week view is usable at phone width without scrolling sideways, in the light theme", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    colorScheme: "light",
    timezoneId: "America/New_York",
  });
  const page = await context.newPage();
  try {
    await page.clock.setFixedTime(NOW);
    await openApp(page);
    const calendar = await place(page, "tuần");
    const box = await calendar.boundingBox();
    expect(box?.width ?? 0, "the calendar fits the phone's width").toBeLessThanOrEqual(390);
    // The days are stacked, each as wide as the week, rather than squeezed into seven columns.
    const widths = await calendar.locator("li.cc-calendar-week-day").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().width));
    expect(widths).toHaveLength(7);
    for (const width of widths) expect(width).toBeGreaterThan(250);
    /*
     * Tapped from the middle of the screen, and only once the point it lands on is the event itself: scrolled only "if
     * needed", the event can sit at the top edge, where whatever else the shared node has put at the top of the page can
     * take the touch instead.
     *
     * Placing the calendar sends the transcript after its bottom with a smooth scroll, and that scroll can still be
     * running, or start again, after the event is put in the middle. A tap made then lands on whatever has moved under the
     * point by the time the touch ends: the next event down. So the event is put in the middle until the transcript stays
     * there, far enough from its bottom that the client no longer follows it, and only then tapped. The calendar's row
     * also enters with a bounce, which can pause at its turn long enough to look settled and then move the event again,
     * so that entrance is waited out first.
     */
    const offsite = calendar.locator(`li[data-date='2026-10-07'] ${event(OFFSITE)}`);
    // The row and card the calendar arrives in rise into place with a bounce; wait for that entrance to end.
    await offsite.evaluate(async (element) => {
      const entering = document.getAnimations().filter((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        return target instanceof Element && target.contains(element) && animation.effect?.getComputedTiming().endTime !== Infinity;
      });
      await Promise.all(entering.map((animation) => animation.finished.catch(() => undefined)));
    });
    await expect
      .poll(async () => {
        await offsite.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
        return transcriptMotion(page);
      })
      .toEqual({ still: true, bottom: "away" });
    await expect
      .poll(() =>
        offsite.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return hit !== null && element.contains(hit);
        }),
      )
      .toBe(true);
    await offsite.tap();
    await expect(calendar.locator(selectedEvent(OFFSITE))).toContainText("Cả ngày, 2026-10-07 đến 2026-10-09");
    await expect(calendar.locator(selectedEvent(OFFSITE))).toContainText("Kéo dài 3 ngày");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe("light");
  } finally {
    await context.close();
  }
});
