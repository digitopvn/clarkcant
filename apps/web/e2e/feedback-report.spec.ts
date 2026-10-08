import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Reporting a bug from the conversation, as a person does it: `/report` summons the Feedback Composer (with words, a
 * prepared issue), Preview shows the issue exactly as it would be filed, and only the person's Create issue files it,
 * answered with a result card naming the issue GitHub was read back holding.
 *
 * The node files to an in-process GitHub (`CC_GITHUB_FIXTURE`), so nothing reaches the real repository; what the
 * browser proves is the path from the composer to the host's card and the truth of what that card claims.
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

test("/report is offered after a slash, and a bare /report summons the Feedback Composer", async ({ page }) => {
  await openApp(page);
  const composer = page.locator("[data-composer]");
  await composer.click();
  await page.keyboard.type("/rep");
  await expect(page.locator('[data-reference-option="report"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("/report ");
  await page.keyboard.press("Enter");

  const card = page.locator('.cc-row[data-role="assistant"] [data-feedback-stage="compose"]').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  // What would be shared is one disclosure away, before anything is sent.
  await card.locator("[data-feedback-shared] summary").click();
  await expect(card.locator("[data-feedback-shared]")).toContainText("digitopvn/clarkcant");
});

test("a bug is previewed, filed, and answered with the issue GitHub holds", async ({ page }) => {
  await openApp(page);
  const composer = page.locator("[data-composer]");
  await composer.click();
  await composer.fill("/report");
  await composer.press("Enter");

  const card = page.locator('.cc-row[data-role="assistant"] [data-feedback-stage="compose"]').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.locator('[data-feedback-kind="bug"]').check();
  await card.locator("[data-feedback-description]").fill("The orb stops animating after the laptop wakes from sleep");

  await card.locator("[data-feedback-preview-button]").click();
  const preview = card.locator("[data-feedback-preview]");
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await expect(preview).toContainText("bug: the orb stops animating");
  // A reproduction nobody gave is said to be unknown, not invented.
  await expect(preview).toContainText("Not known yet.");

  await card.locator("[data-feedback-create]").click();
  const result = page.locator('.cc-row[data-role="assistant"] [data-feedback-stage="result"]').last();
  await expect(result).toBeVisible({ timeout: 20_000 });
  await expect(result).toHaveAttribute("data-feedback-status", "published");
  await expect(result.locator("[data-feedback-issue]")).toHaveAttribute("href", /^https:\/\/github\.com\/digitopvn\/clarkcant\/issues\/\d+$/u);
  // Handling is reported with its reason, and nothing offers to start it.
  await expect(result.locator('[data-feedback-eligibility="handling-unavailable"]')).toBeVisible();
  await expect(result.locator("button")).toHaveCount(0);
  // The composer it answered is a record now: nothing offers to file the same report twice.
  await expect(card).toHaveAttribute("data-feedback-answered", "true");
  await expect(card.locator("[data-feedback-create]")).toHaveCount(0);
});

test("/report with its words prepares the issue, and only the person's press files it", async ({ page }) => {
  await openApp(page);
  const results = page.locator('.cc-row[data-role="assistant"] [data-feedback-stage="result"]');
  const before = await results.count();
  const composer = page.locator("[data-composer]");
  await composer.click();
  await composer.fill("/report bug the dock icon keeps bouncing after Clark answers");
  await composer.press("Enter");

  const prepared = page.locator('.cc-row[data-role="assistant"] [data-feedback-prepared]').last();
  await expect(prepared).toBeVisible({ timeout: 20_000 });
  await expect(prepared).toContainText("bug: the dock icon keeps bouncing");
  // Prepared is not filed: no new result exists until the person presses.
  await expect(results).toHaveCount(before);

  await prepared.locator("[data-feedback-create]").click();
  await expect(results).toHaveCount(before + 1, { timeout: 20_000 });
  await expect(results.last()).toHaveAttribute("data-feedback-status", "published");

  // The prepared card is used now, and stays a record after a reload.
  await expect(prepared.locator("[data-feedback-create]")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("[data-composer]")).toBeVisible();
  const reloaded = page.locator('.cc-row[data-role="assistant"] [data-feedback-prepared]').last();
  await expect(reloaded).toBeVisible({ timeout: 20_000 });
  await expect(reloaded.locator("[data-feedback-create]")).toHaveCount(0);
});

test("an answer to Create issue this app cannot read is not known, never failed, and Check again asks the node", async ({ page }) => {
  await openApp(page);
  const results = page.locator('.cc-row[data-role="assistant"] [data-feedback-stage="result"]');
  const before = await results.count();
  const composer = page.locator("[data-composer]");
  await composer.click();
  await composer.fill("/report bug the settings sheet forgets its scroll position");
  await composer.press("Enter");
  const prepared = page.locator('.cc-row[data-role="assistant"] [data-feedback-prepared]').last();
  await expect(prepared).toBeVisible({ timeout: 20_000 });

  // The node answers in a shape this app does not read, as a newer node might: nothing says whether it was filed.
  await page.route("**/feedback/reports/*/publish", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ publication: { status: "filed-somewhere-new" }, timeline: { messages: [] } }) }),
  );
  await prepared.locator("[data-feedback-create]").click();
  const note = prepared.locator(".cc-command-status[data-result='unknown']");
  await expect(note).toHaveAttribute("data-surface-phase", "partial", { timeout: 20_000 });
  await expect(note).toContainText("Node đã trả lời, nhưng ứng dụng này không đọc được báo cáo đã được gửi lên hay chưa.");
  // Partial is said politely, not as an error, and never with the schema's own words.
  await expect(prepared.locator("[role='status'] .cc-command-status[data-result='unknown']")).toBeVisible();
  await expect(prepared.locator("[role='alert'] p")).toHaveCount(0);
  await expect(prepared).not.toContainText("Invalid");
  await expect(prepared).not.toContainText("filed-somewhere-new");
  await page.unrouteAll({ behavior: "wait" });

  // Check again only asks: the node never filed this report, and says so; nothing new is filed by the check.
  const check = prepared.locator("[data-feedback-check-unread]");
  await check.focus();
  await page.keyboard.press("Enter");
  await expect(prepared.locator("[role='alert'] .cc-command-status[data-result='failed']")).toBeVisible({ timeout: 20_000 });
  await expect(results).toHaveCount(before);

  // Create issue still files it, once.
  await prepared.locator("[data-feedback-create]").click();
  await expect(results).toHaveCount(before + 1, { timeout: 20_000 });
  await expect(results.last()).toHaveAttribute("data-feedback-status", "published");
});

test("a publish whose answer never arrives is not known, never not filed, and Try again or Check again keeps the focus", async ({ page }) => {
  await openApp(page);
  const results = page.locator('.cc-row[data-role="assistant"] [data-feedback-stage="result"]');
  const before = await results.count();
  const composer = page.locator("[data-composer]");
  await composer.click();
  await composer.fill("/report bug the model picker loses its search text");
  await composer.press("Enter");
  const prepared = page.locator('.cc-row[data-role="assistant"] [data-feedback-prepared]').last();
  await expect(prepared).toBeVisible({ timeout: 20_000 });

  // The publish leaves and the connection drops: the node may have filed it, so nothing says it was not filed.
  await page.route("**/feedback/reports/*/publish", (route) => route.abort("connectionreset"));
  await prepared.locator("[data-feedback-create]").click();
  const note = prepared.locator(".cc-command-status[data-result='unknown']");
  await expect(note).toHaveAttribute("data-surface-phase", "partial", { timeout: 20_000 });
  await expect(note).toContainText("nên chưa biết báo cáo đã được gửi lên hay chưa");
  await expect(prepared).not.toContainText("Chưa gửi được");
  const pressNote = prepared.locator("[data-feedback-press]");

  // Try again from the keyboard: its button goes away while the press runs, and focus stays on the note.
  await prepared.locator("[data-feedback-retry]").focus();
  await page.keyboard.press("Enter");
  await expect(pressNote).toBeFocused();
  await expect(note).toBeVisible({ timeout: 20_000 });
  await page.unrouteAll({ behavior: "wait" });

  // Check again only asks, and keeps the focus too: the node says it never sent this one, and nothing is filed.
  await prepared.locator("[data-feedback-check-unread]").focus();
  await page.keyboard.press("Enter");
  await expect(prepared.locator(".cc-command-status[data-result='failed']")).toContainText("chưa từng được gửi", { timeout: 20_000 });
  await expect(pressNote).toBeFocused();
  await expect(results).toHaveCount(before);

  await prepared.locator("[data-feedback-create]").click();
  await expect(results).toHaveCount(before + 1, { timeout: 20_000 });
  await expect(results.last()).toHaveAttribute("data-feedback-status", "published");
});
