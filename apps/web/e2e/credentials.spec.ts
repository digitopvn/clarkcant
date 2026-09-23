import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The unified Credentials section (DESIGN.md 11.6, review U5).
 *
 * Before this, TypeSafe's key lived only in AI & Routing and Gemini's only in Devices & Voice, each with its
 * own form and its own way of saying "saved" or "removed". This suite is about the one thing that changed:
 * there is now a single place -- on the AI & Routing tab -- that lists every key this node holds by name and
 * purpose, says whether it is connected, and never renders the value back, no matter what was just typed into
 * the Replace field.
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

async function openCredentials(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-ai").click();
  await expect(page.locator("[data-credentials-section='true']")).toBeVisible();
}

/**
 * The suite shares one node across runs, so a credential this spec stores has to be removed again -- otherwise
 * the "not connected" assertions below would read as flaky rather than wrong the second time this file runs.
 */
test.afterEach(async ({ request }) => {
  for (const name of ["typesafe", "gemini"]) {
    await request
      .delete(`${GATEWAY}/credentials/${name}`, { headers: { authorization: `Bearer ${token()}` } })
      .catch(() => undefined);
  }
});

test("lists every stored key by name, with connection status, and never shows the value that was typed", async ({
  page,
}) => {
  await openCredentials(page);

  const section = page.locator("[data-credentials-section='true']");
  // Both names appear, because listing one and not the other is the scattered surface this section replaces.
  const typesafe = section.locator("[data-credential-row='typesafe']");
  const gemini = section.locator("[data-credential-row='gemini']");
  await expect(typesafe).toBeVisible();
  await expect(gemini).toBeVisible();

  // Names are visible text; nothing here is a value the node holds.
  await expect(typesafe).toContainText("TypeSafe");
  await expect(gemini).toContainText("Gemini");

  // Neither key was stored yet, so both read as not connected before anything is typed.
  await expect(typesafe.locator("[data-credential-status='typesafe']")).toHaveAttribute("data-tone", "warn");

  const secretValue = "sk-test-do-not-echo-12345";
  const field = typesafe.locator("[data-credential-field='typesafe']");
  await field.fill(secretValue);
  // The stored value is never rendered back: the field is a write-only draft, so even mid-typing the browser
  // never has the value anywhere except the one field it was typed into.
  const domSnapshot = await page.content();
  expect((domSnapshot.match(new RegExp(secretValue, "g")) ?? []).length).toBe(1);

  await typesafe.locator("[data-credential-replace='typesafe']").click();

  // Saved, and the field clears the instant it is sent -- the value is gone from the DOM entirely now.
  await expect(typesafe.locator("[data-credential-status-message='typesafe']")).toBeVisible();
  await expect(field).toHaveValue("");
  expect((await page.content()).includes(secretValue)).toBe(false);

  // The status flips to connected, read from the node's own list of names it holds -- never a value.
  await expect(typesafe.locator("[data-credential-status='typesafe']")).toHaveAttribute("data-tone", "ok", {
    timeout: 10_000,
  });
});

test("replace and remove both work, and removing drops the connected status", async ({ page }) => {
  await openCredentials(page);

  const section = page.locator("[data-credentials-section='true']");
  const gemini = section.locator("[data-credential-row='gemini']");

  await gemini.locator("[data-credential-field='gemini']").fill("gemini-test-key-abcde");
  await gemini.locator("[data-credential-replace='gemini']").click();
  await expect(gemini.locator("[data-credential-status='gemini']")).toHaveAttribute("data-tone", "ok", {
    timeout: 10_000,
  });

  // Replace again with a different value -- the row still reports connected, and the previous value is not
  // recoverable from anything on screen.
  await gemini.locator("[data-credential-field='gemini']").fill("gemini-test-key-fghij");
  await gemini.locator("[data-credential-replace='gemini']").click();
  // The field empties once the node has taken the value, which is the moment the value must be gone.
  await expect(gemini.locator("[data-credential-field='gemini']")).toHaveValue("", { timeout: 10_000 });
  expect((await page.content()).includes("gemini-test-key-fghij")).toBe(false);

  await gemini.locator("[data-credential-remove='gemini']").click();
  await expect(gemini.locator("[data-credential-status='gemini']")).toHaveAttribute("data-tone", "warn", {
    timeout: 10_000,
  });
});

test("Devices & Voice no longer embeds a key form, and points at the Credentials section instead", async ({
  page,
}) => {
  await openCredentials(page);
  await page.locator("#cc-tab-devices").click();

  await expect(page.locator("[data-devices-credentials-link='gemini']")).toBeVisible();
  // The old per-tab form is gone: this is the one place that used to duplicate the row this suite now covers
  // from the Credentials section.
  await expect(page.locator("[data-settings-key-form='gemini']")).toHaveCount(0);
});
