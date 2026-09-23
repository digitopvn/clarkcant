import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

/**
 * Switching the UI language actually changes the chrome, not just the settings screen it was chosen from.
 *
 * Vietnamese is the product's default language (AGENTS.md), and the language picker in Settings → Experience
 * has existed since before this suite: what had not been proven in a browser is that choosing English changes
 * anything a person can see *outside* Settings. Three surfaces are checked because they are three different
 * paths through the catalog — a plain string prop, an aria-label on a control with runtime-computed state, and
 * a heading in a different settings tab reached without a reload — and each one is a place a component could
 * have kept reading a hard-coded Vietnamese literal instead of `useT()`.
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

const PLACEHOLDER_PHRASES_VI = ["có cập nhật gì mới không?", "cần làm gì hôm nay?", "phân tích các commit gần nhất"];
const PLACEHOLDER_PHRASES_EN = ["any updates?", "what needs doing today?", "analyze the latest commits"];

/**
 * The composer placeholder is a typewriter animation, not a static value: it types and deletes one of a few
 * phrases in a loop. Reading it at an arbitrary moment sees a partial phrase (an empty string, `"c"`, `"có c"`,
 * ...) rather than any one it settles at. This polls until the attribute is exactly one of the full phrases for
 * the given language, which is the one point in the animation the phrase is a complete, checkable value.
 */
async function waitForFullPlaceholder(page: import("@playwright/test").Page, phrases: readonly string[]): Promise<void> {
  const composer = page.locator("[data-composer='true']");
  const pattern = new RegExp(`^(${phrases.map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`);
  await expect
    .poll(async () => composer.getAttribute("placeholder"), { timeout: 15_000, intervals: [100, 250, 500] })
    .toMatch(pattern);
}

test("choosing English changes the composer, a voice control, and the marketplace heading", async ({ page }) => {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });

  // The composer placeholder starts in Vietnamese, the product default.
  await waitForFullPlaceholder(page, PLACEHOLDER_PHRASES_VI);

  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-experience")).toBeVisible({ timeout: 20_000 });
  // Experience is the settings tab the language picker lives on, and is the default tab, but the click is
  // explicit so the test does not depend on which tab opened first.
  await page.locator("#cc-tab-experience").click();

  await expect(page.locator("[data-segmented='language']")).toBeVisible({ timeout: 10_000 });
  await page.locator("[data-segmented='language'] [data-segment='en']").click();
  await expect(page.locator("[data-segmented='language'] [data-segment='en']")).toHaveAttribute(
    "data-selected",
    "true",
  );

  // 3. The marketplace heading: a different settings tab, checked while Settings is still open so the
  //    assertion does not depend on a reload having happened after the language switch.
  await expect(page.locator("#cc-tab-extensions")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-extensions").click();
  await expect(page.locator("[data-marketplace-heading='true']")).toHaveText("Widget Library");

  // Settings is a modal; its scrim blocks the composer beneath it, so it must close before voice can open.
  await page.locator(".cc-modal-done").click();
  await expect(page.locator(".cc-modal-scrim")).toHaveCount(0);

  // 1. The composer: a plain string prop threaded from the catalog, and its static aria-label.
  await waitForFullPlaceholder(page, PLACEHOLDER_PHRASES_EN);
  await expect(page.locator("[data-composer='true']")).toHaveAttribute("aria-label", "Message input");

  // 2. A voice control: an aria-label computed from runtime state (muted vs. not), reached through
  //    composer -> voice overlay so the same session that just switched language is the one being checked.
  await page.locator("[data-voice-open='true']").click();
  await expect(page.locator("[data-voice-mute='true']")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-voice-mute='true']")).toHaveAttribute("aria-label", /Turn mic (on|off)/);
  await page.locator("[data-voice-end='true']").click();
});
