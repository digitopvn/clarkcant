import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The English translation of the shell and voice surfaces, in a real browser.
 *
 * `language-switch.spec.ts` and `language.spec.ts` already prove the composer, a voice control's aria-label
 * and the marketplace heading follow the language picker. This file covers the surfaces this session's own
 * translation work touched and that neither of those files exercises: the hero empty state (a component with
 * no locale context of its own before this change), the header's restart control, an attachment failure's
 * error copy (a pure hook threading `t` rather than reading it from a render), and the voice overlay's dialog
 * chrome once a session is actually open.
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
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error("the node's identity file has no local token");
  }
  return parsed.localToken;
}

/** Open the app already on a fresh onboarded session, with the sample suggestion chips suppressed. */
async function openApp(page: Page): Promise<void> {
  await page.route("**/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

/** Switch the UI language to English through the settings picker, then close settings. */
async function switchToEnglish(page: Page): Promise<void> {
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("[data-segmented='language']")).toBeVisible({ timeout: 10_000 });
  await page.locator("[data-segmented='language'] [data-segment='en']").click();
  await expect(page.locator("[data-segmented='language'] [data-segment='en']")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await page.locator(".cc-modal-done").click();
  await expect(page.locator(".cc-modal-scrim")).toHaveCount(0);
}


/** The node keeps the language choice, and the suite shares one node: put it back for the specs after this one. */
test.afterEach(async ({ request }) => {
  await request.put(`${GATEWAY}/preferences/experience.language`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { value: "vi" },
  });
});

test("the hero empty state, header and an attachment failure read in English once the language is switched", async ({
  page,
}) => {
  await openApp(page);

  // Vietnamese is the default, so the hero heading and the header's restart control start out that way.
  await expect(page.locator("h1")).toHaveText("Bạn đang nghĩ gì?");
  await expect(page.locator("[data-home='true']")).toHaveAttribute("title", "Bắt đầu lại");

  await switchToEnglish(page);

  // The hero empty state: rendered by a component that had no locale context at all before this
  // translation, and is the first screen a person sees.
  await expect(page.locator("h1")).toHaveText("What's on your mind?");
  await expect(page.locator("p", { hasText: "Say what you want to do" })).toBeVisible();
  await expect(page.locator("[data-suggestion-static='true'] .cc-chip-label").first()).toHaveText("Do something");

  // The header: the restart control's title and aria-label, threaded through the same `useT()` path.
  await expect(page.locator("[data-home='true']")).toHaveAttribute("title", "Start over");
  await expect(page.locator("[data-home='true']")).toHaveAttribute(
    "aria-label",
    "Start over: return to the start screen and open a new session",
  );

  // An attachment failure: `use-attachment-composer.ts` is a pure hook, not a component, so its error
  // copy has to thread `t()` from `useAttachmentComposer`'s own render rather than reading it ambiently.
  // Nine files trips the eight-per-message ceiling, so the ninth chip is refused before anything uploads.
  const nineFiles = Array.from({ length: 9 }, (_, index) => ({
    name: `file-${index}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from("x"),
  }));
  await page.locator("[data-attachment-input]").setInputFiles(nineFiles);
  const chips = page.locator("[data-attachment-chip]");
  await expect(chips).toHaveCount(9);
  await expect(chips.last()).toHaveAttribute("data-attachment-state", "failed");
  await expect(chips.last().locator(".cc-chip-reason")).toHaveText("one message can only carry 8 files");
});

test("the voice overlay's dialog chrome reads in English once the language is switched", async ({ page }) => {
  await openApp(page);
  await switchToEnglish(page);

  await page.locator("[data-voice-open='true']").click();
  await expect(page.locator("[data-voice-mute='true']")).toBeVisible({ timeout: 15_000 });

  // The dialog's own accessible name, and the state word shown beside the connection dot — both looked up
  // through `useT()` in `VoiceOverlay.tsx` rather than the Vietnamese literals the component started with.
  await expect(page.locator("[role='dialog'][data-voice-state]")).toHaveAttribute("aria-label", "Voice");
  await expect(page.locator("[data-voice-state-label]")).not.toHaveText(/Đang|Chưa|Không/, { timeout: 15_000 });

  // The three footer controls' visible labels.
  await expect(page.locator("[data-voice-mute='true'] .cc-voice-action-text")).toHaveText(/Turn mic (on|off)/);
  await expect(page.locator("[data-voice-minimize='true'] .cc-voice-action-text")).toHaveText(/Expand|Collapse/);
  await expect(page.locator("[data-voice-end='true'] .cc-voice-action-text")).toHaveText("End");
  await expect(page.locator("[data-voice-type-instead='true']").last()).toContainText("Type instead");

  await page.locator("[data-voice-end='true']").click();
});
