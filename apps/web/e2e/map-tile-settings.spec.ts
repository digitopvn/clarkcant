import { readFileSync } from "node:fs";
import { type IncomingHttpHeaders, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { DEFAULT_EXECUTION_POLICY_CONFIG } from "@clarkcant/contracts";

/**
 * The maps' tile provider, turned on and off by a person in Settings and by Clark on request.
 *
 * The provider is a local fake tile server that refuses a request without the key and any path that is not a tile, so
 * the journey is real end to end — Settings stores the key bound to the provider's origin and writes the policy, the
 * node fetches tiles with the key, the map draws them — without reaching any network.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
/** A one-pixel PNG, a real picture the browser decodes. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const KEY = "fixture-tile-key-never-shown";
const TILE_PATH = /^\/tiles\/\d+\/\d+\/\d+\.png$/u;

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

async function setTilePolicy(page: Page, value: unknown): Promise<void> {
  const response = await page.request.put(`${GATEWAY}/preferences/maps.tilePolicy`, { headers: authorized(), data: { value } });
  expect(response.ok(), await response.text()).toBe(true);
}

async function setMode(page: Page, mode: "ask" | "autonomous"): Promise<void> {
  const response = await page.request.put(`${GATEWAY}/preferences/execution.policy`, {
    headers: authorized(),
    data: { value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, mode } },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function forgetKey(page: Page): Promise<void> {
  const response = await page.request.delete(`${GATEWAY}/map-tiles/key`, { headers: authorized() });
  expect(response.ok(), await response.text()).toBe(true);
}

async function tileView(page: Page): Promise<unknown> {
  const response = await page.request.get(`${GATEWAY}/map-tiles`, { headers: authorized() });
  return response.json();
}

async function openMapSettings(page: Page) {
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-extensions").click();
  const section = page.locator("[data-map-tiles-settings='true']");
  await expect(section).toBeVisible({ timeout: 20_000 });
  return section;
}

async function placeMap(page: Page) {
  await say(page, "đặt bản đồ");
  const viewport = page.getByRole("region", { name: "Bản đồ: Chặng giao hàng" }).last();
  await expect(viewport).toBeVisible({ timeout: 20_000 });
  return page.locator("[data-widget-instance]").filter({ has: viewport }).last();
}

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
  status: number;
}

/**
 * A tile server that answers like a keyed provider: 401 without the key, 404 for anything but a z/x/y tile. Every request
 * and the answer it got are kept, so the test can prove the node sent the key and asked only for tiles.
 */
async function fakeProvider(options: { key?: string } = {}): Promise<{ origin: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    const status = options.key !== undefined && request.headers["x-api-key"] !== options.key ? 401 : TILE_PATH.test(path) ? 200 : 404;
    seen.push({ path, headers: request.headers, status });
    if (status !== 200) {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(status === 401 ? "missing key" : "no such tile");
      return;
    }
    response.writeHead(200, { "content-type": "image/png", "content-length": String(PNG.length) });
    response.end(PNG);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("Settings turns provider tiles on with a key bound to the provider, never shown again, and off and back", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  await setTilePolicy(page, null);
  await forgetKey(page);
  const provider = await fakeProvider({ key: KEY });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openApp(page);
    let section = await openMapSettings(page);
    await expect(section.locator("[data-map-tiles-state]")).toHaveAttribute("data-map-tiles-state", "off");
    await expect(section.locator("[data-map-tiles-state]")).toHaveAttribute("data-map-tiles-offline", "no-provider");
    await expect(section.locator("[data-map-tiles-key]")).toHaveAttribute("data-map-tiles-key", "none");

    // A template carrying a key is refused before anything is stored, and the field says so.
    await section.locator("[data-map-tiles-field='origin']").fill(provider.origin);
    await section.locator("[data-map-tiles-field='template']").fill("/tiles/{z}/{x}/{y}.png?api_key=oops");
    await section.locator("[data-map-tiles-field='attribution']").fill("© Fixture tiles");
    await section.locator("[data-map-tiles-field='max-zoom']").fill("10");
    await section.locator("[data-map-tiles-save='true']").click();
    await expect(section.locator("[data-map-tiles-problem='true']")).toBeVisible();
    await expect(section.locator("[data-map-tiles-field='template']")).toHaveAttribute("aria-invalid", "true");
    expect(await tileView(page)).toEqual({ provider: null, offline: "no-provider" });

    await section.locator("[data-map-tiles-field='template']").fill("/tiles/{z}/{x}/{y}.png");
    await section.locator("[data-map-tiles-field='key']").fill(KEY);
    await section.locator("[data-map-tiles-field='placement-header']").check();
    await section.locator("[data-map-tiles-field='key-name']").fill("x-api-key");
    await section.locator("[data-map-tiles-save='true']").click();

    await expect(section.locator("[data-map-tiles-state]")).toHaveAttribute("data-map-tiles-state", "on", { timeout: 15_000 });
    await expect(section.locator("[data-map-tiles-state]")).toContainText(provider.origin);
    await expect(section.locator("[data-map-tiles-key]")).toHaveAttribute("data-map-tiles-key", "set");
    await expect(section.locator("[data-map-tiles-key]")).toHaveAttribute("data-map-tiles-key-origin", provider.origin);
    await expect(section.locator("[data-map-tiles-field='template']")).not.toHaveAttribute("aria-invalid", "true");
    // The key is saved, and never comes back: not in the field, the page, the policy or the page's view of it.
    await expect(section.locator("[data-map-tiles-field='key']")).toHaveValue("");
    expect(await page.content()).not.toContain(KEY);
    const preferences = await page.request.get(`${GATEWAY}/preferences`, { headers: authorized() });
    expect(await preferences.text()).not.toContain(KEY);
    expect(JSON.stringify(await tileView(page))).not.toContain(KEY);
    const key = await page.request.get(`${GATEWAY}/map-tiles/key`, { headers: authorized() });
    expect(await key.json()).toEqual({ key: { origin: provider.origin } });
    await page.screenshot({ path: testInfo.outputPath("map-tile-settings-on.png") });
    await page.keyboard.press("Escape");

    const card = await placeMap(page);
    await expect(card.locator("[data-map-tiles='provider']")).toHaveAttribute("data-map-tile-origin", provider.origin);
    await expect(card.locator("[data-map-tiles='provider']")).toContainText("© Fixture tiles");
    await expect.poll(() => card.locator("image[data-map-tile]").count(), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(provider.seen.length).toBeGreaterThan(0);
    // The node sent the key it holds, as the header the person named, for z/x/y tiles only — and the provider, which
    // refuses anything else, served every one.
    for (const entry of provider.seen) {
      expect(entry.path).toMatch(TILE_PATH);
      expect(entry.headers["x-api-key"]).toBe(KEY);
      expect(entry.status).toBe(200);
    }

    section = await openMapSettings(page);
    await section.locator("[data-map-tiles-off='true']").click();
    await expect(section.locator("[data-map-tiles-state]")).toHaveAttribute("data-map-tiles-state", "off", { timeout: 15_000 });
    await expect(section.locator("[data-map-tiles-state]")).toHaveAttribute("data-map-tiles-offline", "no-provider");
    // Undo brings the provider back, key and all.
    await section.locator("[data-map-tiles-undo='true']").click();
    await expect(section.locator("[data-map-tiles-state]")).toHaveAttribute("data-map-tiles-state", "on", { timeout: 15_000 });
    await section.locator("[data-map-tiles-off='true']").click();
    await expect(section.locator("[data-map-tiles-state]")).toHaveAttribute("data-map-tiles-state", "off", { timeout: 15_000 });
    await page.keyboard.press("Escape");

    const before = provider.seen.length;
    const offline = await placeMap(page);
    await expect(offline.locator("[data-map-tiles='off']")).toHaveAttribute("data-map-tiles-offline", "no-provider");
    await expect(offline.locator("[data-map-tiles='off']")).toContainText("Cài đặt");
    await expect(offline.locator("image[data-map-tile]")).toHaveCount(0);
    const refused = await page.request.get(`${GATEWAY}/map-tiles/0/0/0`, { headers: authorized() });
    expect(refused.status()).toBe(404);
    expect(provider.seen.length).toBe(before);
  } finally {
    await setTilePolicy(page, null);
    await forgetKey(page);
    await provider.close();
  }
});

test("Clark sets and clears the tile provider as the execution policy decides: at once when Autonomous, on a card when Ask", async ({ page }) => {
  test.setTimeout(150_000);
  await setTilePolicy(page, null);
  const provider = await fakeProvider();
  try {
    await setMode(page, "autonomous");
    await page.setViewportSize({ width: 1280, height: 900 });
    await openApp(page);
    await say(page, `hiện ô bản đồ từ ${provider.origin}`);
    await expect(page.getByText(`Đã bật ô bản đồ từ ${provider.origin}`).last()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-host-card="approval"]').filter({ hasText: provider.origin })).toHaveCount(0);
    await expect.poll(() => tileView(page), { timeout: 10_000 }).toMatchObject({ provider: { origin: provider.origin } });

    const card = await placeMap(page);
    await expect(card.locator("[data-map-tiles='provider']")).toHaveAttribute("data-map-tile-origin", provider.origin);
    await expect.poll(() => card.locator("image[data-map-tile]").count(), { timeout: 15_000 }).toBeGreaterThan(0);
    for (const entry of provider.seen) expect(entry.path).toMatch(TILE_PATH);

    await say(page, "tắt ô bản đồ");
    await expect(page.getByText("Đã tắt ô bản đồ").last()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => tileView(page), { timeout: 10_000 }).toEqual({ provider: null, offline: "no-provider" });

    // Ask mode: the host's card, and nothing changes until the person approves it.
    await setMode(page, "ask");
    await say(page, `hiện ô bản đồ từ ${provider.origin}`);
    const approval = page.locator('[data-host-card="approval"]').filter({ hasText: provider.origin }).last();
    await expect(approval).toBeVisible({ timeout: 20_000 });
    await expect(approval).toHaveAttribute("data-decision", "pending");
    await expect(approval).toContainText("chính sách ô bản đồ sẽ ghi");
    expect(await tileView(page)).toEqual({ provider: null, offline: "no-provider" });
    await approval.locator("[data-approve]").click();
    await expect(approval.locator('[data-approval-decision="answered"]')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => tileView(page), { timeout: 10_000 }).toMatchObject({ provider: { origin: provider.origin } });
  } finally {
    await setMode(page, "autonomous");
    await setTilePolicy(page, null);
    await provider.close();
  }
});

test("a keyed provider Clark sets at another origin than the key's runs without the key, and the map says why", async ({ page }) => {
  test.setTimeout(150_000);
  await setTilePolicy(page, null);
  const provider = await fakeProvider({ key: KEY });
  const keyOrigin = "https://tiles-the-person-chose.example";
  try {
    await setMode(page, "autonomous");
    // The person entered the key for another provider.
    const stored = await page.request.put(`${GATEWAY}/map-tiles/key`, { headers: authorized(), data: { origin: keyOrigin, value: KEY } });
    expect(stored.ok(), await stored.text()).toBe(true);

    await page.setViewportSize({ width: 1280, height: 900 });
    await openApp(page);
    await say(page, `hiện ô bản đồ từ ${provider.origin} với khóa header x-api-key`);
    await expect(page.getByText(`khóa đã lưu dành cho ${keyOrigin} nên không được gửi tới đó`).last()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => tileView(page), { timeout: 10_000 }).toEqual({ provider: null, offline: "key-origin-mismatch" });

    const card = await placeMap(page);
    await expect(card.locator("[data-map-tiles='off']")).toHaveAttribute("data-map-tiles-offline", "key-origin-mismatch");
    await expect(card.locator("[data-map-tiles='off']")).toContainText("nguồn khác");
    await expect(card.locator("image[data-map-tile]")).toHaveCount(0);
    const tile = await page.request.get(`${GATEWAY}/map-tiles/0/0/0`, { headers: authorized() });
    expect(tile.status()).toBe(503);
    // The key never left for the provider Clark named: it was not asked at all.
    expect(provider.seen).toEqual([]);

    const section = await openMapSettings(page);
    await expect(section.locator("[data-map-tiles-state]")).toHaveAttribute("data-map-tiles-offline", "key-origin-mismatch");
    await expect(section.locator("[data-map-tiles-key]")).toHaveAttribute("data-map-tiles-key", "other-origin");
    await expect(section.locator("[data-map-tiles-key]")).toHaveAttribute("data-map-tiles-key-origin", keyOrigin);
    // Entering the key again in Settings binds it to the provider's origin, and only that turns its tiles on.
    await section.locator("[data-map-tiles-field='key']").fill(KEY);
    await section.locator("[data-map-tiles-save='true']").click();
    await expect(section.locator("[data-map-tiles-state]")).toHaveAttribute("data-map-tiles-state", "on", { timeout: 15_000 });
    await expect(section.locator("[data-map-tiles-key]")).toHaveAttribute("data-map-tiles-key", "set");
    await expect(section.locator("[data-map-tiles-key]")).toHaveAttribute("data-map-tiles-key-origin", provider.origin);
  } finally {
    await setTilePolicy(page, null);
    await forgetKey(page);
    await provider.close();
  }
});
