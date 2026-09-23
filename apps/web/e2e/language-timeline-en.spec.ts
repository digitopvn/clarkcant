import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Timeline and widget chrome in English.
 *
 * `language.spec.ts` proves the settings/tab strip translates. This proves the same switch reaches
 * the transcript itself: a tool call's own chrome (its status word, its "result" label) and an
 * approval card's buttons, using the same scripted fixture `approval.spec.ts` drives so the turn is
 * account-free and deterministic.
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

/** Switches the UI language through the same settings control `language.spec.ts` drives. */
async function switchToEnglish(page: Page): Promise<void> {
  await page.locator("[data-settings='true']").click();
  await page.locator('[data-segment="en"]').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("en");
  // Close back to the conversation the same way a person does.
  await page.keyboard.press("Escape");
}

/** Ask for the scripted proposal and wait for its card, mirroring `approval.spec.ts`. */
async function propose(page: Page): Promise<void> {
  await page.locator("[data-composer]").fill("chạy lệnh thử");
  await page.locator("[data-send]").click();
  await expect(page.locator('[data-host-card="approval"]').first()).toBeVisible({ timeout: 20_000 });
}


/** The node keeps the language choice, and the suite shares one node: put it back for the specs after this one. */
test.afterEach(async ({ request }) => {
  await request.put(`${GATEWAY}/preferences/experience.language`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { value: "vi" },
  });
});

test("switching to English translates an approval card and a tool call's chrome", async ({ page }) => {
  await openApp(page);
  await switchToEnglish(page);
  await propose(page);

  const card = page.locator('[data-host-card="approval"]').first();
  // The approval card's own chrome — not the command it proposes, which is data, not UI text.
  await expect(card).toContainText("Needs your confirmation");
  await expect(card.locator("[data-approve]")).toHaveText(/Approve and run/);
  await expect(card.locator("[data-deny]")).toHaveText(/Deny/);

  await card.locator("[data-approve]").click();

  // The receipt: a tool-activity block whose status word and section labels are chrome, translated
  // the same as everything else, while its command and result stay untouched data.
  const receipt = page.locator('[data-tool-name="run_command"]').first();
  await expect(receipt).toBeVisible({ timeout: 30_000 });
  await expect(receipt.locator(".cc-sr-only")).toHaveText("done");
  await expect(receipt).toContainText("result");
  await expect(receipt).toContainText("fixture ran");

  await expect(card.locator('[data-approval-decision="answered"]')).toBeVisible();
});
