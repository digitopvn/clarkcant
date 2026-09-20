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
  //
  // The node's own suggestions are pinned to empty for this suite.
  //
  // These journeys are about the four written chips and the demo samples they open. Once the node can offer
  // suggestions drawn from what a person was actually doing, which chips are on screen depends on what happens to
  // be in .data/e2e - so a test that clicked the first chip would be testing whatever the database happened to
  // hold. Asking the node for none is how this suite keeps testing the chip it means to test; the dynamic list has
  // its own journey.
  await page.route("**/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
}

test.beforeAll(() => {
  mkdirSync(EVIDENCE, { recursive: true });
});

test("the client loads, reports a real connection, and asks what to do", async ({ page }) => {
  await openApp(page);

  await expect(page.locator(".cc-brand")).toContainText("ClarkCant");
  // "Ready" must mean the node answered, not that the client rendered.
  await expect(page.locator(".cc-status")).toHaveAttribute("data-connection", "ready");
  // The structure rather than the exact words. Copy is a design decision that keeps changing, and a
  // test pinned to it fails on every rewording while catching nothing — what matters is that a
  // first run shows an invitation with a heading and the four starting chips.
  await expect(page.locator(".cc-empty")).toBeVisible();
  await expect(page.locator(".cc-empty h1")).toBeVisible();
  // At least one chip, rather than exactly four. The node offers suggestions drawn from what the person was
  // actually doing once there is history, and falls back to the four written chips when there is none - so the
  // count depends on how much happened to be in .data/e2e, which is not what this test is about.
  const chips = page.locator("[data-suggestion]");
  await expect(chips.first()).toBeVisible();
  expect(await chips.count()).toBeGreaterThanOrEqual(1);
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
  // A typed message is answered by the model, and on this node that is a fixture which composes an overview out
  // of the node's own records. It used to be answered by a scripted sample recipe, which is precisely what a real
  // message must never get again: a widget shows real data or it does not exist.
  await composer.fill("cho tui xem tổng quan");
  await page.locator("[data-send]").click();

  await expect(page.locator("[data-slot='metrics']")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-role="user"]')).toContainText("tổng quan");
  await page.screenshot({ path: join(EVIDENCE, "j1-03-overview.png") });
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
  await expect(page.locator(".cc-brand")).toContainText("ClarkCant");
  await page.screenshot({ path: join(EVIDENCE, "j1-05-after-reload.png") });
});

test("the composer is keyboard operable end to end", async ({ page }) => {
  await openApp(page);

  // The note surface first, from the demo chip: the chips live on the start screen and it is the only path that
  // runs a scripted sample now that a typed message is answered with the node's own data.
  await page.locator("[data-suggestion]").nth(1).click();
  await expect(page.locator('[data-widget-role="note"]').first()).toBeVisible({ timeout: 20_000 });

  // And the composer, typed into and sent with the keyboard alone.
  await page.locator("[data-composer]").click();
  await page.keyboard.type("cho tui xem tổng quan");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-slot='metrics']")).toBeVisible({ timeout: 20_000 });
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

test("a highlighted passage can be attached to the next prompt", async ({ page }) => {
  // The menu is placed from the selection's own rectangle, so this asserts the whole path: a text selection inside
  // the transcript, the menu appearing over it, and the passage arriving in the composer quoted rather than bare.
  await openApp(page);
  await page.locator("[data-composer]").click();
  await page.keyboard.type("tổng quan");
  await page.keyboard.press("Enter");

  const reply = page.locator('[data-role="assistant"]').last();
  await expect(reply).toBeVisible({ timeout: 20_000 });
  await reply.locator("p").first().selectText();

  const attach = page.locator("[data-selection-action='attach']");
  await expect(attach).toBeVisible();
  await attach.click();

  await expect(page.locator("[data-composer]")).toHaveValue(/>\s/);
  await expect(page.locator("[data-selection-menu='true']")).toHaveCount(0);
});

/*
 * The empty case, ordered before the journey below.
 *
 * It reads best before anything has run on this node. The order is not load-bearing any more: the mark is about work in
 * flight, so a session that has finished does not keep it on screen — which the journey below asserts at its end.
 */
test("the header says nothing about background work when there is none", async ({ page }) => {
  // The empty case, asserted rather than assumed: a mark that showed "0" would be a permanent line of noise, and the
  // count only matters when it is not zero.
  await openApp(page);
  await expect(page.locator("[data-background-sessions]")).toHaveCount(0);
});

test("a selected passage can be sent to a background session", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-composer]").click();
  await page.keyboard.type("tổng quan");
  await page.keyboard.press("Enter");

  const reply = page.locator('[data-role="assistant"]').last();
  await expect(reply).toBeVisible({ timeout: 20_000 });
  await reply.locator("p").first().selectText();

  const button = page.locator("[data-selection-action='background']");
  await expect(button).toBeVisible();
  await button.click();

  // A fixture node does have a model turn, so this is the accepted path rather than a refusal, and the status is what
  // says so. It outlives the menu it was clicked in: the menu goes away with the selection, and an answer that vanished
  // with it would be an answer nobody could read.
  await expect(page.locator("[data-selection-status='true']")).toContainText(/phiên nền/i);

  // And the header now reports the work it started: this is the count the mark exists for, and it is the only way the
  // number is verifiable in a browser - the registry fills when something asks for background work, not on its own.
  await expect(page.locator("[data-background-count='true']")).toBeVisible({ timeout: 20_000 });

  // And it goes away when the work does. The mark is about work in flight: the fixture session finishes in about a
  // second and a half, and the client polls every five, so this is asserting that the header stops saying something
  // about work that is over rather than that it says nothing the instant a worker exits.
  await expect(page.locator("[data-background-sessions]")).toHaveCount(0, { timeout: 20_000 });
});
