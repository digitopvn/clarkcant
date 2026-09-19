import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Stopping a task from its card.
 *
 * The card used to report "Dừng được: có" and offer nothing that stopped anything, so the claim worth
 * a browser is that pressing the control changes the node's record of the task — not that a button
 * changed its own label.
 *
 * Cancellation is two steps on purpose: the request moves a task to `cancel_requested` so the executor
 * can confirm what actually happened, and only a task with nothing in flight is confirmed on the spot.
 * This journey covers the second case, which is the one a parked task is in, and it asserts the
 * wording as well as the flag: a task that is merely stopping must not read as stopped.
 *
 * The node runs the scripted model, and the fixture creates a real task row, so the control acts on
 * something that exists rather than on an invented id.
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

test("pressing Stop changes the task's state on the node, and says which of the two things happened", async ({
  page,
}) => {
  await openApp(page);

  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("cho tôi một task dài");
  await composer.press("Enter");

  const card = page.locator("[data-host-card='task-progress']").last();
  await expect(card).toBeVisible({ timeout: 20_000 });

  // The card's claim and its affordance come from the same field, so a task that says it can be
  // stopped is a task that offers a way to stop it.
  await expect(card.locator("[data-task-cancellable='true']")).toHaveCount(1);
  const stop = card.locator("[data-task-stop]");
  await expect(stop).toHaveCount(1);
  await expect(stop).toBeEnabled();

  await stop.click();

  /*
   * Nothing is running this task, so the node confirms immediately — and the card has to show that as
   * a state that came back from the node rather than as the button having worked. `confirmed="true"`
   * is the part that distinguishes "stopped" from "asked to stop".
   */
  const outcome = card.locator("[data-task-stop-outcome]");
  await expect(outcome).toHaveAttribute("data-task-stop-outcome", "cancelled", { timeout: 20_000 });
  await expect(outcome).toHaveAttribute("data-task-stop-confirmed", "true");
  await expect(outcome).toContainText("Đã dừng");

  // The control does not stay pressable, because a second request would be a second state change for
  // a task that has already ended.
  await expect(stop).toBeDisabled();

  /*
   * Durability, which is the part the card alone cannot prove: the node wrote what it did to the
   * conversation, so after a reload the task reads as stopped rather than as still going. Asserted after
   * a reload on purpose — the card shows the outcome immediately from the response to the call, and it
   * is the recorded message that decides what a later reader sees.
   */
  await page.reload();
  await expect(page.locator("[data-role='assistant']").last()).toContainText("Đã dừng task", { timeout: 20_000 });
});
