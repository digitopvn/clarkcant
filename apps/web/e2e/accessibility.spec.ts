import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The accessibility claims, in a browser.
 *
 * Each of these is a rule from AGENTS.md and DESIGN.md §15 that cannot be checked by reading the source: whether a
 * keyboard can actually complete the main journey, whether a control is big enough to hit, whether the live region
 * is bounded, and whether the things a screen reader announces have names.
 *
 * The bounded live region is the one worth explaining. `aria-live="polite"` on the whole timeline would make a
 * screen reader re-read the conversation on every token that streams in, so what is asserted is the *bound*:
 * additions are announced and the rest is not. A test that only looked for `aria-live` would pass on the version
 * that reads the whole transcript aloud every second.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

/** The floor the design tokens set, repeated here so the test fails if the token moves and the UI does not. */
const MIN_TARGET_SIZE_PX = 24;

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

/** Reach an element with Tab only. A programmatic focus would be satisfied by something outside the tab order. */
async function tabUntil(page: Page, selector: string, maxPresses = 80): Promise<number> {
  for (let pressed = 1; pressed <= maxPresses; pressed += 1) {
    await page.keyboard.press("Tab");
    const reached = await page.evaluate((target) => document.activeElement?.matches(target) ?? false, selector);
    if (reached) return pressed;
  }
  return 0;
}

test("the main journey can be completed with the keyboard alone", async ({ page }) => {
  await openApp(page);

  // Reached by Tab, not by clicking: the composer is the primary control and it has to be in the tab order.
  const presses = await tabUntil(page, "[data-composer='true']");
  expect(presses, "the composer was not reachable with Tab alone").toBeGreaterThan(0);

  await page.keyboard.type("chào Clark");
  await page.keyboard.press("Enter");

  // And the send itself works from the keyboard, with the message in the transcript rather than only in the box.
  await expect(page.locator("[data-role='user']").last()).toContainText("chào Clark", { timeout: 20_000 });
});

test("every control is at least the size the tokens set", async ({ page }) => {
  await openApp(page);

  const sizes = await page.locator("[data-send='true'], [data-composer-open='true'], [data-settings='true']").evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { label: element.getAttribute("aria-label") ?? element.tagName, width: box.width, height: box.height };
    }),
  );

  expect(sizes.length).toBeGreaterThan(0);
  for (const size of sizes) {
    // Named in the failure, because "a control is too small" without saying which one is a search.
    expect(size.width, `${size.label} is ${String(size.width)}px wide`).toBeGreaterThanOrEqual(MIN_TARGET_SIZE_PX);
    expect(size.height, `${size.label} is ${String(size.height)}px tall`).toBeGreaterThanOrEqual(MIN_TARGET_SIZE_PX);
  }
});

test("the live regions are bounded rather than re-reading the conversation", async ({ page }) => {
  await openApp(page);

  // A message first: the timeline is what holds the transcript, so it does not exist until there is one — asserting
  // it on an empty conversation would be asserting a region that is not on screen.
  const composer = page.locator("[data-composer='true']");
  await composer.click();
  await composer.fill("kiểm tra vùng live region");
  await composer.press("Enter");
  await expect(page.locator("[data-role='user']").last()).toContainText("kiểm tra", { timeout: 20_000 });

  // Selected directly rather than by walking up from a message: what is being asserted is the region's own
  // attributes, and an ancestor lookup also fails if the markup nests differently than the test assumed.
  const timeline = page.locator(".cc-timeline").first();
  await expect(timeline).toHaveAttribute("aria-live", "polite");

  /*
   * The bound. `additions` means new messages are announced; the alternative — no `aria-relevant`, or `all` — makes
   * a streaming reply re-announce itself on every token, which is the failure this asserts against.
   */
  await expect(timeline).toHaveAttribute("aria-relevant", "additions");

  // The connection status is its own polite region rather than being folded into the transcript.
  const status = page.locator(".cc-status").first();
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveAttribute("aria-live", "polite");
});

test("the controls a screen reader lands on have names", async ({ page }) => {
  await openApp(page);

  const composer = page.locator("[data-composer='true']");
  await expect(composer).toHaveAttribute("aria-label", /.+/);

  const send = page.locator("[data-send='true']");
  await expect(send).toHaveAttribute("aria-label", /.+/);

  /*
   * An unnamed icon button is announced as "button", which is the same as having no label at all — and the icon is
   * the only visible affordance, so a sighted reader learns nothing about what the label was for either.
   */
  const settings = page.locator("[data-settings='true']");
  await expect(settings).toHaveAttribute("aria-label", /.+/);
});

test("a host card offers a text alternative to its visual form", async ({ page }) => {
  await openApp(page);

  const composer = page.locator("[data-composer='true']");
  await composer.click();
  await composer.fill("hỏi tôi một câu");
  await composer.press("Enter");

  const card = page.locator("[data-host-card='question']").last();
  await expect(card).toBeVisible({ timeout: 20_000 });

  /*
   * The card is announced as a named region rather than as a pile of buttons, and the answers are text — which is
   * what makes the card's text alternative the same thing as its control rather than a separate rendering.
   */
  await expect(card).toHaveAttribute("aria-label", /.+/);
  await expect(card.locator("[data-question-answer]").first()).toHaveText(/.+/);
});
