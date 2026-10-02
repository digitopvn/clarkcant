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
  // It keeps checking, with a backoff, while the node is down.
  await expect.poll(node.healthChecks, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

  await node.bringNodeUp();
  await expect(status).toHaveAttribute("data-connection", "ready", { timeout: 30_000 });
  await expect(notice).toHaveCount(0);
});

test("Try now checks at once instead of waiting out the backoff", async ({ page }) => {
  const node = await openWithNodeDown(page);
  const status = page.locator(".cc-status");
  const next = page.locator("[data-connection-next]");

  // Let the backoff grow past a few seconds, so recovering within that wait can only be the button's doing.
  await expect.poll(node.healthChecks, { timeout: 20_000 }).toBeGreaterThanOrEqual(4);
  await expect(next).toHaveText(/Sẽ kiểm tra lại sau ([4-9]|1\d) giây\./, { timeout: 10_000 });

  await node.bringNodeUp();
  await page.locator("[data-connection-check]").click();
  await expect(status).toHaveAttribute("data-connection", "ready", { timeout: 3_000 });
});
