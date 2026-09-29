import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Choosing a theme a package provides, in the browser.
 *
 * The node's tests cover the registry and every lifecycle step; this covers what only a page can show: that choosing a
 * theme restyles the window without reloading it or touching the conversation, that removing the package draws Clark
 * Default and says so where the choice was made, and that restoring the package brings the chosen theme back without
 * choosing it again.
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
const PACKAGE = "com.example.theme-dusk";
const DUSK_REF = `package:${PACKAGE}#dusk`;
const DRAFT = "một tin nhắn đang viết dở";

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

async function prepare(request: APIRequestContext): Promise<void> {
  const headers = { authorization: `Bearer ${token()}` };
  // Every run starts from Clark Default, whatever an earlier spec or run left chosen.
  const reset = await request.put(`${GATEWAY}/preferences/experience.themeRef`, { headers, data: { value: "builtin:clark" } });
  expect(reset.ok(), `reset answered ${String(reset.status())}: ${await reset.text()}`).toBe(true);
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers })).json()) as { packages: { packageId: string }[] };
  if (listed.packages.some((entry) => entry.packageId === PACKAGE)) return;
  const installed = await request.post(`${GATEWAY}/packages/install`, {
    headers,
    data: { packageId: PACKAGE, version: "1.0.0", localDigest: "sha256:theme-dusk-digest" },
  });
  expect(installed.ok(), `install answered ${String(installed.status())}: ${await installed.text()}`).toBe(true);
}

/**
 * Bring the Appearance section into view and let the controls finish their colour transitions, so a screenshot shows
 * the theme that was applied rather than a frame halfway between two.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector("[data-theme-choice]")?.scrollIntoView({ block: "start" }));
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().filter((animation) => animation instanceof CSSTransition).length))
    .toBe(0);
}

/** The accent the page is drawn with right now, read from the root the way every component reads it. */
const accent = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cc-accent").trim().toUpperCase());

test("a package theme restyles the window in place, falls back when removed, and returns when restored", async ({
  page,
  request,
}) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await prepare(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });

  const clarkAccent = await accent(page);
  expect(clarkAccent).not.toBe("#7AA2F7");
  // A half-typed message, and a mark that only survives if the page is never reloaded.
  await page.locator("[data-composer]").fill(DRAFT);
  await page.evaluate(() => {
    (window as { ccThemeMark?: boolean }).ccThemeMark = true;
  });

  await page.locator("[data-settings='true']").click();
  const dusk = page.locator(`[data-theme-ref='${DUSK_REF}']`);
  await expect(dusk).toBeVisible({ timeout: 20_000 });
  // Where the theme comes from is on the entry itself: package, version, trust lane and digest.
  await expect(dusk.locator("[data-theme-provider='package']")).toContainText(`${PACKAGE}@1.0.0`);
  await expect(dusk.locator("[data-theme-provider='package']")).toContainText("sha256:theme");
  await expect(page.locator("[data-theme-ref='builtin:clark']")).toHaveAttribute("aria-pressed", "true");

  await dusk.click();
  await expect(dusk).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => accent(page), { timeout: 15_000 }).toBe("#7AA2F7");
  await expect(dusk).toHaveAttribute("data-theme-applied", "true");
  await settle(page);
  await page.screenshot({ path: join(EVIDENCE, "theme-picker-1280-dark.png") });

  // The colour scheme is a separate choice: switching it redraws the same theme's light colours.
  await page.locator('[data-theme-choice="light"]').click();
  await expect.poll(() => accent(page)).toBe("#2E7DE9");
  await settle(page);
  await page.screenshot({ path: join(EVIDENCE, "theme-picker-1280-light.png") });
  await page.locator('[data-theme-choice="dark"]').click();
  await expect.poll(() => accent(page)).toBe("#7AA2F7");

  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.screenshot({ path: join(EVIDENCE, "theme-picker-390-dark.png") });
  // Nothing on a phone-width panel is wider than the screen, however long the package id is.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 900 });

  // The page was restyled, not reloaded: the mark and the draft are both still there.
  expect(await page.evaluate(() => (window as { ccThemeMark?: boolean }).ccThemeMark)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-composer]")).toHaveValue(DRAFT);

  // Removing the package from Settings draws Clark Default at once, and the choice is kept.
  await page.locator("[data-settings='true']").click();
  await page.locator("#cc-tab-extensions").click();
  const row = page.locator(`[data-installed-package='${PACKAGE}']`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.locator("[data-package-uninstall]").click();
  await expect(page.locator("[data-package-status]")).toHaveAttribute("data-package-status", "done", { timeout: 20_000 });
  await expect.poll(() => accent(page), { timeout: 15_000 }).toBe(clarkAccent);

  await page.locator("#cc-tab-experience").click();
  const notice = page.locator("[data-theme-fallback='THEME_NOT_INSTALLED']");
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toContainText("Clark Default");
  await expect(notice).toContainText("vẫn được giữ");
  await expect(notice).toHaveAttribute("role", "status");
  await expect(page.locator(`[data-theme-ref='${DUSK_REF}']`)).toHaveCount(0);
  await settle(page);
  await page.screenshot({ path: join(EVIDENCE, "theme-picker-1280-fallback.png") });

  // Restoring the package brings the same theme back without choosing it again.
  await page.locator("#cc-tab-extensions").click();
  await page.locator(`[data-restorable-package='${PACKAGE}'] [data-package-restore]`).click();
  await expect.poll(() => accent(page), { timeout: 15_000 }).toBe("#7AA2F7");
  await page.locator("#cc-tab-experience").click();
  await expect(page.locator(`[data-theme-ref='${DUSK_REF}']`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-theme-fallback]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as { ccThemeMark?: boolean }).ccThemeMark)).toBe(true);

  // Back to Clark Default through the same list, so the specs after this one start where they expect to.
  await page.locator("[data-theme-ref='builtin:clark']").click();
  await expect.poll(() => accent(page), { timeout: 15_000 }).toBe(clarkAccent);
});
