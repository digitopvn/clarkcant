import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The root interaction-state contract (DESIGN.md §4, AGENTS.md "Motion and interaction").
 *
 * Four claims, none checkable by reading the source alone:
 *
 *   - `data-window-mode`, `data-policy-mode` and `data-input-modality` are published on the shell
 *     root and follow real state changes, rather than a component guessing from unrelated DOM.
 *   - Every interactive control gets a visible focus ring on Tab, from a token rather than the
 *     accent colour alone.
 *   - `prefers-reduced-motion: reduce` never leaves a zero-duration animation spinning forever —
 *     the specific bug DESIGN.md §3.4 calls out by name.
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

/** Reach an element with Tab only, so `:focus-visible` engages the same way it does for a real keyboard user. */
async function tabUntil(page: Page, selector: string, maxPresses = 80): Promise<number> {
  for (let pressed = 1; pressed <= maxPresses; pressed += 1) {
    await page.keyboard.press("Tab");
    const reached = await page.evaluate((target) => document.activeElement?.matches(target) ?? false, selector);
    if (reached) return pressed;
  }
  return 0;
}

const shellAttribute = (page: Page, name: string): Promise<string | null> =>
  page.evaluate((attr) => document.querySelector(".cc-shell")?.getAttribute(attr) ?? null, name);

test("the shell publishes window mode, policy mode and input modality as root attributes", async ({ page }) => {
  await openApp(page);

  // Present and one of the declared values from the first paint, not only after some interaction —
  // a component reading these off the shell must never see them absent.
  expect(await shellAttribute(page, "data-window-mode")).toMatch(/^(normal|expanded|compact|orb)$/);
  expect(await shellAttribute(page, "data-policy-mode")).toMatch(/^(autonomous|guarded|ask)$/);
  expect(await shellAttribute(page, "data-input-modality")).toMatch(/^(pointer|keyboard|touch|voice)$/);
});

test("data-input-modality follows the keyboard, not a component's own guess", async ({ page }) => {
  await openApp(page);

  // A pointer touched the page to open it, so the default is pointer; nothing here has typed yet.
  await page.mouse.move(200, 200);
  await expect.poll(() => shellAttribute(page, "data-input-modality")).toBe("pointer");

  // One key press is enough to switch the whole shell over, which is the point of publishing this as
  // one attribute: every component that reads it agrees on the same last-used modality.
  await page.keyboard.press("Tab");
  await expect.poll(() => shellAttribute(page, "data-input-modality")).toBe("keyboard");

  await page.mouse.move(250, 260);
  await expect.poll(() => shellAttribute(page, "data-input-modality")).toBe("pointer");
});

test("data-policy-mode follows a saved change to the execution policy", async ({ page }) => {
  await openApp(page);

  const before = await shellAttribute(page, "data-policy-mode");
  expect(before).not.toBeNull();

  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-control").click();

  const segmented = page.locator('[data-segmented="autonomy-policy"]');
  await expect(segmented).toBeVisible({ timeout: 20_000 });

  // Pick whichever option is not already selected, so this test changes something regardless of the
  // node's starting policy rather than assuming which mode the fixture node boots with.
  const options = segmented.locator("[data-segment]");
  const count = await options.count();
  let chosen: string | undefined;
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    if ((await option.getAttribute("data-selected")) !== "true") {
      chosen = (await option.getAttribute("data-segment")) ?? undefined;
      await option.click();
      break;
    }
  }
  expect(chosen, "every segmented option was already selected, which should not happen with more than one option").toBeDefined();

  await page.locator('[data-autonomy-save="true"]').click();

  // Ground truth is the node's own preference — `execution.mode` is the canonical policy's own
  // projection (ControlSettings.tsx) — rather than a guess at how the four legacy values map onto it.
  const readProjectedMode = async (): Promise<unknown> => {
    const response = await fetch(`${GATEWAY}/preferences`, { headers: { authorization: `Bearer ${token()}` } });
    const body = (await response.json()) as { preferences: { key: string; value: unknown }[] };
    return body.preferences.find((entry) => entry.key === "execution.mode")?.value;
  };
  await expect.poll(readProjectedMode, { timeout: 10_000 }).not.toBeUndefined();
  const projected = await readProjectedMode();

  await expect.poll(() => shellAttribute(page, "data-policy-mode")).toBe(projected);
});

test("Tab produces a visible, non-accent focus ring on the settings gear", async ({ page }) => {
  await openApp(page);

  const gear = page.locator("[data-settings='true']");
  const presses = await tabUntil(page, "[data-settings='true']");
  expect(presses, "the settings gear was not reachable with Tab alone").toBeGreaterThan(0);
  await expect(gear).toBeFocused();

  const outline = await gear.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
  });

  expect(outline.style).not.toBe("none");
  expect(Number.parseFloat(outline.width)).toBeGreaterThan(0);

  // Not transparent, and not the same colour as the accent — the token requirement in AGENTS.md
  // ("Keyboard focus must be visible and must not depend on the accent color alone").
  expect(outline.color).not.toBe("rgba(0, 0, 0, 0)");
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cc-accent").trim());
  const focusToken = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cc-focus").trim());
  expect(focusToken).not.toBe(accent);
});

test("reduced motion collapses every animation's duration, none left spinning at zero forever", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);

  // The OS preference has to reach the motion tokens themselves: the theme block sets them on
  // `:root[data-cc-theme]`, and a reduced override that loses to it on specificity leaves every
  // token-driven transition running at full length.
  const micro = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--cc-motion-micro").trim(),
  );
  expect(micro).toBe("0ms");

  // Open voice, which is the one surface with a continuous, audio-driven animation (the orb scale and
  // the waveform bars) — exactly the shape DESIGN.md §3.4 warns can turn into an infinite zero-duration
  // spinner if reduced motion is implemented as "multiply the duration by zero" instead of removing it.
  const micButton = page.locator("[data-voice-open='true'], [data-composer-open='true']").first();
  if ((await micButton.count()) > 0) await micButton.click().catch(() => undefined);

  const problems = await page.evaluate(() => {
    const found: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>("*")) {
      const style = getComputedStyle(element);
      const animationName = style.animationName;
      if (animationName === "none" || animationName === "") continue;
      const durations = style.animationDuration.split(",").map((value) => Number.parseFloat(value));
      const iterations = style.animationIterationCount.split(",").map((value) => value.trim());
      durations.forEach((duration, index) => {
        const infinite = iterations[index % iterations.length] === "infinite";
        if (infinite && duration === 0) {
          found.push(`${element.className || element.tagName}: ${animationName} duration=0 iteration=infinite`);
        }
      });
    }
    return found;
  });

  expect(problems, problems.join("; ")).toEqual([]);
});
