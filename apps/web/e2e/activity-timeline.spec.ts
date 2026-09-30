import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The activity timeline, placed in the conversation from the Library's own fixture, and previewed in the Library.
 *
 * The browser runs in New York while the timeline is set to Saigon, so a page that grouped entries by the browser's own
 * timezone would put the disk alert (17:40 UTC on the 29th, 00:40 on the 30th in Saigon, 13:40 on the 29th in New York)
 * on the wrong day, and these tests would see it. What only a browser can say is what a person does with the timeline:
 * walk the entries with the keyboard, select one and read it, find it as they left it after a reload, see the node's
 * refusal said in their language, turn pages, and use it all on a phone.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

test.use({ timezoneId: "America/New_York" });

const TIMELINES = "[data-widget-role='timeline']:has(.cc-timeline-root)";
const entry = (id: string): string => `[data-timeline-entry='${id}']`;

type Which = "" | "cũ trước";

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
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

async function say(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill(text);
  await composer.press("Enter");
}

/** Ask the fixture model for a timeline, and return it by position so a later one cannot move the locator. */
async function place(page: Page, which: Which): Promise<Locator> {
  const before = await page.locator(TIMELINES).count();
  await say(page, `đặt dòng thời gian${which === "" ? "" : ` ${which}`}`);
  await expect(page.locator(TIMELINES)).toHaveCount(before + 1, { timeout: 20_000 });
  return page.locator(TIMELINES).nth(before);
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

async function instanceOf(timeline: Locator): Promise<string> {
  const instanceId = await timeline.evaluate((element) => element.closest("[data-widget-instance]")?.getAttribute("data-widget-instance") ?? "");
  expect(instanceId, "the timeline is drawn for an instance").not.toBe("");
  return instanceId;
}

/** The selection the node holds for an instance, read from the conversation's timeline. */
async function heldState(page: Page, conversationId: string, instanceId: string): Promise<unknown> {
  const response = await page.request.get(`${GATEWAY}/conversations/${encodeURIComponent(conversationId)}/timeline?after=0`, {
    headers: authorized(),
  });
  expect(response.ok(), "the node gives the conversation's timeline").toBe(true);
  const timeline = (await response.json()) as { instances?: { instanceId: string; state?: Record<string, unknown> }[] };
  return timeline.instances?.find((instance) => instance.instanceId === instanceId)?.state ?? {};
}

async function focused(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute("data-timeline-entry") ?? null);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test("the timeline groups entries by its own timezone, walks them from the keyboard, and keeps a selection across a reload", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const conversation = watchConversation(page);
  await openApp(page);
  const before = await page.locator(TIMELINES).count();
  const timeline = await place(page, "");

  await expect(timeline.locator("[data-timeline-summary]")).toHaveText(
    "7 mục · 2026-09-28 đến 2026-09-30 · mới nhất trước · giờ theo múi Asia/Saigon",
  );
  // Three days in Saigon, newest first; the alert at 17:40 UTC on the 29th is on the 30th there, though not in New York.
  const days = await timeline.locator("[data-timeline-day]").evaluateAll((items) => items.map((item) => item.getAttribute("data-timeline-day")));
  expect(days).toEqual(["2026-09-30", "2026-09-29", "2026-09-28"]);
  await expect(timeline.locator(`[data-timeline-day='2026-09-30'] ${entry("disk-alert")}`)).toContainText("00:40");
  await expect(timeline.locator(`[data-timeline-day='2026-09-30'] ${entry("tests-passed")}`)).toContainText("15:42");
  // An all-day entry says so, and is set apart by a double border as well as the words.
  const freeze = timeline.locator(entry("freeze"));
  await expect(freeze).toContainText("Cả ngày");
  await expect(freeze).toHaveAttribute("data-all-day", "true");
  // A tone is said in words beside its colour.
  await expect(timeline.locator(`${entry("migration-failed")} [data-timeline-tone-word='danger']`)).toHaveText(/\S/u);
  await expect(timeline.locator(entry("migration-failed"))).toContainText("bởi Lan");
  // The long description opens folded, and unfolds.
  const fold = timeline.locator("[data-timeline-fold='deploy-started']");
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(timeline.locator("[data-timeline-description='deploy-started']")).toContainText("kênh phát hành.");
  // The text alternative lists every entry.
  await expect(timeline.locator("[data-timeline-text-entry]")).toHaveCount(7);

  // One entry is the way in; the arrows walk the page, Home and End go to either end, Enter selects.
  await expect(timeline.locator("[data-timeline-entry][tabindex='0']")).toHaveCount(1);
  await timeline.locator("[data-timeline-entry][tabindex='0']").focus();
  const first = await focused(page);
  await page.keyboard.press("End");
  expect(await focused(page)).toBe("kickoff");
  await page.keyboard.press("Home");
  expect(await focused(page)).toBe(first);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const chosen = await focused(page);
  expect(chosen).not.toBe(first);
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp");
  expect(await focused(page)).toBe("rc-tagged");
  await page.keyboard.press("Enter");
  const selected = timeline.locator("[data-timeline-selected-entry='rc-tagged']");
  await expect(selected).toContainText("Gắn thẻ bản RC1");
  await expect(selected).toContainText("lúc 16:00");
  await expect(timeline.locator(entry("rc-tagged"))).toHaveAttribute("aria-pressed", "true");
  await expect(timeline.locator("[data-timeline-live]")).toContainText("Đã chọn: Gắn thẻ bản RC1");
  // Focus is drawn where it is.
  const outline = await timeline.locator(entry("rc-tagged")).evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe("none");
  await page.screenshot({ path: testInfo.outputPath("timeline-1280-dark.png"), fullPage: false });

  // The node keeps the selection, which is what voice and inspect_ui read.
  const instanceId = await instanceOf(timeline);
  await expect.poll(() => heldState(page, conversation(), instanceId), { timeout: 10_000 }).toEqual({ selectedId: "rc-tagged" });

  // After a reload the timeline opens as it was left.
  await openApp(page);
  const again = page.locator(TIMELINES).nth(before);
  await expect(again.locator("[data-timeline-selected-entry='rc-tagged']")).toBeVisible({ timeout: 20_000 });

  // Escape clears the selection, and the node forgets it too.
  await again.locator(entry("rc-tagged")).focus();
  await page.keyboard.press("Escape");
  await expect(again.locator("[data-timeline-selected-entry]")).toHaveCount(0);
  await expect(again.locator("[data-timeline-live]")).toHaveText("Đã bỏ chọn mục.");
  await expect.poll(() => heldState(page, conversation(), instanceId), { timeout: 10_000 }).toEqual({});
});

test("a selection the node refuses is undrawn, the reason is said in the person's language, and the kept one stays", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const conversation = watchConversation(page);
  await openApp(page);
  const timeline = await place(page, "");
  await timeline.locator(entry("tests-passed")).click();
  const instanceId = await instanceOf(timeline);
  await expect.poll(() => heldState(page, conversation(), instanceId), { timeout: 10_000 }).toEqual({ selectedId: "tests-passed" });

  // A page that still draws an entry the node no longer holds asks for it: here the request names an id the timeline
  // never had, which is what such a page would send.
  await page.route(`**/widgets/${instanceId}/actions`, async (route) => {
    const body = route.request().postDataJSON() as { input?: Record<string, unknown> };
    await route.continue({ postData: JSON.stringify({ ...body, input: { selectedId: "gone" } }) });
  });
  await timeline.locator(entry("kickoff")).click();
  await expect(timeline.locator("[data-timeline-message='true']")).toHaveText(
    "Dòng thời gian không giữ được lựa chọn này vì mục đó không còn trên dòng thời gian. Lựa chọn đã lưu được hiện lại.",
    { timeout: 20_000 },
  );
  // The refused selection is undrawn, and the one the node kept is drawn again.
  await expect(timeline.locator("[data-timeline-selected-entry='tests-passed']")).toBeVisible();
  await expect(timeline.locator(entry("kickoff"))).toHaveAttribute("aria-pressed", "false");
  expect(await heldState(page, conversation(), instanceId)).toEqual({ selectedId: "tests-passed" });
  await page.unroute(`**/widgets/${instanceId}/actions`);
});

test("a timeline with a repeated id or a hidden character is refused with the host's reason, and none is drawn", async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  const before = await page.locator(TIMELINES).count();
  await say(page, "đặt dòng thời gian trùng");
  await expect(page.getByText('ids repeat: "freeze"; each entry needs its own id').last()).toBeVisible({ timeout: 20_000 });
  await say(page, "đặt dòng thời gian ký tự ẩn");
  await expect(page.getByText(/canvas\.timeline@1 has props that do not fit its schema.*U\+202E/u).last()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(TIMELINES)).toHaveCount(before);
});

test("the oldest-first timeline pages five entries at a time, and the keyboard stays on the page shown", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await openApp(page);
  const timeline = await place(page, "cũ trước");
  await expect(timeline.locator("[data-timeline-page-label]")).toHaveText("Trang 1/2");
  await expect(timeline.locator("[data-timeline-entry]")).toHaveCount(5);
  await expect(timeline.locator("[data-timeline-previous]")).toBeDisabled();
  const firstDay = await timeline.locator("[data-timeline-day]").first().getAttribute("data-timeline-day");
  expect(firstDay).toBe("2026-09-28");
  await timeline.locator("[data-timeline-entry]").first().focus();
  expect(await focused(page)).toBe("kickoff");
  await page.keyboard.press("End");
  const last = await focused(page);
  await page.keyboard.press("ArrowDown");
  expect(await focused(page), "the arrows do not leave the page").toBe(last);

  await timeline.locator("[data-timeline-next]").click();
  await expect(timeline.locator("[data-timeline-page-label]")).toHaveText("Trang 2/2");
  await expect(timeline.locator("[data-timeline-entry]")).toHaveCount(2);
  await expect(timeline.locator("[data-timeline-next]")).toBeDisabled();
  await expect(timeline.locator("[data-timeline-entry][tabindex='0']")).toHaveCount(1);
  await timeline.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("timeline-1280-light.png") });
});

test("the timeline adds no motion of its own when motion is reduced", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);
  const timeline = await place(page, "");
  for (const selector of ["[data-timeline-entry]", "[data-timeline-fold]", "[data-timeline-text]"]) {
    const motion = await timeline.locator(selector).first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { animation: style.animationName, transition: style.transitionDuration };
    });
    expect(motion.animation, selector).toBe("none");
    expect(motion.transition.split(",").every((part) => Number.parseFloat(part) === 0), selector).toBe(true);
  }
});

test("the library previews the timeline fixtures through the production renderer, usable without a node", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-developer")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-developer").click();
  await page.locator("[data-widget-library-open='develop']").click();
  await expect(page.locator("[data-widget-library='true']")).toHaveAttribute("data-widget-library-mode", "develop");
  await page.locator("[data-widget-card='canvas.timeline@1']").click();
  await expect(page.locator("[data-widget-lab-controls='true']")).toBeVisible({ timeout: 20_000 });
  const preview = page.locator("[data-widget-preview='canvas.timeline@1']");
  await expect(preview).toBeVisible({ timeout: 20_000 });

  await page.locator("[data-widget-lab-fixture='true']").selectOption("timeline.normal");
  await expect(preview.locator("[data-widget-unavailable='true']")).toHaveCount(0);
  await expect(preview.locator("[data-timeline-selected-entry='deploy-started']")).toBeVisible();
  // Selection works in the preview as it does in the conversation.
  await preview.locator(entry("kickoff")).click();
  await expect(preview.locator("[data-timeline-selected-entry='kickoff']")).toBeVisible();
  await expect(preview.locator("[aria-pressed='true'][data-timeline-entry]")).toHaveCount(1);
  await expect(preview.locator(entry("kickoff"))).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(1, 1);
  await page.screenshot({ path: testInfo.outputPath("timeline-library-1280.png") });

  await page.locator("[data-widget-lab-fixture='true']").selectOption("timeline.truncated");
  await expect(preview.locator("[data-timeline-note='truncated']")).toBeVisible();
  await page.locator("[data-widget-lab-fixture='true']").selectOption("timeline.empty");
  await expect(preview.locator("[data-timeline-empty='true']")).toBeVisible();
});

test("the timeline is usable at phone width with touch, without scrolling sideways, in the light theme", async ({ browser }, testInfo) => {
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
    await openApp(page);
    const timeline = await place(page, "");
    const box = await timeline.boundingBox();
    expect(box?.width ?? 0, "the timeline fits the phone's width").toBeLessThanOrEqual(390);
    await timeline.locator(entry("deploy-started")).tap();
    await expect(timeline.locator("[data-timeline-selected-entry='deploy-started']")).toContainText("lúc 21:05");
    await timeline.locator("[data-timeline-fold='deploy-started']").tap();
    await timeline.locator("[data-timeline-text] > summary").tap();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe("light");
    await timeline.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("timeline-390-light.png"), fullPage: false });
    // The dark theme at the same width keeps it within the phone too.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe("dark");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath("timeline-390-dark.png"), fullPage: false });
  } finally {
    await context.close();
  }
});
