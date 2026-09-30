import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Area and scatter charts, placed in the conversation and browsed in the library.
 *
 * The charts are placed through the views a model's `show_view` uses, over rows written to a dataset the person owns and
 * labelled as the sample they are, so a field the rows lack or a value that is not a number is refused with the host's
 * own reason. What only a browser can say is what a person does with one: hide and show a series from the legend, walk
 * the points with the keyboard and select one, find the chart as they left it after a reload, read the rows as a table,
 * be told when the chart draws only the first rows, read what a scatter plot's axes measure, be told in their own language
 * when the node refuses a point it no longer holds, and use it all on a phone.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

type Which = "vùng" | "vùng chồng" | "vùng co lại" | "phân tán" | "phân tán lớn";

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

const CHARTS = "[data-widget-role='chart']:has([data-xy-chart])";

/** Ask the fixture model for a chart, and return it by position so a later chart cannot move the locator. */
async function place(page: Page, which: Which): Promise<Locator> {
  const before = await page.locator(CHARTS).count();
  await say(page, `đặt biểu đồ ${which}`);
  await expect(page.locator(CHARTS)).toHaveCount(before + 1, { timeout: 20_000 });
  return page.locator(CHARTS).nth(before);
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

async function instanceOf(chart: Locator): Promise<string> {
  const instanceId = await chart.evaluate((element) => element.closest("[data-widget-instance]")?.getAttribute("data-widget-instance") ?? "");
  expect(instanceId, "the chart is drawn for an instance").not.toBe("");
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

async function focusedPoint(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute("data-point") ?? null);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test("an area chart hides a series from its legend, selects a point from the keyboard, and keeps both after a reload", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const conversation = watchConversation(page);
  await openApp(page);
  const before = await page.locator(CHARTS).count();
  const chart = await place(page, "vùng");

  // The rows are a sample and the chart says so; nothing claims to be live.
  await expect(chart.locator(".cc-freshness[data-freshness='sample']")).toHaveCount(1);
  await expect(chart.locator("[data-xy-chart='area'][data-stacked='false']")).toBeVisible();

  // Each series is named in the legend, with its own line pattern and point shape beside its tone.
  const legend = chart.locator("[data-xy-legend] button[data-series]");
  await expect(legend).toHaveCount(2);
  await expect(legend.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(legend.nth(0)).toContainText("Lượt chạy");
  await expect(legend.nth(1)).toContainText("Lượt lỗi");
  const keys = await legend.locator(".cc-xy-key").evaluateAll((svgs) =>
    svgs.map((svg) => ({ dash: svg.querySelector("line")?.getAttribute("stroke-dasharray") ?? "", shape: svg.querySelector("path")?.getAttribute("d") ?? "" })),
  );
  expect(keys[0]?.dash, "the two series draw different lines").not.toBe(keys[1]?.dash);
  await expect(chart.locator("[data-series-points='runs'] [data-point]")).toHaveCount(6);
  await expect(chart.locator("[data-series-points='failures'] [data-point]")).toHaveCount(6);

  // The rows it drew, as a table, with the chart's own names for its fields.
  await expect(chart.locator("[data-xy-table] tbody tr")).toHaveCount(6);
  await expect(chart.locator("[data-xy-table] thead")).toContainText("Lượt chạy");

  // One point is the way in; the arrow keys walk the points and change series, and Enter selects.
  const entry = chart.locator("[data-point][tabindex='0']");
  await expect(entry).toHaveCount(1);
  await expect(entry).toHaveAttribute("data-point", "runs#0");
  await entry.focus();
  await page.keyboard.press("ArrowRight");
  expect(await focusedPoint(page)).toBe("runs#1");
  await page.keyboard.press("ArrowDown");
  expect(await focusedPoint(page)).toBe("failures#1");
  await page.keyboard.press("ArrowUp");
  expect(await focusedPoint(page)).toBe("runs#1");
  await expect(chart.locator("[data-point='runs#1']")).toHaveAttribute("aria-label", "Lượt chạy · W36: 129 lượt");
  await page.keyboard.press("Enter");
  await expect(chart.locator("[data-selected-point='runs#1']")).toContainText("Đã chọn: Lượt chạy · W36: 129 lượt");
  await expect(chart.locator("[data-point='runs#1']")).toHaveAttribute("aria-pressed", "true");

  // Hiding a series takes its points away and says it is hidden in words, not only by a struck-through colour.
  await legend.nth(1).click();
  await expect(legend.nth(1)).toHaveAttribute("aria-pressed", "false");
  await expect(legend.nth(1)).toContainText("(đã ẩn)");
  await expect(chart.locator("[data-series-points='failures']")).toHaveCount(0);
  // The last series shown stays shown, and the chart says why.
  await legend.nth(0).click();
  await expect(legend.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(chart.locator("[data-xy-last-series]")).toBeVisible();

  // The node keeps the view, which is what voice and inspect_ui read.
  const instanceId = await instanceOf(chart);
  await expect
    .poll(() => heldView(page, conversation(), instanceId), { timeout: 10_000 })
    .toMatchObject({ hiddenSeries: ["failures"], selected: { series: "runs", index: 1 } });

  // After a reload the chart is drawn as it was left.
  await openApp(page);
  const again = page.locator(CHARTS).nth(before);
  await expect(again.locator("[data-series='failures']")).toHaveAttribute("aria-pressed", "false", { timeout: 20_000 });
  await expect(again.locator("[data-selected-point='runs#1']")).toContainText("Lượt chạy · W36");

  // Escape on a point clears the selection, and the node forgets it too.
  await again.locator("[data-point][tabindex='0']").focus();
  expect(await focusedPoint(page)).toBe("runs#1");
  await page.keyboard.press("Escape");
  await expect(again.locator("[data-selected-point='']")).toHaveCount(1);
  await expect.poll(() => heldView(page, conversation(), instanceId), { timeout: 10_000 }).toEqual({ hiddenSeries: ["failures"] });
});

test("a stacked area says it is stacked, and a chart over more rows than it holds says it draws only the first", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page);
  const stacked = await place(page, "vùng chồng");
  await expect(stacked.locator("[data-xy-chart='area'][data-stacked='true']")).toHaveAttribute("aria-label", /xếp chồng/u);

  const big = await place(page, "phân tán lớn");
  await expect(big.locator("[data-xy-truncated]")).toHaveText("Đang vẽ 500 hàng đầu tiên trên tổng số 640 hàng.");
  await expect(big.locator("[data-series-points='latency'] [data-point]")).toHaveCount(500);
  // The axes say what they measure, with their units, not only tick numbers.
  await expect(big.locator("[data-xy-axis='x']")).toHaveText("Trục x: Tải (%)");
  await expect(big.locator("[data-xy-axis='y']")).toHaveText("Trục y: Độ trễ (ms)");
  await expect(big.locator("[data-xy-table] tbody tr")).toHaveCount(500);
  // The points of a scatter plot are walked in the order of x, from the smallest to the largest.
  const entry = big.locator("[data-point][tabindex='0']");
  await expect(entry).toHaveAttribute("aria-label", /^Độ trễ · Tải 0 %: \d+ ms \(node-\d+\)$/u);
  await entry.focus();
  await page.keyboard.press("End");
  const last = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
  expect(last).toMatch(/^Độ trễ · Tải 99 %: \d+ ms \(node-\d+\)$/u);
  await page.keyboard.press("Enter");
  await expect(big.locator(".cc-xy-selected")).toContainText(last);
});

test("the arrow keys walk a scatter plot's points in the order of x, not the order of its rows", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const conversation = watchConversation(page);
  await openApp(page);
  const chart = await place(page, "phân tán");
  await expect(chart.locator("[data-series-points='latency'] [data-point]")).toHaveCount(24);

  // The rows put Tải 37 second, but the point after Tải 0 is the next smallest x: Tải 3, in row 20.
  const entry = chart.locator("[data-point][tabindex='0']");
  await expect(entry).toHaveAttribute("data-point", "latency#0");
  await expect(entry).toHaveAttribute("aria-label", "Độ trễ · Tải 0 %: 40 ms (node-1)");
  await entry.focus();
  const walked: (string | null)[] = [];
  for (let step = 0; step < 3; step += 1) {
    await page.keyboard.press("ArrowRight");
    walked.push(await focusedPoint(page));
  }
  expect(walked).toEqual(["latency#19", "latency#11", "latency#3"]);
  await expect(chart.locator("[data-point='latency#19']")).toHaveAttribute("aria-label", "Độ trễ · Tải 3 %: 57 ms (node-20)");
  await page.keyboard.press("ArrowLeft");
  expect(await focusedPoint(page)).toBe("latency#11");
  // One series, so up and down stay on it.
  await page.keyboard.press("ArrowDown");
  expect(await focusedPoint(page)).toBe("latency#11");
  // Home and End go to the smallest and the largest x, wherever their rows are.
  await page.keyboard.press("End");
  expect(await focusedPoint(page)).toBe("latency#8");
  await page.keyboard.press("Home");
  expect(await focusedPoint(page)).toBe("latency#0");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(chart.locator("[data-selected-point='latency#8']")).toContainText("Đã chọn: Độ trễ · Tải 96 %: 104 ms (node-9)");
  // The point still focused is the one selected, and the node keeps it.
  expect(await focusedPoint(page)).toBe("latency#8");
  const instanceId = await instanceOf(chart);
  await expect
    .poll(() => heldView(page, conversation(), instanceId), { timeout: 10_000 })
    .toMatchObject({ hiddenSeries: [], selected: { series: "latency", index: 8 } });
});

test("a field the rows lack and a value that is not a number are refused with the host's reason, and no chart is drawn", async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  const before = await page.locator(CHARTS).count();
  await say(page, "đặt biểu đồ thiếu trường");
  await expect(page.getByText('the dataset has no field "retries"').last()).toBeVisible({ timeout: 20_000 });
  await say(page, "đặt biểu đồ không phải số");
  await expect(page.getByText(`row 3's "failures" is "n/a", not a number`).last()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(CHARTS)).toHaveCount(before);
});

test("a page that asks for a point the node no longer holds says it was refused and draws the rows it holds", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  const chart = await place(page, "vùng co lại");
  await expect(chart.locator("[data-series-points='runs'] [data-point]")).toHaveCount(6);

  // The rows are replaced from another conversation, so this page is still drawing the six it was given.
  const created = await page.request.post(`${GATEWAY}/conversations`, { headers: authorized(), data: { title: "Dữ liệu biểu đồ" } });
  expect(created.ok()).toBe(true);
  const other = ((await created.json()) as { conversationId: string }).conversationId;
  const sent = await page.request.post(`${GATEWAY}/conversations/${encodeURIComponent(other)}/messages`, {
    headers: authorized(),
    data: { text: "rút gọn dữ liệu biểu đồ" },
  });
  expect(sent.ok()).toBe(true);
  await expect
    .poll(async () => {
      const response = await page.request.get(`${GATEWAY}/conversations/${encodeURIComponent(other)}/timeline?after=0`, { headers: authorized() });
      return JSON.stringify(await response.json()).includes("co lại còn 3 hàng");
    }, { timeout: 20_000 })
    .toBe(true);
  await expect(chart.locator("[data-series-points='runs'] [data-point]")).toHaveCount(6);

  await chart.locator("[data-point='runs#5']").click();
  // Said in the person's language; the node's English sentence is for the model and the logs.
  await expect(chart.locator("[data-xy-message]")).toHaveText(
    "Nút không giữ được thay đổi này vì dữ liệu của biểu đồ đã đổi. Biểu đồ đang hiện lại chế độ xem mà nút đang giữ.",
    { timeout: 20_000 },
  );
  // The refused selection is undrawn, and the chart is drawn over the rows the node holds.
  await expect(chart.locator("[data-selected-point='']")).toHaveCount(1);
  await expect(chart.locator("[data-series-points='runs'] [data-point]")).toHaveCount(3, { timeout: 20_000 });
});

test("the charts add no motion of their own when motion is reduced", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);
  const chart = await place(page, "phân tán");
  const motion = await chart.locator("[data-point]").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { animation: style.animationName, transition: style.transitionDuration };
  });
  expect(motion.animation).toBe("none");
  expect(motion.transition.split(",").every((part) => Number.parseFloat(part) === 0)).toBe(true);
});

test("the charts are usable at phone width without scrolling sideways, in the light theme", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "light" });
  const page = await context.newPage();
  try {
    await openApp(page);
    const area = await place(page, "vùng");
    const scatter = await place(page, "phân tán");
    for (const chart of [area, scatter]) {
      const box = await chart.boundingBox();
      expect(box?.width ?? 0, "a chart fits the phone's width").toBeLessThanOrEqual(390);
    }
    await area.locator("[data-series='failures']").tap();
    await expect(area.locator("[data-series='failures']")).toHaveAttribute("aria-pressed", "false");
    await area.locator("[data-point='runs#2']").tap();
    await expect(area.locator("[data-selected-point='runs#2']")).toContainText("Lượt chạy · W37");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe("light");
  } finally {
    await context.close();
  }
});

test("the library previews both charts through the production renderer, usable without a node", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-extensions")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-extensions").click();
  await page.locator("[data-widget-library-open='browse']").click();
  await expect(page.locator("[data-widget-library='true']")).toBeVisible({ timeout: 20_000 });

  for (const [id, kind] of [
    ["canvas.area@1", "area"],
    ["canvas.scatter@1", "scatter"],
  ] as const) {
    await page.locator(`[data-widget-card='${id}']`).click();
    const preview = page.locator(`[data-widget-preview='${id}']`);
    await expect(preview).toBeVisible({ timeout: 20_000 });
    await expect(preview.locator(`[data-xy-chart='${kind}']`)).toBeVisible();
    // A preview draws a fixture's rows and says they are a sample.
    await expect(preview.locator(".cc-freshness[data-freshness='sample']")).toHaveCount(1);
    await expect(preview.locator("[data-widget-unavailable='true']")).toHaveCount(0);
    // The legend and the points work in the preview as they do in the conversation.
    const legend = preview.locator("[data-xy-legend] button[data-series]");
    if ((await legend.count()) > 1) {
      await legend.nth(1).click();
      await expect(legend.nth(1)).toHaveAttribute("aria-pressed", "false");
    }
    await preview.locator("[data-point][tabindex='0']").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(preview.locator(".cc-xy-selected")).not.toBeEmpty();
    await page.locator("[data-widget-library-back]").click();
    await expect(page.locator("[data-widget-grid]")).toBeVisible({ timeout: 20_000 });
  }
});
