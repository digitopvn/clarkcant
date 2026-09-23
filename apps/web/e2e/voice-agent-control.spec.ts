import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * `control_app`, the main agent's app-control tool, reaching the page from both a typed turn and a
 * voice turn - and landing exactly where the header's own home button lands.
 *
 * `voice-control.spec.ts` proves the deterministic path: a sentence the registry matches directly, with
 * no model in between. This suite proves the other half of issue #129's voice criterion, the one a
 * deterministic match never exercises: a sentence (spoken or typed) that the registry does *not* match
 * falls through to the agent's own turn, and if the agent decides to call `control_app`, that decision
 * has to reach the page through the same executor a click reaches it through - `runAppIntent` - whether
 * the turn was answering a typed message or a spoken one.
 *
 * What is real here: the page's own click handler, the typed-message route, the voice socket, the
 * conductor's turn machinery, and `control_app`'s own validation and audit call
 * (`apps/runtime/src/node-tools.ts`, covered directly by `apps/runtime/test/control-app-tool.spec.ts`).
 * What is substituted: the model's judgement to call the tool. The node runs `CC_MODEL_FIXTURE=1`, so a
 * fixture stands in for the agent and calls the exact function `control_app` calls with
 * (`decideControlApp`) - the same validation, the same `host-control` event, the same audit record -
 * rather than a live model's own decision to reach for the tool. That is a real limitation of this
 * evidence and it is named rather than glossed.
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

/**
 * The sentence the fixture composer recognises as "call control_app with nav.home".
 *
 * Long on purpose - more than `APP_COMMAND_MAX_WORDS` - so `isAppCommandShaped` never even looks at its
 * opening verb: the deterministic registry declines it outright on length, on both the typed and the
 * spoken route, and the only thing left that can answer it is the agent's own turn. A shorter sentence
 * that merely avoided the verb list would still be one accidental synonym away from being "understood"
 * by the registry instead of reaching `control_app`.
 */
const AGENT_HOME_SENTENCE = "nhờ agent xử lý giúp tôi việc quay về màn hình bắt đầu nhé";

function token(): string {
  const path = join(DATA_DIR, "identity.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error(`no local token in ${path}`);
  }
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.route("**/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

/** Start a conversation, so there is somewhere for the agent's turn to answer into. */
async function startConversation(page: Page): Promise<void> {
  await page.locator("[data-suggestion]").first().click();
  await expect(page.locator('[data-role="user"]')).toHaveCount(1, { timeout: 15_000 });
}

/** The start screen's own chip, visible only once the session has actually restarted. */
async function expectHome(page: Page): Promise<void> {
  await expect(page.locator("[data-suggestion]").first()).toBeVisible({ timeout: 20_000 });
}

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

test("the header's home button and a typed control_app decision land on the same start screen", async ({
  page,
}) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page);
  await startConversation(page);

  // The button first, so the comparison is against the app's own control rather than against the fixture.
  await page.locator('[data-home="true"]').click();
  await expectHome(page);

  // Back into a conversation, so the typed sentence has somewhere to be answered - the agent's turn,
  // reached because the sentence matches no deterministic app-command.
  await startConversation(page);
  await page.locator('[data-composer="true"]').fill(AGENT_HOME_SENTENCE);
  await page.locator('[data-send="true"]').click();

  // Landed the same place the button did: the executor a click reaches is the one a typed decision reaches.
  await expectHome(page);
  await page.screenshot({ path: join(EVIDENCE, "voice-agent-control-01-typed-parity.png"), fullPage: false });
});

test("a spoken sentence the registry does not match reaches control_app, with the same read-back the typed route gets", async ({
  page,
  request,
}) => {
  await openApp(page);
  await startConversation(page);

  await scriptVoice(request, AGENT_HOME_SENTENCE);
  await openVoice(page);

  /*
   * The decision reaches the page over the same `{type: "app-intent"}` wire frame a deterministic spoken
   * command already uses - `use-voice-session` needs no new handler, and `runAppIntent` needs no new
   * caller - and it is answered with `nav.home`'s own read-back, the same words the typed route's turn
   * produced in the test above.
   *
   * Asserted on the read-back rather than on the start screen's own chip, for the reason
   * `voice-control.spec.ts`'s "a spoken home returns to the start screen" test already gives: the
   * session repeats the fixture's utterance once a second, so `nav.home` runs more than once and the
   * voice overlay is still open when it does, covering the hero screen underneath it. The read-back is
   * what proves the decision was carried out; the overlay staying open is what proves the browser did not
   * navigate anywhere else while proving it.
   */
  await expect(page.getByText("Tôi về màn hình bắt đầu nhé").first()).toBeVisible({ timeout: 20_000 });
});
