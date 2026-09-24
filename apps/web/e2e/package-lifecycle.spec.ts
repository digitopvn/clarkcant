import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Uninstalling and restoring a package from Settings, in the browser.
 *
 * The route's own tests cover what is kept and what is refused; this covers what only a browser can: that the
 * installed row has a real control reaching that route, that the outcome is announced where keyboard focus lands,
 * and that an uninstalled package moves to a list it can be restored from — rather than vanishing, which would read
 * as "deleted" when nothing was.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const PACKAGE = "com.acme.dashboard";

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

async function openExtensions(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-extensions")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-extensions").click();
}

test("an uninstalled package keeps a restore control, and restoring brings it back", async ({ page, request }) => {
  // Installed through the route the marketplace button uses, so this spec does not depend on the order specs run in.
  const listed = await request.get(`${GATEWAY}/packages`, { headers: { authorization: `Bearer ${token()}` } });
  const before = (await listed.json()) as { packages: { packageId: string }[] };
  if (!before.packages.some((entry) => entry.packageId === PACKAGE)) {
    const installed = await request.post(`${GATEWAY}/packages/install`, {
      headers: { authorization: `Bearer ${token()}` },
      data: { packageId: PACKAGE, version: "1.0.0" },
    });
    expect(installed.ok()).toBe(true);
  }

  await openExtensions(page);
  const row = page.locator(`[data-installed-package='${PACKAGE}']`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  // Only one version was ever active here, so there is nowhere to roll back to and no control that pretends otherwise.
  await expect(row.locator("[data-package-rollback]")).toHaveCount(0);

  // Keyboard only: the control is a real button, and the outcome is announced where focus lands.
  await row.locator("[data-package-uninstall]").focus();
  await page.keyboard.press("Enter");

  const status = page.locator("[data-package-status]");
  await expect(status).toHaveAttribute("data-package-status", "done", { timeout: 20_000 });
  await expect(status).toContainText("Đã gỡ");
  await expect(status).toContainText("dữ liệu và lịch sử được giữ");
  await expect(status).toBeFocused();
  await expect(row).toHaveCount(0);

  const restorable = page.locator(`[data-restorable-package='${PACKAGE}']`);
  await expect(restorable).toBeVisible();
  await restorable.locator("[data-package-restore]").click();

  await expect(status).toContainText("Đã khôi phục", { timeout: 20_000 });
  await expect(page.locator(`[data-installed-package='${PACKAGE}']`)).toBeVisible();
  await expect(restorable).toHaveCount(0);
});

test("a package that is not installed is refused by name", async ({ request }) => {
  // An id reaches the route encoded, and the answer names why rather than reporting a change that did not happen.
  const refused = await request.post(`${GATEWAY}/packages/${encodeURIComponent("com.acme.not-installed")}/uninstall`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  expect(refused.status()).toBe(404);
  expect(((await refused.json()) as { code?: string }).code).toBe("NOT_INSTALLED");
});
