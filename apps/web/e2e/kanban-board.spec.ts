import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") throw new Error("CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts");
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const NOTES_PACKAGE = "com.example.notes";
const BOARD_MOVE_CAPABILITY = "com.example.notes.board-move@1";

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
}
function authorized(): Record<string, string> { return { authorization: `Bearer ${token()}` }; }
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
async function heldState(page: Page, conversation: string, instanceId: string): Promise<unknown> {
  const response = await page.request.get(`${GATEWAY}/conversations/${encodeURIComponent(conversation)}/timeline?after=0`, { headers: authorized() });
  expect(response.ok()).toBe(true);
  const timeline = (await response.json()) as { instances?: { instanceId: string; state?: unknown }[] };
  return timeline.instances?.find((instance) => instance.instanceId === instanceId)?.state ?? {};
}
async function instanceOf(board: Locator): Promise<string> {
  const id = await board.evaluate((element) => element.closest("[data-widget-instance]")?.getAttribute("data-widget-instance") ?? "");
  expect(id).not.toBe("");
  return id;
}

async function boardServiceReady(page: Page): Promise<void> {
  const packages = (await (await page.request.get(`${GATEWAY}/packages`, { headers: authorized() })).json()) as { packages?: { packageId: string }[] };
  if (!packages.packages?.some((entry) => entry.packageId === NOTES_PACKAGE)) {
    const installed = await page.request.post(`${GATEWAY}/packages/install`, {
      headers: authorized(),
      data: { packageId: NOTES_PACKAGE, version: "1.0.0", localDigest: "sha256:notes-service-digest" },
    });
    expect(installed.ok(), `notes fixture install answered ${String(installed.status())}`).toBe(true);
  }
  await expect.poll(async () => {
    const response = await page.request.get(`${GATEWAY}/capabilities`, { headers: authorized() });
    const body = (await response.json()) as { capabilities?: { ref: string; usable: boolean }[] };
    return body.capabilities?.find((entry) => entry.ref === BOARD_MOVE_CAPABILITY)?.usable === true;
  }, { timeout: 180_000, intervals: [1_000] }).toBe(true);
}

test("the conversation board supports keyboard, mouse and touch moves with bounded saved view state", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await openApp(page);
  await say(page, "đặt bảng kanban");

  const board = page.locator("[data-widget-definition='canvas.board@1']").first().locator("[data-board-root='true']");
  await expect(board).toBeVisible({ timeout: 30_000 });
  await expect(board.locator("[data-board-mode='local']")).toBeVisible();
  const card = (id: string): Locator => board.locator(`[data-board-card='${id}']`);
  const instanceId = await instanceOf(board);
  const conversation = await conversationId(page);
  await expect(board.locator("[data-board-card][tabindex='0']")).toHaveCount(1);

  await card("schema").focus();
  await page.keyboard.press("Space");
  await expect(board.locator("[aria-live='polite']")).toContainText("Đã chọn thẻ");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toMatchObject({ order: { todo: [], doing: ["schema", "review"] } });
  await card("schema").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toMatchObject({ order: { todo: [], doing: ["review", "schema"] } });
  await expect(board.locator("[data-board-card='schema']").locator(".." )).toHaveAttribute("data-board-position", "1");

  const target = await board.locator("[data-board-column='todo']").boundingBox();
  const handle = board.locator("[data-board-drag-handle='schema']");
  if (target === null) throw new Error("the destination column is not laid out");
  const handleBox = await handle.boundingBox();
  if (handleBox === null) throw new Error("the card drag handle is not laid out");
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + 30);
  await page.mouse.up();
  await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toMatchObject({ order: { todo: ["schema"], doing: ["review"] } });

  const doing = board.locator("[data-board-column='doing']");
  const doingBox = await doing.boundingBox();
  if (doingBox === null) throw new Error("the destination column is not laid out");
  const reviewBox = await card("review").boundingBox();
  if (reviewBox === null) throw new Error("the existing destination card is not laid out");
  const touchTargetY = reviewBox.y + reviewBox.height + 4;
  await handle.dispatchEvent("pointerdown", { pointerId: 17, pointerType: "touch", button: 0, clientX: handleBox.x + 20, clientY: handleBox.y + 20 });
  await board.dispatchEvent("pointermove", { pointerId: 17, pointerType: "touch", clientX: doingBox.x + doingBox.width / 2, clientY: touchTargetY });
  await board.dispatchEvent("pointerup", { pointerId: 17, pointerType: "touch", clientX: doingBox.x + doingBox.width / 2, clientY: touchTargetY });
  await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toMatchObject({ order: { todo: [], doing: ["review", "schema"] } });

  await page.screenshot({ path: testInfo.outputPath("kanban-board-1280-dark.png"), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe("dark");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("kanban-board-390-dark.png"), fullPage: false });
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe("light");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const motion = await card("schema").evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(motion.split(",").every((part) => Number.parseFloat(part) === 0)).toBe(true);
});

test("a keyboard move started while the previous move's save is still being answered keeps its place", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openApp(page);
  await say(page, "đặt bảng kanban");
  const board = page.locator("[data-widget-definition='canvas.board@1']").last().locator("[data-board-root='true']");
  await expect(board).toBeVisible({ timeout: 30_000 });
  const card = (id: string): Locator => board.locator(`[data-board-card='${id}']`);
  const instanceId = await instanceOf(board);
  const conversation = await conversationId(page);

  // The node saves the first move at once, but its answer reaches the page only after the person has picked the card up
  // again and moved it: the page then adopts the node's view in the middle of the second move.
  let release: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => { release = resolve; });
  let held = 0;
  await page.route(`**/conversations/*/widgets/${instanceId}/actions`, async (route) => {
    if (held > 0) { await route.continue(); return; }
    held += 1;
    const response = await route.fetch();
    await answered;
    await route.fulfill({ response });
  });

  // Which of the node's answers the board is drawn from.
  const widget = page.locator(`[data-widget-instance='${instanceId}']`);
  const revision = async (): Promise<number> => Number(await widget.getAttribute("data-widget-revision"));
  const before = await revision();

  await card("schema").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toMatchObject({ order: { todo: [], doing: ["schema", "review"] } });
  await card("schema").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await expect(card("schema").locator("..")).toHaveAttribute("data-board-position", "1");
  // The answer to the first move is still held: the page has not drawn it yet, so it arrives in the middle of this move.
  expect(held, "the first move's answer is the one held back").toBe(1);
  expect(await revision(), "the board has not adopted the first move's answer before the second move").toBe(before);
  release();
  await expect.poll(revision, { timeout: 10_000 }).toBeGreaterThan(before);
  // Adopting that answer leaves the card where the person moved it, still picked up.
  await expect(card("schema").locator("..")).toHaveAttribute("data-board-position", "1");
  await expect(card("schema")).toBeFocused();
  await page.keyboard.press("Space");
  await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toMatchObject({ order: { todo: [], doing: ["review", "schema"] } });
  await expect(card("schema").locator("..")).toHaveAttribute("data-board-position", "1");
});

test("a bound board confirms a capability move and rolls back one refused by policy", async ({ page }) => {
  test.setTimeout(240_000);
  await boardServiceReady(page);
  const preferencesResponse = await page.request.get(`${GATEWAY}/preferences`, { headers: authorized() });
  expect(preferencesResponse.ok()).toBe(true);
  const preferences = (await preferencesResponse.json()) as { preferences?: { key: string; value: unknown }[] };
  const originalPolicy = preferences.preferences?.find((entry) => entry.key === "execution.policy")?.value;
  if (typeof originalPolicy !== "object" || originalPolicy === null || Array.isArray(originalPolicy)) throw new Error("the node did not report its execution policy");

  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openApp(page);
    await say(page, "đặt bảng kanban liên kết");
    const board = page.locator("[data-widget-definition='canvas.board@1']").last().locator("[data-board-root='true']");
    await expect(board).toBeVisible({ timeout: 30_000 });
    await expect(board.locator("[data-board-mode='local']")).toHaveCount(0);
    const instanceId = await instanceOf(board);
    const conversation = await conversationId(page);

    // A press on the drag handle without changing position is not an external move.
    await board.locator("[data-board-drag-handle='schema']").click();
    await page.waitForTimeout(250);
    expect(await heldState(page, conversation, instanceId)).toEqual({});
    await expect(board.locator("[data-board-status='done']")).toHaveCount(0);

    await board.locator("[data-board-card='schema']").focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await expect(board.locator("[data-board-status='done']")).toContainText(/Moved schema.*"doing":\["schema","review"\]/u, { timeout: 30_000 });
    await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toMatchObject({ order: { todo: [], doing: ["schema", "review"] } });

    const denied = await page.request.put(`${GATEWAY}/preferences/execution.policy`, {
      headers: authorized(),
      data: { value: { ...originalPolicy, prohibition: "all" } },
    });
    expect(denied.ok(), `policy update answered ${String(denied.status())}`).toBe(true);

    await board.locator("[data-board-card='schema']").focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Space");
    await expect(board.locator("[data-board-status='refused']")).toContainText(/policy|chính sách|từ chối/iu, { timeout: 30_000 });
    await expect.poll(() => heldState(page, conversation, instanceId), { timeout: 10_000 }).toMatchObject({ order: { todo: [], doing: ["schema", "review"] } });
  } finally {
    const restored = await page.request.put(`${GATEWAY}/preferences/execution.policy`, { headers: authorized(), data: { value: originalPolicy } });
    expect(restored.ok(), `policy restore answered ${String(restored.status())}`).toBe(true);
  }
});

test("the Widget Library renders the interactive board fixture read-only", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-developer")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-developer").click();
  await page.locator("[data-widget-library-open='develop']").click();
  await page.locator("[data-widget-card='canvas.board@1']").click();
  const preview = page.locator("[data-widget-preview='canvas.board@1']");
  await expect(preview.locator("[data-board-root='true']")).toBeVisible({ timeout: 20_000 });
  await expect(preview.locator("[data-board-mode='local']")).toBeVisible();
  await expect(preview.locator("[data-board-card]").first()).toBeVisible();
});
