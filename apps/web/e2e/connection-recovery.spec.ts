import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The page recovers when the node comes back, without a reload.
 *
 * The node is made unreachable from the browser's side: every request to it is refused before it leaves the page, the
 * way a fetch fails while nothing listens on the port. Lifting that is the node coming back. What is asserted is what
 * the person sees — the header's state, the notice that says what failed and when the next check runs, and "Try now".
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
    throw new Error("the node's identity file has no local token");
  }
  return parsed.localToken;
}

/** Opens the app while every request to the node is refused, and returns how to bring the node back. */
async function openWithNodeDown(page: Page): Promise<{ healthChecks: () => number; bringNodeUp: () => Promise<void> }> {
  let healthChecks = 0;
  const refuse = async (route: Parameters<Parameters<Page["route"]>[1]>[0]): Promise<void> => {
    if (new URL(route.request().url()).pathname === "/health") healthChecks++;
    await route.abort("connectionrefused");
  };
  await page.route(`${GATEWAY}/**`, refuse);
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  return { healthChecks: () => healthChecks, bringNodeUp: () => page.unroute(`${GATEWAY}/**`, refuse) };
}

test("a page opened while the node is unreachable says why, and recovers on its own once the node is back", async ({ page }) => {
  const node = await openWithNodeDown(page);
  const status = page.locator(".cc-status");
  const notice = page.locator("[data-connection-notice]");

  await expect(status).toHaveAttribute("data-connection", "offline", { timeout: 15_000 });
  await expect(notice).toHaveAttribute("data-connection-notice", "unreachable");
  // What failed, what is kept, and the real time of the next check; never a "connected" it cannot back up.
  await expect(notice).toContainText("Không kết nối được tới node.");
  await expect(notice).toContainText("Những gì bạn đã viết vẫn được giữ nguyên.");
  // The notice sits outside the polite live region, so a countdown is never read aloud second by second.
  await expect(status.locator("[data-connection-notice]")).toHaveCount(0);
  // A screen reader hears the outage once, through its own polite region, with no countdown in it.
  const announcement = page.locator("[data-connection-announcement]");
  await expect(announcement).toHaveAttribute("aria-live", "polite");
  await expect(announcement).toHaveText("Không kết nối được tới node. Những gì bạn đã viết vẫn được giữ nguyên.");
  await expect(announcement.locator("[data-connection-next]")).toHaveCount(0);
  // It keeps checking, with a backoff, while the node is down.
  await expect.poll(node.healthChecks, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

  await node.bringNodeUp();
  await expect(status).toHaveAttribute("data-connection", "ready", { timeout: 30_000 });
  await expect(notice).toHaveCount(0);
});

test("Try now checks at once instead of waiting out the backoff, and keeps keyboard focus off the body", async ({ page }) => {
  const node = await openWithNodeDown(page);
  const status = page.locator(".cc-status");
  const next = page.locator("[data-connection-next]");
  const tryNow = page.locator("[data-connection-check]");

  // Let the backoff grow to at least six seconds before pressing. Recovery is then required within two, well inside
  // the wait, so it can only be the button's own check and not the automatic one.
  await expect.poll(node.healthChecks, { timeout: 20_000 }).toBeGreaterThanOrEqual(4);
  await expect(next).toHaveText(/Sẽ kiểm tra lại sau ([6-9]|[1-9]\d) giây\./, { timeout: 10_000 });

  await node.bringNodeUp();
  // From the keyboard, the way someone who cannot use a pointer presses it.
  await tryNow.focus();
  await page.keyboard.press("Enter");
  await expect(status).toHaveAttribute("data-connection", "ready", { timeout: 2_000 });
  await expect(page.locator("[data-connection-notice]")).toHaveCount(0);

  // The button went away with the notice while it held focus; focus moved to the composer, not to the body.
  await expect
    .poll(() => page.evaluate(() => document.activeElement !== null && document.activeElement !== document.body))
    .toBe(true);
  await expect(page.getByRole("combobox", { name: "Nhập tin nhắn" })).toBeFocused();
});

test("Try now stays focused and pressable while its check runs", async ({ page }) => {
  await openWithNodeDown(page);
  const tryNow = page.locator("[data-connection-check]");
  await expect(tryNow).toBeVisible({ timeout: 15_000 });

  // Hold the next check in flight long enough to look at the button during it; it still fails in the end.
  await page.route(`${GATEWAY}/health`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.abort("connectionrefused");
  });
  await tryNow.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-connection-next]")).toHaveText("Đang kiểm tra lại…");
  // Never `disabled`, which would drop focus to the body mid-check; a press during a check is simply ignored.
  await expect(tryNow).toHaveAttribute("aria-disabled", "true");
  await expect(tryNow).not.toHaveAttribute("disabled");
  await expect(tryNow).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(tryNow).toHaveAttribute("aria-disabled", "false", { timeout: 5_000 });
  await expect(tryNow).toBeFocused();
});
