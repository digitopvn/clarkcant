import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Reopening an artifact from the message that mentioned it.
 *
 * The inline block is history and stays read-only; reopening asks the node what it still has, which is the only
 * place that can answer. An artifact can expire between the message being written and somebody reading it, and a
 * snapshot cannot know that — so the interesting assertion is not that a file appears, it is that the answer comes
 * from the node rather than from the card.
 *
 * The fixture writes a real row into the artifacts table. That matters for the same reason it did for the task
 * card: a control acting on an invented id would prove the wiring renders and nothing else. It is also the
 * limitation to name — nothing in the product produces an artifact yet, so this path is reachable by fixture but
 * not by ordinary use.
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

test("reopening an artifact asks the node what it still holds", async ({ page }) => {
  await openApp(page);

  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("cho tôi một artifact");
  await composer.press("Enter");

  const block = page.locator("[data-artifact='true']").last();
  await expect(block).toBeVisible({ timeout: 20_000 });

  // Before reopening, the card shows only what the message recorded — no claim about what the node holds now.
  await expect(block.locator("[data-artifact-opened='true']")).toHaveCount(0);

  const open = block.locator("[data-artifact-open]");
  await expect(open).toHaveCount(1);
  await open.click();

  /*
   * The facts come back from the node, so their presence is evidence that the route was reached and the row was
   * read. The digest is the assertion that could only be satisfied by a real record: the card never carried one.
   */
  const opened = block.locator("[data-artifact-opened='true']");
  await expect(opened).toBeVisible({ timeout: 20_000 });
  await expect(opened).toContainText("sha256:");
  await expect(opened).toContainText("20480 B");
  await expect(opened).toContainText("application/pdf");
  await expect(opened).toHaveAttribute("data-artifact-expired", "false");

  // Nothing expired, so nothing claims it did.
  await expect(block.locator("[data-artifact-expiry='true']")).toHaveCount(0);

  // Reopening is a question, not a state change: the control stays usable so the node can be asked again.
  await expect(open).toBeEnabled();
});
