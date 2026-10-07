import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The changelog, as a person reaches it: `/changelog` answered in the conversation with the host-owned card, and the
 * same notes in Settings. Both read the release notes embedded with the node's build, so the version they name is the
 * repository's Clark version, and neither offers an update control.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const CLARK_VERSION = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string }).version;

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("the node's identity file has no local token");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("[data-composer]")).toBeVisible();
}

test("/changelog answers with the host-owned card naming the installed version, and no update control", async ({ page }) => {
  await openApp(page);
  const composer = page.locator("[data-composer]");
  await composer.click();
  await composer.fill("/changelog");
  await composer.press("Enter");

  const card = page.locator('.cc-row[data-role="assistant"] [data-changelog="true"]').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.locator(`[data-installed-version="${CLARK_VERSION}"]`)).toBeVisible();
  // The newest release is open, and the baseline is labelled as history rather than as a release.
  await expect(card.locator("details[data-release-kind]").first()).toHaveAttribute("open", "");
  await expect(card.locator('details[data-release-kind="baseline"]')).toHaveCount(1);
  // The repository runs from source: the card says which commit its notes reach, rather than passing them off as current.
  await expect(card.locator("[data-changelog-covers]")).toBeVisible();
  await expect(card.locator("button, select, input")).toHaveCount(0);
  await expect(page.locator('.cc-row[data-role="user"]', { hasText: "/changelog" })).toHaveCount(0);
});

test("Settings shows the same notes under Version & what's new", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  const section = page.locator("[data-changelog-settings='true']");
  await expect(section).toBeVisible({ timeout: 20_000 });
  await expect(section.locator(`[data-installed-version="${CLARK_VERSION}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(section.locator('details[data-release-kind="baseline"]')).toHaveCount(1);
  await expect(section.locator("button, select, input")).toHaveCount(0);
});
