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
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
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
 * BLOCKED, and the missing condition is named here rather than left as a quiet skip.
 *
 * This test drives the real action and asserts the state afterwards, and it fails: the spoken sentence
 * resolves to nothing, so the session answers "I am not sure what you want to do with the open widget".
 * That answer comes from the resolver's unmatched path, which means the focused instance's offered
 * actions were listed and the words matched none of their labels.
 *
 * What is not established: the label `semanticViewOf` actually emits for this binding. `compose-mini-app.ts`
 * compiles it as "Đổi khoảng thời gian", and the resolver's own unit test passes for exactly that label,
 * so the app is producing something else - most likely a second binding compiled from the section spec
 * rather than the template's. Until that is read off the node, matching this label is a guess, and a guess
 * is what the resolver exists to refuse.
 *
 * The refusal journey below does pass, and it is what proves the focus frame, the view lookup and the
 * "refuse rather than guess" rule are wired. T66 is not claimed: it needs this one green.
 */
test("a spoken action the widget does not offer changes nothing", async ({ page, request }) => {
  await openApp(page);
  await ask(page, "cho tui xem tổng quan công việc tuần này");
  await page.locator("[data-open-live]").first().click();
  const live = page.locator("[data-pin-live]").first();
  await expect(live.locator("[data-surface-composition]").first()).toBeVisible({ timeout: 30_000 });
  const period = live.locator("[data-slot='filter'] select");
  await expect(period).toHaveValue("week", { timeout: 30_000 });

  // Names no offered action. The refusal is said out loud and the surface is left alone - which is the
  // property that separates this from a widget acted on by whatever a transcription happened to say.
  await scriptVoice(request, "cho tui xem tháng mười hai");
  await openVoice(page);
  await expect(page.getByText(/chưa rõ bạn muốn làm gì/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(period).toHaveValue("week");
});
