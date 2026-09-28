import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * What the composer holds after a send.
 *
 * A sent message leaves the composer empty. A draft that outlives its send is one Enter away from
 * sending the same message again, and in Autonomous mode that repeats whatever the message asked
 * for. A send the node refuses gives the text back, so a failure never costs the person what they
 * typed. Only a browser can show both, because the draft is component state.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set; run this through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

/** Matched by the model fixture, which answers it with plain text and no card or effect. */
const MESSAGE = "thử audio giả lập";
const FIXTURE_REPLY = "Fixture đã nhận câu bạn nói";

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

test("a sent message leaves the composer empty", async ({ page }) => {
  await openApp(page);
  const composer = page.locator("[data-composer]");

  await composer.fill(MESSAGE);
  await page.locator("[data-send]").click();

  // Empty while the turn is still running, which is when a second Enter would send it again.
  await expect(composer).toHaveValue("");
  await expect(page.locator('[data-role="user"]')).toHaveCount(1, { timeout: 15_000 });

  // And still empty once the reply has arrived: nothing puts the sent text back.
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(FIXTURE_REPLY, { timeout: 20_000 });
  await expect(composer).toHaveValue("");
});

test("a refused send gives the typed text back", async ({ page }) => {
  await openApp(page);
  const composer = page.locator("[data-composer]");

  // Held until the test has looked at the composer mid-send, then refused. The preflight goes to the real
  // node; only the send itself is answered here.
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/messages/stream", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await released;
    const origin = route.request().headers().origin ?? "*";
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "access-control-allow-origin": origin, vary: "origin" },
      body: JSON.stringify({ code: "E2E_REFUSED", message: "the node refused this send" }),
    });
  });

  await composer.fill(MESSAGE);
  await page.locator("[data-send]").click();

  // Accepted: the composer empties before the node has answered.
  await expect(composer).toHaveValue("");
  release();

  // Refused: the text is back, the placeholder message is gone, and the failure is said.
  await expect(composer).toHaveValue(MESSAGE);
  await expect(page.locator('[data-role="user"]')).toHaveCount(0);
  await expect(page.locator('.cc-hint[data-statusline="false"]')).toContainText("the node refused this send");

  // The restored text is a working draft: sending it again goes through.
  await page.unroute("**/messages/stream");
  await page.locator("[data-send]").click();
  await expect(composer).toHaveValue("");
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(FIXTURE_REPLY, { timeout: 20_000 });
});
