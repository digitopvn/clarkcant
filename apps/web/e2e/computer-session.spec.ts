import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * A desktop session, and the boundary the node does not own.
 *
 * This is the surface where the honest answer is not "here is the screen". Seeing a desktop is an operating-system
 * permission, and this node cannot grant it to itself — so the card reports the state, names the reason, and says
 * who owns the fix. A card that drew a blank or stale preview as if it were live would be claiming a view of
 * somebody's screen that nobody was granted, and a journey that only checked the controls would not notice.
 *
 * Acting is refused while the surface cannot be observed, which is the safety half of the same rule: an
 * unsupervised effect on a surface nobody can see lands where no one is looking. The card says that too, rather
 * than leaving a disabled-looking button unexplained.
 *
 * The session is created in the node's registry by the fixture, in the state a real one starts in.
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

test("a desktop session reports the permission it does not own, and still lets the user take it", async ({
  page,
}) => {
  await openApp(page);

  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("điều khiển màn hình giúp tôi");
  await composer.press("Enter");

  const card = page.locator("[data-host-card='computer-session']").last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveAttribute("data-control-surface", "computer");

  // The state the operating system left it in, reported rather than assumed.
  await expect(card).toHaveAttribute("data-control-preview", "needs-permission");
  const notice = card.locator("[data-control-preview-notice='needs-permission']");
  await expect(notice).toBeVisible();

  /*
   * The three things a user needs from this card, and the reason each is asserted rather than just the presence of
   * a notice: what is missing, that the node cannot fix it itself, and that nothing will be acted on meanwhile.
   */
  await expect(notice).toContainText("Chưa được cấp quyền xem màn hình");
  await expect(notice).toContainText("hệ điều hành");
  await expect(notice).toContainText("node không tự cấp");

  // Nothing draws a preview: there is no screenshot element, because there is no screenshot.
  await expect(card.locator("img")).toHaveCount(0);

  // Taking the wheel is still meaningful while the screen is unobservable — it is about who may act, not about
  // what can be seen — so the verb is offered and it works.
  const takeover = card.locator("[data-control-takeover]");
  await expect(takeover).toHaveCount(1);
  await takeover.click();

  await expect(card).toHaveAttribute("data-control-driver", "user", { timeout: 20_000 });
  await expect(card.locator("[data-control-notice='taken-over']")).toContainText("bị từ chối");

  // And the permission is still reported as missing afterwards: a takeover does not grant one.
  await expect(card).toHaveAttribute("data-control-preview", "needs-permission");
});
