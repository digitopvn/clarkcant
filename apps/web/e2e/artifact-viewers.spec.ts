import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * A block of code, a diff and a file, placed in the conversation and browsed in the library.
 *
 * The cards are placed through the views a model's `show_view` uses, so their props are checked by the host and a card
 * that does not fit is refused with the host's own reason. What only a browser can say is what a person sees: code
 * shown as text even where it looks like markup, line numbers that start where the model said, a copy that really
 * reaches the clipboard, a diff whose signs and numbers a screen reader hears as words, a file card with nothing to
 * press, scrolls a keyboard can reach, no freshness badge, and a page that still fits a phone.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

type Which = "khối mã" | "khối mã ẩn" | "bản diff" | "bản diff ẩn" | "thẻ tệp";
const ROLE: Record<Which, string> = {
  "khối mã": "code",
  "khối mã ẩn": "code",
  "bản diff": "diff",
  "bản diff ẩn": "diff",
  "thẻ tệp": "file",
};

/** Written by code point, so no hidden character sits in this file's own source. */
const BIDI = String.fromCodePoint(0x202e);
const ZERO_WIDTH = String.fromCodePoint(0x200b);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
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

/** Ask the fixture model to place a card, and return the newest one of its kind in the conversation. */
async function place(page: Page, which: Which): Promise<Locator> {
  const selector = `[data-widget-role='${ROLE[which]}']`;
  const before = await page.locator(selector).count();
  await say(page, `đặt ${which}`);
  await expect(page.locator(selector)).toHaveCount(before + 1, { timeout: 20_000 });
  // By position, not `.last()`: a later card must not move this locator onto itself.
  return page.locator(selector).nth(before);
}

async function placeAll(page: Page): Promise<{ code: Locator; diff: Locator; file: Locator }> {
  return { code: await place(page, "khối mã"), diff: await place(page, "bản diff"), file: await place(page, "thẻ tệp") };
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

/**
 * How far the last line number sits from the last line of code, in pixels. Each number is on its own line of the gutter,
 * so a line the gutter did not count, or counted twice, moves the last number off the last line.
 */
async function lastLineDrift(code: Locator): Promise<number> {
  return code.locator("[data-viewer-scroll='code']").evaluate((element) => {
    const numbers = element.querySelector(".cc-viewer-gutter")?.firstChild;
    const body = element.querySelector(".cc-code-body code");
    if (numbers === null || numbers === undefined || body === null) throw new Error("the block has no numbers or no code");
    const text = numbers.textContent ?? "";
    const range = document.createRange();
    range.setStart(numbers, text.lastIndexOf("\n") + 1);
    range.setEnd(numbers, text.length);
    const number = range.getBoundingClientRect();
    const lines = body.getClientRects();
    const line = lines[lines.length - 1];
    if (line === undefined) throw new Error("the code has no lines");
    return Math.abs((number.top + number.bottom) / 2 - (line.top + line.bottom) / 2);
  });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function theme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"));
}

test("code, a diff and a file show what the model wrote, as text, and nothing claims to be live", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await openApp(page);
  const { code, diff, file } = await placeAll(page);

  // Code that looks like markup is shown as the characters the model wrote, and no script element is added for it.
  await expect(code.locator("[data-viewer-state='ready']")).toBeVisible();
  await expect(code.locator(".cc-code-body")).toContainText('const note = "<script>alert(1)</script>";');
  await expect(code.locator("script")).toHaveCount(0);
  await expect(code.locator(".cc-viewer-name")).toHaveText("packages/billing/src/format-money.ts");
  await expect(code.locator(".cc-viewer-meta")).toHaveText("ts · Dòng 40–44");
  // The numbers start at the model's first line, and a screen reader is not read them one by one.
  const gutter = code.locator(".cc-viewer-gutter");
  await expect(gutter).toHaveAttribute("aria-hidden", "true");
  await expect(gutter).toHaveText(["40\n41\n42\n43\n44"]);
  // Each number sits on its own line of code: the last number and the last line share a row, so none has drifted.
  expect(await lastLineDrift(code), "the last line number sits beside the last line of code").toBeLessThan(3);

  // The copy button is named after what it copies, starting with the word it shows.
  await expect(code.locator("[data-viewer-copy]")).toHaveAccessibleName("Sao chép mã: packages/billing/src/format-money.ts");
  // The status region is there before anything is copied, so the first result is announced; it takes no room while empty.
  const status = code.locator("[data-copy-state]");
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveAttribute("data-copy-state", "idle");
  expect(await status.evaluate((element) => getComputedStyle(element).display)).not.toBe("none");

  // The bounded scroll is a named region a keyboard can reach.
  const scroll = code.locator("[data-viewer-scroll='code']");
  await expect(scroll).toHaveAttribute("role", "region");
  await expect(scroll).toHaveAccessibleName("Mã: packages/billing/src/format-money.ts");
  await scroll.scrollIntoViewIfNeeded();
  await settled(code);
  const unfocused = await scroll.screenshot();
  // Tab from the copy button, the control just before it, so the focus arrives the way a keyboard user's does.
  await code.locator("[data-viewer-copy]").focus();
  await page.keyboard.press("Tab");
  await expect(scroll).toBeFocused();
  const ring = await scroll.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      offset: Number.parseFloat(style.outlineOffset),
    };
  });
  expect(ring.style, "a focused scroll shows a ring").not.toBe("none");
  expect(ring.width).toBeGreaterThan(0);
  // The ring is drawn inside the scroll's own box, so a card that clips what overflows it cannot hide the ring.
  expect(ring.offset + ring.width, "the ring sits inside the scroll").toBeLessThanOrEqual(0);
  // And it is really painted: the focused scroll does not look like the unfocused one.
  const focused = await scroll.screenshot();
  expect(focused.equals(unfocused), "focus changes what the scroll looks like").toBe(false);

  // Copy puts the code itself on the clipboard, and says so in words.
  await code.locator("[data-viewer-copy]").click();
  await expect(code.locator("[data-copy-state='copied']")).toHaveText("Đã sao chép mã.");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.split("\n")).toHaveLength(5);
  expect(copied).toContain('const note = "<script>alert(1)</script>";');
  expect(copied.startsWith("// Định dạng số tiền theo đồng Việt Nam.")).toBe(true);

  // The diff counts what it shows, and each line has a sign, its numbers, and its kind in words for a screen reader.
  await expect(diff.locator("[data-diff-summary='2:3:1']")).toHaveText("2 tệp thay đổi: thêm 3 dòng, bớt 1 dòng");
  const changed = diff.locator("[data-diff-path='packages/billing/src/format-money.ts']");
  await expect(changed.locator(".cc-diff-header")).toHaveText(
    "@@ -40,3 +40,3 @@ export function formatMoney(amount: number): string {",
  );
  const removed = changed.locator("[data-line-kind='remove']");
  await expect(removed.locator(".cc-diff-gutter")).toHaveText("−");
  await expect(removed.locator(".cc-viewer-num").first()).toHaveText("41");
  await expect(removed.locator(".cc-sr-only")).toHaveText("Bớt, dòng cũ 41:");
  const added = changed.locator("[data-line-kind='add']");
  await expect(added.locator(".cc-diff-gutter")).toHaveText("+");
  await expect(added.locator(".cc-viewer-num").nth(1)).toHaveText("41");
  await expect(added.locator(".cc-sr-only")).toHaveText("Thêm, dòng mới 41:");
  // A remove and an add are told apart by more than colour: their backgrounds differ, and so do their signs.
  const [removeBackground, addBackground] = await Promise.all([
    removed.evaluate((element) => getComputedStyle(element).backgroundColor),
    added.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(removeBackground).not.toBe(addBackground);
  const created = diff.locator("[data-diff-path='packages/billing/test/format-money.spec.ts']");
  await expect(created.locator(".cc-diff-header")).toHaveText("@@ -0,0 +1,2 @@");
  await expect(created.locator("[data-line-kind='add']")).toHaveCount(2);
  await expect(diff.locator("[data-viewer-scroll='diff']")).toHaveCount(2);
  await expect(diff.locator("[data-viewer-scroll='diff']").first()).toHaveAccessibleName(
    "Diff: packages/billing/src/format-money.ts",
  );

  // A file card names and describes the file; it has nothing to press and says it opens nothing.
  await expect(file.locator(".cc-viewer-file-name")).toHaveText("bao-cao-quy-3.pdf");
  await expect(file.locator("[data-file-fact='type'] dd")).toHaveText("application/pdf");
  await expect(file.locator("[data-file-fact='size'] dd")).toHaveAttribute("title", "482133 B");
  await expect(file.locator("[data-file-fact='path'] dd")).toHaveText("Tài liệu/Báo cáo/bao-cao-quy-3.pdf");
  await expect(file.locator("[data-file-named-only]")).toHaveText("Thẻ chỉ nêu tệp này; không mở hay tải tệp từ đây được.");
  await expect(file.locator("a, button, input, select, textarea, [tabindex]")).toHaveCount(0);

  // What is shown is what the model wrote when it placed the card: no card carries a freshness badge.
  for (const card of [code, diff, file]) await expect(card.locator(".cc-freshness[data-freshness]")).toHaveCount(0);

  expect(await theme(page)).toBe("dark");
  for (const [name, card] of [
    ["code", code],
    ["diff", diff],
    ["file", file],
  ] as const) {
    await card.scrollIntoViewIfNeeded();
    await settled(card);
    await page.screenshot({ path: testInfo.outputPath(`artifact-${name}-1280-dark.png`) });
  }

  // The same cards in the light theme: an added line stays distinct from the card behind it.
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => theme(page)).toBe("light");
  const [lineColour, cardColour] = await Promise.all([
    added.evaluate((element) => getComputedStyle(element).backgroundColor),
    diff.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(lineColour).not.toBe(cardColour);
  for (const [name, card] of [
    ["code", code],
    ["diff", diff],
    ["file", file],
  ] as const) {
    await card.scrollIntoViewIfNeeded();
    await settled(card);
    await page.screenshot({ path: testInfo.outputPath(`artifact-${name}-1280-light.png`) });
  }
});

test("a diff whose hunk cannot be numbered is refused with the host's reason, and no card is drawn", async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  const before = await page.locator("[data-widget-role='diff']").count();
  await say(page, "đặt bản diff sai");
  await expect(page.getByText("starts at old line 0, so it can only add lines").last()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-widget-role='diff']")).toHaveCount(before);
});

test("a line break inside one line of a diff is refused with the host's reason, and no card is drawn", async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  const before = await page.locator("[data-widget-role='diff']").count();
  await say(page, "đặt bản diff xuống dòng");
  await expect(page.getByText("contains U+2028, a line break").last()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-widget-role='diff']")).toHaveCount(before);
});

/** Check a card draws each hidden character as a visible marker, never the character itself, and warns about it. */
async function expectMarked(card: Locator, body: string, markers: { codePoint: string; title: string }[], warning: string): Promise<void> {
  for (const marker of markers) {
    const drawn = card.locator(`${body} [data-hidden-char='${marker.codePoint}']`);
    await expect(drawn).toHaveCount(1);
    await expect(drawn).toHaveText(`⟨${marker.codePoint}⟩`);
    await expect(drawn).toHaveAttribute("title", marker.title);
  }
  await expect(card.locator("[data-hidden-char]")).toHaveCount(markers.length);
  const text = (await card.locator(body).textContent()) ?? "";
  for (const hidden of [BIDI, ZERO_WIDTH, LINE_SEPARATOR]) expect(text, "no hidden character is drawn raw").not.toContain(hidden);
  await expect(card.locator(`[data-viewer-hidden='${markers.length}']`)).toHaveText(warning);
}

const BIDI_TITLE = "U+202E: ký tự đổi hướng chữ, được hiện ra thay vì áp dụng";
const ZERO_WIDTH_TITLE = "U+200B: ký tự vô hình, được hiện ra để không thể ẩn đi";

test("hidden characters in code and a diff are drawn as markers with a warning, and a line separator counts as a line", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await openApp(page);
  const code = await place(page, "khối mã ẩn");
  const diff = await place(page, "bản diff ẩn");

  await expect(code.locator(".cc-viewer-name")).toHaveText("src/auth/role.ts");
  await expectMarked(
    code,
    ".cc-code-body",
    [
      { codePoint: "U+202E", title: BIDI_TITLE },
      { codePoint: "U+200B", title: ZERO_WIDTH_TITLE },
    ],
    "Đoạn mã này có 2 ký tự ẩn có thể khiến mã đọc khác với vẻ ngoài. Mỗi ký tự được hiện thành ⟨U+…⟩ thay vì được áp dụng.",
  );
  // The four lines the model wrote hold a line separator, which breaks a line wherever the code is read: it is counted,
  // so there are five numbered lines and the last number still sits beside the last line.
  await expect(code.locator(".cc-viewer-gutter")).toHaveText(["10\n11\n12\n13\n14"]);
  await expect(code.locator(".cc-viewer-meta")).toContainText("Dòng 10–14");
  expect(await lastLineDrift(code), "the last line number sits beside the last line of code").toBeLessThan(3);

  await expectMarked(
    diff,
    "[data-line-kind='add'] code",
    [{ codePoint: "U+202E", title: BIDI_TITLE }],
    "Bản diff này có 1 ký tự ẩn có thể khiến các dòng đọc khác với vẻ ngoài. Mỗi ký tự được hiện thành ⟨U+…⟩ thay vì được áp dụng.",
  );
  // A line with nothing hidden in it is drawn untouched.
  await expect(diff.locator("[data-line-kind='remove'] code")).toHaveText('const role = "user";');

  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect.poll(() => theme(page)).toBe(colorScheme);
    for (const [name, card] of [
      ["code", code],
      ["diff", diff],
    ] as const) {
      await card.scrollIntoViewIfNeeded();
      await settled(card);
      await page.screenshot({ path: testInfo.outputPath(`artifact-hidden-${name}-1280-${colorScheme}.png`) });
    }
  }

  // At phone width the markers and the warning still fit, and nothing widens the page.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await context.newPage();
  try {
    await openApp(phone);
    const phoneCode = await place(phone, "khối mã ẩn");
    const phoneDiff = await place(phone, "bản diff ẩn");
    for (const [name, card] of [
      ["code", phoneCode],
      ["diff", phoneDiff],
    ] as const) {
      await expect(card.locator("[data-viewer-hidden]")).toBeVisible();
      const box = await card.boundingBox();
      expect(box?.width ?? 0, "a card fits the phone's width").toBeLessThanOrEqual(390);
      await card.scrollIntoViewIfNeeded();
      await settled(card);
      await phone.screenshot({ path: testInfo.outputPath(`artifact-hidden-${name}-390.png`) });
    }
    expect(await horizontalOverflow(phone)).toBeLessThanOrEqual(0);
  } finally {
    await context.close();
  }
});

test("a copy the browser refuses says so in words, and a second try is announced again", async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  const code = await place(page, "khối mã");
  // The browser refuses the write, as it does when the page lacks permission or focus.
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Write permission denied.", "NotAllowedError")),
    });
  });
  const status = code.locator("[data-copy-state]");
  await expect(status).toHaveAttribute("data-copy-state", "idle");
  await expect(status).toHaveAttribute("role", "status");

  const failed = "Không sao chép được. Hãy chọn đoạn mã rồi tự sao chép.";
  await code.locator("[data-viewer-copy]").click();
  await expect(code.locator("[data-copy-state='failed']")).toHaveText(failed);
  await expect(code.locator("[data-viewer-copy]")).toHaveAttribute("data-viewer-copy", "failed");
  const first = await status.locator("span").elementHandle();
  if (first === null) throw new Error("the status holds no message");

  // The same words again are a new message: the old one is replaced rather than left in place, so it is read again.
  await code.locator("[data-viewer-copy]").click();
  await expect.poll(() => first.evaluate((element) => element.isConnected)).toBe(false);
  await expect(code.locator("[data-copy-state='failed']")).toHaveText(failed);
});

test("the cards add no motion of their own when motion is reduced", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);
  const code = await place(page, "khối mã");
  for (const selector of ["[data-viewer-scroll='code']", "[data-viewer-copy]"]) {
    const motion = await code.locator(selector).evaluate((element) => {
      const style = getComputedStyle(element);
      return { animation: style.animationName, transition: style.transitionDuration };
    });
    expect(motion.animation, selector).toBe("none");
    expect(
      motion.transition.split(",").every((part) => Number.parseFloat(part) === 0),
      selector,
    ).toBe(true);
  }
});

test("the cards read at phone width; a long line scrolls inside its card, not the page", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await openApp(page);
    const { code, diff, file } = await placeAll(page);
    for (const card of [code, diff, file]) {
      const box = await card.boundingBox();
      expect(box?.width ?? 0, "a card fits the phone's width").toBeLessThanOrEqual(390);
    }
    // The long line is still there, reachable by scrolling the block rather than by wrapping or widening the page.
    for (const scroll of [code.locator("[data-viewer-scroll='code']"), diff.locator("[data-viewer-scroll='diff']").first()]) {
      const widths = await scroll.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
      expect(widths.scroll, "the long line scrolls inside its block").toBeGreaterThan(widths.client);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const [name, card] of [
      ["code", code],
      ["diff", diff],
      ["file", file],
    ] as const) {
      await card.scrollIntoViewIfNeeded();
      await settled(card);
      await page.screenshot({ path: testInfo.outputPath(`artifact-${name}-390.png`) });
    }
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

  for (const id of ["canvas.code@1", "canvas.diff@1", "canvas.file@1"]) {
    await page.locator(`[data-widget-card='${id}']`).click();
    await expect(page.locator(`[data-widget-detail='${id}']`)).toBeVisible({ timeout: 20_000 });
    const preview = page.locator(`[data-widget-preview='${id}']`);
    await expect(preview).toBeVisible({ timeout: 20_000 });
    await expect(preview.locator("[data-viewer-state='ready']").first()).toBeVisible();
    await expect(preview.locator("[data-viewer-state='error']")).toHaveCount(0);
    await expect(preview.locator(".cc-freshness[data-freshness]")).toHaveCount(0);
    await settled(page.locator("[data-widget-library='true']"));
    await page.screenshot({ path: testInfo.outputPath(`library-${id.replace(/[@.]/gu, "-")}.png`) });
    await page.locator("[data-widget-library-back]").click();
    await expect(page.locator("[data-widget-grid]")).toBeVisible({ timeout: 20_000 });
  }
});
