import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * A secret typed into a card, in a real browser.
 *
 * This is the one property that cannot be checked from the node: that the value a person types reaches the host
 * and is then absent from everything the page can show. A card that stored the key correctly and left it in the
 * input, or in a status line, or in the transcript, would pass every server-side test and still be the leak this
 * feature exists to prevent.
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

/** Open the app against the node this run started. The token is never logged. */
async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("[data-composer]")).toBeVisible();
}

test("a secret typed into the card is stored, and is nowhere afterwards", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-composer]").click();
  await page.keyboard.type("nhập key thử");
  await page.keyboard.press("Enter");

  const field = page.locator("[data-credential-field='fixture_key']");
  await expect(field).toBeVisible({ timeout: 20_000 });

  // Not a real key, and shaped like one: the assertion is about where a value may appear, and a value that looks
  // like a key is the kind somebody would paste.
  const secret = "sk-fixture-not-a-real-key-0123456789";
  await field.fill(secret);
  await page.locator("[data-credential-submit='true']").click();

  const status = page.locator("[data-credential-status='true']");
  await expect(status).toContainText("Đã lưu");

  // The three places it could have been left: the field, the page, and the node's own answer.
  await expect(field).toHaveValue("");
  expect(await page.locator("body").innerText()).not.toContain(secret);
  expect(await status.innerText()).not.toContain(secret);

  // And the node accepts the same name again, which is what "stored" means: the route answers with the names it
  // holds and never with a value.
  const stored = await fetch(`${GATEWAY}/credentials`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify({ fields: [{ name: "fixture_key", value: secret }] }),
  });
  const body = (await stored.json()) as { names?: string[] };
  expect(body.names).toEqual(["fixture_key"]);
  expect(JSON.stringify(body)).not.toContain(secret);
});
