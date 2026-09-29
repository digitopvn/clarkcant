import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Choosing a theme a package provides, in the browser.
 *
 * The node's tests cover the registry and every lifecycle step; this covers what only a page can show: that choosing a
 * theme restyles the window without reloading it or touching the conversation — a half-typed message and a pinned
 * widget are both still there — that removing the package draws Clark Default and says so where the choice was made,
 * that restoring the package brings the chosen theme back without choosing it again, and that an update whose colours
 * are too dim to read is refused the same way, with the failing pairs named.
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

test("a package theme restyles the window in place, falls back when removed or unreadable, and returns when restored", async ({
  page,
  request,
}) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await prepare(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  // The node's own suggestions are asked for none, so the first chip is the written sample chart (see j1.spec.ts).
  await page.route("**/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });

  const clarkAccent = await accent(page);
  expect(clarkAccent).not.toBe("#7AA2F7");

  // A pinned widget, marked on its own element so that re-creating it — not only losing it — would show.
  await page.locator("[data-suggestion]").first().click();
  await expect(page.locator('[data-widget-role="chart"]').first()).toBeVisible({ timeout: 20_000 });
  // The conversation carries on from earlier specs, so this pin is told apart from any they left by its id.
  const pinIds = (): Promise<string[]> =>
    page.locator("[data-pin-shelf='true'] [data-pin-id]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-pin-id") ?? ""));
  const pinsBefore = await pinIds();
  await page.locator("[data-pin-instance]").first().click();
  await expect.poll(async () => (await pinIds()).filter((id) => !pinsBefore.includes(id)).length).toBe(1);
  const pinId = (await pinIds()).find((id) => !pinsBefore.includes(id)) ?? "";
  const pinned = page.locator(`[data-pin-shelf='true'] [data-pin-id='${pinId}']`);
  await pinned.evaluate((element) => {
    (element as HTMLElement & { ccThemeMark?: boolean }).ccThemeMark = true;
  });
  const pinSurvived = async (): Promise<void> => {
    const same = page.locator(`[data-pin-shelf='true'] [data-pin-id='${pinId}']`);
    await expect(same).toBeVisible();
    expect(await same.evaluate((element) => (element as HTMLElement & { ccThemeMark?: boolean }).ccThemeMark)).toBe(true);
  };

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
  await expect.poll(() => accent(page)).toBe("#2959AA");
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

  // The page was restyled, not reloaded: the mark, the draft and the pinned widget are all still there.
  expect(await page.evaluate(() => (window as { ccThemeMark?: boolean }).ccThemeMark)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-composer]")).toHaveValue(DRAFT);
  await pinSurvived();

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

  /*
   * An update whose dark accent is too dim to read is refused where it would be drawn: the page shows Clark Default
   * and says why, naming the pairs that fail, and the choice is kept. The update is installed from outside this page,
   * as another device would, and reaches it when the window is looked at again.
   */
  const headers = { authorization: `Bearer ${token()}` };
  const dim = await request.post(`${GATEWAY}/packages/install`, {
    headers,
    data: { packageId: PACKAGE, version: "1.1.0", localDigest: "sha256:theme-dusk-dim-digest" },
  });
  expect(dim.ok(), `install answered ${String(dim.status())}: ${await dim.text()}`).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => accent(page), { timeout: 15_000 }).toBe(clarkAccent);
  const unreadable = page.locator("[data-theme-fallback='THEME_LOW_CONTRAST']");
  await expect(unreadable).toBeVisible({ timeout: 15_000 });
  await expect(unreadable).toHaveAttribute("role", "status");
  await expect(unreadable).toContainText("Clark Default");
  await expect(unreadable).toContainText("khó đọc");
  await unreadable.locator("summary").click();
  await expect(unreadable.locator(".cc-theme-notice-detail")).toContainText("accent text on the page");
  await expect(page.locator(`[data-theme-ref='${DUSK_REF}']`)).toHaveCount(0);
  await unreadable.scrollIntoViewIfNeeded();
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().filter((animation) => animation instanceof CSSTransition).length))
    .toBe(0);
  await page.screenshot({ path: join(EVIDENCE, "theme-fallback-low-contrast-1280-dark.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await unreadable.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(EVIDENCE, "theme-fallback-low-contrast-390-dark.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Rolling the update back draws the kept choice again.
  const rolledBack = await request.post(`${GATEWAY}/packages/${encodeURIComponent(PACKAGE)}/rollback`, { headers });
  expect(rolledBack.ok(), `rollback answered ${String(rolledBack.status())}: ${await rolledBack.text()}`).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => accent(page), { timeout: 15_000 }).toBe("#7AA2F7");
  await expect(page.locator("[data-theme-fallback]")).toHaveCount(0);

  // Back to Clark Default through the same list, so the specs after this one start where they expect to.
  await page.locator("[data-theme-ref='builtin:clark']").click();
  await expect.poll(() => accent(page), { timeout: 15_000 }).toBe(clarkAccent);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-composer]")).toHaveValue(DRAFT);
  await pinSurvived();
  expect(await page.evaluate(() => (window as { ccThemeMark?: boolean }).ccThemeMark)).toBe(true);

  // Unpinned again, so a spec after this one finds the shelf as it was.
  await page.locator(`[data-unpin='${pinId}']`).click();
  await expect(page.locator(`[data-pin-id='${pinId}']`)).toHaveCount(0);
});
