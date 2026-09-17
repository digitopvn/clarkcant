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
const FIXTURE_REPLY = "node đã nhận được audio và trả lời bằng fixture";

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

  await page.locator('[data-settings="true"]').click();
  await page.locator("#cc-tab-voice").click();

  // Before starting, the surface must not claim to be listening.
  await expect(page.locator("[data-voice-start='true']")).toBeVisible();
  await page.locator("[data-voice-start='true']").click();

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

  // The reply arrives only if a second of real audio reached the node from the page. This is the
  // assertion that would fail if capture were wired to nothing.
  await expect(page.locator("[data-voice-transcript='true']")).toContainText(FIXTURE_REPLY, {
    timeout: 20_000,
  });

  // Audio came back and was scheduled for playback, in more than one frame.
  const frames = Number(await page.locator("[data-voice-state]").getAttribute("data-voice-audio-frames"));
  expect(frames).toBeGreaterThan(1);

  await page.screenshot({ path: join(EVIDENCE, "voice-01-listening-with-transcript.png"), fullPage: true });

  // Mute is local and immediate, and it is visible.
  await page.locator("[data-voice-mute='true']").click();
  await expect(page.locator("[data-voice-mute='true']")).toHaveAttribute("data-muted", "true");
  await page.locator("[data-voice-mute='true']").click();
  await expect(page.locator("[data-voice-mute='true']")).toHaveAttribute("data-muted", "false");

  // Ending records the session into the conversation.
  await page.locator("[data-voice-end='true']").click();
  await expect(page.locator("[data-voice-ended='true']")).toContainText("ghi lại", { timeout: 15_000 });
  await page.screenshot({ path: join(EVIDENCE, "voice-02-after-ending.png"), fullPage: true });

  // The stored transcript survives a reload, which is the difference between showing a transcript
  // and recording a session.
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(FIXTURE_REPLY, {
    timeout: 15_000,
  });
  await page.screenshot({ path: join(EVIDENCE, "voice-03-recorded-after-reload.png"), fullPage: true });
});
