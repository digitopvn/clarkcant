import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The marketplace-results card, as the conversation shows it.
 *
 * What matters here is what a listing has to say to be judgeable — where it comes from, which version, the digest
 * the install path will check, and the lane the isolation implies — and that the card names the directory it came
 * from rather than presenting a third party's claim as a fact about this machine.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

/** The app connects to a node by token and gateway; a bare "/" reaches a page with no conversation on it. */
async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(`http://127.0.0.1:${NODE_PORT}`)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

async function search(page: Page): Promise<void> {
  await openApp(page);
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill("tìm gói");
  await composer.press("Enter");
}

test("a search result names its directory, its source and its risk lane", async ({ page }) => {
  await search(page);

  const card = page.locator("[data-marketplace='true']").first();
  await expect(card).toBeVisible();

  // The origin is visible, not implied: a result without it would look like something this machine knows.
  await expect(card).toContainText("/tmp/cc-directory.json");
  await expect(card.locator("[data-marketplace-package='com.acme.dashboard']")).toBeVisible();
  await expect(card.locator("[data-marketplace-source='true']")).toHaveText("/tmp/dashboard");
  await expect(card.locator("[data-marketplace-risk='isolated-ui']")).toContainText("cách ly");
  // The digest is shown, and the whole value is available rather than only the truncated line.
  await expect(card.locator("[data-marketplace-digest='true']")).toHaveAttribute("title", /^sha256:1{8}/);
  await expect(card).toContainText("1.0.0");
});

test("a search result offers no install button of its own", async ({ page }) => {
  await search(page);

  const card = page.locator("[data-marketplace='true']").first();
  await expect(card).toBeVisible();
  /*
   * Installing goes through the install path, where the digest is verified and consent is recorded. A button here
   * would be a second entry point into installing — and the one place a listing could become an authorisation.
   */
  await expect(card.locator("button")).toHaveCount(0);
});
