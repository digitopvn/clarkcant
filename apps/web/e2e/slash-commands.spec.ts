import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Slash commands, as a person uses them: found after `/` in the composer, answered by the host in the conversation
 * as an agent message with a card, and acted on from that card.
 *
 * The node runs the scripted model and the fake provider list, so a sign-in here asks what a real one asks — a key in
 * a password field — and changes what the node reports about that provider, which is the claim worth a browser.
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
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("the node's identity file has no local token");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("[data-composer]")).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer]");
  await composer.click();
  await composer.fill(text);
  await composer.press("Enter");
}

function lastCard(page: Page, command: string) {
  return page.locator(`.cc-row[data-role="assistant"] [data-command="${command}"]`).last();
}

test("a command is found after a slash and answered in the conversation with a card", async ({ page }) => {
  await openApp(page);
  const composer = page.locator("[data-composer]");
  await composer.click();
  await page.keyboard.type("/sess");

  const option = page.locator('[data-reference-option="sessions"]');
  await expect(option).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("/sessions ");
  // A command is what the message says, not a reference it carries.
  await expect(page.locator("[data-reference-chips]")).toHaveCount(0);

  await page.keyboard.press("Enter");
  const card = lastCard(page, "sessions");
  await expect(card).toBeVisible({ timeout: 20_000 });
  // The command itself is not echoed as the person's message: the host's answer is the record.
  await expect(page.locator('.cc-row[data-role="user"]', { hasText: "/sessions" })).toHaveCount(0);
});

test("Enter sends a command typed in full, even with the list showing it", async ({ page }) => {
  await openApp(page);
  const composer = page.locator("[data-composer]");
  await composer.click();
  await page.keyboard.type("/sessions");
  // The list is up and its row is the command already typed: there is nothing left for Enter to complete.
  await expect(page.locator('[data-reference-option="sessions"]')).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(lastCard(page, "sessions")).toBeVisible({ timeout: 20_000 });
  await expect(composer).toHaveValue("");
});

test("the thinking level is chosen from the card the command answers with", async ({ page }) => {
  await openApp(page);
  await send(page, "/thinking");

  const card = lastCard(page, "thinking");
  await expect(card).toBeVisible({ timeout: 20_000 });
  const high = card.locator('[data-row-id="high"]');
  await high.getByRole("button").click();
  await expect(high.locator(".cc-command-status")).toContainText("Đã đặt", { timeout: 10_000 });

  // The node holds the choice: asking again marks it as the one in use.
  await send(page, "/thinking");
  const again = lastCard(page, "thinking");
  await expect(again.locator('[data-row-id="high"]')).toHaveAttribute("data-current", "true", { timeout: 20_000 });

  // Back to the model's default, so the rest of the suite runs as it always has.
  await again.locator('[data-row-id="default"]').getByRole("button").click();
  await expect(again.locator('[data-row-id="default"] .cc-command-status')).toContainText("Đã đặt", { timeout: 10_000 });
});

test("a provider is signed in to with a key from the /login card, and signed out of from /logout", async ({ page }) => {
  await openApp(page);
  await send(page, "/login");

  const card = lastCard(page, "login");
  await expect(card).toBeVisible({ timeout: 20_000 });
  const other = card.locator('[data-row-id="fake-other"]');
  await other.getByRole("button", { name: "Dùng API key" }).click();

  const field = other.locator('.cc-sign-in input[type="password"]');
  await expect(field).toBeVisible({ timeout: 10_000 });
  await field.fill("e2e-test-key");
  await other.getByRole("button", { name: "Gửi" }).click();
  await expect(other.locator(".cc-sign-in .cc-command-status")).toContainText("Đã đăng nhập", { timeout: 10_000 });
  // What was typed never comes back into the page.
  await expect(page.locator("body")).not.toContainText("e2e-test-key");

  await send(page, "/logout");
  const logout = lastCard(page, "logout");
  const stored = logout.locator('[data-row-id="fake-other"]');
  await expect(stored).toBeVisible({ timeout: 20_000 });
  // A key the node only reads from its environment offers no sign-out here.
  await expect(logout.locator('[data-row-id="fake"]').getByRole("button")).toHaveCount(0);

  await stored.getByRole("button", { name: "Đăng xuất" }).click();
  await expect(stored.locator(".cc-command-status")).toContainText("Đã đăng xuất", { timeout: 10_000 });
});

test("a /login sign-in keeps the focus that started it, and is shown again on the card after a reload", async ({ page }) => {
  await openApp(page);
  await send(page, "/login");
  const card = lastCard(page, "login");
  await expect(card).toBeVisible({ timeout: 20_000 });
  const other = card.locator('[data-row-id="fake-other"]');

  // Pressed from the keyboard; the field the provider asks with takes the focus, so typing goes straight there.
  await other.getByRole("button", { name: "Dùng API key" }).focus();
  await page.keyboard.press("Enter");
  const field = other.locator('.cc-sign-in input[type="password"]');
  await expect(field).toBeFocused({ timeout: 10_000 });

  // The page reloads mid-sign-in: the node still runs it, so the newest card's row shows it rather than nothing.
  await page.reload();
  await expect(page.locator("[data-composer]")).toBeVisible();
  const again = lastCard(page, "login").locator('[data-row-id="fake-other"]');
  await expect(again.locator('.cc-sign-in input[type="password"]')).toBeVisible({ timeout: 20_000 });
  await expect(again.getByRole("button", { name: "Dùng API key" })).toHaveAttribute("aria-disabled", "true");
  // Shown in that one row only.
  await expect(page.locator('[data-command="login"] [data-row-id="fake-other"] .cc-sign-in')).toHaveCount(1);
  // And it does not pull the focus from where a page that just opened puts it.
  await expect(again.locator('.cc-sign-in input[type="password"]')).not.toBeFocused();

  await again.locator(".cc-sign-in").getByRole("button", { name: "Hủy" }).click();
  await expect(again.locator(".cc-sign-in .cc-command-status")).toContainText("Đã hủy", { timeout: 10_000 });
});

/** A widget project folder of the test's own, outside the node's data folder, with a package id no other test uses. */
function writeProject(): { root: string; packageId: string } {
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const root = join(process.cwd(), ".data", "e2e-develop", `timer-${unique}`);
  const packageId = `com.example.e2e.develop.t${unique}`;
  mkdirSync(join(root, "widgets", "main"), { recursive: true });
  writeFileSync(join(root, "widgets", "main", "index.html"), "<!doctype html><p>timer</p>\n");
  writeFileSync(
    join(root, "widgets", "main", "widget.json"),
    JSON.stringify({ name: "Timer", dataContract: { kind: "none" }, actions: [], datasetRefs: [], semanticDescription: "A timer", requestedCapabilities: [] }),
  );
  writeFileSync(
    join(root, "clarkcant.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: packageId,
      version: "0.1.0",
      displayName: "Timer",
      description: "A timer.",
      hostApi: { min: 1, max: 1 },
      facets: [{ kind: "widget", id: "timer", entry: "widgets/main/index.html", definition: "widgets/main/widget.json", isolation: "isolated-ui" }],
      requestedCapabilities: [],
      permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64", "web"],
      publisher: { id: "example", sourceUrl: "https://example.com", license: "MIT" },
    }),
  );
  return { root, packageId };
}

test("a folder typed into the /develop card in a browser is developed as the person's own choice", async ({ page, request }) => {
  const { root, packageId } = writeProject();
  const headers = { authorization: `Bearer ${token()}` };
  try {
    await openApp(page);
    await send(page, "/develop");
    const card = lastCard(page, "develop");
    await expect(card).toBeVisible({ timeout: 20_000 });

    // A browser has no folder dialog: the row asks for the path and says why, rather than offering a dialog it cannot open.
    const choose = card.locator('[data-row-id="choose"]');
    await choose.getByRole("button", { name: "Chọn thư mục…" }).click();
    const entry = choose.locator('[data-folder-entry="browser"]');
    await expect(entry).toBeVisible();
    await expect(entry).toContainText("Trình duyệt không mở được hộp chọn thư mục");
    const field = entry.getByRole("textbox", { name: "Đường dẫn thư mục" });
    await expect(field).toBeFocused();

    // Escape leaves the card as it was; pressing the row again asks again.
    // Focus returns to the button that opened the field, so the keyboard is where it was.
    await field.press("Escape");
    await expect(entry).toHaveCount(0);
    await expect(choose.getByRole("button", { name: "Chọn thư mục…" })).toBeFocused();
    await choose.getByRole("button", { name: "Chọn thư mục…" }).click();
    await entry.getByRole("textbox").fill(root);
    await entry.getByRole("button", { name: "Phát triển" }).click();

    const status = choose.locator('.cc-command-status[data-result="done"]');
    await expect(status).toContainText(root.split(/[\\/]/).at(-1) ?? root, { timeout: 20_000 });

    // The node holds the session, which only the person's own start can have begun outside Clark's workspace.
    const listed = (await (await request.get(`${GATEWAY}/widget-dev/sessions`, { headers })).json()) as {
      sessions: { root: string; status: string }[];
    };
    const mine = listed.sessions.find((candidate) => candidate.root.endsWith(root.split(/[\\/]/).at(-1) ?? root));
    expect(mine).toMatchObject({ status: "live" });

    // /develop forget lists the folder the person chose, and takes the choice back on their press.
    await send(page, "/develop forget");
    const folders = lastCard(page, "develop");
    await expect(folders).toContainText("Thư mục Clark được phát triển", { timeout: 20_000 });
    const row = folders.locator("li", { hasText: root.split(/[\\/]/).at(-1) ?? root });
    await expect(row).toContainText("bạn đã chọn");
    await row.getByRole("button", { name: "Thu hồi" }).click();
    await expect(row.locator('.cc-command-status[data-result="done"]')).toContainText("Đã thu hồi", { timeout: 10_000 });
    await expect(row).not.toContainText("bạn đã chọn");
  } finally {
    await request.post(`${GATEWAY}/widget-dev/chosen-folders/forget`, { headers, data: { root } });
    const listed = (await (await request.get(`${GATEWAY}/widget-dev/sessions`, { headers })).json()) as { sessions: { sessionId: string; root: string }[] };
    for (const entry of listed.sessions.filter((candidate) => candidate.root.endsWith(root.split(/[\\/]/).at(-1) ?? root))) {
      await request.delete(`${GATEWAY}/widget-dev/sessions/${entry.sessionId}`, { headers });
    }
    const packages = (await (await request.get(`${GATEWAY}/packages`, { headers })).json()) as { packages: { packageId: string }[] };
    if (packages.packages.some((entry) => entry.packageId === packageId)) {
      await request.post(`${GATEWAY}/packages/${encodeURIComponent(packageId)}/uninstall`, { headers });
    }
    rmSync(root, { recursive: true, force: true });
  }
});

/** Puts the language back for the specs after this one: the suite shares one node, and it keeps the choice. */
async function resetLanguage(request: import("@playwright/test").APIRequestContext): Promise<void> {
  await request.put(`${GATEWAY}/preferences/experience.language`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { value: "vi" },
  });
}

test("/settings opens the one Settings dialog over the conversation, on a named tab, and gives focus back", async ({ page }) => {
  await openApp(page);
  await send(page, "/sessions");
  await expect(lastCard(page, "sessions")).toBeVisible({ timeout: 20_000 });
  const rows = page.locator(".cc-row");
  const before = await rows.count();
  const composer = page.locator("[data-composer]");

  await send(page, "/settings");
  const settings = page.getByRole("dialog", { name: "Cài đặt" });
  await expect(settings).toBeVisible({ timeout: 20_000 });
  // The same dialog the gear opens, once: no second surface and nothing stacked.
  await expect(page.locator('[data-modal="true"]')).toHaveCount(1);
  await expect(settings.locator("[data-active-tab]")).toHaveAttribute("data-active-tab", "experience");
  await expect(page.locator('.cc-row[data-role="user"]', { hasText: "/settings" })).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(composer).toBeFocused();
  // The conversation is still the one it was, with the host's read-back added to it.
  await expect(page.locator('.cc-row[data-role="assistant"]').last()).toContainText("Tôi mở Settings nhé.");
  expect(await rows.count()).toBeGreaterThan(before);
  await expect(lastCard(page, "sessions")).toBeVisible();

  // A tab named in Vietnamese words opens Settings on it.
  await send(page, "/settings thiết bị");
  await expect(settings.locator("[data-active-tab]")).toHaveAttribute("data-active-tab", "devices", { timeout: 20_000 });
  await expect(page.locator("#cc-tab-devices")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(composer).toBeFocused();

  // A tab that does not exist opens nothing and says which ones there are.
  await send(page, "/settings hoá đơn");
  await expect(page.locator('.cc-row[data-role="assistant"]').last()).toContainText("Settings không có tab “hoá đơn”", { timeout: 20_000 });
  await expect(settings).toHaveCount(0);
});

test("/settings typed while a reply is written opens Settings on the tab its Vietnamese label names, and another command says it waits", async ({ page }) => {
  await openApp(page);
  const composer = page.locator("[data-composer]");
  // The fixture's slow reply, a piece every 150 ms, leaves time to type while it is written.
  await send(page, "viết một câu trả lời thật dài");
  await expect(page.locator("[data-stop]")).toBeVisible({ timeout: 15_000 });

  await send(page, "/settings bộ nhớ");
  const settings = page.getByRole("dialog", { name: "Cài đặt" });
  await expect(settings.locator("[data-active-tab]")).toHaveAttribute("data-active-tab", "memory", { timeout: 20_000 });
  await expect(composer).toHaveValue("");
  // Closed with its own button rather than Escape, which would also stop the reply.
  await settings.getByRole("button", { name: "Xong" }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.locator("[data-stop]")).toBeVisible();

  // A command answered in the conversation has to wait for this reply: it stays in the draft, and the page says why.
  await send(page, "/thinking high");
  await expect(page.locator("[data-intent-notice]")).toContainText("Gửi /thinking được khi Clark trả lời xong", { timeout: 15_000 });
  await expect(composer).toHaveValue("/thinking high");

  await page.locator("[data-stop]").click();
  await expect(page.locator("[data-send]")).toBeVisible({ timeout: 15_000 });
});

test("/new typed while a reply is written starts a new conversation and says the reply goes on in the one left behind", async ({ page }) => {
  await openApp(page);
  const composer = page.locator("[data-composer]");
  await send(page, "viết một câu trả lời thật dài");
  await expect(page.locator("[data-stop]")).toBeVisible({ timeout: 15_000 });

  await send(page, "/new");
  await expect(page.locator(".cc-empty[data-leaving='false']")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-role="user"]')).toHaveCount(0);
  await expect(page.locator("[data-intent-notice]")).toContainText("Clark vẫn đang viết nốt câu trả lời ở cuộc trước", { timeout: 15_000 });
  await expect(page.locator("[data-intent-notice]")).toContainText("/sessions");
  await expect(composer).toHaveValue("");
  await expect(page.locator("[data-stop]")).toHaveCount(0);
});

test.describe("in English", () => {
  test.afterEach(async ({ request }) => resetLanguage(request));

  test("/settings ai opens Settings on AI & Routing and reads it back in English", async ({ page }) => {
    await openApp(page);
    await page.locator("[data-settings='true']").click();
    await page.locator("[data-segmented='language'] [data-segment='en']").click();
    await expect(page.locator("[data-segmented='language'] [data-segment='en']")).toHaveAttribute("data-selected", "true");
    await page.keyboard.press("Escape");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toHaveCount(0);

    await send(page, "/settings ai");
    await expect(settings).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-modal="true"]')).toHaveCount(1);
    await expect(settings.locator("[data-active-tab]")).toHaveAttribute("data-active-tab", "ai");
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect(page.locator("[data-composer]")).toBeFocused();
    await expect(page.locator('.cc-row[data-role="assistant"]').last()).toContainText("Opening Settings on the AI & Routing tab.");

    await send(page, "/settings billing");
    await expect(page.locator('.cc-row[data-role="assistant"]').last()).toContainText('Settings has no tab "billing"', { timeout: 20_000 });
    await expect(settings).toHaveCount(0);
  });
});
