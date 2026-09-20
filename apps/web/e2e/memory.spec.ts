import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The Memory tab: what was remembered, where it came from, and removing it.
 *
 * The write goes through a turn: the fixture stands in for the agent and calls the same `remember` tool a model
 * calls, so this journey exercises the tool's own validation and redaction, the write, and the Memory tab reading it
 * back. What a fixture cannot prove is the provider's judgement - that a model would decide to call it - and that
 * stays an opt-in check behind a provider key.
 *
 * The deletion journey re-opens the tab afterwards on purpose. A row that vanished from the screen and came back on
 * the next read would look identical in a screenshot, and it is exactly the difference between a memory somebody
 * controls and one that is only hidden.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const EVIDENCE = join(process.cwd(), "plans", "reports", "evidence");

const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

function token(): string {
  const path = join(DATA_DIR, "identity.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error(`no local token in ${path}`);
  }
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

/** Type a message and send it, through the same composer a person uses. */
async function say(page: Page, text: string): Promise<void> {
  await page.locator("textarea[aria-label='Nhập tin nhắn']").fill(text);
  await page.locator("[data-send='true']").click();
}

/** Open Settings on a named tab. */
async function openTab(page: Page, tab: string): Promise<void> {
  await page.locator("[data-settings='true']").click();
  await page.locator(`#cc-tab-${tab}`).click();
  await expect(page.locator(`#cc-tab-${tab}`)).toHaveAttribute("data-selected", "true");
}

test("a node that has remembered nothing says so", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  // Pinned empty: this journey is about the empty state, and whether the shared database happens to hold
  // something from another test is not what it is testing.
  await page.route("**/memory", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], counts: { preference: 0, "project-fact": 0, decision: 0 } }),
    }),
  );
  await openApp(page);
  await openTab(page, "memory");

  await expect(page.locator("[data-memory-state='empty']")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-memory-state='empty']")).toContainText("Chưa có gì được ghi nhớ");
  await page.screenshot({ path: join(EVIDENCE, "memory-empty-light.png"), fullPage: false });
});

test("a remembered thing shows its source and its kind", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page);
  await say(page, "nhớ rằng: người dùng thích câu trả lời ngắn, không lan man");

  await openTab(page, "memory");

  const row = page.locator("[data-memory-id]").filter({ hasText: "câu trả lời ngắn" }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  // The kind is the section the row sits in, not text inside the row, and the source is said in words rather
  // than left blank.
  await expect(page.locator("[data-memory-kind='preference']")).toBeVisible();
  await expect(page.locator("[data-memory-kind='preference']")).toContainText("Sở thích");
  await expect(row.locator("[data-memory-source]")).not.toBeEmpty();
  expect(await page.locator("[data-memory-count]").first().getAttribute("data-memory-count")).toBeTruthy();

  await page.screenshot({ path: join(EVIDENCE, "memory-populated-dark.png"), fullPage: false });
});

test("deleting a remembered thing removes it rather than hiding it", async ({ page }) => {
  await openApp(page);
  await say(page, "nhớ rằng: điều này sẽ bị xoá ngay sau đây");
  await openTab(page, "memory");

  const row = page.locator("[data-memory-id]").filter({ hasText: "sẽ bị xoá ngay sau đây" }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.locator("[data-memory-delete='true']").click();
  await expect(row).toHaveCount(0, { timeout: 20_000 });

  // Closes and re-opens the tab, which reads the node again. Something that came back here was hidden, not
  // deleted, and this is the only assertion that can tell the two apart.
  // Closes with Escape, the way a person closes a dialog. The gear is behind the dialog while it is open, so
  // clicking it is not something a person could do either - and a test that does it measures the overlay.
  await page.keyboard.press("Escape");
  await expect(page.locator("#cc-tab-memory")).toHaveCount(0);
  await openTab(page, "memory");
  await expect(page.locator("[data-memory-id]").filter({ hasText: "sẽ bị xoá ngay sau đây" })).toHaveCount(0, {
    timeout: 20_000,
  });
});
