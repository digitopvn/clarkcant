import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * T66: voice and click reach the same widget action state.
 *
 * What this drives is one real action on one real surface, twice. The click path changes the period
 * through the live surface's own control; the voice path asks for it out loud, through the node's
 * registry, the resolver, the one invoke function a click also goes through, and the fixture
 * provider. Between the two the state is put back, so the second path has to do the work rather than
 * inherit it - without the reset this test would pass on a surface that ignored the second command.
 *
 * ## What this does not count
 *
 * The phase asked for one action invocation per path, and this suite cannot count invocations: the
 * node writes them to `action_invocations` and no route exposes that table, so a browser run has no
 * way to read it. Rather than add an endpoint that exists for a test, the claim is narrowed to what
 * is observable - both paths land on the same state - and the counting is named as missing. A double
 * invocation of a period change is idempotent, so the state cannot stand in for the count either.
 *
 * The provider is substituted (`CC_VOICE_FIXTURE=1`); everything else is real, including the socket,
 * the instance's ownership, the binding digest and the revision check.
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
  const path = join(DATA_DIR, "identity.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error(`no local token in ${path}`);
  }
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("textarea[aria-label='Nhập tin nhắn']")).toBeVisible();
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
}

/** Type a request and wait for the surface it composes. Scripted, so no provider is called. */
async function ask(page: Page, text: string): Promise<void> {
  await page.locator("textarea[aria-label='Nhập tin nhắn']").fill(text);
  await page.locator("[data-send='true']").click();
  await expect(page.locator("[data-surface-composition]").first()).toBeVisible({ timeout: 30_000 });
}

/** What the node will be understood to have heard, for the next voice session and no further. */
async function scriptVoice(request: APIRequestContext, words: string): Promise<void> {
  const response = await request.post(`${GATEWAY}/voice-fixture/words`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { words },
  });
  expect(response.status()).toBe(200);
}

async function openVoice(page: Page): Promise<void> {
  await page.locator('[data-voice-open="true"]').click();
  await expect(page.locator('[data-voice-state="listening"]')).toBeVisible({ timeout: 15_000 });
}

/**
 * A sentence that names none of the open widget's actions is Clark's, like any sentence that is not a command.
 *
 * The spoken words select nothing on the surface: the resolver matches labels only, so the surface is left alone and
 * the sentence becomes the person's message, which Clark's turn answers. The overview offers no action Clark can
 * perform, so the turn is given none. This node runs no model, so the turn's answer says that; what this pins is that
 * the sentence reached the turn, was neither refused nor acted on by the host, and left the period unchanged.
 */
test("a spoken sentence naming none of the widget's actions goes to Clark and changes nothing by itself", async ({ page, request }) => {
  await openApp(page);
  await ask(page, "cho tui xem tổng quan công việc tuần này");
  await page.locator("[data-open-live]").first().click();
  const live = page.locator("[data-pin-live]").first();
  await expect(live.locator("[data-surface-composition]").first()).toBeVisible({ timeout: 30_000 });
  const period = live.locator("[data-slot='filter'] select");
  await expect(period).toHaveValue("week", { timeout: 30_000 });

  await scriptVoice(request, "cho tui xem tháng mười hai");
  await openVoice(page);
  await expect(page.getByText("cho tui xem tháng mười hai").first()).toBeVisible({ timeout: 20_000 });
  // Clark's turn answered it: this node runs no model, and the turn says so, which only a turn can say.
  await expect(page.getByText(/chưa có model nào để tui dùng/u).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/chưa rõ bạn muốn làm gì|không có hành động nào|không có widget nào đang mở/i)).toHaveCount(0);
  await expect(period).toHaveValue("week");
});

/**
 * T66: one real action, reached two ways, landing in the same state.
 *
 * Measured rather than assumed, and an earlier note here was wrong about why it failed: the sentence does resolve and the action
 * does run - the node reported ok, revision 7 to 8, "Da Doi khoang thoi gian". What was missing was that the page
 * had no handler for the node's report, so the surface kept showing the old period. The sentence also has to carry
 * the argument: this action takes a period, and a sentence naming only the action cannot choose one.
 */
test("a spoken action and the same click reach the same state", async ({ page, request }) => {
  await openApp(page);
  await ask(page, "cho tui xem tổng quan công việc tuần này");
  await page.locator("[data-open-live]").first().click();
  const live = page.locator("[data-pin-live]").first();
  await expect(live.locator("[data-surface-composition]").first()).toBeVisible({ timeout: 30_000 });
  const period = live.locator("[data-slot='filter'] select");
  await expect(period).toHaveValue("week", { timeout: 30_000 });

  // The click path, through the surface's own control.
  await period.selectOption("month");
  await expect(period).toHaveValue("month", { timeout: 30_000 });

  // Put it back, so the spoken path has to do the work rather than inherit it. Without this the journey would
  // pass on a surface that ignored the second command.
  await period.selectOption("week");
  await expect(period).toHaveValue("week", { timeout: 30_000 });

  await scriptVoice(request, "xem theo tháng");
  await openVoice(page);
  await expect(period).toHaveValue("month", { timeout: 30_000 });
});
