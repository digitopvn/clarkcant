import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Approving a command, in a real browser.
 *
 * The gate and the runner are covered by unit tests and the route by an integration test. What only a
 * browser can prove is the client half: that the card's buttons reach the route, that the receipt the
 * node appends is what appears, and that a refused card is not left looking actionable. The command
 * comes from the node's scripted fixture, so this stays account-free.
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
    throw new Error("no local token in the e2e identity file");
  }
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

/** Ask for the scripted proposal and wait for its card. */
async function propose(page: Page): Promise<void> {
  await page.locator("[data-composer]").fill("chạy lệnh thử");
  await page.locator("[data-send]").click();
  await expect(page.locator('[data-host-card="approval"]').first()).toBeVisible({ timeout: 20_000 });
}

test("a proposed command runs only after the user approves it", async ({ page }) => {
  await openApp(page);
  await propose(page);

  const card = page.locator('[data-host-card="approval"]').first();
  // The operation is visible before it is approved, which is what makes approving a decision about
  // something rather than about a promise.
  await expect(card).toHaveAttribute("data-decision", "pending");
  await expect(card).toContainText("node -e");
  await expect(card.locator("[data-approve]")).toBeEnabled();

  await card.locator("[data-approve]").click();

  // The receipt: what ran, and whether it worked.
  const receipt = page.locator('[data-tool-name="run_command"]').first();
  await expect(receipt).toBeVisible({ timeout: 30_000 });
  await expect(receipt).toContainText("fixture ran");
  await expect(page.locator('.cc-evidence[data-verdict="verified"]').first()).toBeVisible();

  // And the card stops offering a decision that has been made: messages are immutable, so this is read
  // from the receipt rather than from the card itself.
  await expect(card.locator("[data-approve]")).toHaveCount(0);
  await expect(card.locator('[data-approval-decision="answered"]')).toBeVisible();

  // And the agent picked the work back up. The turn that proposed the command ended with the card, so nothing
  // else would ever tell it what happened: the outcome is fed back and this is the answer to it.
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("tiếp tục công việc", {
    timeout: 20_000,
  });
});

test("refusing runs nothing and says so", async ({ page }) => {
  await openApp(page);
  await propose(page);

  const card = page.locator('[data-host-card="approval"]').first();
  await card.locator("[data-deny]").click();

  const refusal = page.locator('[data-tool-name="decide_approval"]').first();
  await expect(refusal).toBeVisible({ timeout: 20_000 });
  await expect(refusal).toContainText("Đã từ chối");
  // Nothing ran, so there is no receipt to find.
  await expect(page.locator('[data-tool-name="run_command"]')).toHaveCount(0);

  // The card says which way it went and stops offering either button, as it does after an approval.
  await expect(card.locator("[data-approve]")).toHaveCount(0);
  await expect(card.locator("[data-deny]")).toHaveCount(0);
  await expect(card.locator('[data-approval-decision="denied"]')).toHaveText("đã từ chối");
});
