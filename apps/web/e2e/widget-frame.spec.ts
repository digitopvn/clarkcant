import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * A widget running in its own frame, from the conversation.
 *
 * The server routes, the frame session and the surface each have their own tests; this is the only one that proves the
 * journey between them — a package on disk, an instance the node made, a frame the browser mounted, and an action that
 * reached the host and came back.
 *
 * The sandbox assertion is deliberate and exact. `allow-scripts` without `allow-same-origin` is the whole isolation
 * story: with `allow-same-origin` the frame would share this document's origin and could read its storage, its cookies
 * and its DOM, which is the difference between a sandbox and a decoration. Asserting the exact value is what stops
 * somebody adding the second token while fixing an unrelated problem.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

/** Compose the fixture widget, then open the current view — which is what mounts the frame. */
async function openFrame(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(`http://127.0.0.1:${NODE_PORT}`)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });

  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill("widget cách ly");
  await composer.press("Enter");

  // The transcript's own affordance: an expanded pin is where a live instance is mounted.
  const open = page.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });
  await open.click();

  await expect(page.locator("[data-pin-live] [data-widget-frame]")).toBeVisible({ timeout: 20_000 });
}

test("a widget package runs in a sandboxed frame, and its code is the package's", async ({ page }) => {
  await openFrame(page);

  const frame = page.locator("[data-pin-live] [data-widget-frame]");
  // The frame reached `ready`, which is later than the element's `load`: it means the widget's own code received the
  // init message and answered.
  await expect(frame).toHaveAttribute("data-frame-status", "ready", { timeout: 20_000 });

  const document = page.frameLocator("[data-pin-live] [data-widget-frame] iframe");
  // The title comes from the props the node created the instance with, through the init message — the frame has no
  // other way to know it.
  await expect(document.locator("[data-widget-title]")).toHaveText("Widget trong frame (fixture)");
  await expect(document.locator("[data-widget-ready]")).toHaveCount(1);
});

test("the frame is sandboxed with scripts and without a shared origin", async ({ page }) => {
  await openFrame(page);

  // Exact, not a substring: `allow-scripts allow-same-origin` contains the value below and would defeat the sandbox.
  await expect(page.locator("[data-pin-live] [data-widget-frame] iframe")).toHaveAttribute("sandbox", "allow-scripts");
});

test("an action the widget invokes reaches the host and comes back", async ({ page }) => {
  await openFrame(page);

  const document = page.frameLocator("[data-pin-live] [data-widget-frame] iframe");
  await document.locator("[data-widget-action]").click();

  /*
   * The outcome is set from the promise the SDK resolved, and that promise settles from the host's own answer: the
   * frame asked, the session authorized, the node performed, and the result travelled back. Anything less than all
   * four leaves this assertion failing.
   */
  await expect(document.locator("[data-widget-outcome-state='accepted']")).toBeVisible({ timeout: 20_000 });
  await expect(document.locator("[data-widget-outcome]")).toContainText("host đã nhận hành động");
});

test("state the widget saves is stored by the node and is there when the frame is opened again", async ({ page }) => {
  await openFrame(page);

  const document = page.frameLocator("[data-pin-live] [data-widget-frame] iframe");
  await expect(document.locator("[data-widget-count]")).toHaveText("0", { timeout: 20_000 });
  await document.locator("[data-widget-increment]").click();
  // "đã lưu" is set from the promise the host settles once the node has committed the write — not before.
  await expect(document.locator("[data-widget-saved-state='saved']")).toBeVisible({ timeout: 20_000 });
  await document.locator("[data-widget-increment]").click();
  await expect(document.locator("[data-widget-count]")).toHaveText("2");
  await expect(document.locator("[data-widget-saved-state='saved']")).toBeVisible({ timeout: 20_000 });

  // A fresh page has no memory of the frame: whatever it shows now came from the node.
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  const open = page.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });
  await open.click();
  const reopened = page.frameLocator("[data-pin-live] [data-widget-frame] iframe");
  await expect(reopened.locator("[data-widget-count]")).toHaveText("2", { timeout: 20_000 });
});
