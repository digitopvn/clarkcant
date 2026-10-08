import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * Choosing who answers Clark's decisions from Settings → AI & Routing, as a person does it.
 *
 * The node is started with no decision provider, model, account id or key in its environment (`playwright.config.ts`
 * blanks them), so it follows the environment to TypeSafe with no key. Every choice and key here goes through the
 * node's own decision provider routes, and the card redraws from what the node answered: what these journeys prove is
 * that each provider can be chosen, each state is said with what to do about it, a key is saved and removed, and a
 * typed key never comes back into the page or the node's answer.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const CLOUDFLARE_TOKEN = "e2e-decision-cloudflare-token-7f3a";
const OPENROUTER_KEY = "e2e-decision-openrouter-key-91c2";
const TYPESAFE_KEY = "e2e-decision-typesafe-key-55d0";

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("the node's identity file has no local token");
  return parsed.localToken;
}

async function openDecisionProvider(page: Page): Promise<Locator> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-settings="true"]').click();
  await page.locator("#cc-tab-ai").click();
  const section = page.locator('[data-decision-provider="true"]');
  await expect(section).toBeVisible({ timeout: 15_000 });
  await expect(section.locator("[data-decision-current]")).toBeVisible({ timeout: 15_000 });
  return section;
}

/** The node's own answer, read as text so a test can search it for a key. */
async function nodeView(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${GATEWAY}/decision-provider`, { headers: { authorization: `Bearer ${token()}` } });
  expect(response.ok()).toBe(true);
  return response.text();
}

/** The shared node keeps the choice and the keys: put both back so the specs after this one see a node that chose nothing. */
test.afterEach(async ({ request }) => {
  const headers = { authorization: `Bearer ${token()}` };
  await request.put(`${GATEWAY}/decision-provider`, { headers, data: { selection: null } });
  for (const provider of ["typesafe", "cloudflare", "openrouter"]) {
    // A 404 says there was nothing to remove, which is the state this wants.
    await request.delete(`${GATEWAY}/decision-provider/credential/${provider}`, { headers });
  }
  await request.put(`${GATEWAY}/preferences/experience.language`, { headers, data: { value: "vi" } });
});

test("each provider is chosen, Cloudflare says what it is missing, and its key is saved and removed without being shown", async ({
  page,
  request,
}) => {
  const section = await openDecisionProvider(page);
  const current = section.locator("[data-decision-current]");
  const segment = (value: string): Locator => section.locator(`[data-segmented="decision-provider"] [data-segment="${value}"]`);

  // Following the environment, which names nothing: TypeSafe by default, with no key.
  await expect(current).toHaveAttribute("data-decision-selected-by", "default");
  await expect(current).toHaveAttribute("data-decision-status", "no-credential");
  await expect(segment("environment")).toHaveAttribute("aria-pressed", "true");
  await expect(section.locator("[data-decision-applies]")).toContainText("Áp dụng từ quyết định tiếp theo");

  // TypeSafe, chosen in Settings.
  await segment("typesafe").click();
  await expect(current).toHaveAttribute("data-decision-selected-by", "settings", { timeout: 10_000 });
  await expect(current).toHaveAttribute("data-decision-active-provider", "typesafe");
  await expect(section.locator('[data-decision-outcome="selection"]')).toContainText("Đã lưu");

  // Cloudflare with no account id anywhere is misconfigured, and says so with what to do about it.
  await segment("cloudflare").click();
  await expect(current).toHaveAttribute("data-decision-active-provider", "cloudflare", { timeout: 10_000 });
  await expect(current).toHaveAttribute("data-decision-status", "misconfigured");
  // The reason is worded in the person's language from the node's code; the node's English sentence never appears.
  await expect(current.locator("[data-decision-hint]")).toContainText("Cấu hình này chưa dùng được: Cloudflare cần một account id (CLOUDFLARE_ACCOUNT_ID)");
  await expect(current.locator("[data-decision-hint]")).toContainText("Nhập account id Cloudflare");
  await expect(current.locator("[data-decision-hint]")).not.toContainText("decision provider needs");
  await expect(section.locator('[data-decision-account-source="none"]')).toBeVisible();

  // The account id fixes that; the provider then needs only its key.
  await section.locator("[data-decision-account-input]").fill(ACCOUNT_ID);
  await section.locator("[data-decision-account-save]").click();
  await expect(current).toHaveAttribute("data-decision-status", "no-credential", { timeout: 10_000 });
  await expect(section.locator('[data-decision-account-source="settings"]')).toBeVisible();

  // The other Clef model is one press away.
  await section.locator('[data-segmented="decision-cloudflare-model"] [data-segment="clef"]').click();
  await expect(current.locator(".cc-list-title")).toContainText("clef", { timeout: 10_000 });

  // Saving the token makes it ready; the card says where the key comes from and never what it is.
  const cloudflare = section.locator('[data-decision-key-card="cloudflare"]');
  await cloudflare.locator('[data-decision-key-input="cloudflare"]').fill(CLOUDFLARE_TOKEN);
  await cloudflare.locator('[data-decision-key-save="cloudflare"]').click();
  await expect(cloudflare).toHaveAttribute("data-decision-key-source", "vault", { timeout: 10_000 });
  await expect(current).toHaveAttribute("data-decision-status", "ready");
  await expect(current.locator("[data-decision-hint]")).toContainText("api.cloudflare.com");
  await expect(cloudflare.locator('[data-decision-key-input="cloudflare"]')).toHaveValue("");
  await expect(page.locator("body")).not.toContainText(CLOUDFLARE_TOKEN);
  expect(await page.content()).not.toContain(CLOUDFLARE_TOKEN);
  expect(await nodeView(request)).not.toContain(CLOUDFLARE_TOKEN);

  // Removed, it is gone from the vault and the provider has no key again.
  await cloudflare.locator('[data-decision-key-remove="cloudflare"]').click();
  await expect(cloudflare).toHaveAttribute("data-decision-key-source", "none", { timeout: 10_000 });
  await expect(cloudflare.locator('[data-decision-outcome="key:cloudflare"]')).toContainText("Đã gỡ khoá");
  await expect(current).toHaveAttribute("data-decision-status", "no-credential");
  await expect(cloudflare.locator("[data-decision-key-remove]")).toHaveCount(0);

  // OpenRouter needs a pinned slug before anything is saved, and refuses its own router.
  await segment("openrouter").click();
  await expect(section.locator("[data-decision-model-needed]")).toBeVisible();
  await expect(current).toHaveAttribute("data-decision-active-provider", "cloudflare");
  const slug = section.locator("[data-decision-openrouter-model]");
  await slug.fill("openrouter/auto");
  await section.locator("[data-decision-model-use]").click();
  await expect(section.locator('[data-decision-outcome="selection"]')).toHaveAttribute("data-result", "failed", { timeout: 10_000 });
  await expect(section.locator('[data-decision-outcome="selection"]')).toContainText("Node không nhận lựa chọn này");
  await expect(section.locator('[data-decision-outcome="selection"]')).not.toContainText("router");
  await expect(current).toHaveAttribute("data-decision-active-provider", "cloudflare");
  await slug.fill("typesafe/jev-1.13");
  await section.locator("[data-decision-model-use]").click();
  await expect(current).toHaveAttribute("data-decision-active-provider", "openrouter", { timeout: 10_000 });
  await expect(current).toHaveAttribute("data-decision-status", "no-credential");
  const openrouter = section.locator('[data-decision-key-card="openrouter"]');
  await openrouter.locator('[data-decision-key-input="openrouter"]').fill(OPENROUTER_KEY);
  await openrouter.locator('[data-decision-key-save="openrouter"]').click();
  await expect(current).toHaveAttribute("data-decision-status", "ready", { timeout: 10_000 });
  await expect(current.locator("[data-decision-hint]")).toContainText("openrouter.ai");
  expect(await page.content()).not.toContain(OPENROUTER_KEY);
  expect(await nodeView(request)).not.toContain(OPENROUTER_KEY);

  // Back to following the environment.
  await segment("environment").click();
  await expect(current).toHaveAttribute("data-decision-selected-by", "default", { timeout: 10_000 });
  await expect(current).toHaveAttribute("data-decision-active-provider", "typesafe");
});

test("a key is saved and removed with the keyboard alone", async ({ page }) => {
  const section = await openDecisionProvider(page);
  const typesafe = section.locator('[data-decision-key-card="typesafe"]');
  const field = typesafe.locator('[data-decision-key-input="typesafe"]');

  await field.focus();
  await page.keyboard.type(TYPESAFE_KEY);
  await page.keyboard.press("Enter");
  await expect(typesafe).toHaveAttribute("data-decision-key-source", "vault", { timeout: 10_000 });
  await expect(section.locator("[data-decision-current]")).toHaveAttribute("data-decision-status", "ready");
  await expect(field).toHaveValue("");
  expect(await page.content()).not.toContain(TYPESAFE_KEY);

  // With the field empty its Save is disabled, so Tab goes straight to Remove.
  await field.focus();
  await page.keyboard.press("Tab");
  const remove = typesafe.locator('[data-decision-key-remove="typesafe"]');
  await expect(remove).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(typesafe).toHaveAttribute("data-decision-key-source", "none", { timeout: 10_000 });

  // The selector is reachable and pressable from the keyboard too.
  const segment = section.locator('[data-segmented="decision-provider"] [data-segment="typesafe"]');
  await segment.focus();
  await page.keyboard.press("Enter");
  await expect(section.locator("[data-decision-current]")).toHaveAttribute("data-decision-selected-by", "settings", { timeout: 10_000 });
});

test("on a phone, in English, the card fits the screen and every control is reachable", async ({ browser, request }) => {
  await request.put(`${GATEWAY}/preferences/experience.language`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { value: "en" },
  });
  await request.put(`${GATEWAY}/decision-provider`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { selection: { provider: "cloudflare", model: "clef-flash" } },
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    storageState: { cookies: [], origins: [{ origin: new URL(test.info().project.use.baseURL ?? "").origin, localStorage: [{ name: "cc_onboarded", value: "1" }] }] },
  });
  const page = await context.newPage();
  const section = await openDecisionProvider(page);
  await expect(section.locator("h3")).toHaveText("Decision provider", { timeout: 10_000 });
  await expect(section.locator("[data-decision-current]")).toHaveAttribute("data-decision-status", "misconfigured");
  await expect(section.locator("[data-decision-hint]")).toContainText(
    "This configuration can't be used: Cloudflare needs an account id (CLOUDFLARE_ACCOUNT_ID). Enter the Cloudflare account id below",
  );
  const controls = [
    ...(await section.locator('[data-segmented="decision-provider"] button').all()),
    section.locator("[data-decision-account-input]"),
    section.locator("[data-decision-account-save]"),
    section.locator('[data-decision-key-input="cloudflare"]'),
    section.locator('[data-decision-key-save="cloudflare"]'),
  ];
  expect(controls.length).toBe(8);
  for (const control of controls) {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await context.close();
});
