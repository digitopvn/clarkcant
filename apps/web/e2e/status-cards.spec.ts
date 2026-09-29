import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * A status, the progress of one thing, and a few labelled facts, placed in the conversation and browsed in the library.
 *
 * The cards are placed through the views a model's `show_view` uses, so their props are checked by the host and a card
 * that does not fit is refused with the host's own reason. What only a browser can say is what a person sees: the tone
 * said in words and not by colour alone, the as-of time in their own locale, a progress bar a screen reader can read,
 * steps with the current one marked, facts that line up, no freshness badge claiming a reading is live, and a page that
 * still fits a phone.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

type Which = "trạng thái" | "tiến độ" | "các bước" | "chi tiết";
const ROLE: Record<Which, string> = { "trạng thái": "status", "tiến độ": "progress", "các bước": "progress", "chi tiết": "details" };

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
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

/** Ask the fixture model to place a card, and return the newest one of its kind in the conversation. */
async function place(page: Page, which: Which): Promise<Locator> {
  const selector = `[data-widget-role='${ROLE[which]}']`;
  const before = await page.locator(selector).count();
  await say(page, `đặt thẻ ${which}`);
  await expect(page.locator(selector)).toHaveCount(before + 1, { timeout: 20_000 });
  // By position, not `.last()`: a later card must not move this locator onto itself.
  return page.locator(selector).nth(before);
}

async function placeAll(page: Page): Promise<{ status: Locator; value: Locator; steps: Locator; details: Locator }> {
  return {
    status: await place(page, "trạng thái"),
    value: await place(page, "tiến độ"),
    steps: await place(page, "các bước"),
    details: await place(page, "chi tiết"),
  };
}

/**
 * Wait for a card to hold still. Everything that lands in the conversation comes up and settles, scaled a little on the
 * way, so a position read during that is the position of a moment rather than of the card. A looping animation never
 * stops and is not counted.
 */
async function settled(target: Locator): Promise<void> {
  await target.evaluate(async (element) => {
    const frame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
    const moving = (): boolean =>
      document.getAnimations().some((animation) => {
        const node = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
        return (
          node !== null &&
          (node.contains(element) || element.contains(node)) &&
          animation.playState === "running" &&
          animation.effect?.getComputedTiming().iterations !== Infinity
        );
      });
    const deadline = performance.now() + 5_000;
    for (let still = 0; still < 6 && performance.now() < deadline; ) {
      await frame();
      still = moving() ? 0 : still + 1;
    }
  });
}

/** Where a fact's value sits against its label, read in one frame so a scroll between two reads cannot skew it. */
async function factOffset(details: Locator, label: string): Promise<{ dy: number; dx: number }> {
  return details.locator(`[data-details-item='${label}']`).evaluate((row) => {
    const term = row.querySelector("dt")?.getBoundingClientRect();
    const value = row.querySelector("dd")?.getBoundingClientRect();
    if (term === undefined || value === undefined) throw new Error("the fact has no label or no value");
    return { dy: value.top - term.top, dx: value.left - term.left };
  });
}

/**
 * The card says it shows what Clark stated, at the time its message was kept, as a time the reader can read: the time
 * alone today. The attribute is the stored instant, so the words are checked against it rather than against a clock.
 */
async function expectStated(card: Locator): Promise<void> {
  const stated = card.locator("time[data-status-stated-at]");
  await expect(stated).toHaveCount(1);
  const at = await stated.getAttribute("data-status-stated-at");
  expect(Number.isNaN(Date.parse(at ?? "")), "the stated time is an instant").toBe(false);
  expect(await stated.getAttribute("datetime")).toBe(at);
  const shown = await stated.evaluate((element, instant) => {
    const time = new Intl.DateTimeFormat(document.documentElement.lang || "vi", { timeStyle: "short" }).format(new Date(instant));
    return { text: element.textContent ?? "", time };
  }, at ?? "");
  expect(shown.text).toBe(`Theo Clark lúc ${shown.time}`);
}

/**
 * How each fact of a details card sits in the space it was given: whether a label or a value spills out of its own box,
 * how narrow the label was squeezed, and whether a row reaches past the card.
 */
async function factFit(details: Locator): Promise<{ label: string; spills: boolean; labelWidth: number; pastCard: number; dy: number }[]> {
  return details.evaluate((card) => {
    const box = card.getBoundingClientRect();
    return [...card.querySelectorAll<HTMLElement>("[data-details-item]")].map((row) => {
      const term = row.querySelector("dt");
      const value = row.querySelector("dd");
      if (term === null || value === null) throw new Error("the fact has no label or no value");
      const termBox = term.getBoundingClientRect();
      const valueBox = value.getBoundingClientRect();
      return {
        label: row.dataset.detailsItem ?? "",
        spills: term.scrollWidth > term.clientWidth + 1 || value.scrollWidth > value.clientWidth + 1,
        labelWidth: termBox.width,
        pastCard: Math.max(termBox.right, valueBox.right) - box.right,
        dy: valueBox.top - termBox.top,
      };
    });
  });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function theme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"));
}

test("a status, a progress and a details card say what the model wrote, and nothing claims to be live", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await openApp(page);
  const { status, value, steps, details } = await placeAll(page);

  // The tone is a word beside its colour, so it is read the same by someone who cannot tell the colours apart.
  await expect(status.locator("[data-status-tone='warning']")).toBeVisible();
  await expect(status.locator("[data-status-tone-word='warning']")).toHaveText("Cảnh báo");
  await expect(status).toContainText("Chạy xong nhưng có 2 test chập chờn");
  await expect(status).toContainText("Hai test E2E phải chạy lại mới qua.");
  // The as-of time is the model's instant with its offset, shown as a time the reader can place, never as "now".
  const asOf = status.locator("[data-status-as-of] time");
  await expect(asOf).toHaveAttribute("datetime", "2026-09-30T07:30:00+07:00");
  await expect(asOf).toContainText("Tính đến");
  // A card that says when it was true needs nothing more: "as Clark stated" is for one that does not.
  await expect(status.locator("[data-status-stated-at]")).toHaveCount(0);

  // A value of a maximum is a progress bar a screen reader hears as the same figure a sighted reader sees.
  const bar = value.getByRole("progressbar");
  await expect(bar).toHaveAttribute("aria-valuemin", "0");
  await expect(bar).toHaveAttribute("aria-valuemax", "120");
  await expect(bar).toHaveAttribute("aria-valuenow", "42");
  await expect(bar).toHaveAttribute("aria-valuetext", "42 / 120 ảnh · 35%");
  await expect(bar).toHaveAccessibleName("Ảnh đã nhập");
  await expect(value.locator("[data-progress-percent='35']")).toHaveText("42 / 120 ảnh · 35%");
  // Progress looks like a reading, so it always says whose words it is and when they were kept, in the reader's time.
  await expectStated(value);

  // Steps say how many are finished and which one is current, in words as well as marks.
  await expect(steps.locator("[data-progress-kind='steps']")).toBeVisible();
  await expect(steps.locator("[data-progress-steps-summary='1/3']")).toHaveText("Xong 1/3 bước");
  await expect(steps.locator("[data-step-status]")).toHaveCount(3);
  const current = steps.locator("[aria-current='step']");
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("data-step-status", "current");
  await expect(current).toContainText("Chuyển đồ");
  await expect(current).toContainText("Đang làm");
  await expect(steps.locator("[data-step-status='done']")).toContainText("Xong");
  await expectStated(steps);

  // Facts are label and value pairs, each label beside its own value.
  await expect(details.locator("[data-details-item]")).toHaveCount(3);
  await expect(details.locator("[data-details-item='Tổng tiền'] dt")).toHaveText("Tổng tiền");
  await expect(details.locator("[data-details-item='Tổng tiền'] dd")).toHaveText("1.250.000 ₫");
  // Facts are what they are, with no time claimed for them unless the model gave one.
  await expect(details.locator(".cc-status-card-asof")).toHaveCount(0);
  await settled(details);
  const wide = await factOffset(details, "Khách hàng");
  expect(Math.abs(wide.dy), "a label and its value share a row at desktop width").toBeLessThan(4);
  expect(wide.dx).toBeGreaterThan(0);

  // What is shown is what the model wrote: no card carries a freshness badge and none has a control to press.
  for (const card of [status, value, steps, details]) {
    await expect(card.locator(".cc-freshness[data-freshness]")).toHaveCount(0);
    await expect(card.locator("button, a, input, select, textarea, [tabindex]")).toHaveCount(0);
  }

  expect(await theme(page)).toBe("dark");
  await status.scrollIntoViewIfNeeded();
  await settled(status);
  await page.screenshot({ path: testInfo.outputPath("status-cards-1280-dark.png"), fullPage: false });
  await details.scrollIntoViewIfNeeded();
  await settled(details);
  await page.screenshot({ path: testInfo.outputPath("status-cards-1280-dark-lower.png"), fullPage: false });

  // The same cards in the light theme keep their tone marks distinct from the card behind them.
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => theme(page)).toBe("light");
  const mark = status.locator(".cc-status-card-mark");
  const [markColour, cardColour] = await Promise.all([
    mark.evaluate((element) => getComputedStyle(element).color),
    status.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(markColour).not.toBe(cardColour);
  await status.scrollIntoViewIfNeeded();
  await settled(status);
  await page.screenshot({ path: testInfo.outputPath("status-cards-1280-light.png"), fullPage: false });
  await details.scrollIntoViewIfNeeded();
  await settled(details);
  await page.screenshot({ path: testInfo.outputPath("status-cards-1280-light-lower.png"), fullPage: false });
});

test("a progress value above its maximum is refused with the host's reason, and no card is drawn", async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  const before = await page.locator("[data-widget-role='progress']").count();
  await say(page, "đặt thẻ tiến độ sai");
  await expect(page.getByText("the value 130 is above the maximum 120").last()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-widget-role='progress']")).toHaveCount(before);
});

test("the cards add no motion of their own when motion is reduced", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);
  const value = await place(page, "tiến độ");
  const fill = value.locator(".cc-progress-fill");
  const motion = await fill.evaluate((element) => {
    const style = getComputedStyle(element);
    return { animation: style.animationName, transition: style.transitionDuration };
  });
  expect(motion.animation).toBe("none");
  expect(motion.transition.split(",").every((part) => Number.parseFloat(part) === 0)).toBe(true);
});

test("the cards read at phone width without scrolling sideways", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await openApp(page);
    const { status, value, steps, details } = await placeAll(page);
    for (const card of [status, value, steps, details]) {
      const box = await card.boundingBox();
      expect(box?.width ?? 0, "a card fits the phone's width").toBeLessThanOrEqual(390);
    }
    // At phone width a fact's value goes under its label, so a long value does not squeeze the label to nothing.
    await settled(details);
    const narrow = await factOffset(details, "Khách hàng");
    expect(narrow.dy).toBeGreaterThan(0);
    expect(Math.abs(narrow.dx)).toBeLessThan(4);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await status.scrollIntoViewIfNeeded();
    await settled(status);
    await page.screenshot({ path: testInfo.outputPath("status-cards-390.png") });
    await details.scrollIntoViewIfNeeded();
    await settled(details);
    await page.screenshot({ path: testInfo.outputPath("status-cards-390-lower.png") });
  } finally {
    await context.close();
  }
});

test("the library previews each card through the production renderer", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-extensions")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-extensions").click();
  await page.locator("[data-widget-library-open='browse']").click();
  await expect(page.locator("[data-widget-library='true']")).toBeVisible({ timeout: 20_000 });

  const expected: [string, string][] = [
    ["canvas.status@1", "[data-status-state='ready']"],
    ["canvas.progress@1", "[data-progress-state='ready']"],
    ["canvas.details@1", "[data-details-state='ready']"],
  ];
  for (const [id, ready] of expected) {
    await page.locator(`[data-widget-card='${id}']`).click();
    await expect(page.locator(`[data-widget-detail='${id}']`)).toBeVisible({ timeout: 20_000 });
    const preview = page.locator(`[data-widget-preview='${id}']`);
    await expect(preview).toBeVisible({ timeout: 20_000 });
    await expect(preview.locator(ready).first()).toBeVisible();
    await expect(preview.locator(".cc-freshness[data-freshness]")).toHaveCount(0);
    await settled(page.locator("[data-widget-library='true']"));
    await page.screenshot({ path: testInfo.outputPath(`library-${id.replace(/[@.]/gu, "-")}.png`) });
    await page.locator("[data-widget-library-back]").click();
    await expect(page.locator("[data-widget-grid]")).toBeVisible({ timeout: 20_000 });
  }
});

/** Ask for the fixture's grid of the three cards and return it. */
async function arrangeCards(page: Page): Promise<Locator> {
  const before = await page.locator("[data-layout-root]").count();
  await say(page, "bố cục thẻ trạng thái");
  await expect(page.locator("[data-layout-root]")).toHaveCount(before + 1, { timeout: 30_000 });
  return page.locator("[data-layout-root]").nth(before);
}

test("a details card as one tile of a three-column grid keeps each label beside or above its own value", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await openApp(page);
  const surface = await arrangeCards(page);
  const details = surface.locator("[data-widget-role='details']");
  await expect(details.locator("[data-details-item]")).toHaveCount(3);
  await expect(details.locator("[data-details-item='Địa chỉ giao hàng đầy đủ'] dd")).toHaveText("12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh");
  // In a layout, the cards read as they do on their own: the status and the progress say they are what Clark stated.
  await expectStated(surface.locator("[data-widget-role='progress']"));
  await expectStated(surface.locator("[data-widget-role='status']"));
  await settled(surface);

  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect.poll(() => theme(page)).toBe(scheme);
    const facts = await factFit(details);
    for (const fact of facts) {
      expect(fact.spills, `"${fact.label}" stays inside its own box`).toBe(false);
      expect(fact.pastCard, `"${fact.label}" stays inside the card`).toBeLessThanOrEqual(0.5);
      // A label is never squeezed to a sliver by a long value: it keeps room for a word, or goes above its value.
      expect(fact.labelWidth, `"${fact.label}" has room to be read`).toBeGreaterThan(48);
    }
    // Every row is laid out the same way, so labels and values line up down the card.
    const beside = facts.map((fact) => Math.abs(fact.dy) < 4);
    expect(new Set(beside).size, "every fact is laid out the same way").toBe(1);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await surface.scrollIntoViewIfNeeded();
    await settled(surface);
    await page.screenshot({ path: testInfo.outputPath(`status-cards-grid-1280-${scheme}.png`), fullPage: false });
  }
});

test("the grid of cards reads at phone width, each fact's value under its label", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await openApp(page);
    const surface = await arrangeCards(page);
    const details = surface.locator("[data-widget-role='details']");
    await expect(details.locator("[data-details-item]")).toHaveCount(3);
    await settled(surface);
    for (const fact of await factFit(details)) {
      expect(fact.spills, `"${fact.label}" stays inside its own box`).toBe(false);
      expect(fact.pastCard, `"${fact.label}" stays inside the card`).toBeLessThanOrEqual(0.5);
      expect(fact.dy, `"${fact.label}" goes under its label`).toBeGreaterThan(0);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await details.scrollIntoViewIfNeeded();
    await settled(details);
    await page.screenshot({ path: testInfo.outputPath("status-cards-grid-390.png") });
  } finally {
    await context.close();
  }
});

test("a status card an older node stored with a line break in its label says it cannot be read, and draws no forged line", async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  const before = await page.locator("[data-widget-role='status']").count();
  await say(page, "đặt thẻ trạng thái cũ");
  await expect(page.locator("[data-widget-role='status']")).toHaveCount(before + 1, { timeout: 20_000 });
  const card = page.locator("[data-widget-role='status']").nth(before);
  await expect(card.locator("[data-status-state='error']")).toHaveText("Thẻ trạng thái này không đọc được nên chưa hiển thị.");
  await expect(card.locator("[data-status-state='ready']")).toHaveCount(0);
  await expect(card).not.toContainText("Dòng hai");
});