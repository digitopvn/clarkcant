import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Answering a question by voice, and the same question by click.
 *
 * The invariant this exists for is that voice is another way into the same Clark rather than a second product:
 * a spoken answer must land where a pressed answer lands. It can only be true because of a design decision made
 * elsewhere — the card's answer is not a route of its own, it is the user's own next message, which is the path
 * the composer and the voice session both already use. A card answered through a dedicated endpoint would pass
 * every unit test and still produce two different transcripts depending on how the user replied.
 *
 * So the assertion is not "voice works". It is that the result is the state a click produces: the answer is in the
 * transcript as the user's own words, and the card has stopped asking.
 *
 * What is substituted is the provider, not the wiring: the node runs `CC_VOICE_FIXTURE=1`, so the sentence it is
 * understood to have heard is scripted while capture, the socket, the agent turn and the transcript are real.
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
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

/**
 * Script what the node will be understood to have heard.
 *
 * Scripted immediately before the session opens, because the fixture's words are consumed by whichever session
 * speaks next — a session left open by an earlier journey can take them, which is a property of the fixture
 * rather than of the feature.
 */
async function scriptVoice(request: APIRequestContext, words: string): Promise<void> {
  const response = await request.post(`${GATEWAY}/voice-fixture/words`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { words },
  });
  expect(response.status()).toBe(200);
}

test("an answer spoken out loud lands in the transcript exactly where a pressed one does", async ({
  page,
  request,
}) => {
  await openApp(page);

  const composer = page.locator("textarea[aria-label='Nhập tin nhắn']");
  await composer.click();
  await composer.fill("hỏi tôi một câu");
  await composer.press("Enter");

  const card = page.locator("[data-host-card='question']").last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveAttribute("data-answered", "false");

  // The exact label the card offers. Saying it is the spoken equivalent of pressing it, which is the whole claim:
  // the label is what a click puts in the transcript.
  await scriptVoice(request, "Dự án hiện tại");

  await page.locator('[data-voice-open="true"]').click();
  await expect(page.locator('[data-voice-state="listening"]')).toBeVisible({ timeout: 15_000 });

  /*
   * The answer arrives as the user's own message, which is the state a click produces. Asserted against the
   * transcript rather than against the voice overlay, because the overlay is a view of the session and the
   * transcript is what the agent and a later reader actually see.
   */
  const spoken = page.locator("[data-role='user']").last();
  await expect(spoken).toContainText("Dự án hiện tại", { timeout: 30_000 });

  /*
   * And the card stops asking, because the node recorded the answer — the same receipt a click produces. Note which
   * surface asked and which answered: the question came from a typed message and the answer from a sentence, which is
   * the claim. A waiting question belongs to the conversation, not to the surface that raised it.
   */
  await expect(card).toHaveAttribute("data-answered", "true");
  await expect(card.locator("[data-question-option]")).toHaveCount(0);
});
