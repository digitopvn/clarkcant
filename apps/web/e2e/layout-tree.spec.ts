import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * A surface the model arranged as a tree, in a real browser.
 *
 * The tree is proposed through the composed view a model's `show_view` uses, so the compiler, the catalog lookup and
 * the bounds are the host's. What only a browser can say is whether the arrangement was drawn: a grid with the columns
 * it asked for, a card holding what it holds, tabs a keyboard can drive, a section that opens, and one column when the
 * surface is narrow — and whether the conversation, reloaded, draws the same tree from what was stored.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

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

/** Ask for one of the fixture's trees and return the newest arranged surface. */
async function arrange(page: Page, which: "bảng điều khiển" | "đầy đủ"): Promise<Locator> {
  const before = await page.locator("[data-layout-root]").count();
  await say(page, `bố cục ${which}`);
  await expect(page.locator("[data-layout-root]")).toHaveCount(before + 1, { timeout: 30_000 });
  return page.locator("[data-layout-root]").nth(before);
}

/** How many columns a grid is drawing right now, from the browser's own layout. */
async function columnsOf(grid: Locator): Promise<number> {
  return grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").filter((part) => part !== "").length);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test("a grid of two tiles and a card is drawn as the tree says, and again from history after a reload", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  const surface = await arrange(page, "bảng điều khiển");

  const grid = surface.locator(":scope > [data-layout='grid']");
  await expect(grid).toHaveAttribute("data-layout-columns", "3");
  const body = grid.locator(":scope > .cc-layout-grid-body");
  await expect(body.locator(":scope > [data-layout='widget'] [data-slot='metrics']")).toHaveCount(2);
  const card = body.locator(":scope > [data-layout='card']");
  await expect(card).toHaveAttribute("data-layout-label", "Chi tiết theo ngày");
  await expect(card.getByRole("heading", { name: "Chi tiết theo ngày" })).toBeVisible();
  // Inside the card, in the order the tree gives: the period selector above the table.
  const inCard = card.locator("[data-slot]");
  await expect(inCard).toHaveCount(2);
  await expect(inCard.nth(0)).toHaveAttribute("data-slot", "filter");
  await expect(inCard.nth(1)).toHaveAttribute("data-slot", "table");
  // Side by side where the conversation has room, and never more columns than the tree asked for: a column narrower
  // than a region can be read at is dropped rather than drawn.
  const wide = await columnsOf(body);
  expect(wide).toBeGreaterThan(1);
  expect(wide).toBeLessThanOrEqual(3);
  await surface.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("layout-dashboard-desktop.png") });

  // History: the reloaded conversation draws the same tree from the stored bundle.
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  const again = page.locator("[data-layout-root]").last();
  await expect(again.locator(":scope > [data-layout='grid'] > .cc-layout-grid-body > [data-layout='card'] [data-slot='table']")).toBeVisible({
    timeout: 30_000,
  });
  await expect(again.locator("[data-slot='metrics']")).toHaveCount(2);
  await expect(again.locator("[data-layout='card']")).toHaveAttribute("data-layout-label", "Chi tiết theo ngày");

  // Narrow: one column, nothing wider than the screen.
  await page.setViewportSize({ width: 375, height: 812 });
  await again.scrollIntoViewIfNeeded();
  await expect.poll(() => columnsOf(again.locator(".cc-layout-grid-body").first())).toBe(1);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("layout-dashboard-mobile.png") });
});

test("tabs follow the keyboard, a collapsible opens, and a split stacks when narrow", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  const surface = await arrange(page, "đầy đủ");

  await expect(surface.locator("[data-layout='row'] [data-slot]")).toHaveCount(2);
  await expect(surface.locator("hr.cc-layout-divider")).toHaveCount(1);

  // Tabs: one stop in the tab order, arrows move and select, Home and End jump.
  const tablist = surface.getByRole("tablist", { name: "Xu hướng và bảng" });
  const chart = tablist.getByRole("tab", { name: "Biểu đồ" });
  const table = tablist.getByRole("tab", { name: "Bảng" });
  await expect(chart).toHaveAttribute("aria-selected", "true");
  await expect(table).toHaveAttribute("tabindex", "-1");
  const panels = surface.locator("[data-layout='tabs'] [role='tabpanel']");
  await expect(panels.nth(0)).toBeVisible();
  await expect(panels.nth(1)).toBeHidden();

  await chart.focus();
  await page.keyboard.press("ArrowRight");
  await expect(table).toBeFocused();
  await expect(table).toHaveAttribute("aria-selected", "true");
  await expect(panels.nth(1)).toBeVisible();
  await expect(panels.nth(1).locator("[data-slot='table']")).toBeVisible();
  await expect(panels.nth(0)).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(chart).toBeFocused();
  await page.keyboard.press("End");
  await expect(table).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(chart).toHaveAttribute("aria-selected", "true");
  // The panel says which tab labels it.
  await expect(panels.nth(0)).toHaveAttribute("aria-labelledby", (await chart.getAttribute("id")) ?? "");

  // The collapsible starts closed, as the tree says, and opens from the keyboard.
  const collapsible = surface.locator("[data-layout='collapsible']");
  await expect(collapsible).not.toHaveAttribute("open", /.*/u);
  await expect(collapsible.locator("[data-slot='trend']")).toBeHidden();
  await collapsible.locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  await expect(collapsible.locator("[data-slot='trend']")).toBeVisible();

  // The split has two sides next to each other while there is room.
  const split = surface.locator("[data-layout='split'] > .cc-layout-split-body");
  const sides = split.locator(":scope > [data-layout='widget']");
  await expect(sides).toHaveCount(2);
  const [left, right] = [await sides.nth(0).boundingBox(), await sides.nth(1).boundingBox()];
  expect(left !== null && right !== null && right.x > left.x + left.width - 1).toBe(true);
  await surface.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("layout-all-kinds-desktop.png"), fullPage: true });

  // And one above the other when there is not.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect
    .poll(async () => {
      const [top, bottom] = [await sides.nth(0).boundingBox(), await sides.nth(1).boundingBox()];
      return top !== null && bottom !== null && bottom.y >= top.y + top.height - 1;
    })
    .toBe(true);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("layout-all-kinds-mobile.png"), fullPage: true });
});

test("a tree the node cannot honour is refused in the conversation, with the reason, and nothing is drawn", async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  const before = await page.locator("[data-layout-root]").count();

  await say(page, "bố cục quá sâu");
  await expect(page.locator("[data-role='assistant']").last()).toContainText("levels deep", { timeout: 20_000 });
  await say(page, "bố cục widget lạ");
  await expect(page.locator("[data-role='assistant']").last()).toContainText("canvas.sparkle@1", { timeout: 20_000 });
  await expect(page.locator("[data-role='assistant']").last()).toContainText("not a widget this node's catalog holds");

  await expect(page.locator("[data-layout-root]")).toHaveCount(before);
});
