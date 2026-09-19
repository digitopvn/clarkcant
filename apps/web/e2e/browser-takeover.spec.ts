import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Taking the wheel from the agent, and stopping the session.
 *
 * This is the one capability where the agent acts unsupervised, which makes it the one where "the agent is still
 * driving" has to be something the user can change. The claim worth a browser is not that a flag flips: it is that
 * the takeover takes effect on a process the node is not synchronously controlling. The mechanism is the lease
 * epoch — the agent's already-planned action is refused for having a stale lease — so the card is asserted to say
 * that, and the epoch is asserted to move, because those are the two things that make the browser the user's.
 *
 * The session is created in the node's own registry by the fixture, so the verbs act on something that exists.
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

test("a takeover changes who may act, and a stop ends the session", async ({ page }) => {
  await openApp(page);

  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("mở browser giúp tôi");
  await composer.press("Enter");

  const card = page.locator("[data-host-card='browser-session']").last();
  await expect(card).toBeVisible({ timeout: 20_000 });

  // The agent is driving, at the epoch its plan was made under.
  await expect(card).toHaveAttribute("data-control-driver", "agent");
  await expect(card).toHaveAttribute("data-control-status", "running");
  await expect(card).toContainText("agent");

  const takeover = card.locator("[data-control-takeover]");
  await expect(takeover).toHaveCount(1);
  await takeover.click();

  /*
   * The two assertions that make this a takeover rather than a label change: the driver is the user, and the card
   * says the agent's earlier action was refused for a stale lease. Without the second, nothing here would show
   * that anything about the agent's ability to act had changed.
   */
  await expect(card).toHaveAttribute("data-control-driver", "user", { timeout: 20_000 });
  const notice = card.locator("[data-control-notice='taken-over']");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("bị từ chối");
  await expect(card).toHaveAttribute("data-control-epoch", "1");

  // Nothing offers a takeover the user already has: a control with nothing left to do is worse than no control.
  await expect(card.locator("[data-control-takeover]")).toHaveCount(0);

  // And the session stops when asked.
  const stop = card.locator("[data-control-stop]");
  await expect(stop).toHaveCount(1);
  await stop.click();

  await expect(card).toHaveAttribute("data-control-status", "stopped", { timeout: 20_000 });
  await expect(card.locator("[data-control-notice='stopped']")).toBeVisible();
  // A stopped session has no verbs left, so none are drawn.
  await expect(card.locator("[data-control-stop]")).toHaveCount(0);
  await expect(card.locator("[data-control-takeover]")).toHaveCount(0);
});
