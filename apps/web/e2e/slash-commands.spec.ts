import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Slash commands, as a person uses them: found after `/` in the composer, answered by the host in the conversation
 * as an agent message with a card, and acted on from that card.
 *
 * The node runs the scripted model and the fake provider list, so a sign-in here asks what a real one asks — a key in
 * a password field — and changes what the node reports about that provider, which is the claim worth a browser.
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
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("the node's identity file has no local token");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("[data-composer]")).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer]");
  await composer.click();
  await composer.fill(text);
  await composer.press("Enter");
}

function lastCard(page: Page, command: string) {
  return page.locator(`.cc-row[data-role="assistant"] [data-command="${command}"]`).last();
}

test("a command is found after a slash and answered in the conversation with a card", async ({ page }) => {
  await openApp(page);
  const composer = page.locator("[data-composer]");
  await composer.click();
  await page.keyboard.type("/sess");

  const option = page.locator('[data-reference-option="sessions"]');
  await expect(option).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("/sessions ");
  // A command is what the message says, not a reference it carries.
  await expect(page.locator("[data-reference-chips]")).toHaveCount(0);

  await page.keyboard.press("Enter");
  const card = lastCard(page, "sessions");
  await expect(card).toBeVisible({ timeout: 20_000 });
  // The command itself is not echoed as the person's message: the host's answer is the record.
  await expect(page.locator('.cc-row[data-role="user"]', { hasText: "/sessions" })).toHaveCount(0);
});

test("Enter sends a command typed in full, even with the list showing it", async ({ page }) => {
  await openApp(page);
  const composer = page.locator("[data-composer]");
  await composer.click();
  await page.keyboard.type("/sessions");
  // The list is up and its row is the command already typed: there is nothing left for Enter to complete.
  await expect(page.locator('[data-reference-option="sessions"]')).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(lastCard(page, "sessions")).toBeVisible({ timeout: 20_000 });
  await expect(composer).toHaveValue("");
});

test("the thinking level is chosen from the card the command answers with", async ({ page }) => {
  await openApp(page);
  await send(page, "/thinking");

  const card = lastCard(page, "thinking");
  await expect(card).toBeVisible({ timeout: 20_000 });
  const high = card.locator('[data-row-id="high"]');
  await high.getByRole("button").click();
  await expect(high.locator(".cc-command-status")).toContainText("Đã đặt", { timeout: 10_000 });

  // The node holds the choice: asking again marks it as the one in use.
  await send(page, "/thinking");
  const again = lastCard(page, "thinking");
  await expect(again.locator('[data-row-id="high"]')).toHaveAttribute("data-current", "true", { timeout: 20_000 });

  // Back to the model's default, so the rest of the suite runs as it always has.
  await again.locator('[data-row-id="default"]').getByRole("button").click();
  await expect(again.locator('[data-row-id="default"] .cc-command-status')).toContainText("Đã đặt", { timeout: 10_000 });
});

test("a provider is signed in to with a key from the /login card, and signed out of from /logout", async ({ page }) => {
  await openApp(page);
  await send(page, "/login");

  const card = lastCard(page, "login");
  await expect(card).toBeVisible({ timeout: 20_000 });
  const other = card.locator('[data-row-id="fake-other"]');
  await other.getByRole("button", { name: "Dùng API key" }).click();

  const field = other.locator('.cc-sign-in input[type="password"]');
  await expect(field).toBeVisible({ timeout: 10_000 });
  await field.fill("e2e-test-key");
  await other.getByRole("button", { name: "Gửi" }).click();
  await expect(other.locator(".cc-sign-in .cc-command-status")).toContainText("Đã đăng nhập", { timeout: 10_000 });
  // What was typed never comes back into the page.
  await expect(page.locator("body")).not.toContainText("e2e-test-key");

  await send(page, "/logout");
  const logout = lastCard(page, "logout");
  const stored = logout.locator('[data-row-id="fake-other"]');
  await expect(stored).toBeVisible({ timeout: 20_000 });
  // A key the node only reads from its environment offers no sign-out here.
  await expect(logout.locator('[data-row-id="fake"]').getByRole("button")).toHaveCount(0);

  await stored.getByRole("button", { name: "Đăng xuất" }).click();
  await expect(stored.locator(".cc-command-status")).toContainText("Đã đăng xuất", { timeout: 10_000 });
});
