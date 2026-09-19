import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Reading a diff without a pointer.
 *
 * A diff is the one card whose content is routinely taller than the window, and that makes it the card most
 * likely to end up as a region only a mouse can scroll inside: the page scrolls, the diff does not, and the
 * reviewer a keyboard user cannot be is the one who was asked to approve the change.
 *
 * So the claim is not that the card is focusable in the abstract. It is that a keyboard user can reach it using
 * only keys, that the focus is visible when they arrive, and that the ring does not depend on the accent colour
 * alone — which is why the outline style is read rather than the class name.
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

/**
 * Reach an element using only Tab.
 *
 * Deliberately not `element.focus()`: a programmatic focus would be satisfied by an element that is reachable but
 * sits outside the tab order, which is the exact defect worth catching. It also would not trigger `:focus-visible`
 * in Chromium, so the visible-ring assertion after it would be meaningless.
 */
async function tabUntil(page: Page, selector: string, maxPresses = 80): Promise<number> {
  for (let pressed = 1; pressed <= maxPresses; pressed += 1) {
    await page.keyboard.press("Tab");
    const reached = await page.evaluate(
      (target) => document.activeElement?.matches(target) ?? false,
      selector,
    );
    if (reached) return pressed;
  }
  return 0;
}

test("a diff is reachable and visibly focused using only the keyboard", async ({ page }) => {
  await openApp(page);

  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("xem diff");
  await composer.press("Enter");

  const card = page.locator("[data-host-card='code-diff']").last();
  await expect(card).toBeVisible({ timeout: 20_000 });

  // Announced as a group with a name, so arriving at it says what it is rather than only where the cursor is.
  await expect(card).toHaveAttribute("data-diff-keyboard", "true");
  await expect(card).toHaveAttribute("role", "group");
  await expect(card).toHaveAttribute("aria-label", /^Diff: /);

  // Start from a known place so the walk is over a fixed sequence rather than wherever the last click landed.
  await composer.click();
  const presses = await tabUntil(page, "[data-host-card='code-diff']");

  expect(presses, "the diff was not reachable with Tab alone").toBeGreaterThan(0);
  await expect(card).toBeFocused();

  /*
   * The ring itself. Read as a computed style because a class name would pass even if a later rule overrode it —
   * and because the requirement is that the outline is a solid, non-zero line rather than the accent colour
   * alone being the only signal.
   */
  const outline = await card.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(outline.style).toBe("solid");
  expect(outline.width).not.toBe("0px");
});
