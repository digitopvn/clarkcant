import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * A question the agent asks, answered by pressing one of the answers it named.
 *
 * This is the primitive the plan singles out, and the claim worth a browser is that the answer becomes the
 * user's *own message* rather than a second, parallel route into the agent. Two consequences follow, and both
 * are asserted here: the transcript reads as a conversation rather than as a form submission, and the card stops
 * being answerable once the conversation has moved past it — so a click cannot send a second answer to a
 * question that was already answered.
 *
 * The node runs the scripted model, so the card is produced without a provider account.
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

test("an answer becomes the user's own message, and the card stops asking", async ({ page }) => {
  await openApp(page);

  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("hỏi tôi một câu");
  await composer.press("Enter");

  const card = page.locator("[data-host-card='question']").last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  // The scripted producer names the answers, so the card offers exactly those and no free-text field.
  await expect(card).toContainText("Bạn muốn tôi mở dự án nào?");
  await expect(card).toHaveAttribute("data-answerable", "true");

  const answer = card.locator("[data-question-answer='option-2']");
  await expect(answer).toHaveText("Dự án khác");
  await answer.click();

  // The answer is in the transcript as the user's message — the same shape a typed reply has.
  await expect(page.locator("[data-role='user']").last()).toContainText("Dự án khác");

  /*
   * And the card is no longer answerable. The transcript is immutable, so the card derives this from "nothing has
   * come after me" — which is the only rule that cannot offer a second answer to a question already answered.
   */
  await expect(card).toHaveAttribute("data-answerable", "false");
  await expect(card.locator("[data-question-answer='option-1']")).toHaveCount(0);
  await expect(card.locator("[data-question-closed='true']")).toBeVisible();
});
