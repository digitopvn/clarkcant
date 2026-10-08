import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * Signing in to pi's providers from Settings → AI & Routing, as a person does it.
 *
 * The node runs the fake provider list `/login` uses: `fake` is signed in from the environment and takes only an API
 * key, `fake-other` starts signed out and offers an account sign-in (a page to open, then a code) as well as a key. The
 * sign-in is the node's own, through the same routes and registry `/login` follows, so what these journeys prove is
 * the one capability reached from Settings: the ways in pi advertises, where a credential comes from, a typed value
 * never shown back, and the model catalogue read again once a provider signs in.
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

async function openProviders(page: Page) {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-settings="true"]').click();
  await page.locator("#cc-tab-ai").click();
  const section = page.locator('[data-provider-sign-in="true"]');
  await expect(section).toBeVisible({ timeout: 15_000 });
  return section;
}

/** The shared node keeps who is signed in: put `fake-other` back to signed out for the specs after this one. */
test.afterEach(async ({ request }) => {
  const headers = { authorization: `Bearer ${token()}` };
  await request.post(`${GATEWAY}/providers/fake-other/sign-out`, { headers, data: {} });
  await request.put(`${GATEWAY}/preferences/experience.language`, { headers, data: { value: "vi" } });
});

test("a provider is signed in to with an API key from Settings, the catalogue is read again, and it is signed out of", async ({ page }) => {
  const section = await openProviders(page);
  const other = section.locator('[data-provider-id="fake-other"]');
  await expect(other).toHaveAttribute("data-configured", "false");

  await other.getByRole("button", { name: "Dùng API key" }).click();
  const field = other.locator('.cc-sign-in input[type="password"]');
  await expect(field).toBeVisible({ timeout: 10_000 });
  await field.fill("e2e-settings-key");
  // Counted from the answer on, so the read the tab made when it opened is not mistaken for the refresh.
  let catalogueReads = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && new URL(request.url()).pathname === "/model") catalogueReads += 1;
  });
  await other.getByRole("button", { name: "Gửi" }).click();
  await expect(other.locator(".cc-sign-in .cc-command-status")).toContainText("Đã đăng nhập", { timeout: 10_000 });
  // The model catalogue beside this section is read again once a provider signs in.
  await expect.poll(() => catalogueReads, { timeout: 10_000 }).toBeGreaterThan(0);

  // The list is read again too: now signed in, with a credential pi stored, which is the one kind that can be removed.
  await expect(other).toHaveAttribute("data-configured", "true", { timeout: 10_000 });
  await expect(other).toHaveAttribute("data-source", "stored");
  await expect(other.locator("[data-provider-source-note]")).toContainText("pi đã lưu");
  await expect(other.getByRole("button", { name: "Thay API key" })).toBeVisible();
  // What was typed never comes back into the page.
  await expect(page.locator("body")).not.toContainText("e2e-settings-key");

  await other.getByRole("button", { name: "Đăng xuất" }).click();
  await expect(other.locator(".cc-command-status").first()).toContainText("Đã đăng xuất", { timeout: 10_000 });
  await expect(other).toHaveAttribute("data-configured", "false", { timeout: 10_000 });
});

test("an account sign-in is followed with the keyboard alone: the provider's page, then its code", async ({ page }) => {
  const section = await openProviders(page);
  const other = section.locator('[data-provider-id="fake-other"]');

  const account = other.getByRole("button", { name: "Đăng nhập tài khoản" });
  await account.focus();
  await page.keyboard.press("Enter");

  // The provider's own page, opened by the person, never by the app.
  const link = other.locator('.cc-sign-in a[href="https://example.invalid/fake-sign-in"]');
  await expect(link).toBeVisible({ timeout: 10_000 });
  const code = other.locator('.cc-sign-in input[type="text"]');
  await expect(code).toBeVisible({ timeout: 10_000 });
  await code.focus();
  await page.keyboard.type("e2e-oauth-code");
  await page.keyboard.press("Enter");

  await expect(other.locator(".cc-sign-in .cc-command-status")).toContainText("Đã đăng nhập", { timeout: 10_000 });
  await expect(other).toHaveAttribute("data-configured", "true", { timeout: 10_000 });
  await expect(page.locator("body")).not.toContainText("e2e-oauth-code");
});

test("a key from the environment offers no account sign-in pi does not advertise, and no sign-out, and says why", async ({ page }) => {
  const section = await openProviders(page);
  const fake = section.locator('[data-provider-id="fake"]');
  await expect(fake).toHaveAttribute("data-source", "environment");
  await expect(fake.locator("[data-provider-source-note]")).toContainText("biến môi trường");
  await expect(fake.locator("[data-provider-source-note]")).toContainText("Không đăng xuất được ở đây");
  await expect(fake.locator('[data-provider-method="api_key"]')).toBeVisible();
  // `fake` has no sign-in of its own, so there is no account button to press.
  await expect(fake.locator('[data-provider-method="oauth"]')).toHaveCount(0);
  await expect(fake.locator("[data-provider-sign-out]")).toHaveCount(0);
});

test("a node with no pi to sign in through says so, and an unreadable list can be read again", async ({ page }) => {
  let refusal: { status: number; code: string; message: string } = {
    status: 503,
    code: "PROVIDER_AUTH_UNAVAILABLE",
    message: "This node has no pi runtime to sign in through, so there are no providers to sign in to here.",
  };
  await page.route("**/providers/auth", (route) =>
    route.fulfill({ status: refusal.status, contentType: "application/json", body: JSON.stringify({ code: refusal.code, message: refusal.message }) }),
  );
  const section = await openProviders(page);
  await expect(section.locator('[data-provider-sign-in-state="unavailable"]')).toContainText("không có pi", { timeout: 10_000 });

  // A different refusal is a failure, with the node's reason and a way to try again; the next read succeeds.
  refusal = { status: 502, code: "PROVIDER_AUTH_FAILED", message: "pi could not list its providers: e2e" };
  await page.locator(".cc-modal-done").click();
  await page.locator('[data-settings="true"]').click();
  await page.locator("#cc-tab-ai").click();
  const failed = section.locator('[data-provider-sign-in-state="failed"]');
  await expect(failed).toContainText("pi could not list its providers: e2e", { timeout: 10_000 });
  await page.unroute("**/providers/auth");
  await failed.getByRole("button", { name: "Thử lại" }).click();
  await expect(section.locator('[data-provider-id="fake-other"]')).toBeVisible({ timeout: 10_000 });
});

test("on a phone, in English, the rows fit the screen and every way in is reachable", async ({ browser, request }) => {
  await request.put(`${GATEWAY}/preferences/experience.language`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { value: "en" },
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    storageState: { cookies: [], origins: [{ origin: new URL(test.info().project.use.baseURL ?? "").origin, localStorage: [{ name: "cc_onboarded", value: "1" }] }] },
  });
  const page = await context.newPage();
  const section = await openProviders(page);
  await expect(section.locator("h3")).toHaveText("Provider sign-in", { timeout: 10_000 });
  const other = section.locator('[data-provider-id="fake-other"]');
  const account = other.getByRole("button", { name: "Sign in with account" });
  const key = other.getByRole("button", { name: "Use an API key" });
  await expect(account).toBeVisible();
  await expect(key).toBeVisible();
  for (const button of [account, key]) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await expect(section.locator('[data-provider-id="fake"] [data-provider-source-note]')).toContainText("environment (.env or the shell)");
  await context.close();
});
