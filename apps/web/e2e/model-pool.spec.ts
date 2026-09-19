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
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
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
  await page.locator("#cc-tab-models").click();
  const table = page.locator("[data-model-pool-table]");
  await expect(table).toBeVisible({ timeout: 15_000 });
  await expect(table).toContainText("fast");
  await expect(table).toContainText("smart");
});
