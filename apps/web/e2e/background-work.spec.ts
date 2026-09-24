import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Background work a person can see and stop, in a real browser.
 *
 * Two claims only a browser settles: that the limit chosen in Settings is the one the node admits work under, and
 * that the stop beside a running piece of work in the process panel reaches the node and ends that work — shown as
 * stopped, not failed, and gone from the header mark. The work is the fixture's scripted background run, which honours
 * a stop the way a real worker does and calls no provider.
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
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

async function nodeLimit(request: APIRequestContext): Promise<number> {
  const response = await request.get(`${GATEWAY}/background-sessions`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  const body = (await response.json()) as { limit?: unknown };
  return typeof body.limit === "number" ? body.limit : -1;
}

test("the background limit chosen in Settings is the one the node admits work under", async ({ page, request }) => {
  await openApp(page);
  await page.locator('[data-settings="true"]').click();
  await page.locator("#cc-tab-control").click();

  const panel = page.locator("#cc-tabpanel-control");
  const limit = panel.locator('[data-segmented="background-limit"]');
  await expect(limit.locator('[data-segment="3"]')).toHaveAttribute("aria-pressed", "true");

  await limit.locator('[data-segment="1"]').click();
  await expect(limit.locator('[data-segment="1"]')).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => nodeLimit(request), { timeout: 10_000 }).toBe(1);
  await page.screenshot({ path: join(EVIDENCE, "background-01-limit.png"), fullPage: true });

  // Put it back, so the node this suite shares with the other specs ends where it started.
  await limit.locator('[data-segment="3"]').click();
  await expect.poll(() => nodeLimit(request), { timeout: 10_000 }).toBe(3);
});

test("a running background request is stopped from the process panel and reported as stopped", async ({ page, request }) => {
  await openApp(page);

  // A terminal card is where the process panel lives.
  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("mở terminal giúp tôi");
  await composer.press("Enter");
  const card = page.locator("[data-host-card='terminal-session']").last();
  await expect(card).toBeVisible({ timeout: 20_000 });

  // The panel lists the whole node's work, so the request may belong to a conversation of its own: one made here,
  // rather than guessed from whichever conversation was touched last by a spec running beside this one.
  const created = await request.post(`${GATEWAY}/conversations`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { title: "Việc nền để dừng" },
  });
  const { conversationId } = (await created.json()) as { conversationId: string };

  const started = await request.post(`${GATEWAY}/background-sessions`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { conversationId, text: "việc nền dài: đọc lại báo cáo" },
  });
  expect(started.status()).toBe(202);
  const { sessionId } = (await started.json()) as { sessionId: string };

  await card.locator("[data-terminal-processes='true']").click();
  const panel = card.locator("[data-terminal-panel='true']");
  const stop = panel.locator(`[data-panel-stop='${sessionId}']`);
  await expect(stop).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-background-sessions]")).toBeVisible({ timeout: 10_000 });

  await stop.click();

  await expect(panel.locator("[data-panel-background-status='stopped']").first()).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator(`[data-panel-stop='${sessionId}']`)).toHaveCount(0);
  // The header mark is polled; once nothing is running it is gone rather than showing a zero.
  await expect(page.locator("[data-background-sessions]")).toHaveCount(0, { timeout: 12_000 });
  await page.screenshot({ path: join(EVIDENCE, "background-02-stopped.png"), fullPage: true });
});
