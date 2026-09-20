import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * What is installed, in the Extensions tab.
 *
 * The claim worth a browser is that the list is honest about its own emptiness. A fresh node has nothing installed,
 * and the two ways to get that wrong are to show a placeholder row or to show nothing at all — the first invents a
 * package, the second is indistinguishable from a section that failed to load.
 *
 * The second claim is the labelling. A native Pi extension is trusted process-level code that runs beside the host;
 * an isolated widget is opaque-origin code in a frame with no Node, no filesystem and no host cookies. This test
 * pins that the lane is carried on each row, so the two can never be shown with the same wording.
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

test("the installed list says it is empty rather than showing a placeholder", async ({ page }) => {
  await openExtensions(page);

  const section = page.locator("section", { hasText: "Đã cài trên node này" }).last();
  await expect(section).toBeVisible({ timeout: 20_000 });

  // Either it names what is installed or it says there is nothing — never a row that stands for nothing.
  const rows = section.locator("[data-installed-package]");
  const empty = section.getByText("Chưa cài gói nào trên node này.");

  const rowCount = await rows.count();
  if (rowCount === 0) {
    await expect(empty).toBeVisible();
  } else {
    /*
     * If this node has packages, each row has to carry the facts the section exists for: where it came from, which
     * digest, and which lane. Asserted per row rather than in aggregate, because one row missing its digest is the
     * failure this list is meant to prevent.
     */
    for (let index = 0; index < rowCount; index += 1) {
      const row = rows.nth(index);
      await expect(row.locator("[data-installed-digest]")).toHaveCount(1);
      /*
       * The lane is an attribute of the row itself, not a descendant: `row.locator(...)` searches *inside* an
       * element, so the previous form could never match. It went unnoticed because this node had no packages
       * installed until the install journey gave it one — the per-row branch had never run.
       */
      await expect(row).toHaveAttribute("data-installed-lane", /.+/);
      await expect(row.locator("[data-installed-source-tier]")).toHaveCount(1);
    }
    await expect(empty).toHaveCount(0);
  }
});

test("the lane is carried on the row, so two very different trust levels cannot read the same", async ({ page }) => {
  await openExtensions(page);

  const section = page.locator("section", { hasText: "Đã cài trên node này" }).last();
  await expect(section).toBeVisible({ timeout: 20_000 });

  const lanes = await section.locator("[data-installed-package]").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-installed-lane")),
  );

  // Whatever is installed, each row names a lane from the closed set — and never a lane the product does not have.
  for (const lane of lanes) {
    expect(["declarative", "isolated-ui", "service", "trusted-native"]).toContain(lane);
  }
});
