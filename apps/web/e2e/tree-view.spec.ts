import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

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

async function instanceOf(tree: Locator): Promise<string> {
  const id = await tree.evaluate((element) => element.closest("[data-widget-instance]")?.getAttribute("data-widget-instance") ?? "");
  expect(id, "the hierarchy is drawn for a saved widget instance").not.toBe("");
  return id;
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test("the conversation tree is keyboard accessible, host-persisted and responsive", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openApp(page);
  await say(page, "đặt cây phân cấp");

  const tree = page.getByRole("tree", { name: "Dự án" });
  await expect(tree).toBeVisible({ timeout: 20_000 });
  const row = (id: string): Locator => tree.locator(`[data-tree-row='${id}']`);
  await expect(row("project")).toHaveAttribute("aria-expanded", "true");
  await expect(row("project")).toHaveAttribute("aria-level", "1");
  await expect(row("project")).toHaveAttribute("aria-posinset", "1");
  await expect(row("project")).toHaveAttribute("aria-setsize", "2");
  await expect(row("composer")).toContainText("Đang hoạt động");
  await expect(tree.locator("[role='treeitem'][tabindex='0']")).toHaveCount(1);

  // Home, End and type-ahead follow the same visible hierarchy without changing its saved view.
  await row("project").focus();
  await page.keyboard.press("r");
  await expect(row("runtime")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(row("project")).toBeFocused();
  await page.keyboard.press("End");
  await expect(row("people")).toBeFocused();

  // Arrow keys walk the currently visible hierarchy. Right opens a branch; left closes it.
  await row("project").focus();
  await page.keyboard.press("ArrowDown");
  await expect(row("client")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row("composer")).toBeFocused();
  await page.keyboard.press("Enter");
  const instanceId = await instanceOf(tree);
  const conversation = await conversationId(page);
  await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toMatchObject({ selectedId: "composer" });

  await row("client").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(row("composer")).toHaveCount(0);
  await expect(row("client")).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toMatchObject({
    selectedId: "composer",
    expandedIds: ["project"],
  });

  // The standalone renderer pins compactly; its pin record and view state both survive a reload.
  const pinResponse = await page.request.post(`${GATEWAY}/conversations/${encodeURIComponent(conversation)}/pins`, {
    headers: { ...authorized(), "content-type": "application/json" },
    data: { instanceId, displayMode: "compact" },
  });
  expect(pinResponse.status()).toBe(201);
  const pin = (await pinResponse.json()) as { pinId: string };
  await page.reload();
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`[data-pin-id='${pin.pinId}']`)).toBeVisible({ timeout: 20_000 });
  const restored = page.getByRole("tree", { name: "Dự án" }).first();
  const restoredRow = (id: string): Locator => restored.locator(`[data-tree-row='${id}']`);
  await expect(restoredRow("project")).toHaveAttribute("aria-expanded", "true");
  await expect(restoredRow("client")).toHaveAttribute("aria-expanded", "false");
  await restoredRow("client").focus();
  await page.keyboard.press("ArrowRight");
  await expect(restoredRow("composer")).toBeVisible();
  await expect(restoredRow("composer")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toMatchObject({
    selectedId: "composer",
    expandedIds: ["project", "client"],
  });
  await page.locator(`[data-unpin='${pin.pinId}']`).click();
  await expect(page.locator(`[data-pin-live='${pin.pinId}']`)).toHaveCount(0);

  const inlineTree = page.getByRole("tree", { name: "Dự án" }).first();
  const reducedMotion = await inlineTree.locator("[data-tree-row='project']").evaluate((element) => {
    const style = getComputedStyle(element);
    return { animation: style.animationName, transition: style.transitionDuration };
  });
  expect(reducedMotion.animation).toBe("none");
  expect(reducedMotion.transition.split(",").every((part) => Number.parseFloat(part) === 0)).toBe(true);

  await page.screenshot({ path: testInfo.outputPath("tree-1280-dark.png"), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe("dark");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("tree-390-dark.png"), fullPage: false });
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe("light");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("tree-390-light.png"), fullPage: false });
});

test("the Widget Library previews the tree fixture with the production renderer", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-developer")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-developer").click();
  await page.locator("[data-widget-library-open='develop']").click();
  await page.locator("[data-widget-card='canvas.tree@1']").click();
  const preview = page.locator("[data-widget-preview='canvas.tree@1']");
  const tree = preview.getByRole("tree", { name: "Dự án" });
  await expect(tree).toBeVisible({ timeout: 20_000 });
  await expect(tree.locator("[data-tree-row='composer'][aria-selected='true']")).toBeVisible();
  await page.locator("[data-widget-lab-fixture='true']").selectOption("tree.empty");
  await expect(preview.locator("[data-tree-state='empty']")).toBeVisible();
  await page.locator("[data-widget-lab-fixture='true']").selectOption("tree.normal");
  await expect(tree.locator("[data-tree-row='project']")).toBeVisible();
  await tree.locator("[data-tree-row='runtime']").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tree.locator("[data-tree-row='worker']")).toBeVisible();

  await page.locator("[data-widget-lab-viewport='true']").selectOption("320");
  const frame = page.locator("[data-widget-preview-frame]");
  await expect(frame).toHaveCSS("width", "320px");
  await page.locator("[data-widget-lab-theme='true']").selectOption("dark");
  await expect(frame).toHaveAttribute("data-cc-theme", "dark");
  await page.locator("[data-widget-lab-reduced-motion='true']").check();
  await expect(frame).toHaveAttribute("data-cc-reduced-motion", "true");
  await page.screenshot({ path: testInfo.outputPath("tree-library-dark-narrow.png") });
});

test("the tree refuses a duplicate identifier with the host's reason", async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  const before = await page.getByRole("tree").count();
  await say(page, "đặt cây phân cấp trùng");
  await expect(page.getByText(/node ids repeat: project/u).last()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("tree")).toHaveCount(before);
});
