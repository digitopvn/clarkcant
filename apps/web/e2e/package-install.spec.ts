import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Installing from a listing, in the browser.
 *
 * The route's own tests cover what it refuses and why; this covers the part only a browser can: that the listing a
 * person is looking at has a control that reaches that route, and that both an install and a refusal come back as
 * something a reader can tell apart.
 *
 * The directory the node reads is a fixture, and the suite configures it — without one the honest answer to every
 * install is "no directory is configured", which would leave the refusal path as the only journey a browser could
 * ever walk.
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

async function openSearch(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(`http://127.0.0.1:${NODE_PORT}`)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill("tìm gói");
  await composer.press("Enter");
  await expect(page.locator("[data-marketplace='true']").first()).toBeVisible();
}

test("a listing can be installed, and says so", async ({ page }) => {
  await openSearch(page);

  const listed = page.locator("[data-marketplace-package='com.acme.dashboard']");
  await listed.locator("[data-install-package]").click();

  // The outcome is shown where the control is, so a reader does not have to infer it from the card changing shape.
  await expect(listed.locator("[data-install-state='installed']")).toBeVisible({ timeout: 20_000 });
  await expect(listed.locator("[data-install-state='installed']")).toContainText("Đã cài");
});

test("a package the directory does not list is refused by name, in place", async ({ page }) => {
  await openSearch(page);

  const unlisted = page.locator("[data-marketplace-package='com.acme.not-listed']");
  await unlisted.locator("[data-install-package]").click();

  /*
   * The refusal is not a silent no-op: the node's own reason lands beside the button that was pressed, which is the
   * difference between "we refuse that" and "nothing happened".
   */
  const refused = unlisted.locator("[data-install-state='refused']");
  await expect(refused).toBeVisible({ timeout: 20_000 });
  await expect(refused).not.toBeEmpty();
});

test("only the listing that was pressed reports an outcome", async ({ page }) => {
  await openSearch(page);

  const listed = page.locator("[data-marketplace-package='com.acme.dashboard']");
  await listed.locator("[data-install-package]").click();
  await expect(listed.locator("[data-install-state]")).toBeVisible({ timeout: 20_000 });

  // A status shown on every row would read as though every row had been installed.
  await expect(page.locator("[data-marketplace-package='com.acme.not-listed'] [data-install-state]")).toHaveCount(0);
});
