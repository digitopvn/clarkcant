import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * `control_app` answers with what the screen did, not with what it asked for.
 *
 * `voice-agent-control.spec.ts` proves an agent decision reaches the page through the same executor a click
 * does. This suite proves the other half: the page reports back, and the sentence the agent is handed - the
 * reply this journey reads - is "done" only when the page ran the action, and a truthful failure when it could
 * not. It also proves an agent-issued action is carried out once: a reload does not replay it.
 *
 * What is substituted is the same as in `voice-agent-control.spec.ts`: the node runs `CC_MODEL_FIXTURE=1`, and
 * a fixture stands in for the model's decision to call the tool by calling `controlApp` - the function the tool
 * executes with - for a sentence shaped `agent control_app <kind> [arg]`. Everything after that decision is real:
 * the stream route expecting a report, the page's executor, its report route, and the tool's wait for it.
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

const DONE = "Màn hình đã thực hiện xong";
const FAILED = "Màn hình không thực hiện được lệnh";

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

async function startConversation(page: Page): Promise<void> {
  await page.locator("[data-suggestion]").first().click();
  await expect(page.locator('[data-role="user"]')).toHaveCount(1, { timeout: 15_000 });
}

async function scriptVoice(request: APIRequestContext, words: string): Promise<void> {
  const response = await request.post(`${GATEWAY}/voice-fixture/words`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { words },
  });
  expect(response.status()).toBe(200);
}

/** Type a sentence the fixture model answers by calling `control_app`, and wait for that reply. */
async function askAgent(page: Page, sentence: string, expected: string): Promise<void> {
  await page.locator('[data-composer="true"]').fill(sentence);
  await page.locator('[data-send="true"]').click();
  await expect(page.getByText(expected).last()).toBeVisible({ timeout: 20_000 });
}

test("the agent opens Settings on a tab and is told it is done only because the page ran it", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page);
  await startConversation(page);

  await askAgent(page, "agent control_app settings.tab ai", DONE);

  // What the reply claims is what the screen shows: Settings open, on the AI tab.
  await expect(page.locator("#cc-tab-ai")).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: join(EVIDENCE, "agent-app-control-01-settings-tab.png"), fullPage: false });

  // Carried out once: the action is not stored for replay, so a reload lands on the plain conversation.
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[role="tablist"]')).toHaveCount(0);
});

test("a model switch the page could not make is reported to the agent as a failure, with the page's reason", async ({
  page,
}) => {
  await openApp(page);
  await startConversation(page);

  await askAgent(page, "agent control_app model.select no-such-profile", FAILED);
  // The note beside the model label and the agent's reply say the same thing, so neither side claims a switch.
  await expect(page.locator("[data-model-label]").first()).not.toHaveAttribute("data-model-label", "no-such-profile");
  const note = page.locator(".cc-model-switch [data-model-note]");
  await expect(note).toContainText("no-such-profile");
  // A sentence for a person, not the node's error code in front of it.
  await expect(note).not.toContainText("NO_MODEL_PROFILE");
  // Said once, next to the model label, not again in a second notice elsewhere on the page.
  await expect(page.locator('[data-intent-notice="true"]')).toHaveCount(0);
  await page.screenshot({ path: join(EVIDENCE, "agent-app-control-02-model-refused.png"), fullPage: false });
});

test("a model switch the page made is reported as done, and the label and note follow it", async ({ page }) => {
  await openApp(page);
  await startConversation(page);

  await askAgent(page, "agent control_app model.select smart", DONE);
  await expect(page.locator('[data-model-label="smart"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-model-note]").first()).toContainText("smart");

  await askAgent(page, "agent control_app model.select fast", `${DONE}`);
  await expect(page.locator('[data-model-label="fast"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-model-note]").first()).toContainText("fast");
});

test("a command the page cannot carry out says so in a readable notice, inside the page's gutter", async ({ page }) => {
  await openApp(page);
  await startConversation(page);

  // There is no window to shrink in a browser, so the typed command is refused with a reason.
  await page.locator('[data-composer="true"]').fill("thu nhỏ tối thiểu");
  await page.locator('[data-send="true"]').click();
  const notice = page.locator('[data-intent-notice="true"]');
  await expect(notice).toBeVisible({ timeout: 20_000 });

  // A card clear of the page's edges, not a loose line of text pinned to the corner.
  const box = await notice.boundingBox();
  const viewport = page.viewportSize();
  if (box === null || viewport === null) throw new Error("the notice has no box");
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 16);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(await notice.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
  await page.screenshot({ path: join(EVIDENCE, "agent-app-control-04-refused-notice.png"), fullPage: false });
});

test("the agent opens voice mode and is told so only once the session is listening", async ({ page }) => {
  await openApp(page);
  await startConversation(page);

  await askAgent(page, "agent control_app voice.open", DONE);
  await expect(page.locator('[data-voice-state="listening"]')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: join(EVIDENCE, "agent-app-control-03-voice-open.png"), fullPage: false });
});

test("the agent returns to the conversation from Settings without leaving it, unlike going home", async ({ page }) => {
  await openApp(page);
  await startConversation(page);
  // Watched from before the send, because Settings is open only between the two calls of one turn.
  await page.evaluate(() => {
    const seen = window as unknown as { sawSettings?: boolean };
    new MutationObserver(() => {
      if (document.querySelector('[role="tablist"]') !== null) seen.sawSettings = true;
    }).observe(document.body, { childList: true, subtree: true });
  });

  await page.locator('[data-composer="true"]').fill("agent control_app settings.open; nav.conversation");
  await page.locator('[data-send="true"]').click();
  // Both calls answered done, each only after the page said so, in the order they were asked, in one reply said once.
  const reply = page.locator('[data-role="assistant"]').last();
  await expect(reply).toContainText(new RegExp(`${DONE}: .*Settings.*${DONE}: .*cuộc trò chuyện`, "su"), { timeout: 20_000 });
  await expect(page.getByText(DONE)).toHaveCount(1);

  expect(await page.evaluate(() => (window as unknown as { sawSettings?: boolean }).sawSettings)).toBe(true);
  // Settings closed, and the conversation is the same one: both messages still there, no start screen.
  await expect(page.locator('[role="tablist"]')).toHaveCount(0);
  await expect(page.locator('[data-role="user"]')).toHaveCount(2);
  await expect(page.locator("[data-suggestion]")).toHaveCount(0);
});

test("the agent cycles the model the way the hotkey does, and the label says where it moved", async ({ page }) => {
  await openApp(page);
  await startConversation(page);
  const label = page.locator("[data-model-label]").first();
  await expect(label).toHaveAttribute("data-model-label", /.+/, { timeout: 15_000 });
  const before = await label.getAttribute("data-model-label");

  await askAgent(page, "agent control_app model.cycle", DONE);
  await expect(label).not.toHaveAttribute("data-model-label", before ?? "");
  const after = await label.getAttribute("data-model-label");
  await expect(page.locator(".cc-model-switch [data-model-note]")).toContainText(after ?? "");

  // The profile is the node's, not this page's, so it is put back: a suite that reads the starting profile later
  // (the hotkey test) must not find the one this test moved to.
  await askAgent(page, `agent control_app model.select ${before ?? ""}`, DONE);
  await expect(label).toHaveAttribute("data-model-label", before ?? "", { timeout: 15_000 });
});

test("the agent changes the orb's style through the preference Settings writes, and the orb on screen follows", async ({
  page,
  request,
}) => {
  const headers = { authorization: `Bearer ${token()}` };
  const storedOrb = async (): Promise<unknown> => {
    const response = await request.get(`${GATEWAY}/preferences`, { headers });
    const body = (await response.json()) as { preferences: { key: string; value: unknown }[] };
    return body.preferences.find((entry) => entry.key === "orb.profile")?.value;
  };

  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page);
  await startConversation(page);
  const orb = page.locator(".cc-orb[data-orb]").first();
  await expect(orb).toHaveAttribute("data-orb-profile", "clark");

  try {
    await askAgent(page, "agent control_app orb.select plasma", DONE);
    // What the reply claims is what the screen shows, and what the node stored: one preference, not a
    // second copy of the choice kept by the conversation.
    await expect(orb).toHaveAttribute("data-orb-profile", "plasma");
    expect(await storedOrb()).toBe("plasma");
    await page.screenshot({ path: join(EVIDENCE, "agent-app-control-05-orb-plasma.png"), fullPage: false });

    // Settings shows the agent's choice as the selected style, because it reads the same preference.
    await page.locator('[data-settings="true"]').click();
    await expect(page.locator('[data-orb-preset="plasma"]')).toHaveAttribute("aria-pressed", "true");
  } finally {
    // The style is the node's, so it is put back for the suites that expect the shipped orb.
    for (let step = 0; step < 16; step += 1) {
      const response = await request.post(`${GATEWAY}/preferences/orb.profile/undo`, { headers });
      const answer = (await response.json()) as { preference?: { isDefault?: boolean } };
      if (answer.preference?.isDefault === true) break;
    }
  }
});

test("the voice agent ends voice mode through the same contract, and the page confirms it", async ({ page, request }) => {
  await openApp(page);
  await startConversation(page);

  await scriptVoice(request, "agent control_app voice.end");
  await page.locator('[data-voice-open="true"]').click();
  await expect(page.locator(".cc-voice")).toBeVisible({ timeout: 15_000 });

  // The spoken sentence is not an app command the registry knows, so it reached the voice agent's own turn, whose
  // control_app call closed the overlay through the same executor the end button uses.
  await expect(page.locator(".cc-voice")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('[data-composer="true"]')).toBeVisible();
  // And the voice agent was told the screen did it, not merely that it was asked.
  await expect(page.getByText(DONE).first()).toBeAttached({ timeout: 20_000 });
});
