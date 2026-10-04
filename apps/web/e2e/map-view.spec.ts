import { readFileSync } from "node:fs";
import { type IncomingHttpHeaders, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
const WEB_PORT = process.env.CC_E2E_WEB_PORT;
if (NODE_PORT === undefined || NODE_PORT === "" || WEB_PORT === undefined || WEB_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT or CC_E2E_WEB_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
/** Where the page may send requests: the web client it was served from and the node. Nothing else, ever. */
const PAGE_ORIGINS = new Set([GATEWAY, `http://127.0.0.1:${WEB_PORT}`]);
/** A one-pixel PNG, a real picture the browser decodes. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

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

async function conversationId(page: Page): Promise<string> {
  const stored = await page.evaluate(() => sessionStorage.getItem("cc_conversation"));
  if (stored === null || stored === "") throw new Error("the app has not selected a conversation");
  return stored;
}

async function heldState(page: Page, conversation: string, instanceId: string): Promise<unknown> {
  const response = await page.request.get(`${GATEWAY}/conversations/${encodeURIComponent(conversation)}/timeline?after=0`, { headers: authorized() });
  expect(response.ok(), "the node gives the conversation timeline").toBe(true);
  const timeline = (await response.json()) as { instances?: { instanceId: string; state?: unknown }[] };
  return timeline.instances?.find((instance) => instance.instanceId === instanceId)?.state ?? {};
}

async function instanceOf(map: Locator): Promise<string> {
  const id = await map.evaluate((element) => element.closest("[data-widget-instance]")?.getAttribute("data-widget-instance") ?? "");
  expect(id, "the map is drawn for a saved widget instance").not.toBe("");
  return id;
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function setTilePolicy(page: Page, value: unknown): Promise<void> {
  const response = await page.request.put(`${GATEWAY}/preferences/maps.tilePolicy`, { headers: authorized(), data: { value } });
  expect(response.ok(), await response.text()).toBe(true);
}

/** Every request the page makes, by URL. */
function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  return urls;
}

function beyondTheNode(urls: readonly string[]): string[] {
  return urls.filter((url) => {
    if (url.startsWith("data:") || url.startsWith("blob:")) return false;
    return !PAGE_ORIGINS.has(new URL(url).origin);
  });
}

test("the conversation map is keyboard accessible, host-persisted, offline by default and responsive", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await setTilePolicy(page, null);
  const requests = recordRequests(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openApp(page);
  await say(page, "đặt bản đồ");

  const viewport = page.getByRole("region", { name: "Bản đồ: Chặng giao hàng" }).last();
  await expect(viewport).toBeVisible({ timeout: 20_000 });
  const card = page.locator("[data-widget-instance]").filter({ has: viewport }).last();
  await expect(card.locator("[data-map-basemap='natural-earth']")).toHaveAttribute("d", /^M/u);
  await expect(card.locator("[data-map-basemap-credit]")).toContainText("Natural Earth");
  await expect(card.locator("[data-map-tiles='off']")).toBeVisible();
  await expect(card.locator("[data-map-tile]")).toHaveCount(0);
  await expect(card.locator("[data-map-shape]")).toHaveCount(5);
  await expect(card.locator("[data-map-feature]")).toHaveCount(5);
  await expect(card.locator("[data-map-content]")).toHaveAttribute("data-map-motion", "reduced");

  // Keyboard: visible focus, then pan, zoom and step through features.
  await viewport.focus();
  await expect(viewport).toBeFocused();
  const startZoom = Number(await viewport.getAttribute("data-map-zoom"));
  const startCenter = await viewport.getAttribute("data-map-center");
  await page.keyboard.press("ArrowRight");
  await expect(viewport).not.toHaveAttribute("data-map-center", startCenter ?? "");
  expect(await viewport.evaluate((element) => element.matches(":focus-visible") && getComputedStyle(element).outlineStyle !== "none")).toBe(true);
  await page.keyboard.press("+");
  await expect(viewport).toHaveAttribute("data-map-zoom", String(startZoom + 1));
  await page.keyboard.press("n");
  await expect(card.locator("[data-map-feature='hanoi']")).toHaveAttribute("data-selected", "true");
  await expect(card.locator("[data-map-shape='hanoi']")).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("n");
  await expect(card.locator("[data-map-feature='danang']")).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("p");
  await expect(card.locator("[data-map-feature='hanoi']")).toHaveAttribute("data-selected", "true");
  await expect(card.locator("[data-map-status]")).toContainText("Hà Nội");

  const instanceId = await instanceOf(viewport);
  const conversation = await conversationId(page);
  await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toMatchObject({ selectedId: "hanoi", zoom: startZoom + 1 });

  // Choosing in the table selects on the map, and brings the place into view.
  await card.locator("[data-map-select='halong']").click();
  await expect(card.locator("[data-map-select='halong']")).toHaveAttribute("aria-pressed", "true");
  await expect(card.locator("[data-map-shape='halong']")).toHaveAttribute("data-selected", "true");
  await expect(card.locator("[data-map-shape='hanoi']")).not.toHaveAttribute("data-selected", "true");
  await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toMatchObject({ selectedId: "halong" });

  // Reset and the saved view survive a reload.
  await viewport.focus();
  await page.keyboard.press("0");
  await expect(viewport).toHaveAttribute("data-map-zoom", String(startZoom));
  await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toMatchObject({ zoom: startZoom });
  await page.reload();
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  const restored = page.locator(`[data-widget-instance='${instanceId}']`);
  await expect(restored.locator("[data-map-feature='halong']")).toHaveAttribute("data-selected", "true", { timeout: 20_000 });
  await expect(restored.locator("[data-map-viewport]")).toHaveAttribute("data-map-zoom", String(startZoom));

  // No tile policy: the page has asked nobody but the node, and the node for no tile.
  expect(beyondTheNode(requests)).toEqual([]);
  expect(requests.filter((url) => /\/map-tiles\/\d/u.test(url))).toEqual([]);

  await page.screenshot({ path: testInfo.outputPath("map-1280-dark.png"), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe("dark");
  await restored.scrollIntoViewIfNeeded();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  const box = await restored.locator("[data-map-viewport]").boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("map-390-dark.png"), fullPage: false });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe("light");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  // Light and dark draw land and sea from the theme, so they differ between the two.
  const landLight = await restored.locator("[data-map-basemap]").evaluate((element) => getComputedStyle(element).fill);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe("dark");
  const landDark = await restored.locator("[data-map-basemap]").evaluate((element) => getComputedStyle(element).fill);
  expect(landLight).not.toBe(landDark);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(restored.locator("[data-map-content]")).toHaveAttribute("data-map-motion", "animated");
  await page.screenshot({ path: testInfo.outputPath("map-390-light.png"), fullPage: false });
});

test("with a tile policy, tiles come through the node from that provider only, with its attribution", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  const provider = createServer((request, response) => {
    seen.push({ path: request.url ?? "", headers: request.headers });
    response.writeHead(200, { "content-type": "image/png", "content-length": String(PNG.length) });
    response.end(PNG);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${String((provider.address() as AddressInfo).port)}`;
  try {
    await setTilePolicy(page, { origin, template: "/tiles/{z}/{x}/{y}.png", attribution: "© Fixture tiles", maxZoom: 10 });
    const requests = recordRequests(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openApp(page);
    await say(page, "đặt bản đồ");
    const viewport = page.getByRole("region", { name: "Bản đồ: Chặng giao hàng" }).last();
    await expect(viewport).toBeVisible({ timeout: 20_000 });
    const card = page.locator("[data-widget-instance]").filter({ has: viewport }).last();
    await expect(card.locator("[data-map-tiles='provider']")).toHaveAttribute("data-map-tile-origin", origin);
    await expect(card.locator("[data-map-tiles='provider']")).toContainText("© Fixture tiles");
    await expect(card.locator("[data-map-basemap-credit]")).toContainText("Natural Earth");
    await expect.poll(() => card.locator("image[data-map-tile]").count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const href = await card.locator("image[data-map-tile]").first().getAttribute("href");
    expect(href?.startsWith("blob:")).toBe(true);

    // The page asked the node for tiles; the node asked the provider, on the template's path only.
    expect(requests.some((url) => url.startsWith(`${GATEWAY}/map-tiles/`))).toBe(true);
    expect(beyondTheNode(requests)).toEqual([]);
    expect(requests.some((url) => url.startsWith(origin))).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => /^\/tiles\/\d+\/\d+\/\d+\.png$/u.test(entry.path))).toBe(true);
    expect(seen.every((entry) => entry.headers.authorization === undefined && entry.headers.cookie === undefined)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("map-tiles-1280.png"), fullPage: false });
  } finally {
    await setTilePolicy(page, null);
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
  // Back to none: the node refuses every tile without asking anyone.
  const before = seen.length;
  const refused = await page.request.get(`${GATEWAY}/map-tiles/0/0/0`, { headers: authorized() });
  expect(refused.status()).toBe(404);
  expect(((await refused.json()) as { code?: string }).code).toBe("MAP_TILES_OFF");
  expect(seen.length).toBe(before);
});

test("the map refuses a URL, an unknown geometry and hidden characters with the host's reason", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  const before = await page.locator("[data-map-viewport]").count();
  await say(page, "đặt bản đồ có url");
  await expect(page.getByText(/map props carry no URLs \(tileUrl\)/u).last()).toBeVisible({ timeout: 20_000 });
  await say(page, "đặt bản đồ hình lạ");
  await expect(page.getByText(/geometry\.type "Circle" is not one of Point, LineString, Polygon/u).last()).toBeVisible({ timeout: 20_000 });
  await say(page, "đặt bản đồ ký tự ẩn");
  await expect(page.getByText(/Fixture không đặt được: .*features\.0\.label/u).last()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-map-viewport]")).toHaveCount(before);
});

test("the Widget Library previews the map fixture with the production renderer and no tiles", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const requests = recordRequests(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-developer")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-developer").click();
  await page.locator("[data-widget-library-open='develop']").click();
  await page.locator("[data-widget-card='canvas.map@1']").click();
  const preview = page.locator("[data-widget-preview='canvas.map@1']");
  const viewport = preview.getByRole("region", { name: "Bản đồ: Chặng giao hàng" });
  await expect(viewport).toBeVisible({ timeout: 20_000 });
  await expect(preview.locator("[data-map-feature]")).toHaveCount(5);
  await preview.locator("[data-map-select='danang']").click();
  await expect(preview.locator("[data-map-shape='danang']")).toHaveAttribute("data-selected", "true");
  await viewport.focus();
  const zoom = Number(await viewport.getAttribute("data-map-zoom"));
  await page.keyboard.press("-");
  await expect(viewport).toHaveAttribute("data-map-zoom", String(zoom - 1));
  await page.locator("[data-widget-lab-fixture='true']").selectOption("map.empty");
  await expect(preview.locator("[data-map-state='empty']")).toBeVisible();
  await page.locator("[data-widget-lab-fixture='true']").selectOption("map.normal");
  await expect(preview.locator("[data-map-feature='hanoi']")).toBeVisible();

  await page.locator("[data-widget-lab-viewport='true']").selectOption("320");
  const frame = page.locator("[data-widget-preview-frame]");
  await expect(frame).toHaveCSS("width", "320px");
  await page.locator("[data-widget-lab-theme='true']").selectOption("dark");
  await expect(frame).toHaveAttribute("data-cc-theme", "dark");
  await page.locator("[data-widget-lab-reduced-motion='true']").check();
  await expect(frame).toHaveAttribute("data-cc-reduced-motion", "true");
  await viewport.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(preview.locator("[data-map-content]")).toHaveAttribute("data-map-motion", "reduced");
  const overflow = await frame.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(requests.filter((url) => /\/map-tiles/u.test(url))).toEqual([]);
  expect(beyondTheNode(requests)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("map-library-dark-narrow.png") });
});
