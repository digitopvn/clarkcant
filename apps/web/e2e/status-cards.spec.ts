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
 * Which conversation the page is in, read from the requests the page itself makes for it. The node's timeline for that
 * conversation is what a card's stated time is checked against.
 */
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

/**
 * The card says it shows what Clark stated, at the time its message was kept, as a time the reader can read: the time
 * alone when that is today, the day and the time otherwise. Both are formatted from the stored instant, so a run that
 * crosses midnight between keeping the card and reading it still passes, and nothing is checked against a clock.
 *
 * The instant itself is the one the node kept: it is read back from the node's timeline for the snapshot of the card's
 * own instance, so a card that showed the time it was drawn, or any time but its capture, fails here.
 */
async function expectStated(page: Page, conversationId: string, card: Locator): Promise<void> {
  const stated = card.locator("time[data-status-stated-at]");
  await expect(stated).toHaveCount(1);
  const at = (await stated.getAttribute("data-status-stated-at")) ?? "";
  expect(Number.isNaN(Date.parse(at)), "the stated time is an instant").toBe(false);
  expect(await stated.getAttribute("datetime")).toBe(at);

  const instanceId = await card.evaluate(
    (element) => element.closest("[data-widget-instance]")?.getAttribute("data-widget-instance") ?? "",
  );
  expect(instanceId, "the card is drawn for an instance").not.toBe("");
  const response = await page.request.get(`${GATEWAY}/conversations/${encodeURIComponent(conversationId)}/timeline?after=0`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  expect(response.ok(), "the node gives the conversation's timeline").toBe(true);
  const timeline = (await response.json()) as { snapshots: { instanceId?: string; capturedAt: string }[] };
  const captured = timeline.snapshots.filter((snapshot) => snapshot.instanceId === instanceId);
  expect(captured, "the card's instance was kept once").toHaveLength(1);
  expect(Date.parse(at), "the card states the instant its snapshot was kept").toBe(Date.parse(captured[0]?.capturedAt ?? ""));

  const shown = await stated.evaluate((element, instant) => {
    const locale = document.documentElement.lang || "vi";
    const date = new Date(instant);
    return {
      text: element.textContent ?? "",
      timeOnly: new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(date),
      dayAndTime: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date),
    };
  }, at);
  expect([`Theo Clark lúc ${shown.timeOnly}`, `Theo Clark lúc ${shown.dayAndTime}`]).toContain(shown.text);
}

/**
 * How each fact of a details card sits in the space it was given: whether a label or a value spills out of its own box,
 * how narrow the label was squeezed, and whether a row reaches past the card.
 */
async function factFit(
  details: Locator,
): Promise<{ label: string; spills: boolean; labelWidth: number; listWidth: number; boxWidth: number; pastCard: number; dy: number }[]> {
  return details.evaluate((card) => {
    const box = card.getBoundingClientRect();
    const list = card.querySelector(".cc-details")?.getBoundingClientRect();
    // The box the details card sizes its columns by: its container query measures this, not the window.
    const sizedBy = card.querySelector(".cc-details-box")?.getBoundingClientRect();
    if (list === undefined || sizedBy === undefined) throw new Error("the details card has no list of facts");
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
        listWidth: list.width,
        boxWidth: sizedBy.width,
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
  const conversation = watchConversation(page);
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
  await expectStated(page, conversation(), value);

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
  await expectStated(page, conversation(), steps);

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
  // On its own the card is wider than the width its facts stack at, which is what the grid below is measured against.
  const alone = await factFit(details);
  expect(alone[0]?.boxWidth ?? 0, "a details card on its own is wider than the stacking width").toBeGreaterThan(360);

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
    // A preview draws a fixture nobody stated, so it never says Clark stated it: a card that would say so says "Sample".
    await expect(preview.locator("[data-status-stated-at]")).toHaveCount(0);
    await expect(preview).not.toContainText("Theo lời Clark");
    await expect(preview).not.toContainText("Theo Clark");
    if (id === "canvas.progress@1") await expect(preview.locator("[data-status-sample]").first()).toHaveText("Mẫu");
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

/**
 * How many columns a layout grid is drawn with, and how many its width has room for. A grid takes at most the columns
 * the tree asked for and never one narrower than 220px, so a three-column grid in the conversation column is as many
 * columns as fit there: the count is measured, not assumed.
 */
async function gridColumns(surface: Locator): Promise<{ drawn: number; fit: number; tiles: number }> {
  return surface.locator(".cc-layout-grid-body").first().evaluate((grid) => {
    const style = getComputedStyle(grid);
    const gap = Number.parseFloat(style.columnGap) || 0;
    const width = grid.getBoundingClientRect().width;
    const lefts = new Set([...grid.children].map((child) => Math.round(child.getBoundingClientRect().left)));
    return { drawn: lefts.size, fit: Math.max(1, Math.floor((width + gap) / (220 + gap))), tiles: grid.children.length };
  });
}

test("a details card as a tile of a grid asked for three columns keeps each label beside or above its own value", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const conversation = watchConversation(page);
  await openApp(page);
  const surface = await arrangeCards(page);
  const details = surface.locator("[data-widget-role='details']");
  await expect(details.locator("[data-details-item]")).toHaveCount(3);
  await expect(details.locator("[data-details-item='Địa chỉ giao hàng đầy đủ'] dd")).toHaveText("12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh");
  // In a layout, the cards read as they do on their own: the status and the progress say they are what Clark stated.
  await expectStated(page, conversation(), surface.locator("[data-widget-role='progress']"));
  await expectStated(page, conversation(), surface.locator("[data-widget-role='status']"));
  await settled(surface);

  // The tree asks for three columns; the conversation column is drawn with as many as fit at 220px or more, never more
  // than three. At 1280 that is two, and the test says so rather than calling it a three-column grid.
  const columns = await gridColumns(surface);
  expect(columns.tiles).toBe(3);
  expect(columns.drawn, "the grid is drawn with as many columns as fit, up to the three asked for").toBe(Math.min(3, columns.fit));
  expect(columns.drawn, "a grid asked for three columns is two in the conversation column at 1280").toBe(2);
  testInfo.annotations.push({ type: "grid columns at 1280", description: `${columns.drawn} of the 3 asked for` });

  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect.poll(() => theme(page)).toBe(scheme);
    const facts = await factFit(details);
    for (const fact of facts) {
      expect(fact.spills, `"${fact.label}" stays inside its own box`).toBe(false);
      expect(fact.pastCard, `"${fact.label}" stays inside the card`).toBeLessThanOrEqual(0.5);
      // A label is never squeezed to a sliver by a long value: it keeps room for a word, or goes above its value.
      expect(fact.labelWidth, `"${fact.label}" has room to be read`).toBeGreaterThan(48);
      // Beside its value a label takes at most 40% of the list; otherwise the value is under it.
      expect(fact.labelWidth <= fact.listWidth * 0.4 + 1 || fact.dy > 0, `"${fact.label}" takes at most 40% or sits above`).toBe(true);
      // The card stacks by the width of its own box, not the window's: the window is 1280 wide, where the same card on
      // its own keeps its values beside their labels, and a tile narrower than 360px puts each value under its label.
      if (fact.boxWidth <= 360) expect(fact.dy, `"${fact.label}" goes under its label in a ${fact.boxWidth}px tile`).toBeGreaterThan(0);
      else expect(Math.abs(fact.dy), `"${fact.label}" stays beside its label in a ${fact.boxWidth}px tile`).toBeLessThan(4);
    }
    // At 1280 the tile is narrower than the stacking width, so the container query is what stacks it.
    if (columns.drawn > 1) expect(facts[0]?.boxWidth ?? 0, "a tile of a grid is narrower than the stacking width").toBeLessThanOrEqual(360);
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