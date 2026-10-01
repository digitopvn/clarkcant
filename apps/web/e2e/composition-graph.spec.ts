import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Widgets on one surface that affect one another through state the node holds.
 *
 * The surface is proposed through the composed view a model's `show_view` uses: a choice writes which series a line
 * chart plots, a search box writes the query a table is narrowed by. What only a browser can say is whether a person's
 * pick changes the widget it feeds at once, whether the live surface keeps it across a reload because the node applied
 * it, and whether the transcript still shows the surface as it was captured.
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

/** Ask for the fixture's linked surface and return the newest one the transcript holds. */
async function linked(page: Page): Promise<Locator> {
  const before = await page.locator("[data-layout-root]").count();
  await say(page, "bố cục có liên kết");
  await expect(page.locator("[data-layout-root]")).toHaveCount(before + 1, { timeout: 30_000 });
  return page.locator("[data-layout-root]").nth(before);
}

/**
 * A real task row created this week, through a turn, so the chart and the table have figures on the live surface: a
 * period with no work at all is shown as missing there, which is the honest outcome but not the one under test.
 */
async function withATask(page: Page): Promise<void> {
  await say(page, "cho tôi một task dài");
  await expect(page.locator("[data-host-card='task-progress']").last()).toBeVisible({ timeout: 20_000 });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test("a choice switches the chart's series and a search narrows the table, and the live surface keeps both", async ({ page, request }, testInfo) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await withATask(page);
  const inline = await linked(page);

  // The transcript draws the surface as it started: the chart plots the series the state starts at.
  await expect(inline.locator("[data-slot='trend'] [data-chart-series]")).toHaveAttribute("data-chart-series", "completed", { timeout: 15_000 });
  await expect(inline.getByRole("radio", { name: "Việc xong" })).toBeChecked();

  // The current view: a pin that claims the live instance.
  await page.locator("[data-open-live]").last().click();
  const pin = page.locator("[data-pin-live]").last();
  const live = pin.locator("[data-surface-composition]");
  await expect(live).toBeVisible({ timeout: 30_000 });
  const series = live.locator("[data-slot='trend'] [data-chart-series]");
  await expect(series).toHaveAttribute("data-chart-series", "completed");

  // Picking another series changes the chart at once, and the node is told the event, not the value the page computed.
  const pressed = page.waitForRequest((sent) => sent.method() === "POST" && ACTION_ROUTE.test(sent.url()));
  await live.getByRole("radio", { name: "Việc tạo" }).click();
  await expect(series).toHaveAttribute("data-chart-series", "created");
  // Named as the person picked it, not by the column it reads.
  await expect(series).toHaveText("Đang hiển thị: Việc tạo");
  const press = await pressed;
  const body = press.postDataJSON() as { input: unknown };
  expect(body.input).toEqual({ event: "choice.change", payload: { value: "created" } });
  const answered = await press.response();
  expect(answered?.status()).toBe(200);

  // Typing in the search box narrows the table beside it.
  const table = live.locator("[data-slot='table']");
  const rows = table.locator("tbody tr[data-row-id]");
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  const all = await rows.count();
  const firstCell = ((await rows.first().locator("td").first().textContent()) ?? "").trim();
  expect(firstCell).not.toBe("");
  const searched = page.waitForRequest(
    (sent) => sent.method() === "POST" && ACTION_ROUTE.test(sent.url()) && JSON.stringify(sent.postDataJSON()).includes("query.change"),
  );
  const search = live.locator("[data-slot='search'] [data-search-input]");
  await search.pressSequentially(firstCell);
  await search.press("Enter");
  await searched;
  await expect.poll(async () => rows.count()).toBeGreaterThan(0);
  const narrowed = await rows.evaluateAll(
    (elements, query) => elements.every((row) => (row.textContent ?? "").toLowerCase().includes(query.toLowerCase())),
    firstCell,
  );
  expect(narrowed).toBe(true);
  await pin.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("graph-live-desktop.png") });

  // What an agent turn would read is the node's own values, bounded and typed.
  const liveRoute = press.url().replace(/\/actions$/u, "/live");
  await expect
    .poll(async () => {
      const read = await request.get(liveRoute, { headers: { authorization: `Bearer ${token()}` } });
      return ((await read.json()) as { semanticState?: { values?: unknown } }).semanticState?.values;
    })
    .toEqual({ metric: "created", query: firstCell });

  // The transcript keeps what it captured.
  await expect(inline.locator("[data-slot='trend'] [data-chart-series]")).toHaveAttribute("data-chart-series", "completed");
  await expect(inline.getByRole("radio", { name: "Việc xong" })).toBeChecked();

  // Reloaded, the live surface shows what the node kept: the series, the pick, the query and the rows it narrows to.
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  const again = page.locator("[data-pin-live]").last().locator("[data-surface-composition]");
  await expect(again).toBeVisible({ timeout: 30_000 });
  await expect(again.locator("[data-slot='trend'] [data-chart-series]")).toHaveAttribute("data-chart-series", "created", { timeout: 15_000 });
  await expect(again.getByRole("radio", { name: "Việc tạo" })).toBeChecked();
  await expect(again.locator("[data-slot='search'] [data-search-input]")).toHaveValue(firstCell);
  const kept = again.locator("[data-slot='table'] tbody tr[data-row-id]");
  await expect.poll(async () => kept.count()).toBeLessThanOrEqual(all);
  expect(
    await kept.evaluateAll(
      (elements, query) => elements.every((row) => (row.textContent ?? "").toLowerCase().includes(query.toLowerCase())),
      firstCell,
    ),
  ).toBe(true);

  // Narrow: the choice, the search box, the chart and the table stack, and nothing is wider than the screen.
  await page.setViewportSize({ width: 375, height: 812 });
  await again.scrollIntoViewIfNeeded();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  const radio = again.locator("[data-slot='choice'] label").first();
  expect((await radio.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath("graph-live-mobile.png") });
});

test("the transcript's copy can be explored on the page, and nothing is sent", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  const inline = await linked(page);
  let sent = 0;
  page.on("request", (sentRequest) => {
    if (sentRequest.method() === "POST" && /\/widgets\//u.test(sentRequest.url())) sent += 1;
  });
  const series = inline.locator("[data-slot='trend'] [data-chart-series]");
  await expect(series).toHaveAttribute("data-chart-series", "completed", { timeout: 15_000 });
  await inline.getByRole("radio", { name: "Việc xong" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(inline.getByRole("radio", { name: "Việc tạo" })).toBeChecked();
  await expect(series).toHaveAttribute("data-chart-series", "created");
  await inline.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("graph-history-explored.png") });
  expect(sent).toBe(0);
});

/** One pixel, as a PNG: what is under test is that a reference the node minted is drawn, not the picture. */
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

test("a picture picked in a composed gallery reaches the carousel beside it, the surface's state and inspect_ui", async ({ page, request }, testInfo) => {
  test.setTimeout(150_000);
  // The pictures are imported through the production route, so the layout shows what the node holds, not fixture data.
  for (const altText of ["Bến cảng lúc sáng", "Cánh đồng lúa chín"]) {
    const uploaded = await request.post(`${GATEWAY}/images`, {
      headers: { authorization: `Bearer ${token()}` },
      data: { dataBase64: ONE_PIXEL_PNG, mimeType: "image/png", altText },
    });
    expect(uploaded.ok()).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  const before = await page.locator("[data-layout-root]").count();
  await say(page, "bố cục ảnh");
  await expect(page.locator("[data-layout-root]")).toHaveCount(before + 1, { timeout: 30_000 });

  await page.locator("[data-open-live]").last().click();
  const live = page.locator("[data-pin-live]").last().locator("[data-surface-composition]");
  await expect(live).toBeVisible({ timeout: 30_000 });
  const gallery = live.locator("[data-section-id='pictures-1']");
  const carousel = live.locator("[data-section-id='pictures-2'] [data-carousel-index]");
  await expect(gallery.locator("img[data-image-ref]").first()).toHaveAttribute("src", /^blob:/u, { timeout: 15_000 });
  await expect(carousel).toHaveAttribute("data-carousel-index", "0");

  // Chosen from the keyboard: the node is told the event with the index the gallery stores, and the carousel follows.
  const choice = gallery.locator(".cc-gallery-select").nth(1);
  const pressed = page.waitForRequest(
    (sent) => sent.method() === "POST" && ACTION_ROUTE.test(sent.url()) && JSON.stringify(sent.postDataJSON()).includes("media.select"),
  );
  // Reached with Tab from the picture before it, so the ring drawn is the keyboard's, not a pointer's.
  await gallery.locator(".cc-gallery-select").first().focus();
  await page.keyboard.press("Tab");
  await expect(choice).toBeFocused();
  expect(await choice.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  await page.keyboard.press("Enter");
  const press = await pressed;
  expect((press.postDataJSON() as { input: unknown }).input).toEqual({ event: "media.select", payload: { selectedIndex: 1 } });
  expect((await press.response())?.status()).toBe(200);
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  await expect(carousel).toHaveAttribute("data-carousel-index", "1");

  // The surface's own state holds the pick, which is what a turn reads. It holds the stored value, counted from 0: the
  // second picture is `picture: 1`. Only a media widget's own semantic summary counts from 1 (`selectedNumber`).
  const liveRoute = press.url().replace(/\/actions$/u, "/live");
  await expect
    .poll(async () => {
      const read = await request.get(liveRoute, { headers: { authorization: `Bearer ${token()}` } });
      return ((await read.json()) as { semanticState?: { values?: unknown } }).semanticState?.values;
    })
    .toEqual({ picture: 1 });
  await say(page, "kiểm tra giao diện");
  const inspection = page.locator("[data-role='assistant']").last();
  await expect(inspection).toContainText("picture: 1", { timeout: 20_000 });

  // Reloaded, both leaves draw the picture the node kept.
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  const again = page.locator("[data-pin-live]").last().locator("[data-surface-composition]");
  await expect(again).toBeVisible({ timeout: 30_000 });
  await expect(again.locator("[data-section-id='pictures-2'] [data-carousel-index]")).toHaveAttribute("data-carousel-index", "1", { timeout: 15_000 });
  await expect(again.locator("[data-section-id='pictures-1'] .cc-gallery-select").nth(1)).toHaveAttribute("aria-pressed", "true");

  // A phone's width in both themes: the theme the page applied is read back, and nothing scrolls sideways.
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe(colorScheme);
    await again.scrollIntoViewIfNeeded();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`graph-pictures-390-${colorScheme}.png`) });
  }
});

test("a graph the node cannot check is refused in the conversation, with the reason, and nothing is drawn", async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  const before = await page.locator("[data-layout-root]").count();
  await say(page, "bố cục liên kết sai");
  const reply = page.locator("[data-role='assistant']").last();
  await expect(reply).toContainText('names state "chart", which the graph does not declare', { timeout: 20_000 });
  await expect(reply).toContainText("canvas.metrics@1 reads nothing from a graph");
  await expect(page.locator("[data-layout-root]")).toHaveCount(before);
});
