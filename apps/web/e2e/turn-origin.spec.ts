import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { DEFAULT_EXECUTION_POLICY_CONFIG } from "@clarkcant/contracts";

/**
 * Who asked, in the browser (#427).
 *
 * The person opts in from Settings → Control to being asked before a risky effect a program's turn causes. A script
 * then posts into the conversation with the token alone — the CLI or API — and the card it causes says so; the
 * person's own message for the same effect runs as before, and its activity row says it was theirs.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
}

function authorized(): Record<string, string> {
  return { authorization: `Bearer ${token()}` };
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
}

async function say(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill(text);
  await composer.press("Enter");
}

async function conversationId(page: Page): Promise<string> {
  const stored = await page.evaluate(() => sessionStorage.getItem("cc_conversation"));
  if (stored === null || stored === "") throw new Error("the app has not selected a conversation");
  return stored;
}

async function reset(page: Page): Promise<void> {
  for (const [key, value] of [
    ["execution.policy", DEFAULT_EXECUTION_POLICY_CONFIG],
    ["maps.tilePolicy", null],
  ] as const) {
    const response = await page.request.put(`${GATEWAY}/preferences/${key}`, { headers: authorized(), data: { value } });
    expect(response.ok(), await response.text()).toBe(true);
  }
}

async function openControl(page: Page): Promise<void> {
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-control").click();
}

test.afterEach(async ({ page }) => {
  await reset(page);
});

test("a program's turn asks first when the person opted in, and the card and activity say who asked", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  await reset(page);

  // The opt-in, chosen in Settings → Control rather than written behind the page's back.
  await openControl(page);
  const section = page.locator("[data-machine-turns='true']");
  await expect(section).toContainText("Yêu cầu từ chương trình khác", { timeout: 20_000 });
  await expect(section.locator("[data-segment='as-person']")).toHaveAttribute("aria-pressed", "true");
  await section.locator("[data-segment='ask']").click();
  await expect(section.locator("[data-segment='ask']")).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
  await expect
    .poll(async () => {
      const listed = (await (await page.request.get(`${GATEWAY}/preferences`, { headers: authorized() })).json()) as {
        preferences: { key: string; value: unknown }[];
      };
      return listed.preferences.find((preference) => preference.key === "execution.machineTurns")?.value;
    })
    .toBe("ask");
  await page.keyboard.press("Escape");


  // The person's own message for a risky effect still runs, as before the opt-in, and its activity row names them.
  await say(page, "hiện ô bản đồ từ https://tiles2.example");
  await expect
    .poll(async () => {
      const activity = (await (await page.request.get(`${GATEWAY}/activity`, { headers: authorized() })).json()) as {
        effects: { origin?: string; description: string }[];
      };
      return activity.effects.find((effect) => effect.description.includes("tiles2.example"))?.origin;
    }, { timeout: 20_000 })
    .toBe("person");

  // A script posts into the same conversation with the token alone — the CLI or API — and claims to be the person.
  const conversation = await conversationId(page);
  const posted = await page.request.post(`${GATEWAY}/conversations/${encodeURIComponent(conversation)}/messages`, {
    headers: authorized(),
    data: { text: "hiện ô bản đồ từ https://tiles.example", origin: "person" },
  });
  expect(posted.ok(), await posted.text()).toBe(true);
  // The node answers the script's turn with a card; the page shows it once it reads the conversation again.
  await expect
    .poll(async () => {
      const timeline = await page.request.get(`${GATEWAY}/conversations/${encodeURIComponent(conversation)}/timeline?after=0`, {
        headers: authorized(),
      });
      return JSON.stringify(await timeline.json()).includes('"origin":"cli-api"');
    }, { timeout: 20_000 })
    .toBe(true);
  await page.reload();
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  const card = page.locator("[data-host-card='approval'][data-decision='pending']");
  await expect(card.locator("[data-approval-origin='cli-api']")).toHaveText("Do một chương trình yêu cầu qua CLI hoặc API", {
    timeout: 20_000,
  });

  await openControl(page);
  await expect(page.locator("[data-effect-origin='person']").first()).toHaveText(/Do bạn yêu cầu/u, { timeout: 20_000 });
});