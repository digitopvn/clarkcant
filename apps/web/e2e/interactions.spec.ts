import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * A question, answered, in a real browser.
 *
 * The manager and the route are covered by unit tests; what only a browser can prove is the loop a person
 * actually performs — the card appears, the options are the ones that were offered, the answer leaves for the
 * node, and the agent's next turn carries it. The question comes from the node's scripted fixture, which drives
 * the real tool, so this stays account-free without faking the path.
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

test("a question is asked, answered, and the answer opens the next turn", async ({ page }) => {
  await openApp(page);

  await page.locator("[data-composer]").fill("hỏi tui chọn");
  await page.locator("[data-send]").click();

  const card = page.locator('[data-host-card="question"]').first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("Chọn môi trường triển khai.");
  // Waiting, and asking nothing of the model's judgement: the options are the ones the host offered.
  await expect(card).toHaveAttribute("data-answered", "false");
  await expect(card.locator('[data-question-option="production"]')).toBeVisible();

  await card.locator('[data-question-option="production"]').click();

  // The card stops asking once the transcript holds the answer, and the agent has picked the work back up in a
  // turn of its own — which is the whole design: nothing was holding a provider call open while a person chose.
  await expect(card).toHaveAttribute("data-answered", "true", { timeout: 30_000 });
  // `.first()` because the fixture's reply is rendered by more than one node in the timeline (the streamed text and
  // the markdown body), and this assertion is about the answer having arrived, not about how many times it is drawn.
  await expect(page.getByText("Fixture: tui đã nhận câu trả lời").first()).toBeVisible({ timeout: 30_000 });
});
