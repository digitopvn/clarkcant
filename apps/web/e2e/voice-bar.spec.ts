import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The compact surface: what the desktop window becomes when it shrinks to the voice bar.
 *
 * The presentation itself is the overlay collapsed, which is what the window shows once it is small. It is
 * reached here through `?cc-compact=1`, a named test hook, rather than by pretending to have a desktop shell -
 * the shell's half of this is proven by the Electron smoke, which needs a display and is operator-run.
 *
 * The property worth asserting is not that a bar is drawn. It is that the session survives the change of
 * presentation: collapsing hides the body, it does not end the microphone, and a surface that unmounted the
 * session to draw a bar would look identical in a screenshot and be broken.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const EVIDENCE = join(process.cwd(), "plans", "reports", "evidence");

const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

function token(): string {
  const path = join(DATA_DIR, "identity.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error(`no local token in ${path}`);
  }
  return parsed.localToken;
}

/** Open the app, optionally as the compact surface. */
async function openApp(page: Page, options: { compact?: boolean } = {}): Promise<void> {
  const compact = options.compact === true ? "&cc-compact=1" : "";
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}${compact}`);
  await expect(page.locator("textarea[aria-label='Nhập tin nhắn']")).toBeVisible();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

test("the compact surface is the whole window when the client is asked for it", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page, { compact: true });

  const scrim = page.locator(".cc-voice-scrim").first();
  await expect(scrim).toBeVisible({ timeout: 20_000 });
  await expect(scrim).toHaveAttribute("data-voice-collapsed", "true");

  // The conversation is still mounted behind it - that is how the session keeps running - so what this asserts
  // is that the surface covers the window rather than that the conversation is gone.
  await expect(page.locator("[data-compact='true']")).toHaveCount(1);
  await expect(page.locator("[data-voice-minimize='true']")).toBeVisible();
  await expect(page.locator("[data-voice-end='true']")).toBeVisible();
  await expect(page.locator("[data-voice-mute='true']")).toBeVisible();

  await page.screenshot({ path: join(EVIDENCE, "voice-bar-dark.png"), fullPage: false });
});

test("the session survives both directions of the change", async ({ page }) => {
  await openApp(page, { compact: true });

  const state = page.locator("[data-voice-state]").first();
  await expect(state).toHaveAttribute("data-voice-state", "listening", { timeout: 20_000 });

  // Expanding the presentation - the desktop window growing back - must not end the session.
  await page.locator("[data-voice-minimize='true']").click();
  await expect(page.locator(".cc-voice-scrim").first()).toHaveAttribute("data-voice-collapsed", "false");
  await expect(state).toHaveAttribute("data-voice-state", "listening");

  // And shrinking again must not end it either, which is the direction a naive implementation breaks: the
  // surface that draws the bar is not the one that owns the microphone.
  await page.locator("[data-voice-minimize='true']").click();
  await expect(page.locator(".cc-voice-scrim").first()).toHaveAttribute("data-voice-collapsed", "true");
  await expect(state).toHaveAttribute("data-voice-state", "listening");
});
