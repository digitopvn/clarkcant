import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Live voice, end to end in a real browser.
 *
 * What is real here: Chromium's microphone (a synthetic device, but the same capture path a person
 * uses), the page's own capture and playback, the WebSocket, the node's authentication and
 * single-session rule, and the conversation the transcript is written into.
 *
 * What is substituted: the provider. The node runs `CC_VOICE_FIXTURE=1`, a scripted adapter, so this
 * suite needs no account and spends no quota. That is a real limitation of this evidence and it is
 * stated rather than glossed: this run proves the browser-to-node path, and the adapter that talks
 * to Gemini is covered by unit tests plus one live operator-checked run recorded in
 * `plans/reports/`.
 *
 * The assertions are chosen so that a broken capture cannot pass: the fixture answers only after it
 * has received a second of audio, so a transcript in the UI means audio genuinely travelled from
 * the page, and `data-voice-audio-frames` means audio genuinely came back.
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

/** The words the fixture provider answers with. Kept here so the assertion and the fixture agree. */
/**
 * The live model's own scripted answer.
 *
 * It must not appear anywhere: the session is told to transcribe and to read back, and the agent is the
 * one that answers. Two answers to one question is the failure this guards against.
 */
const FIXTURE_REPLY = "node đã nhận được audio và trả lời bằng fixture";

/** What the voice fixture says once a second of real audio has reached the node. */
const FIXTURE_SPOKEN = "audio giả lập từ thiết bị micro";

/** What the agent answers to those words, scripted by the node's model fixture. */
const AGENT_REPLY = "Fixture đã nhận câu bạn nói và trả lời qua hội thoại, không phải model thật.";

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

/**
 * Start a conversation.
 *
 * A voice session records into a conversation, and a node asked to record into nothing says so
 * instead. The scripted suggestion is used because it creates the conversation without calling a
 * provider, so this suite stays account-free.
 */
async function startConversation(page: Page): Promise<void> {
  await page.locator("[data-suggestion]").first().click();
  await expect(page.locator('[data-role="user"]')).toHaveCount(1, { timeout: 15_000 });
}

test("a microphone session carries audio both ways and records the transcript", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page);
  await startConversation(page);

  // Opened from the composer, which is where a person looks to start talking. This button used to be
  // disabled with a tooltip while the working session sat in a settings tab.
  await page.locator('[data-voice-open="true"]').click();

  // The screen appears, and the assertion that matters is the next one: the node accepted the session
  // and capture opened. There is deliberately no assertion on the `connecting` state in between — it
  // lasts as long as the handshake, and a test that races a handshake fails on a fast machine and
  // passes on a slow one, which is the worst way for a test to be wrong.
  const voice = page.locator("[data-voice-state]");
  await expect(voice).toBeVisible();

  // Capture really opened, and the node accepted the session.
  await expect(page.locator('[data-voice-state="listening"]')).toBeVisible({ timeout: 15_000 });

  // Audio is leaving the browser. Asserted separately from the reply because otherwise a failure
  // cannot tell "nothing was captured" apart from "nothing was answered", and the two look the
  // same on screen while having nothing in common as bugs.
  await expect
    .poll(async () => Number(await page.locator("[data-voice-state]").getAttribute("data-voice-capture-frames")), {
      timeout: 15_000,
      message: "the browser never sent a capture frame",
    })
    .toBeGreaterThan(0);

  // What was said is transcribed, so the person can read their own sentence back while speaking.
  await expect(page.locator(".cc-voice")).toContainText(FIXTURE_SPOKEN, { timeout: 20_000 });

  // The answer arrives only if a second of real audio reached the node from the page, and it is the
  // agent's answer: the sentence was spoken, became a message, and the session read the reply back.
  await expect(page.locator(".cc-voice")).toContainText(AGENT_REPLY, { timeout: 20_000 });
  // The live model's own words never arrive, because it is no longer the one answering.
  await expect(page.locator(".cc-voice")).not.toContainText(FIXTURE_REPLY);

  // The answer is in the conversation behind the session, while the session is still open. The failure
  // this covers is real: the messages were written, and only a reload made them appear.
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(AGENT_REPLY, { timeout: 20_000 });

  // Collapsed, the session stays running and stops hiding the conversation it is answering into.
  await page.locator('[data-voice-minimize="true"]').click();
  await expect(page.locator('[data-voice-collapsed="true"]')).toBeVisible({ timeout: 15_000 });
  // The body's parts go, except the waveform: it is the only evidence on screen that the microphone is
  // still live, and hiding it is what made a collapsed session look silent.
  await expect(page.locator(".cc-voice-orb")).toBeHidden();
  await expect(page.locator(".cc-voice-wave")).toBeVisible();
  // Still the same conversation, still the answer, and still updating rather than frozen.
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(AGENT_REPLY);
  await page.screenshot({ path: join(EVIDENCE, "voice-01b-collapsed-over-conversation.png"), fullPage: true });
  await page.locator('[data-voice-minimize="true"]').click();
  await expect(page.locator('[data-voice-collapsed="false"]')).toBeVisible({ timeout: 15_000 });

  // Audio came back and was scheduled for playback, in more than one frame.
  const frames = Number(await page.locator("[data-voice-state]").getAttribute("data-voice-audio-frames"));
  expect(frames).toBeGreaterThan(1);

  // The waveform is driven by the frames themselves, so a row of bars that never moves would be a
  // picture of a microphone rather than a reaction to one.
  await expect.poll(async () => Number(await page.locator(".cc-voice").getAttribute("data-voice-level")), {
    timeout: 15_000,
    message: "no audio level was ever reported",
  }).toBeGreaterThan(0);

  await page.screenshot({ path: join(EVIDENCE, "voice-01-listening-with-transcript.png"), fullPage: true });

  // Mute is local and immediate, and it is visible.
  await page.locator("[data-voice-mute='true']").click();
  await expect(page.locator("[data-voice-mute='true']")).toHaveAttribute("data-muted", "true");
  await page.locator("[data-voice-mute='true']").click();
  await expect(page.locator("[data-voice-mute='true']")).toHaveAttribute("data-muted", "false");

  // Ending leaves the voice mode; the recording is what proves the session was real, and that is
  // asserted after the reload rather than on a panel that no longer exists.
  await page.locator("[data-voice-end='true']").click();
  await expect(page.locator(".cc-voice")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator("[data-composer='true']")).toBeVisible();
  await page.screenshot({ path: join(EVIDENCE, "voice-02-after-ending.png"), fullPage: true });

  // The stored transcript survives a reload, which is the difference between showing a transcript
  // and recording a session. It is the assistant's answer that is stored, because that is the message
  // the agent's turn wrote while the sentence was being said.
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(AGENT_REPLY, {
    timeout: 15_000,
  });
  await page.screenshot({ path: join(EVIDENCE, "voice-03-recorded-after-reload.png"), fullPage: true });
});
