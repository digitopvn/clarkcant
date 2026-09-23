import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * A secret, in a real browser.
 *
 * Every assertion here is negative, and that is the point of the feature. A value typed into this card must not
 * reach the page, the conversation, or the model — so what the browser proves is that after a person types one,
 * the string is nowhere in the document, and the node still answers the next request with metadata alone.
 *
 * The card comes from the node's scripted fixture, which drives the real `request_secret` tool.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");

const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

/** Distinctive enough that finding it in a document is unambiguous. */
const TYPED_VALUE = "fixture-value-that-must-never-be-rendered";

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

test("a secret typed into the card is stored, and is nowhere afterwards", async ({ page }) => {
  await openApp(page);

  await page.locator("[data-composer]").fill("xin secret thử");
  await page.locator("[data-send]").click();

  const card = page.locator('[data-host-card="credential"]').first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  // The upgrade this phase added: what it is for, who will use it, and where it is kept. The purpose line *is* the
  // description the requester gave, so the text is asserted once — the card deliberately does not print the same
  // sentence twice, and a second marker for it would be asserting duplication.
  await expect(card).toContainText("Dùng để chạy model OpenAI trên node này.");
  await expect(card.locator('[data-credential-consumer="capability:openai"]')).toBeVisible();
  await expect(card.locator('[data-credential-scope^="node:"]')).toBeVisible();

  await card.locator("[data-credential-field='openai_api_key']").fill(TYPED_VALUE);
  await card.getByRole("button").click();

  // Stored, and gone from the screen: the field is cleared by the card as soon as it hands the value over.
  await expect(card.locator("[data-credential-field='openai_api_key']")).toHaveValue("", { timeout: 15_000 });

  // The negative assertion, made against the whole document rather than against a locator: a value that reached
  // any element, attribute or inline script would be a leak, and this is the only check that covers all three.
  await expect
    .poll(async () => (await page.content()).includes(TYPED_VALUE), { timeout: 15_000 })
    .toBe(false);

  // And the node now knows the secret by name and description only: asking again answers from metadata.
  await page.locator("[data-composer]").fill("xin secret thử lại lần nữa");
  await page.locator("[data-send]").click();
  await expect(page.getByText("openai_api_key: available.").first()).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => (await page.content()).includes(TYPED_VALUE), { timeout: 15_000 })
    .toBe(false);
});
