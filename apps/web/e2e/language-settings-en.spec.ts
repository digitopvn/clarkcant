import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Every Settings tab, with English chosen, has no leftover Vietnamese chrome.
 *
 * `language-switch.spec.ts` and `language.spec.ts` prove that choosing English actually changes a few
 * spot-checked labels. This suite is the broader sweep: open each of the six tabs and scan the dialog's own
 * rendered text for a Vietnamese diacritic, which is the one thing a hard-coded Vietnamese literal (as
 * opposed to a translated one) is guaranteed to contain and an English string is guaranteed not to.
 *
 * Two kinds of text are deliberately excluded from the scan, both marked with `data-out-of-scope-i18n` in the
 * component tree rather than guessed at from the DOM shape:
 *
 *   - Subtrees owned by a different file than the ones this suite's phase translated (`tool-lists.tsx`,
 *     `memory-groups.ts`, `package-provenance.ts`) — a real gap, but not one this phase's file ownership
 *     covers, and flagging it here would misreport someone else's file as this phase's bug.
 *   - Node-reported data: ids, digests, timestamps, model names, error messages the node itself worded. These
 *     are excluded by data-attribute on their containers (`[data-node-id]`, `[data-installed-package]`, error
 *     banners) rather than swept up as UI copy, because AGENTS.md's instruction is to leave user/agent data
 *     untranslated, not to translate it into looking like a UI bug.
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

/** Any character from the Vietnamese-specific range of Latin Extended, which a hard-coded Vietnamese string
 *  always has at least one of and a translated English string never does. */
const VIETNAMESE_DIACRITIC = /[À-ỹ]/;

const TABS = [
  "experience",
  "ai",
  "control",
  "extensions",
  "devices",
  "memory",
  "developer",
] as const;

/**
 * The dialog's own visible text, minus subtrees marked as node data or as another file's ownership.
 *
 * Reads `innerText` per excluded node and subtracts it from the panel's own `innerText`, rather than cloning
 * and stripping the DOM: Playwright's `evaluate` runs this in the page, so the subtraction has to be a string
 * operation the page can do, and `innerText` (not `textContent`) is what matches what a person actually reads
 * — collapsed whitespace, no hidden nodes.
 */
async function panelTextExcludingDataAndForeignScope(page: Page): Promise<string> {
  return page.locator("[data-active-tab]").evaluate((element) => {
    const panel = element as HTMLElement;
    const excluded = panel.querySelectorAll<HTMLElement>(
      "[data-out-of-scope-i18n], [data-node-id], [data-pi-setting], [data-pi-extension], " +
        "[data-installed-package], [data-model-profile], [data-settings-error], " +
        "[data-settings-preference-error], [data-recent-effects-problem], [data-effect-entry], " +
        "[data-autonomy-error], [data-voice-capabilities='error'], [data-node-narrowing], code, " +
        // "Tiếng Việt" is the Vietnamese language's own name, correctly identical in both locales (the same
        // way "English" is not translated either) — a proper noun, not an untranslated UI string.
        "[data-segmented='language'] [data-segment='vi']",
    );
    let text = panel.innerText;
    for (const node of excluded) {
      if (!(node instanceof HTMLElement)) continue;
      const fragment = node.innerText.trim();
      if (fragment !== "") text = text.split(fragment).join("");
    }
    return text;
  });
}

test("every Settings tab renders with no leftover Vietnamese chrome once English is chosen", async ({ page }) => {
  await openApp(page);

  await page.locator("[data-settings='true']").click();
  await expect(page.locator("[data-segmented='language']")).toBeVisible({ timeout: 20_000 });
  await page.locator("[data-segmented='language'] [data-segment='en']").click();
  await expect(page.locator("[data-segmented='language'] [data-segment='en']")).toHaveAttribute(
    "data-selected",
    "true",
  );

  for (const tabId of TABS) {
    await page.locator(`#cc-tab-${tabId}`).click();
    await expect(page.locator(`[data-active-tab='${tabId}']`)).toBeVisible({ timeout: 10_000 });
    // The developer tab's pi-config table is read-only and collapsed by default; opening it renders more
    // of this file's own translated copy without pulling in additional node data than the exclusion list
    // above already accounts for, so it is left collapsed.

    const text = await panelTextExcludingDataAndForeignScope(page);
    expect(text, `tab "${tabId}" should have no Vietnamese diacritic outside excluded node data`).not.toMatch(
      VIETNAMESE_DIACRITIC,
    );
  }

  await page.locator(".cc-modal-done").click();
  await expect(page.locator(".cc-modal-scrim")).toHaveCount(0);

  // Leaves the shared node's cached preference where the rest of the suite expects it.
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-experience").click();
  await page.locator("[data-segmented='language'] [data-segment='vi']").click();
  await expect(page.locator("[data-segmented='language'] [data-segment='vi']")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await page.locator(".cc-modal-done").click();
});
