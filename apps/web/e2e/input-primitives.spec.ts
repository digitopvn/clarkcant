import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * A form, a list and a search box, used the way a person uses them.
 *
 * The form and the list are placed through the views a model's `show_view` uses, so their fields and items are checked
 * by the host and their action is compiled by it; both are bound to Clark, so the journey needs no container engine.
 * What only a browser can say is whether a person can fill in, fix, send, pick and page with a keyboard or a finger,
 * whether a mistake is shown where it is and focus goes to it, whether the node refuses what the page would not have
 * sent, and whether a search box in a composed surface narrows the table beside it.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const ACTION_ROUTE = /\/widgets\/[^/]+\/actions$/u;

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

/** Ask the fixture model to place a form or a list, and return the newest one in the conversation. */
async function place(page: Page, what: "biểu mẫu" | "danh sách" | "danh sách trống"): Promise<Locator> {
  const role = what === "biểu mẫu" ? "form" : "list";
  const selector = `[data-widget-role='${role}']`;
  const before = await page.locator(selector).count();
  await say(page, `đặt ${what}`);
  await expect(page.locator(selector)).toHaveCount(before + 1, { timeout: 20_000 });
  // By position, not `.last()`: a later widget must not move this locator onto itself.
  return page.locator(selector).nth(before);
}

/**
 * Wait for a widget to hold still. Everything that lands in the conversation comes up and settles, scaled a little on the
 * way, and a pressed button gives a little and springs back a moment after the press, so a size read during either is
 * the size of a moment rather than of the control. Still means nothing in or around the widget moving for a few frames
 * in a row; a looping animation never stops and is not counted. A button a finger has just tapped counts as moving until
 * the browser lets go of it: it stays pressed for a moment after the tap, and under reduced motion the press is a step
 * with no transition running, so nothing else says it is not at rest (a 44px button measured 42.68px for about 80ms).
 */
async function settled(target: Locator): Promise<void> {
  await target.evaluate(async (element) => {
    const frame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
    const moving = (): boolean =>
      element.matches(":active") ||
      element.querySelector(":active") !== null ||
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
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test("a form shows what is wrong where it is, then sends what was filled in to Clark", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  const form = await place(page, "biểu mẫu");
  const element = form.locator("form");
  await expect(element).toHaveAttribute("data-form-actionable", "true");
  const submit = form.locator("[data-form-submit]");
  await expect(submit).toHaveText("Gửi cho Clark");

  // Nothing is shown as wrong before the person has done anything.
  await expect(form.locator("[data-field-error]")).toHaveCount(0);
  // A slider nobody moved has no value, and says so, rather than sending wherever its thumb rests.
  await expect(form.locator("[data-field-output='minutes']")).toHaveText("Chưa chọn");

  // Sending an empty form sends nothing: the two required fields are marked and focus goes to the first.
  let sent = 0;
  page.on("request", (sentRequest) => {
    if (sentRequest.method() === "POST" && ACTION_ROUTE.test(sentRequest.url())) sent += 1;
  });
  await submit.click();
  await expect(form.locator("[data-form-result='invalid']")).toContainText("2 ô");
  await expect(form.locator("[data-field-error='topic']")).toBeVisible();
  await expect(form.locator("[data-field-error='day']")).toBeVisible();
  const topic = form.getByLabel(/^Chủ đề/u);
  await expect(topic).toBeFocused();
  await expect(topic).toHaveAttribute("aria-invalid", "true");
  // The error is what a screen reader hears with the field, not only what is painted beside it.
  const describedBy = (await topic.getAttribute("aria-describedby")) ?? "";
  expect(describedBy).not.toBe("");
  await expect(form.locator(`[id="${describedBy.split(" ").at(-1) ?? ""}"]`)).toHaveText("Cần điền ô này.");
  expect(sent).toBe(0);

  // Filled in from the keyboard alone: type, tab on, pick with arrows, press with Space.
  await topic.pressSequentially("Rà soát quý");
  await expect(form.locator("[data-field-error='topic']")).toHaveCount(0);
  await form.getByLabel(/^Ngày họp/u).fill("2026-10-05");
  await form.getByLabel(/^Giờ bắt đầu/u).fill("09:30");
  const slider = form.locator("[data-field='minutes'] input[type='range']");
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).not.toHaveAttribute("data-field-unset", "true");
  await expect(form.locator("[data-field-output='minutes']")).toHaveText("30");
  await form.getByRole("radio", { name: "Trực tuyến" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(form.getByRole("radio", { name: "Văn phòng" })).toBeChecked();
  const chip = form.getByRole("button", { name: "Bình" });
  await chip.focus();
  await page.keyboard.press("Space");
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  const remind = form.getByRole("switch", { name: /Nhắc trước 10 phút/u });
  await remind.focus();
  await page.keyboard.press("Space");
  await expect(remind).toHaveAttribute("aria-checked", "true");
  await form.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("form-filled-desktop.png") });

  // Sent: the person's message says what they filled in, and the turn was given the checked values.
  const pressed = page.waitForRequest((sentRequest) => sentRequest.method() === "POST" && ACTION_ROUTE.test(sentRequest.url()));
  await submit.focus();
  await page.keyboard.press("Enter");
  const press = await pressed;
  const body = press.postDataJSON() as { actionBindingId: string; expectedRevision: number; expectedBindingDigest: string; input: Record<string, unknown> };
  expect(body.input).toEqual({
    topic: "Rà soát quý",
    day: "2026-10-05",
    start: "09:30",
    minutes: 30,
    room: "hq",
    people: ["binh"],
    remind: true,
  });
  const bubble = page.locator("[data-role='user'] [data-bubble='user']").last();
  await expect(bubble).toContainText("Gửi cho Clark", { timeout: 30_000 });
  await expect(bubble).toContainText("Chủ đề: Rà soát quý");
  await expect(bubble).toContainText("Người tham dự: Bình");
  const reply = page.locator("[data-role='assistant']").last();
  await expect(reply).toContainText("đã nhận yêu cầu", { timeout: 30_000 });
  await expect(reply).toContainText("Ghi cuộc họp này vào danh sách việc cần làm");
  await expect(reply).toContainText('"topic":"Rà soát quý"');
  await expect(form.locator("[data-form-result='done']")).toContainText("đã nhận yêu cầu", { timeout: 10_000 });

  // What the page would never send, the node refuses on its own: a missing required value, a value outside its
  // options, and a field the form does not have.
  const attempt = async (input: Record<string, unknown>): Promise<{ status: number; code?: string; message?: string }> => {
    const answered = await request.post(press.url(), {
      headers: { authorization: `Bearer ${token()}` },
      data: { ...body, input, invocationId: `inv_${String(Date.now())}_${String(Math.random()).slice(2)}` },
    });
    return { status: answered.status(), ...((await answered.json()) as { code?: string; message?: string }) };
  };
  for (const input of [{ topic: "Họp" }, { topic: "Họp", day: "2026-10-05", room: "roof" }, { topic: "Họp", day: "2026-10-05", extra: "x" }]) {
    const refused = await attempt(input);
    expect(refused.status, JSON.stringify(input)).toBe(400);
    expect(refused.code).toBe("INVALID_INPUT");
    expect(refused.message ?? "").not.toBe("");
  }
});

test("a form asking for a secret is refused before it is drawn", async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  const before = await page.locator("[data-widget-role='form']").count();
  await say(page, "đặt biểu mẫu bí mật");
  const reply = page.locator("[data-role='assistant']").last();
  await expect(reply).toContainText("asks for a secret", { timeout: 20_000 });
  await expect(reply).toContainText("connection flow");
  await expect(page.locator("[data-widget-role='form']")).toHaveCount(before);
});

test("a list pages, picks by id, and sends the item a person pressed", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  const list = await place(page, "danh sách");
  const items = list.locator("[data-list-item]");
  await expect(list.locator("ul[data-list-state='ready']")).toBeVisible();
  await expect(items).toHaveCount(5);
  await expect(list.locator("[data-list-page-status]")).toContainText("1");
  await expect(list.locator("[data-list-page-status]")).toContainText("12");

  // Pick one from the keyboard, page on, and the pick is still that item.
  const first = list.locator("[data-list-select='task-2']");
  await first.focus();
  await page.keyboard.press("Space");
  await expect(first).toBeChecked();
  await expect(list.locator("[data-list-selected-count]")).toHaveAttribute("data-list-selected-count", "1");
  const next = list.locator("[data-list-page='next']");
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(items.first()).toHaveAttribute("data-list-item", "task-6");
  await expect(next).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(items).toHaveCount(2);
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await list.locator("[data-list-page='previous']").click();
  await list.locator("[data-list-page='previous']").click();
  await expect(list.locator("[data-list-select='task-2']")).toBeChecked();
  await list.locator("[data-list-clear-selection]").click();
  await expect(list.locator("[data-list-selected-count]")).toHaveAttribute("data-list-selected-count", "0");

  // Each item carries the one action, named with the item, and a press sends that item's id.
  const button = list.getByRole("button", { name: "Nhờ Clark xử lý: Việc số 3" });
  await expect(button).toBeVisible();
  const pressed = page.waitForRequest((sentRequest) => sentRequest.method() === "POST" && ACTION_ROUTE.test(sentRequest.url()));
  await button.click();
  const body = (await pressed).postDataJSON() as { input: Record<string, unknown> };
  expect(body.input).toEqual({ itemId: "task-3" });
  await expect(page.locator("[data-role='user'] [data-bubble='user']").last()).toHaveText("Nhờ Clark xử lý: Việc số 3", {
    timeout: 30_000,
  });
  await expect(list.locator("[data-list-result='done']")).toContainText("Việc số 3: ", { timeout: 30_000 });
  // Clark's answer is said once, in the conversation and beside the list.
  // The list hears the answer from the action and the conversation from its own stream, so the conversation is read
  // once it has it, and by what it says rather than by position: other replies may land after it. The reply that holds
  // the list carries the answer beside the list, which is checked on its own below.
  const once = (text: string): number => text.split("đã nhận yêu cầu").length - 1;
  const answers = page
    .locator("[data-role='assistant']")
    .filter({ hasText: "đã nhận yêu cầu" })
    .filter({ hasNot: page.locator("[data-widget-role='list']") });
  await expect(answers).toHaveCount(1, { timeout: 30_000 });
  expect(once(await answers.innerText())).toBe(1);
  expect(once(await list.locator("[data-list-result='done']").innerText())).toBe(1);
  await list.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("list-desktop.png") });

  // An empty list says so in its own words, with no buttons for items that are not there.
  const empty = await place(page, "danh sách trống");
  await expect(empty.locator("[data-list-state='empty']")).toHaveText("Không còn việc nào chờ.");
  await expect(empty.locator("[data-list-item-action]")).toHaveCount(0);
  await expect(empty.locator("[data-list-page]")).toHaveCount(0);
});

test("a search box in a composed surface narrows the table beside it, and nothing is sent", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  const before = await page.locator("[data-layout-root]").count();
  await say(page, "bố cục bảng điều khiển");
  await expect(page.locator("[data-layout-root]")).toHaveCount(before + 1, { timeout: 30_000 });
  const surface = page.locator("[data-layout-root]").nth(before);
  const card = surface.locator("[data-layout='card']");
  const search = card.locator("[data-slot='search'] [data-search-input]");
  const table = card.locator("[data-slot='table']");
  await expect(search).toBeVisible();
  const rows = table.locator("tbody tr[data-row-id]");
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  const all = await rows.count();
  const status = table.locator("[data-table-page-status]");
  const everything = (await status.textContent()) ?? "";

  let sent = 0;
  page.on("request", (sentRequest) => {
    if (sentRequest.method() === "POST" && /\/widgets\//u.test(sentRequest.url())) sent += 1;
  });

  // A query that matches nothing says so in the table, not by emptying it silently.
  await search.fill("không-có-gì-khớp");
  await expect(table.locator("[data-table-no-matches]")).toBeVisible();
  // Escape clears it, and every row is back.
  await search.press("Escape");
  await expect(rows).toHaveCount(all);
  await expect(status).toHaveText(everything);

  // A query that one row's first cell holds narrows to the rows that hold it.
  const firstCell = ((await rows.first().locator("td").first().textContent()) ?? "").trim();
  expect(firstCell).not.toBe("");
  await search.pressSequentially(firstCell);
  await search.press("Enter");
  await expect.poll(async () => rows.count()).toBeGreaterThan(0);
  await expect(status).not.toHaveText(everything);
  const matching = await rows.evaluateAll(
    (elements, query) => elements.every((row) => (row.textContent ?? "").toLowerCase().includes(query.toLowerCase())),
    firstCell,
  );
  expect(matching).toBe(true);
  await surface.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("search-narrows-desktop.png") });

  // The clear button empties the box, gives focus back to it, and every row returns.
  await card.locator("[data-search-clear]").click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(status).toHaveText(everything);
  expect(sent).toBe(0);
});

test("a form and a list read at phone width, and a finger can use them", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  // Reduced motion, so the transcript scrolls instantly. When a tap has to retry (the form is still arriving), Playwright
  // brings the target into view with `Element.scrollIntoView`, which follows the transcript's smooth scrolling: the call
  // returns with the target where it was and it glides into place over the next frames (755px to 647px over 11 frames,
  // measured here), so the tap lands on the spot it is leaving. On CI that missed the chip, a list item's checkbox and the
  // list's next page. What this test proves (the layout at phone width, and that a finger can use every control) does not
  // depend on the scroll being animated.
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  try {
    await openApp(page);
    const form = await place(page, "biểu mẫu");
    await form.getByRole("button", { name: "An" }).tap();
    await expect(form.getByRole("button", { name: "An" })).toHaveAttribute("aria-pressed", "true");
    const remind = form.getByRole("switch", { name: /Nhắc trước 10 phút/u });
    await remind.tap();
    await expect(remind).toHaveAttribute("aria-checked", "true");
    // Every control a finger presses is at least the size a finger needs.
    const targets: [string, Locator][] = [
      ["chip", form.getByRole("button", { name: "An" })],
      ["switch", remind],
      ["radio", form.locator("[data-field='room'] label").first()],
      ["date", form.getByLabel(/^Ngày họp/u)],
      ["send", form.locator("[data-form-submit]")],
    ];
    await settled(form);
    for (const [name, target] of targets) {
      const box = await target.boundingBox();
      expect(box?.height ?? 0, `the ${name} is at least 44px tall`).toBeGreaterThanOrEqual(44);
    }
    await form.locator("[data-form-submit]").tap();
    await expect(form.locator("[data-form-result='invalid']")).toBeVisible();
    await expect(form.getByLabel(/^Chủ đề/u)).toBeFocused();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await form.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("form-mobile.png") });

    const list = await place(page, "danh sách");
    await list.locator("[data-list-select='task-1']").tap();
    await expect(list.locator("[data-list-select='task-1']")).toBeChecked();
    await list.locator("[data-list-page='next']").tap();
    await expect(list.locator("[data-list-item]").first()).toHaveAttribute("data-list-item", "task-6");
    const itemButton = list.locator("[data-list-item-action='task-6']");
    await settled(list);
    for (const target of [itemButton, list.locator("[data-list-page='next']"), list.locator("[data-list-item='task-6'] label")]) {
      expect((await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await list.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("list-mobile.png") });
  } finally {
    await context.close();
  }
});
