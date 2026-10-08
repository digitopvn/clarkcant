import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Text typed right after the logo, or right after `/new` during a reply, belongs to the new conversation.
 *
 * Both tell the node (`POST /app-intents`), and that answer can be slow. The start screen and the composer must not
 * wait for it: a message typed and sent in that window starts a reply in the new conversation, and a draft typed in it
 * is still there once the answer arrives. Before, the restart ran only on the answer, so the message was checked as a
 * command in the conversation left behind and the late restart then emptied the composer.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set; run this through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
/** How late the node's answer to the click arrives: long enough that a person can type and send before it. */
const INTENT_DELAY_MS = 1_500;
const LONG_REPLY = "viết một câu trả lời thật dài";

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

function isIntentRequest(url: string): boolean {
  return new URL(url).pathname.endsWith("/app-intents");
}

/** Every app-intent answer late, or failing late as a dropped connection does. */
async function openStartScreen(page: Page, intents: "late" | "unreachable", open = true): Promise<void> {
  await page.route("**/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.route("**/app-intents", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, INTENT_DELAY_MS));
    // The node cannot be reached: the request fails as a dropped connection does.
    if (intents === "unreachable") await route.abort("connectionrefused");
    else await route.continue();
  });
  if (open) await openPage(page);
}

async function openPage(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
}

/**
 * No notice now, nor a moment later. Read as it stands rather than retried: a notice clears itself after six seconds, so
 * a retrying assertion would pass by waiting one out.
 */
async function expectNoNotice(page: Page): Promise<void> {
  for (const wait of [500, 1_000]) {
    await page.waitForTimeout(wait);
    expect(await page.locator("[data-intent-notice]").count()).toBe(0);
  }
}

/**
 * The app, with a first message whose stream is held so its reply is still running, and every app-intent answer late.
 * Returns the held stream so the test can let it end.
 */
async function openWithRunningReply(page: Page, intents: "late" | "unreachable" = "late"): Promise<() => Route | undefined> {
  await openStartScreen(page, intents, false);
  let held: Route | undefined;
  await page.route("**/messages/stream", async (route) => {
    if (held === undefined) {
      held = route;
      return;
    }
    await route.continue();
  });
  await openPage(page);

  const composer = page.locator("[data-composer]");
  await composer.fill("xin chào");
  await composer.press("Enter");
  await expect.poll(() => held !== undefined, { timeout: 15_000 }).toBe(true);
  await expect(page.locator("[data-stop]")).toBeVisible();
  return () => held;
}

test("a message sent right after the logo starts a reply in the new conversation", async ({ page }) => {
  const held = await openWithRunningReply(page);
  const composer = page.locator("[data-composer]");

  await page.locator('[data-home="true"]').click();
  // No waiting for the node's answer to the click: the person types and sends at once.
  await composer.fill(LONG_REPLY);
  await composer.press("Enter");

  // The message is the new conversation's first, and its reply is being written.
  await expect(page.locator('[data-role="user"]')).toHaveCount(1);
  await expect(page.locator('[data-role="user"]')).toContainText(LONG_REPLY);
  await expect(page.getByText(/Đoạn 2\./u).first()).toBeVisible({ timeout: 15_000 });
  await expect(composer).toHaveValue("");

  // The click's late answer changes nothing: the reply goes on, and so does its Stop.
  await page.waitForTimeout(INTENT_DELAY_MS);
  await expect(page.locator('[data-role="user"]')).toHaveCount(1);
  await expect(page.locator("[data-stop]")).toBeVisible();

  await page.locator("[data-stop]").click();
  await expect(page.locator('[data-role="assistant"]').last().locator("[data-model-note]")).toContainText(
    "Đã dừng theo yêu cầu",
    { timeout: 15_000 },
  );
  await held()?.continue();
});

test("a draft typed right after the logo is still there when the node's answer arrives", async ({ page }) => {
  const held = await openWithRunningReply(page);
  const composer = page.locator("[data-composer]");

  const answered = page.waitForResponse((response) => isIntentRequest(response.url()));
  await page.locator('[data-home="true"]').click();
  // The start screen is back at once, with Send rather than the old reply's Stop.
  await expect(page.locator(".cc-empty")).toBeVisible({ timeout: 1_000 });
  await expect(page.locator("[data-stop]")).toHaveCount(0, { timeout: 1_000 });
  await composer.fill("một câu chưa gửi");
  await answered;
  // The answer is handled in a task after the response; give it the time it would take to clear the draft.
  await page.waitForTimeout(500);

  await expect(composer).toHaveValue("một câu chưa gửi");
  await expect(page.locator(".cc-empty")).toBeVisible();
  await held()?.continue();
});

test("a message sent right after /new during a reply starts a reply in the new conversation", async ({ page }) => {
  const held = await openWithRunningReply(page);
  const composer = page.locator("[data-composer]");

  const answered = page.waitForResponse((response) => isIntentRequest(response.url()));
  await composer.fill("/new");
  await composer.press("Enter");
  // No waiting for the node's answer to /new: the person types and sends at once.
  await composer.fill(LONG_REPLY);
  await composer.press("Enter");

  await expect(page.locator('[data-role="user"]')).toHaveCount(1);
  await expect(page.locator('[data-role="user"]')).toContainText(LONG_REPLY);
  await expect(page.getByText(/Đoạn 2\./u).first()).toBeVisible({ timeout: 15_000 });
  await expect(composer).toHaveValue("");

  // The late answer changes nothing, and its read-back is not said over a conversation the person has already
  // written in: it would be a remark about leaving, shown beside a reply that has nothing to do with it.
  await answered;
  await expectNoNotice(page);
  await expect(page.locator('[data-role="user"]')).toHaveCount(1);
  await expect(page.locator("[data-stop]")).toBeVisible();

  await page.locator("[data-stop]").click();
  await expect(page.locator('[data-role="assistant"]').last().locator("[data-model-note]")).toContainText(
    "Đã dừng theo yêu cầu",
    { timeout: 15_000 },
  );
  await held()?.continue();
});

test("a draft typed right after /new during a reply is still there when the node's answer arrives", async ({ page }) => {
  const held = await openWithRunningReply(page);
  const composer = page.locator("[data-composer]");

  const answered = page.waitForResponse((response) => isIntentRequest(response.url()));
  await composer.fill("/new");
  await composer.press("Enter");
  await expect(page.locator(".cc-empty")).toBeVisible({ timeout: 1_000 });
  await expect(page.locator("[data-stop]")).toHaveCount(0, { timeout: 1_000 });
  await composer.fill("một câu chưa gửi");
  await answered;
  await expect(page.locator("[data-intent-notice]")).toContainText("/sessions");

  await expect(composer).toHaveValue("một câu chưa gửi");
  await expect(page.locator(".cc-empty")).toBeVisible();
  await held()?.continue();
});

/** What the page says itself when the node cannot be told: leaving did not stop that reply, which /sessions reopens. */
const KEPT_WHILE_REPLYING = "Việc rời đi không dừng câu trả lời ở cuộc trước, cuộc đó vẫn được giữ; mở lại bất cứ lúc nào bằng /sessions.";

for (const [name, leave] of [
  [
    "/new",
    async (page: Page) => {
      await page.locator("[data-composer]").fill("/new");
      await page.locator("[data-composer]").press("Enter");
    },
  ],
  [
    "the logo",
    async (page: Page) => {
      await page.locator('[data-home="true"]').click();
    },
  ],
] as const) {
  test(`when the node cannot be told about ${name} during a reply, the page says what was kept and keeps the draft`, async ({ page }) => {
    const held = await openWithRunningReply(page, "unreachable");
    const composer = page.locator("[data-composer]");

    const failed = page.waitForEvent("requestfailed", (request) => isIntentRequest(request.url()));
    await leave(page);
    await expect(page.locator(".cc-empty")).toBeVisible({ timeout: 1_000 });
    await composer.fill("một câu chưa gửi");
    await failed;

    // The node's read-back will not come, so the page says what was kept; not "could not ask the node", since the
    // person is where they asked to be.
    await expect(page.locator("[data-intent-notice]")).toContainText(KEPT_WHILE_REPLYING);
    await expect(page.locator("[data-intent-notice]")).not.toContainText("Không hỏi được node");
    await expect(composer).toHaveValue("một câu chưa gửi");
    await expect(page.locator(".cc-empty")).toBeVisible();
    await held()?.continue();
  });
}
test("when the node cannot be told about the logo, nothing is said once a message was sent in the new conversation", async ({ page }) => {
  const held = await openWithRunningReply(page, "unreachable");
  const composer = page.locator("[data-composer]");

  const failed = page.waitForEvent("requestfailed", (request) => isIntentRequest(request.url()));
  await page.locator('[data-home="true"]').click();
  await composer.fill(LONG_REPLY);
  await composer.press("Enter");
  await expect(page.locator('[data-role="user"]')).toHaveCount(1);
  await failed;

  // "Started a new conversation…" over the person's own first message there would describe something no longer on screen.
  await expectNoNotice(page);
  await expect(page.locator('[data-role="user"]')).toContainText(LONG_REPLY);

  await page.locator("[data-stop]").click();
  await expect(page.locator('[data-role="assistant"]').last().locator("[data-model-note]")).toContainText(
    "Đã dừng theo yêu cầu",
    { timeout: 15_000 },
  );
  await held()?.continue();
});

test("the logo on the start screen says nothing when the node cannot be told, since nothing was left behind", async ({ page }) => {
  await openStartScreen(page, "unreachable");

  const failed = page.waitForEvent("requestfailed", (request) => isIntentRequest(request.url()));
  await page.locator('[data-home="true"]').click();
  await failed;

  await expectNoNotice(page);
  await expect(page.locator(".cc-empty")).toBeVisible();
});

/** The shorter remark, for a conversation whose reply had already finished: there is no reply to say leaving did not stop. */
const KEPT = "Đã mở cuộc trò chuyện mới. Cuộc trước vẫn được giữ; mở lại bất cứ lúc nào bằng /sessions.";

test("the logo after a finished reply says, once, only that the conversation left behind is kept", async ({ page }) => {
  const held = await openWithRunningReply(page, "unreachable");
  await held()?.continue();
  await expect(page.locator("[data-stop]")).toHaveCount(0, { timeout: 15_000 });

  const failed = page.waitForEvent("requestfailed", (request) => isIntentRequest(request.url()));
  await page.locator('[data-home="true"]').click();
  await expect(page.locator(".cc-empty")).toBeVisible({ timeout: 1_000 });
  await failed;

  const notice = page.locator("[data-intent-notice]");
  await expect(notice).toHaveCount(1);
  await expect(notice).toHaveText(KEPT);
  await page.waitForTimeout(1_000);
  await expect(notice).toHaveCount(1);
});

test("a draft edited after Enter on a sentence asking to go home is kept through the restart", async ({ page }) => {
  const held = await openWithRunningReply(page);
  const composer = page.locator("[data-composer]");

  const answered = page.waitForResponse((response) => isIntentRequest(response.url()));
  await composer.fill("về trang chủ");
  await composer.press("Enter");
  // The sentence waits for the node's reading; meanwhile the person starts the next message in its place.
  await expect(page.locator("[data-stop]")).toBeVisible();
  await composer.fill("câu tiếp theo");
  await answered;

  // The node read it as going home, and the restart did not take the edited text with it.
  await expect(page.locator(".cc-empty")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(composer).toHaveValue("câu tiếp theo");
  await held()?.continue();
});