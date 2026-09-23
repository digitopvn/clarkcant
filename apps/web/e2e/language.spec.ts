import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The UI language picker.
 *
 * Mirrors `appearance.spec.ts`'s theme test: the claim worth checking in a browser is that a
 * choice is actually applied to the surface, not just to the control's own selected state, and
 * that it survives a reload rather than being remembered only by the tab that set it.
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

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}


/** The node keeps the language choice, and the suite shares one node: put it back for the specs after this one. */
test.afterEach(async ({ request }) => {
  await request.put(`${GATEWAY}/preferences/experience.language`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { value: "vi" },
  });
});

test("switching the UI language changes visible labels, sets <html lang>, and survives a reload", async ({
  page,
}) => {
  await openApp(page);

  // Vietnamese is the default: the tab strip renders in Vietnamese, and the document says so, before
  // anyone touches the language control.
  await expect(page.evaluate(() => document.documentElement.lang)).resolves.toBe("vi");

  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-ai")).toHaveText("AI & Định tuyến");

  // Switching to English changes the tab strip immediately, not just the language control's own state.
  await page.locator('[data-segment="en"]').click();
  await expect(page.locator("#cc-tab-ai")).toHaveText("AI & Routing");
  await expect(page.locator("#cc-tab-experience")).toHaveText("Experience");
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("en");

  // The settings dialog chrome itself is translated, not only the tabs.
  await expect(page.locator(".cc-modal-done")).toHaveText("Done");

  // And it survives a reload: the choice is read back from storage, not just held in this tab's state.
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("en");
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-ai")).toHaveText("AI & Routing");

  // Back to Vietnamese, so this test leaves the shared node's cached preference where the rest of the
  // suite expects it.
  await page.locator('[data-segment="vi"]').click();
  await expect(page.locator("#cc-tab-ai")).toHaveText("AI & Định tuyến");
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("vi");
});
