import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Journey J1 in a real browser.
 *
 * This is the strongest evidence this repository produces: a production build of the client,
 * a real headless node, and a real browser. It asserts the two things that are easy to fake
 * and hard to get right — that a scripted sample is visibly labelled as a sample, and that
 * what the user sees came from the node rather than from the client's optimism.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const EVIDENCE = join(process.cwd(), "plans", "reports", "evidence");

/**
 * The node this run started.
 *
 * Read from the environment rather than assumed, because the suite runs on its own ports so
 * that it does not have to stop a developer's servers. The client defaults to the usual port,
 * so without this it would talk to whatever else is listening there.
 */
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

function token(): string {
  const path = join(DATA_DIR, "identity.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(
      "the node did not write its identity to " + path + ", so its webServer probably failed to start",
      { cause },
    );
  }
  try {
    return (JSON.parse(raw) as { localToken: string }).localToken;
  } catch (cause) {
    throw new Error("the node identity at " + path + " is not valid JSON", { cause });
  }
}

/**
 * Open the app with a token.
 *
 * No storage clearing is needed and none is done: Playwright gives every test its own
 * browser context, so session storage already starts empty. An earlier version cleared it
 * with , which runs on *every* navigation — including the reload that the
 * resume test performs — so the test was erasing the very state it meant to verify.
 */
async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
}

test.beforeAll(() => {
  mkdirSync(EVIDENCE, { recursive: true });
});

test("the client loads, reports a real connection, and asks what to do", async ({ page }) => {
  await openApp(page);

  await expect(page.locator(".cc-brand")).toContainText("Agent");
  // "Ready" must mean the node answered, not that the client rendered.
  await expect(page.locator(".cc-status")).toHaveAttribute("data-connection", "ready");
  await expect(page.getByRole("heading", { name: "Bạn muốn làm gì?" })).toBeVisible();
  await page.screenshot({ path: join(EVIDENCE, "j1-01-empty.png") });
});

test("a suggestion produces a labelled sample with a real widget", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-suggestion]").first().click();

  await expect(page.locator('.cc-row[data-role="user"]')).toContainText("biểu đồ");

  // The host card is the sample label, and it must be host-owned.
  const card = page.locator('[data-host-card="system"]').first();
  await expect(card).toHaveAttribute("data-owner", "host");
  await expect(card).toContainText("Dữ liệu mẫu / demo tương tác");
  await expect(card).toContainText("không có model nào được gọi");

  // A real chart drew from a real dataset, and it admits the data is sampled.
  await expect(page.locator('[data-widget-role="chart"]').first()).toBeVisible();
  await expect(page.locator("[data-freshness='sample']").first()).toBeVisible();
  await expect(page.locator("[data-chart-summary='true']").first()).not.toBeEmpty();

  await page.screenshot({ path: join(EVIDENCE, "j1-02-sample-chart.png") });
});

test("typing a message works, and the answer comes back from the node", async ({ page }) => {
  await openApp(page);

  const composer = page.locator("[data-composer]");
  await composer.click();
  await composer.fill("cho tui xem bảng dữ liệu");
  await page.locator("[data-send]").click();

  await expect(page.locator(".cc-table").first()).toBeVisible();
  await expect(page.locator('[data-role="user"]')).toContainText("bảng dữ liệu");
  await expect(page.locator('[data-widget-role="table"]').first()).toBeVisible();
  await page.screenshot({ path: join(EVIDENCE, "j1-03-table.png") });
});

test("pinning and unpinning keeps the widget data", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-suggestion]").first().click();
  await expect(page.locator('[data-widget-role="chart"]').first()).toBeVisible();

  await page.locator("[data-pin-instance]").first().click();

  const shelf = page.locator("[data-pin-shelf='true']");
  await expect(shelf).toBeVisible();
  // A pin refreshes on open unless the user granted something broader.
  await expect(shelf.locator("[data-pin-id]").first()).toHaveAttribute("data-refresh-policy", "on-open");
  await page.screenshot({ path: join(EVIDENCE, "j1-04-pinned.png") });

  await shelf.locator("[data-unpin]").first().click();
  await expect(page.locator("[data-pin-shelf='true']")).toHaveCount(0);
  // Unpinning is a presentation change: the widget is still there.
  await expect(page.locator('[data-widget-role="chart"]').first()).toBeVisible();
});

test("reopening the app resumes the same conversation", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-suggestion]").first().click();
  await expect(page.locator('[data-widget-role="chart"]').first()).toBeVisible();

  await page.reload();
  await expect(page.locator('[data-widget-role="chart"]').first()).toBeVisible();
  await expect(page.locator(".cc-brand")).toContainText("Agent");
  await page.screenshot({ path: join(EVIDENCE, "j1-05-after-reload.png") });
});

test("the composer is keyboard operable end to end", async ({ page }) => {
  await openApp(page);

  await page.locator("[data-composer]").click();
  await page.keyboard.type("tạo note nhanh cho tui");
  await page.keyboard.press("Enter");

  await expect(page.locator('[data-widget-role="note"]').first()).toBeVisible();
  const area = page.locator(".cc-note-area").first();
  await area.click();
  await page.keyboard.type("ghi chú thử");
  await expect(page.locator("[data-note-status='draft']")).toBeVisible();
  await page.screenshot({ path: join(EVIDENCE, "j1-06-note-keyboard.png") });
});

test("the bearer token is never written into the page", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-suggestion]").first().click();
  await expect(page.locator('[data-widget-role="chart"]').first()).toBeVisible();

  // The token authorises local commands, so it must not appear in the rendered document
  // where any injected script could read it.
  expect(await page.content()).not.toContain(token());
});

test("an unauthenticated client is told what it needs instead of failing silently", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-needs-token='true']")).toBeVisible();
  await expect(page.locator(".cc-status")).toContainText("Chưa có token");
});
