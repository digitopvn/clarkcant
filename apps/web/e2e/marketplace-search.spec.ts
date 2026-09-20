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
  // Scoped to the package under test: the card lists more than one now, so an unscoped locator would be asserting
  // against whichever row came first. The source is the exact npm version the directory resolves.
  const dashboard = card.locator("[data-marketplace-package='com.acme.dashboard']");
  await expect(dashboard.locator("[data-marketplace-source='true']")).toHaveText("com.acme.dashboard@1.0.0");
  await expect(dashboard.locator("[data-marketplace-risk='isolated-ui']")).toContainText("cách ly");
  // The digest is shown, and the whole value is available rather than only the truncated line.
  await expect(dashboard.locator("[data-marketplace-digest='true']")).toHaveAttribute("title", /^sha256:1{8}/);
  await expect(card).toContainText("1.0.0");
});

test("every install control belongs to the row it acts on", async ({ page }) => {
  await search(page);

  const card = page.locator("[data-marketplace='true']").first();
  await expect(card).toBeVisible();
  /*
   * This test used to assert the card had **no** install control, which was right while the install route did not
   * exist: a button whose action is missing is worse than no button. The route exists now, so each row carries its
   * own control, and what is worth asserting is that it is *per row* — a single card-wide control would be worse
   * than either, because it would have to guess which package was meant.
   */
  const rows = card.locator("[data-marketplace-package]");
  await expect(rows.locator("[data-install-package]")).toHaveCount(await rows.count());
  for (const id of ["com.acme.dashboard", "com.acme.not-listed"]) {
    // Each control names the package it installs, rather than relying on where it happens to sit.
    await expect(card.locator(`[data-marketplace-package='${id}'] [data-install-package='${id}']`)).toHaveCount(1);
  }
});
