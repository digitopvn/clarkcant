import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Reporting a bug from the conversation, as a person does it: `/report` summons the Feedback Composer, Preview shows
 * the issue exactly as it would be filed, and Create issue answers with a result card naming the issue GitHub was read
 * back holding.
 *
 * The node files to an in-process GitHub (`CC_GITHUB_FIXTURE`), so nothing reaches the real repository; what the
 * browser proves is the path from the composer to the host's card and the truth of what that card claims.
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
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("the node's identity file has no local token");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("[data-composer]")).toBeVisible();
}

test("/report is offered after a slash, and a bare /report summons the Feedback Composer", async ({ page }) => {
  await openApp(page);
  const composer = page.locator("[data-composer]");
  await composer.click();
  await page.keyboard.type("/rep");
  await expect(page.locator('[data-reference-option="report"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("/report ");
  await page.keyboard.press("Enter");

  const card = page.locator('.cc-row[data-role="assistant"] [data-feedback-stage="compose"]').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  // What would be shared is one disclosure away, before anything is sent.
  await card.locator("[data-feedback-shared] summary").click();
  await expect(card.locator("[data-feedback-shared]")).toContainText("digitopvn/clarkcant");
});

test("a bug is previewed, filed, and answered with the issue GitHub holds", async ({ page }) => {
  await openApp(page);
  const composer = page.locator("[data-composer]");
  await composer.click();
  await composer.fill("/report");
  await composer.press("Enter");

  const card = page.locator('.cc-row[data-role="assistant"] [data-feedback-stage="compose"]').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.locator('[data-feedback-kind="bug"]').check();
  await card.locator("[data-feedback-description]").fill("The orb stops animating after the laptop wakes from sleep");

  await card.locator("[data-feedback-preview-button]").click();
  const preview = card.locator("[data-feedback-preview]");
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await expect(preview).toContainText("bug: the orb stops animating");
  // A reproduction nobody gave is said to be unknown, not invented.
  await expect(preview).toContainText("Not known yet.");

  await card.locator("[data-feedback-create]").click();
  const result = page.locator('.cc-row[data-role="assistant"] [data-feedback-stage="result"]').last();
  await expect(result).toBeVisible({ timeout: 20_000 });
  await expect(result).toHaveAttribute("data-feedback-status", "published");
  await expect(result.locator("[data-feedback-issue]")).toHaveAttribute("href", /^https:\/\/github\.com\/digitopvn\/clarkcant\/issues\/\d+$/u);
  // Handling is reported with its reason, and nothing offers to start it.
  await expect(result.locator('[data-feedback-eligibility="handling-unavailable"]')).toBeVisible();
  await expect(result.locator("button")).toHaveCount(0);
});
