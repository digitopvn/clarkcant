import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Changing the model with one key, in a real browser.
 *
 * What only a browser can prove is the pair the design cares about: the press reaches the node, and the label beside
 * the composer says which generation the next message will run on. The pool comes from the node's fixture, which
 * arranges the same precondition the composer fixture does.
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
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error("no local token in the e2e identity file");
  }
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
}

test("the hotkey moves to the next profile and the label follows", async ({ page }) => {
  await openApp(page);

  // The alias the node is on, read from the node rather than assumed: the label is beside the composer so it has to
  // be right without the settings panel ever being opened.
  const label = page.locator("[data-model-label]").first();
  await expect(label).toHaveAttribute("data-model-label", "fast", { timeout: 15_000 });

  await page.keyboard.press("Control+]");

  // The next profile by priority, and the note says what that means: a new generation, not the running turn.
  await expect(page.locator('[data-model-label="smart"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-model-note]").first()).toContainText("smart");

  // And the pool is a table in settings, so what the key walks is something a person can look at.
  await page.locator('[data-settings="true"]').click();
  await page.locator("#cc-tab-ai").click();
  const table = page.locator("[data-model-pool-table]");
  await expect(table).toBeVisible({ timeout: 15_000 });
  await expect(table).toContainText("fast");
  await expect(table).toContainText("smart");
  // The roles read in the interface language, and the order field fits inside the table rather than off its edge.
  const smart = table.locator('[data-model-profile="smart"]');
  await expect(smart).toContainText("trò chuyện, viết code");
  await expect(smart).not.toContainText("foreground");
  const priority = smart.locator("[data-model-priority]");
  const fieldBox = await priority.boundingBox();
  const tableBox = await table.boundingBox();
  expect(fieldBox!.x + fieldBox!.width).toBeLessThanOrEqual(tableBox!.x + tableBox!.width);
  expect(fieldBox!.width).toBeLessThan(140);});

test("a touch phone is told which model it is on, without a key chord it has no keys for", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await openApp(page);
  await expect(page.locator("[data-model-label]").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.cc-model-switch [data-model-note="shortcut"]')).toBeHidden();
  await context.close();
});

test("a keyboard is told the chord that changes the model", async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.cc-model-switch [data-model-note="shortcut"]')).toBeVisible({ timeout: 15_000 });
  // The chord is the platform's own: Ctrl on Windows and Linux, Command on macOS.
  await expect(page.locator('.cc-model-switch [data-model-note="shortcut"]')).toContainText(/Ctrl\+\]|⌘\]/u);
});
test("the statusline names the model the next turn runs and its thinking level, and follows a switch", async ({ page }) => {
  // The fixture node runs no model, so the node's answer is given one; everything else in it is the node's own.
  let model: { provider: string; id: string; thinkingLevel?: string } = { provider: "deepseek", id: "deepseek-v4-flash" };
  await page.route("**/node", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, model: { ...model, maxWallClockMs: 300_000, maxTokens: 32_000 } } });
  });
  await openApp(page);

  const statusline = page.locator("[data-statusline='true']");
  await expect(statusline).toContainText("deepseek-v4-flash");
  // No level named: the model thinks at its own default, which the statusline calls auto.
  await expect(statusline).toContainText("thinking: tự động");

  // A switch made from this page is read back at once, without a reload.
  model = { provider: "anthropic", id: "claude-opus-5-5", thinkingLevel: "high" };
  await page.locator("body").press("Control+]");
  await expect(statusline).toContainText("claude-opus-5-5");
  await expect(statusline).toContainText("thinking: high");
  await expect(statusline).not.toContainText("deepseek-v4-flash");
  await page.unroute("**/node");
});
