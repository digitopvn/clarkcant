import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";

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
/** The digests of the fixtures' bytes, as `fixtures/directory.json` lists them (a unit test keeps the two in step). */
const DUSK_DIGEST = "sha256:08c8691d1f8021e05d69a0754f3e6447de04a47ea2fc3cbd0b1817bcd2089053";
const DUSK_DIM_DIGEST = "sha256:b5b53158c6434ec13b4c44cb63aeb9e59221be06f791340855c6402f10c5a0c6";

/** Every screenshot's horizontal overflow, written beside the screenshots so a reviewer can read it without a rerun. */
const overflowLog: { shot: string; scrollWidth: number; clientWidth: number; overflow: number }[] = [];

/** Record how far the page is wider than the window, and fail when it is: nothing on the panel may widen the page. */
async function recordOverflow(page: Page, shot: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  const overflow = scrollWidth - clientWidth;
  overflowLog.push({ shot, scrollWidth, clientWidth, overflow });
  writeFileSync(join(EVIDENCE, "theme-overflow.json"), `${JSON.stringify(overflowLog, null, 2)}\n`);
  console.log(`[overflow] ${shot}: scrollWidth ${String(scrollWidth)} - clientWidth ${String(clientWidth)} = ${String(overflow)}`);
  expect(overflow, `${shot} is wider than the window`).toBeLessThanOrEqual(0);
}

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
  /*
   * And from Dusk 1.0.0. Being installed is not enough: a run that failed after installing the unreadable update, or
   * after removing the package, leaves it that way, and a retry that kept it would fail at the first stage instead of
   * reporting the stage that really failed.
   */
  const listed = (await (await request.get(`${GATEWAY}/packages`, { headers })).json()) as {
    packages: { packageId: string; version: string }[];
  };
  if (listed.packages.some((entry) => entry.packageId === PACKAGE && entry.version === "1.0.0")) return;
  const installed = await request.post(`${GATEWAY}/packages/install`, {
    headers,
    data: { packageId: PACKAGE, version: "1.0.0", localDigest: DUSK_DIGEST },
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

/*
 * One journey on one page, told as six tests that run in order.
 *
 * The journey is long — about 130 browser steps and eight screenshots — and it was once a single test under the
 * suite's 60-second budget. It never hung: every step answered, but on a shared CI runner each step costs two to three
 * times what it costs on a workstation, and the passing runs spread from 33 to 60 seconds until some ran out of time
 * with nothing wrong. Split by stage, each stage keeps the whole budget for a few seconds of work, a stage that does
 * stall still fails on its own, and the report names which one.
 *
 * The stages share the page on purpose: what this spec proves is that the window is restyled rather than reloaded, so
 * the mark on `window`, the half-typed message and the pinned widget have to live through every stage. Serial mode
 * skips the stages after one that fails, since they would start from a state the journey never reached.
 */
test.describe.configure({ mode: "serial" });

let page: Page;
/** Set only once the page is open, so cleanup after a failure to open one has nothing to close. */
let context: BrowserContext | undefined;
let clarkAccent = "";
let pinId = "";
/** The conversation the pin was made in, read from the page's own pin request so cleanup can remove it. */
let pinConversationId = "";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  context = page.context();
  page.on("request", (request) => {
    const match = /\/conversations\/([^/?]+)\/pins$/u.exec(request.url());
    if (match !== null && request.method() === "POST") pinConversationId = decodeURIComponent(match[1] ?? "");
  });
});

/*
 * Whatever stage the journey stopped at, the specs after this one find Clark Default chosen and no pin of this spec's
 * on the shelf. The last stage does both through the page; this does them again through the node, which is a no-op
 * after a pass and the only cleanup after a failure.
 */
test.afterAll(async ({ request }) => {
  const headers = { authorization: `Bearer ${token()}` };
  const reset = await request.put(`${GATEWAY}/preferences/experience.themeRef`, { headers, data: { value: "builtin:clark" } });
  expect(reset.ok(), `reset answered ${String(reset.status())}: ${await reset.text()}`).toBe(true);
  if (pinId !== "" && pinConversationId !== "") {
    const unpinned = await request.delete(
      `${GATEWAY}/conversations/${encodeURIComponent(pinConversationId)}/pins/${encodeURIComponent(pinId)}`,
      { headers },
    );
    // 404 is the pass case: the last stage already unpinned it.
    expect(unpinned.ok() || unpinned.status() === 404, `unpin answered ${String(unpinned.status())}: ${await unpinned.text()}`).toBe(true);
  }
  await context?.close();
});

const dusk = (): Locator => page.locator(`[data-theme-ref='${DUSK_REF}']`);
const provenance = (): Locator => page.locator(`[data-theme-provenance='${DUSK_REF}']`);
const unreadable = (): Locator => page.locator("[data-theme-fallback='THEME_LOW_CONTRAST']");
/** The page was restyled, not reloaded: the mark set on `window` before the first theme change is still there. */
async function notReloaded(): Promise<void> {
  const marked = await page.evaluate(() => (window as { ccThemeMark?: boolean }).ccThemeMark);
  expect(marked, "the page was reloaded: the mark set on window before the first theme change is gone").toBe(true);
}

/** The pin this spec made is still on the shelf, and is the same element rather than one drawn again. */
async function pinSurvived(): Promise<void> {
  const same = page.locator(`[data-pin-shelf='true'] [data-pin-id='${pinId}']`);
  await expect(same).toBeVisible();
  expect(await same.evaluate((element) => (element as HTMLElement & { ccThemeMark?: boolean }).ccThemeMark)).toBe(true);
}

test("choosing a package theme restyles the window in place", async ({ request }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await prepare(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  // The node's own suggestions are asked for none, so the first chip is the written sample chart (see j1.spec.ts).
  await page.route("**/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });

  clarkAccent = await accent(page);
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
  pinId = (await pinIds()).find((id) => !pinsBefore.includes(id)) ?? "";
  await page.locator(`[data-pin-shelf='true'] [data-pin-id='${pinId}']`).evaluate((element) => {
    (element as HTMLElement & { ccThemeMark?: boolean }).ccThemeMark = true;
  });

  // A half-typed message, and a mark that only survives if the page is never reloaded.
  await page.locator("[data-composer]").fill(DRAFT);
  await page.evaluate(() => {
    (window as { ccThemeMark?: boolean }).ccThemeMark = true;
  });

  await page.locator("[data-settings='true']").click();
  await expect(dusk()).toBeVisible({ timeout: 20_000 });
  // The entry shows what a person chooses by: the name, the description and the package's trust lane.
  await expect(dusk()).toContainText("Dusk");
  await expect(dusk().locator("[data-theme-provider='package']")).toHaveText("chỉ dữ liệu");
  // The exact build — package id, version and digest — is one click away rather than on every card.
  await expect(dusk()).not.toContainText(PACKAGE);
  await expect(dusk()).not.toContainText("sha256:");
  await expect(provenance().locator("[data-theme-digest]")).toBeHidden();
  await provenance().locator("summary").click();
  await expect(provenance().locator("[data-theme-package]")).toHaveText(`${PACKAGE}@1.0.0`);
  // The digest of the fixture's bytes, whole, as a published directory lists it.
  await expect(provenance().locator("[data-theme-digest]")).toHaveText(DUSK_DIGEST);
  expect(DUSK_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
  await provenance().locator("summary").click();
  await expect(provenance().locator("[data-theme-digest]")).toBeHidden();
  await expect(page.locator("[data-theme-ref='builtin:clark']")).toHaveAttribute("aria-pressed", "true");

  await dusk().click();
  await expect(dusk()).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => accent(page), { timeout: 15_000 }).toBe("#7AA2F7");
  await expect(dusk()).toHaveAttribute("data-theme-applied", "true");
  await settle(page);
  await page.screenshot({ path: join(EVIDENCE, "theme-picker-1280-dark.png") });
  await recordOverflow(page, "theme-picker-1280-dark");
});

test("the colour scheme redraws the same theme, and a phone-width panel is no wider than the screen", async () => {
  // The colour scheme is a separate choice: switching it redraws the same theme's light colours.
  await page.locator('[data-theme-choice="light"]').click();
  await expect.poll(() => accent(page)).toBe("#2959AA");
  await settle(page);
  await page.screenshot({ path: join(EVIDENCE, "theme-picker-1280-light.png") });
  await recordOverflow(page, "theme-picker-1280-light");
  await page.locator('[data-theme-choice="dark"]').click();
  await expect.poll(() => accent(page)).toBe("#7AA2F7");

  // Nothing on a phone-width panel is wider than the screen, however long the package id or digest is — open or not.
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.screenshot({ path: join(EVIDENCE, "theme-picker-390-dark.png") });
  await recordOverflow(page, "theme-picker-390-dark");
  await provenance().locator("summary").click();
  await expect(provenance().locator("[data-theme-digest]")).toBeVisible();
  await provenance().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(EVIDENCE, "theme-picker-390-dark-details.png") });
  await recordOverflow(page, "theme-picker-390-dark-details");
  await provenance().locator("summary").click();
  await page.setViewportSize({ width: 1280, height: 900 });

  // The page was restyled, not reloaded: the mark, the draft and the pinned widget are all still there.
  await notReloaded();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-composer]")).toHaveValue(DRAFT);
  await pinSurvived();
});

test("removing the package draws Clark Default at once, keeps the choice, and says so where it was made", async () => {
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
  await expect(dusk()).toHaveCount(0);
  // The details are the page's own sentence, not the node's English message.
  await notice.locator("summary").click();
  await expect(notice.locator(".cc-theme-notice-detail")).toHaveText(`Không gói nào đã cài cung cấp ${DUSK_REF}.`);
  await settle(page);
  await page.screenshot({ path: join(EVIDENCE, "theme-picker-1280-fallback.png") });
  await recordOverflow(page, "theme-picker-1280-fallback");
});

test("restoring the package brings the same theme back without choosing it again", async () => {
  await page.locator("#cc-tab-extensions").click();
  await page.locator(`[data-restorable-package='${PACKAGE}'] [data-package-restore]`).click();
  await expect.poll(() => accent(page), { timeout: 15_000 }).toBe("#7AA2F7");
  await page.locator("#cc-tab-experience").click();
  await expect(dusk()).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-theme-fallback]")).toHaveCount(0);
  await notReloaded();
});

/*
 * An update whose dark accent is too dim to read is refused where it would be drawn: the page shows Clark Default
 * and says why, naming the pairs that fail, and the choice is kept. The update is installed from outside this page,
 * as another device would, and reaches it when the window is looked at again.
 */
test("an update too dim to read is refused where it would be drawn, with the failing pairs named", async ({ request }) => {
  const headers = { authorization: `Bearer ${token()}` };
  const dim = await request.post(`${GATEWAY}/packages/install`, {
    headers,
    data: { packageId: PACKAGE, version: "1.1.0", localDigest: DUSK_DIM_DIGEST },
  });
  expect(dim.ok(), `install answered ${String(dim.status())}: ${await dim.text()}`).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => accent(page), { timeout: 15_000 }).toBe(clarkAccent);
  await expect(unreadable()).toBeVisible({ timeout: 15_000 });
  await expect(unreadable()).toHaveAttribute("role", "status");
  await expect(unreadable()).toContainText("Clark Default");
  await expect(unreadable()).toContainText("khó đọc");
  await unreadable().locator("summary").click();
  // One failing pair per line, worded and numbered in Vietnamese from the pairs the node sent as data.
  const pairs = unreadable().locator("[data-theme-contrast] li");
  await expect(pairs).toHaveText([
    "Chữ nhấn trên nền trang (tối): 2,00:1, cần 4,5:1",
    "Chữ nhấn trên nền cửa sổ (tối): 1,82:1, cần 4,5:1",
    "Chữ nhấn trên thẻ (tối): 1,71:1, cần 4,5:1",
    "Chữ nhấn trên bề mặt nổi (tối): 1,57:1, cần 4,5:1",
    "Chữ nhấn trên khối mã (tối): 2,18:1, cần 4,5:1",
    "Nhãn nút trên nút màu nhấn (tối): 2,00:1, cần 4,5:1",
  ]);
  // Nothing of the node's English message reaches a Vietnamese page.
  const noticeText = await unreadable().innerText();
  expect(noticeText).not.toMatch(/\b(accent|text|page|needs|scheme|colou?rs?|dark|light|theme|close to read)\b/i);
  // The list of themes Clark could not read words the same pairs the same way.
  await expect(page.locator(`[data-theme-problem='${DUSK_REF}']`)).toContainText("Chữ nhấn trên nền trang (tối): 2,00:1, cần 4,5:1");
  await expect(page.locator(`[data-theme-problem='${DUSK_REF}']`)).not.toContainText("accent text");
  await expect(dusk()).toHaveCount(0);
  const showNotice = async (): Promise<void> => {
    await unreadable().scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.evaluate(() => document.getAnimations().filter((animation) => animation instanceof CSSTransition).length))
      .toBe(0);
  };
  await showNotice();
  await page.screenshot({ path: join(EVIDENCE, "theme-fallback-low-contrast-1280-dark.png") });
  await recordOverflow(page, "theme-fallback-low-contrast-1280-dark");
  await page.locator('[data-theme-choice="light"]').click();
  await showNotice();
  await page.screenshot({ path: join(EVIDENCE, "theme-fallback-low-contrast-1280-light.png") });
  await recordOverflow(page, "theme-fallback-low-contrast-1280-light");
  await page.locator('[data-theme-choice="dark"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await showNotice();
  await page.screenshot({ path: join(EVIDENCE, "theme-fallback-low-contrast-390-dark.png") });
  await recordOverflow(page, "theme-fallback-low-contrast-390-dark");
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("rolling the update back draws the kept choice again, and the conversation was never touched", async ({ request }) => {
  const headers = { authorization: `Bearer ${token()}` };
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
  await notReloaded();

  // Unpinned again, so a spec after this one finds the shelf as it was.
  await page.locator(`[data-unpin='${pinId}']`).click();
  await expect(page.locator(`[data-pin-id='${pinId}']`)).toHaveCount(0);
});
