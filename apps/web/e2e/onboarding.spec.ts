import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The empty state.
 *
 * Two claims are worth a browser for. The first is that the four chips are really there and say
 * whether they need a model — a chip that quietly does nothing is worse than a missing one, because
 * the user concludes the app is broken rather than that something is not configured. The second is
 * that pressing one actually sends a message and the empty state goes away; a chip that fills the
 * composer and stops would look identical in a screenshot.
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
  const path = join(DATA_DIR, "identity.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`the node did not write its identity to ${path}`, { cause });
  }
  const parsed = JSON.parse(raw) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error(`no local token in ${path}`);
  }
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

test("the empty state offers four chips and says which need a model", async ({ page }) => {
  await openApp(page);

  const chips = page.locator("[data-suggestion]");
  await expect(chips).toHaveCount(4);

  // Every chip states whether it needs a model. The detail is visible text, not a tooltip, because
  // the question it answers is asked before the click rather than after. Read from the inner span:
  // the attribute sits on the button, so its text content includes the label as well.
  const details = await page.locator(".cc-chip-detail").allTextContents();
  expect(details).toHaveLength(4);
  for (const detail of details) {
    expect(["chạy trên dữ liệu mẫu", "cần model"]).toContain(detail);
  }
  // Exactly one chip needs a model; if they all did, the three scripted ones would be lying about
  // working on this node, and if none did the fourth would be lying about needing a provider.
  expect(details.filter((detail) => detail === "cần model")).toHaveLength(1);
});

test("a chip sends a real message and the empty state goes away", async ({ page }) => {
  await openApp(page);
  await expect(page.locator(".cc-empty")).toBeVisible();

  // The first chip reaches a scripted recipe, so this holds without a provider account.
  await page.locator("[data-suggestion='cho tui xem biểu đồ']").click();

  // Gone, not merely scrolled past: the timeline replaced it.
  await expect(page.locator(".cc-empty")).toHaveCount(0);
  await expect(page.locator(".cc-timeline")).toBeVisible({ timeout: 20_000 });

  // And the node answered rather than the client rendering an optimistic echo.
  await expect(page.locator("text=dữ liệu mẫu").first()).toBeVisible({ timeout: 20_000 });
});

test.describe("the first run", () => {
  // The state every other spec starts with, cleared here: this screen exists for somebody who has not seen it, and a
  // suite that marked everybody as already onboarded would never look at it at all.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("shows the name, the tagline and one way in, and does not come back", async ({ page }) => {
    // Its own navigation rather than the shared helper: that one waits for the connection status in the header, and this
    // screen deliberately has no header - which is exactly what made the first version of this test fail, and the
    // failure looked like the screen not rendering.
    await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);

    await expect(page.locator("[data-onboarding='true']")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-onboarding='true'] h1")).toHaveText("ClarkCant");
    await expect(page.locator("[data-onboarding='true'] p")).toContainText("Clark Cant Can");

    // Then the choices, in order, and then the key. All of it is walked here rather than assumed: this node may report
    // no provider at all, in which case the honest branch is the one that explains that and lets the person carry on.
    await page.locator("[data-onboarding-start='true']").click();
    await expect(page.locator("[data-onboarding-step='provider']")).toBeVisible();

    // Wait for the step to settle before branching: the catalogue is read from the node, so a count taken the instant
    // the step appears sees zero and would take the wrong branch. Reading it too early is what made this test fail
    // once already, and the failure looked like the screen not rendering.
    await page.locator("[data-onboarding-provider], [data-onboarding-none='true']").first().waitFor({ timeout: 20_000 });

    const provider = page.locator("[data-onboarding-provider]").first();
    if ((await provider.count()) > 0) {
      await provider.click();
      await expect(page.locator("[data-onboarding-step='model']")).toBeVisible();
      // A select rather than chips, because a provider can offer dozens of models: the first provider in this
      // machine's catalogue offers more than a screenful, and chips that cannot be reached cannot be clicked.
      await page.locator("[data-onboarding-model-select]").selectOption({ index: 1 });
      await page.locator("[data-onboarding-continue='true']").click();
    } else {
      // No provider on this node, and it says so in words rather than showing an empty list.
      await expect(page.locator("[data-onboarding-none='true']")).toBeVisible();
      await page.locator("[data-onboarding-finish='true']").click();
    }

    // The key, which is skippable and never echoed back.
    await expect(page.locator("[data-onboarding-key='typesafe']")).toBeVisible();
    const secret = "not-a-real-typesafe-key";
    await page.locator("[data-onboarding-key-input='true']").fill(secret);
    await expect(page.locator("[data-onboarding-key-input='true']")).toHaveValue(secret);
    // Skipped rather than saved, and not because saving is untested: this suite shares one node, so a credential written
    // here changes what a later spec sees. That is exactly how this test broke secret-input.spec.ts, whose node answered
    // with one more credential name than it expected. The save path is covered there, through the same client method
    // and the same route, so the coverage is kept and the side effect is not.
    await page.locator("[data-onboarding-finish='true']").click();

    await expect(page.locator("[data-onboarding='true']")).toHaveCount(0);
    // The value must not appear anywhere on the page: a secret echoed into a surface is a secret in a screenshot.
    await expect(page.locator(`text=${secret}`)).toHaveCount(0);

    // And it stays gone: a screen somebody has dismissed is dismissed, not shown again on the next load.
    await page.reload();
    await expect(page.locator("[data-onboarding='true']")).toHaveCount(0);
  });
});
