import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The model picker, as a person uses it: `/model` answers in the conversation with a host card that lists what the node
 * can run, marks which providers are signed in, and switches the model only once the person confirms — and the next
 * turn runs on it. After a sign-in on the `/login` card, the same picker is offered for the provider just signed in to.
 *
 * The node runs the fake provider list: `fake` is signed in from the environment, `fake-other` starts signed out. The
 * fixture answers "model nào đang trả lời" with a real model turn that reads the stored choice, so the reply names the
 * model the next turn actually ran on.
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

async function gateway(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${GATEWAY}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
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

/** The reply the fixture gives to "which model answers", naming the model the turn ran on. */
async function nextTurnModel(page: Page): Promise<string> {
  const replies = page.locator('.cc-row[data-role="assistant"]', { hasText: "Fixture: lượt này chạy trên" });
  // Waits for this turn's own reply: an earlier one in the same conversation would otherwise be read in its place.
  const before = await replies.count();
  await send(page, "model nào đang trả lời");
  await expect(replies).toHaveCount(before + 1, { timeout: 20_000 });
  const text = (await replies.last().textContent()) ?? "";
  return /chạy trên (\S+?)\.?$/u.exec(text.trim())?.[1] ?? text;
}

/** Answers a GET the page makes with what the node said, changed; anything else goes to the node untouched. */
function rewriteGet(change: (body: Record<string, unknown>) => Record<string, unknown>) {
  return async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    return route.fulfill({ response, json: change(body) });
  };
}

/** Back to how the suite found the node: `fake-other` signed out, and the model the fixture node starts with. */
test.afterEach(async () => {
  await gateway("POST", "/providers/fake-other/sign-out", {});
  await gateway("POST", "/model", { provider: "fake", id: "fake-model" });
});

test("/model is offered after a slash, opens without changing anything, and the confirmed choice answers the next turn", async ({ page }) => {
  await openApp(page);
  const composer = page.locator("[data-composer]");
  await composer.click();
  await page.keyboard.type("/mod");
  await expect(page.locator('[data-reference-option="model"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("/model ");
  await page.keyboard.press("Enter");

  const card = lastCard(page, "model");
  await expect(card).toBeVisible({ timeout: 20_000 });
  const picker = card.locator(".cc-model-picker[data-state='ready']");
  await expect(picker).toBeVisible({ timeout: 10_000 });
  // Opening the card changed nothing: the model the next turn runs on is still the one it was.
  const before = await nextTurnModel(page);
  expect(before).toBe("fake/fake-model");

  // Sign-in status per provider, and the search narrows the list.
  await expect(picker.locator('[data-model="fake/fake-model"] .cc-badge')).toHaveText("đã đăng nhập");
  await expect(picker.locator('[data-model="fake-other/fake-other-model"] .cc-badge')).toHaveText("chưa đăng nhập");
  await picker.getByRole("searchbox", { name: "Tìm model" }).fill("large");
  await expect(picker.locator("[data-model]")).toHaveCount(1);

  await picker.locator('[data-model="fake/fake-model-large"] input[type="radio"]').check();
  await picker.getByRole("button", { name: "Dùng model này" }).click();
  await expect(picker).toContainText("Đổi sang fake/fake-model-large?");
  // Cancel leaves everything as it was.
  await picker.getByRole("button", { name: "Hủy" }).click();
  await expect(picker.getByRole("button", { name: "Đổi model" })).toHaveCount(0);

  await picker.getByRole("button", { name: "Dùng model này" }).click();
  await picker.getByRole("button", { name: "Đổi model" }).click();
  await expect(picker.locator(".cc-command-status[data-result='done']")).toHaveText(
    "Đã đổi sang fake/fake-model-large. Model này trả lời từ tin nhắn tiếp theo.",
    { timeout: 10_000 },
  );

  expect(await nextTurnModel(page)).toBe("fake/fake-model-large");
});

test("a signed-out provider's model is shown but cannot be applied until it signs in", async ({ page }) => {
  await openApp(page);
  await send(page, "/model fake-other");
  const picker = lastCard(page, "model").locator(".cc-model-picker[data-state='ready']");
  await expect(picker).toBeVisible({ timeout: 20_000 });
  await expect(picker.getByRole("searchbox", { name: "Tìm model" })).toHaveValue("fake-other");

  await picker.locator('[data-model="fake-other/fake-other-model"] input[type="radio"]').check();
  await expect(picker).toContainText("fake-other chưa đăng nhập, nên model của nó chưa trả lời được. Đăng nhập bằng /login trước.");
  await expect(picker.getByRole("button", { name: "Dùng model này" })).toBeDisabled();
  expect(await nextTurnModel(page)).toBe("fake/fake-model");
});

test("with no provider signed in, nothing can be applied, and the picker says why", async ({ page }) => {
  await page.route(
    "**/providers/auth",
    rewriteGet((body) => ({ providers: (body.providers as Record<string, unknown>[]).map((entry) => ({ ...entry, configured: false, source: undefined })) })),
  );
  await openApp(page);
  await send(page, "/model");
  const picker = lastCard(page, "model").locator(".cc-model-picker[data-state='ready']");
  await expect(picker).toBeVisible({ timeout: 20_000 });
  await expect(picker.locator(".cc-badge", { hasText: "đã đăng nhập" })).toHaveCount(0);
  await picker.locator('[data-model="fake/fake-model-large"] input[type="radio"]').check();
  await expect(picker.getByRole("button", { name: "Dùng model này" })).toBeDisabled();
  await expect(picker).toContainText("fake chưa đăng nhập");
});

test("a catalogue that cannot be read says so with a retry, and an empty one says what to do", async ({ page }) => {
  let failing = true;
  await page.route("**/model", async (route) => {
    if (route.request().method() !== "GET" || !failing) return route.fallback();
    const response = await route.fetch();
    return route.fulfill({ response, status: 503, json: { error: { code: "UNAVAILABLE", message: "catalogue offline" } } });
  });
  await openApp(page);
  await send(page, "/model");
  const card = lastCard(page, "model");
  const failed = card.locator(".cc-model-picker[data-state='failed']");
  await expect(failed).toBeVisible({ timeout: 20_000 });
  await expect(failed).toContainText("Không đọc được danh sách model");
  await expect(failed.locator("[role='alert']")).toBeVisible();

  failing = false;
  await failed.getByRole("button", { name: "Thử lại" }).click();
  await expect(card.locator(".cc-model-picker[data-state='ready'] [data-model]").first()).toBeVisible({ timeout: 10_000 });

  await page.unroute("**/model");
  await page.route("**/model", rewriteGet((body) => ({ ...body, catalogue: [] })));
  await send(page, "/model");
  const empty = lastCard(page, "model").locator(".cc-model-picker[data-state='ready']");
  await expect(empty).toContainText("Node này chưa có model nào để chọn", { timeout: 20_000 });
  await expect(empty.getByRole("button", { name: "Dùng model này" })).toHaveCount(0);
});

test("the picker fits a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp(page);
  await send(page, "/model");
  const picker = lastCard(page, "model").locator(".cc-model-picker[data-state='ready']");
  await expect(picker).toBeVisible({ timeout: 20_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Search and provider stack rather than squeeze side by side, and the apply button stays inside the card.
  const search = await picker.getByRole("searchbox", { name: "Tìm model" }).boundingBox();
  const provider = await picker.getByRole("combobox", { name: "Provider" }).boundingBox();
  expect(provider?.y ?? 0).toBeGreaterThan((search?.y ?? 0) + (search?.height ?? 0) - 1);
  const card = await lastCard(page, "model").boundingBox();
  const apply = await picker.getByRole("button", { name: "Dùng model này" }).boundingBox();
  expect((apply?.x ?? 0) + (apply?.width ?? 0)).toBeLessThanOrEqual((card?.x ?? 0) + (card?.width ?? 0) + 1);
});

/** Signs `fake-other` in from a fresh `/login` card, by key or by the code a provider page shows. */
async function signInOther(page: Page, method: "key" | "oauth") {
  await send(page, "/login");
  const card = lastCard(page, "login");
  await expect(card).toBeVisible({ timeout: 20_000 });
  const row = card.locator('[data-row-id="fake-other"]');
  if (method === "key") {
    await row.getByRole("button", { name: "Dùng API key" }).click();
    const field = row.locator('.cc-sign-in input[type="password"]');
    await expect(field).toBeVisible({ timeout: 10_000 });
    await field.fill("e2e-picker-key");
  } else {
    await row.getByRole("button", { name: "Đăng nhập tài khoản" }).click();
    await expect(row.locator(".cc-sign-in a", { hasText: "Mở trang đăng nhập" })).toBeVisible({ timeout: 10_000 });
    const field = row.locator('.cc-sign-in input[type="text"]');
    await expect(field).toBeVisible({ timeout: 10_000 });
    await field.fill("e2e-picker-code");
  }
  await row.getByRole("button", { name: "Gửi" }).click();
  return row;
}

test("after a key sign-in, the /login card names the provider and offers its models; the chosen one answers the next turn", async ({ page }) => {
  await openApp(page);
  const row = await signInOther(page, "key");

  await expect(row.locator(".cc-sign-in > .cc-command-status")).toHaveText("Đã đăng nhập Fake Other.", { timeout: 10_000 });
  // What was typed never comes back into the page.
  await expect(page.locator("body")).not.toContainText("e2e-picker-key");
  const after = row.locator("[data-after-sign-in='ready']");
  await expect(after).toContainText("Fake Other có 1 model", { timeout: 10_000 });
  // Signing in changed nothing about the model in use.
  expect(await nextTurnModel(page)).toBe("fake/fake-model");

  await after.getByRole("button", { name: "Chọn model của Fake Other" }).click();
  const picker = row.locator(".cc-model-picker[data-state='ready']");
  await expect(picker).toBeVisible({ timeout: 10_000 });
  // The picker opens on the provider just signed in to.
  await expect(picker.locator("[data-model]")).toHaveCount(1);
  await expect(picker.locator('[data-model="fake-other/fake-other-model"] .cc-badge')).toHaveText("đã đăng nhập");
  await picker.locator('[data-model="fake-other/fake-other-model"] input[type="radio"]').check();
  await picker.getByRole("button", { name: "Dùng model này" }).click();
  await picker.getByRole("button", { name: "Đổi model" }).click();
  await expect(picker.locator(".cc-command-status[data-result='done']")).toContainText("Đã đổi sang fake-other/fake-other-model", { timeout: 10_000 });

  expect(await nextTurnModel(page)).toBe("fake-other/fake-other-model");
});

test("after an account sign-in, keeping the current model changes nothing", async ({ page }) => {
  await openApp(page);
  const row = await signInOther(page, "oauth");
  await expect(row.locator(".cc-sign-in > .cc-command-status")).toHaveText("Đã đăng nhập Fake Other.", { timeout: 10_000 });
  const after = row.locator("[data-after-sign-in='ready']");
  const keep = after.getByRole("button", { name: "Giữ model hiện tại" });
  await expect(keep).toBeVisible({ timeout: 10_000 });
  await keep.click();
  await expect(after).toContainText("Vẫn dùng fake/fake-model. Không có gì thay đổi.");
  await expect(row.locator(".cc-model-picker")).toHaveCount(0);
  expect(await nextTurnModel(page)).toBe("fake/fake-model");
});

test("a provider with no models after sign-in is said plainly, with a way to check again", async ({ page }) => {
  await page.route(
    "**/model",
    rewriteGet((body) => ({ ...body, catalogue: (body.catalogue as { id: string }[]).filter((entry) => entry.id !== "fake-other") })),
  );
  await openApp(page);
  const row = await signInOther(page, "key");
  await expect(row.locator(".cc-sign-in > .cc-command-status")).toHaveText("Đã đăng nhập Fake Other.", { timeout: 10_000 });
  const none = row.locator("[data-after-sign-in='no-models']");
  await expect(none).toContainText("Fake Other chưa có model nào Clark chạy được", { timeout: 10_000 });
  await expect(row.getByRole("button", { name: "Chọn model của Fake Other" })).toHaveCount(0);

  await page.unroute("**/model");
  await none.getByRole("button", { name: "Kiểm tra lại" }).click();
  await expect(row.locator("[data-after-sign-in='ready']")).toBeVisible({ timeout: 10_000 });
});

test("a failed sign-in offers no model to choose", async ({ page }) => {
  let signInId: string | undefined;
  await page.route("**/providers/sign-ins/*/answer", async (route) => {
    signInId = /sign-ins\/([^/]+)\/answer/u.exec(route.request().url())?.[1];
    // The node refused the answer: what a provider rejecting a key comes back as.
    const response = await route.fetch({ method: "GET", url: route.request().url().replace(/\/answer$/u, "") });
    const body = (await response.json()) as Record<string, unknown>;
    return route.fulfill({ response, json: { ...body, state: "failed", prompt: undefined, error: "The key was refused." } });
  });
  try {
    await openApp(page);
    const row = await signInOther(page, "key");
    await expect(row.locator(".cc-sign-in > .cc-command-status[data-result='failed']")).toContainText("Đăng nhập không thành công", { timeout: 10_000 });
    await expect(row.locator(".cc-after-sign-in")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Chọn model của Fake Other" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("e2e-picker-key");
  } finally {
    if (signInId !== undefined) await gateway("POST", `/providers/sign-ins/${signInId}/cancel`, {});
  }
});

test("a sign-in from Settings offers the same next step: that provider's models, applied only once confirmed", async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-settings="true"]').click();
  await page.locator("#cc-tab-ai").click();
  const row = page.locator('[data-provider-sign-in="true"] [data-provider-id="fake-other"]');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole("button", { name: "Dùng API key" }).click();
  const field = row.locator('.cc-sign-in input[type="password"]');
  await expect(field).toBeVisible({ timeout: 10_000 });
  await field.fill("e2e-settings-picker-key");
  await row.getByRole("button", { name: "Gửi" }).click();

  await expect(row.locator(".cc-sign-in > .cc-command-status")).toHaveText("Đã đăng nhập Fake Other.", { timeout: 10_000 });
  const after = row.locator("[data-after-sign-in='ready']");
  await after.getByRole("button", { name: "Chọn model của Fake Other" }).click({ timeout: 10_000 });
  const picker = row.locator(".cc-model-picker[data-state='ready']");
  await picker.locator('[data-model="fake-other/fake-other-model"] input[type="radio"]').check();
  await picker.getByRole("button", { name: "Dùng model này" }).click();
  await picker.getByRole("button", { name: "Đổi model" }).click();
  await expect(picker.locator(".cc-command-status[data-result='done']")).toContainText("Đã đổi sang fake-other/fake-other-model", { timeout: 10_000 });
  await expect(page.locator("body")).not.toContainText("e2e-settings-picker-key");

  await page.keyboard.press("Escape");
  expect(await nextTurnModel(page)).toBe("fake-other/fake-other-model");
});

test("with the sign-ins unreadable in the page, the node itself refuses a signed-out provider's model and says why", async ({ page }) => {
  await page.route("**/providers/auth", (route) =>
    route.request().method() === "GET" ? route.fulfill({ status: 503, json: { code: "INTERNAL_ERROR", message: "offline" } }) : route.fallback(),
  );
  await openApp(page);
  await send(page, "/model fake-other");
  const picker = lastCard(page, "model").locator(".cc-model-picker[data-state='ready']");
  await expect(picker).toBeVisible({ timeout: 20_000 });
  // The page cannot tell the provider is signed out, so it lets the choice through; the node is where it stops.
  await picker.locator('[data-model="fake-other/fake-other-model"] input[type="radio"]').check();
  await picker.getByRole("button", { name: "Dùng model này" }).click();
  await picker.getByRole("button", { name: "Đổi model" }).click();
  const failed = picker.locator(".cc-command-status[data-result='failed']");
  await expect(failed).toHaveText(
    "Không đổi được sang fake-other/fake-other-model: chưa dùng được fake-other/fake-other-model vì chưa đăng nhập Fake Other; đăng nhập bằng /login rồi chọn lại. Model đang dùng vẫn giữ nguyên.",
    { timeout: 10_000 },
  );
  expect(await nextTurnModel(page)).toBe("fake/fake-model");
});

test("Settings says a saved model answers this conversation from the next message, and says why a signed-out one is refused", async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-settings="true"]').click();
  await page.locator("#cc-tab-ai").click();

  const model = page.locator('[data-search-input="model"]');
  await expect(model).toBeVisible({ timeout: 15_000 });
  await model.click();
  await model.fill("large");
  await model.press("Enter");
  await page.locator('[data-model-save="true"]').click();
  const status = page.locator('[data-model-status="true"]');
  await expect(status).toHaveText("Đã lưu fake/fake-model-large. Áp dụng cho hội thoại này từ tin nhắn tiếp theo.", { timeout: 10_000 });

  const provider = page.locator('[data-search-input="provider"]');
  await provider.click();
  await provider.fill("fake-other");
  await provider.press("Enter");
  await model.click();
  await model.fill("fake-other-model");
  await model.press("Enter");
  await page.locator('[data-model-save="true"]').click();
  await expect(status).toHaveText(
    "Không lưu được lựa chọn: chưa dùng được fake-other/fake-other-model vì chưa đăng nhập Fake Other; đăng nhập bằng /login rồi chọn lại.",
    { timeout: 10_000 },
  );

  await page.keyboard.press("Escape");
  expect(await nextTurnModel(page)).toBe("fake/fake-model-large");
});

test("by keyboard, focus lands on the next step after Cancel and Switch model, never on the page", async ({ page }) => {
  await openApp(page);
  await send(page, "/model large");
  const picker = lastCard(page, "model").locator(".cc-model-picker[data-state='ready']");
  await expect(picker).toBeVisible({ timeout: 20_000 });

  await picker.getByRole("searchbox", { name: "Tìm model" }).focus();
  await page.keyboard.press("Tab");
  await expect(picker.getByRole("combobox", { name: "Provider" })).toBeFocused();
  await page.keyboard.press("Tab");
  const radio = picker.locator('[data-model="fake/fake-model-large"] input[type="radio"]');
  await expect(radio).toBeFocused();
  await page.keyboard.press("Space");
  await expect(radio).toBeChecked();
  await page.keyboard.press("Tab");
  const use = picker.getByRole("button", { name: "Dùng model này" });
  await expect(use).toBeFocused();

  await page.keyboard.press("Enter");
  const confirm = picker.getByRole("button", { name: "Đổi model" });
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(picker.getByRole("button", { name: "Hủy" })).toBeFocused();
  await page.keyboard.press("Enter");
  // Cancel goes back to the button that asked the question.
  await expect(use).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Enter");
  // Switch model hands focus to the line that says what the choice came to.
  const done = picker.locator(".cc-command-status[data-result='done']");
  await expect(done).toHaveText("Đã đổi sang fake/fake-model-large. Model này trả lời từ tin nhắn tiếp theo.", { timeout: 10_000 });
  await expect(done).toBeFocused();

  expect(await nextTurnModel(page)).toBe("fake/fake-model-large");
});

test("a second sign-in on the same row is a fresh step, and by keyboard Keep and Choose each leave focus on what comes next", async ({ page }) => {
  await openApp(page);
  const row = await signInOther(page, "key");
  await expect(row.locator(".cc-sign-in > .cc-command-status")).toHaveText("Đã đăng nhập Fake Other.", { timeout: 10_000 });
  const keep = row.getByRole("button", { name: "Giữ model hiện tại" });
  await expect(keep).toBeVisible({ timeout: 10_000 });
  await keep.focus();
  await page.keyboard.press("Enter");
  const kept = row.locator(".cc-after-sign-in .cc-command-status[data-result='done']");
  await expect(kept).toHaveText("Vẫn dùng fake/fake-model. Không có gì thay đổi.");
  await expect(kept).toBeFocused();

  // Signed out elsewhere, then signed in again on the very same row.
  await gateway("POST", "/providers/fake-other/sign-out", {});
  await row.getByRole("button", { name: "Dùng API key" }).click();
  const field = row.locator('.cc-sign-in input[type="password"]');
  await expect(field).toBeVisible({ timeout: 10_000 });
  await field.fill("e2e-picker-key-again");
  await row.getByRole("button", { name: "Gửi" }).click();
  await expect(row.locator(".cc-sign-in > .cc-command-status")).toHaveText("Đã đăng nhập Fake Other.", { timeout: 10_000 });

  // The step asks again rather than opening on what was chosen after the first sign-in.
  const after = row.locator("[data-after-sign-in='ready']");
  await expect(after).toContainText("Fake Other có 1 model", { timeout: 10_000 });
  await expect(row.getByRole("button", { name: "Giữ model hiện tại" })).toBeVisible();
  await expect(row.locator(".cc-after-sign-in")).not.toContainText("Vẫn dùng");

  const choose = after.getByRole("button", { name: "Chọn model của Fake Other" });
  await choose.focus();
  await page.keyboard.press("Enter");
  const picker = row.locator(".cc-model-picker[data-state='ready']");
  await expect(picker).toBeVisible({ timeout: 10_000 });
  await expect(picker.getByRole("searchbox", { name: "Tìm model" })).toBeFocused();
  await expect(page.locator("body")).not.toContainText("e2e-picker-key-again");
});
