import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { toneWav } from "../../../apps/runtime/src/test-support/media-fixtures.ts";

/**
 * The audio player and the document preview, placed in the conversation and browsed in the library.
 *
 * The audio comes from a real https origin on loopback that the node's media policy names
 * (`CC_MEDIA_ORIGINS`, set by playwright.config.ts with the certificate it made): the node fetches it, checks it and keeps
 * it as an artifact of the conversation, and the page plays it from the node. So what is asserted is the whole path —
 * the origin hears only the node, never the browser; the page asks only its own origins; the player never starts by
 * itself; and the place a person paused at survives a reload. The document is a text file attached in the conversation,
 * paged with the keyboard, its hidden characters marked and its truncation said.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
const WEB_PORT = process.env.CC_E2E_WEB_PORT;
const MEDIA_PORT = process.env.CC_E2E_MEDIA_PORT;
const MEDIA_CERT = process.env.CC_E2E_MEDIA_CERT;
const MEDIA_KEY = process.env.CC_E2E_MEDIA_KEY;
if (NODE_PORT === undefined || WEB_PORT === undefined || MEDIA_PORT === undefined || MEDIA_CERT === undefined || MEDIA_KEY === undefined) {
  throw new Error("the e2e ports and the media origin's certificate are not set; run this suite through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const APP = `http://127.0.0.1:${WEB_PORT}`;
const MEDIA_ORIGIN = `https://127.0.0.1:${MEDIA_PORT}`;

const ZERO_WIDTH = String.fromCodePoint(0x200b);
const BIDI = String.fromCodePoint(0x202e);

interface OriginRequest {
  path: string;
  userAgent: string | undefined;
  cookie: string | undefined;
  authorization: string | undefined;
  referer: string | undefined;
}

let origin: Server | undefined;
const heard: OriginRequest[] = [];
const TONE = Buffer.from(toneWav({ seconds: 4, frequency: 330 }));

test.beforeAll(async () => {
  origin = createServer({ cert: readFileSync(MEDIA_CERT), key: readFileSync(MEDIA_KEY) }, (request, response) => {
    heard.push({
      path: request.url ?? "",
      userAgent: request.headers["user-agent"],
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      referer: request.headers.referer,
    });
    if (request.url === "/tone.wav") {
      response.writeHead(200, { "content-type": "audio/wav", "content-length": String(TONE.byteLength), "set-cookie": "tracker=1" });
      response.end(TONE);
      return;
    }
    // Off the allowed origin: the same server under another name is another origin.
    if (request.url === "/away") {
      response.writeHead(302, { location: `https://localhost:${MEDIA_PORT}/tone.wav` });
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    origin?.once("error", reject);
    origin?.listen(Number(MEDIA_PORT), "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  origin?.closeAllConnections();
  await new Promise<void>((resolve) => (origin === undefined ? resolve() : origin.close(() => resolve())));
});

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token");
  return parsed.localToken;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

async function say(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await expect(page.locator('[data-attachment-chip][data-attachment-state="checking"]')).toHaveCount(0);
  await composer.fill(text);
  await composer.press("Enter");
}

/** Ask the fixture model to place one, and return the newest card of that role. */
async function place(page: Page, prompt: string, role: "audio" | "document"): Promise<Locator> {
  const selector = `[data-widget-role='${role}']`;
  const before = await page.locator(selector).count();
  await say(page, `đặt ${prompt}`);
  await expect(page.locator(selector)).toHaveCount(before + 1, { timeout: 30_000 });
  return page.locator(selector).nth(before);
}

/** Every request the page makes, so a test can say none left the app and the node. */
function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  return urls;
}

function expectOnlyOwnOrigins(urls: readonly string[]): void {
  const foreign = urls.filter((url) => {
    if (url.startsWith("blob:") || url.startsWith("data:")) return false;
    const { origin: from } = new URL(url);
    return from !== APP && from !== GATEWAY;
  });
  expect(foreign, "every request the page made went to the app or the node").toEqual([]);
}

async function settled(target: Locator): Promise<void> {
  await target.evaluate(async (element) => {
    const frame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
    const moving = (): boolean =>
      document.getAnimations().some((animation) => {
        const node = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
        return node !== null && (node.contains(element) || element.contains(node)) && animation.playState === "running" &&
          animation.effect?.getComputedTiming().iterations !== Infinity;
      });
    const deadline = performance.now() + 5_000;
    for (let still = 0; still < 6 && performance.now() < deadline; ) {
      await frame();
      still = moving() ? 0 : still + 1;
    }
  });
}

async function theme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"));
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

const audioState = (player: Locator) =>
  player.evaluate((element) => {
    const media = element as HTMLAudioElement;
    return { paused: media.paused, time: media.currentTime, duration: media.duration, ready: media.readyState, autoplay: media.autoplay };
  });

/** A long text file: three and a bit pages, with a hidden character on the first. */
const LONG_TEXT = Array.from({ length: 160 }, (_, index) => `Dòng ${String(index + 1)}: ghi chú cuộc họp về kế hoạch quý tư.${index === 2 ? ZERO_WIDTH : ""}`).join("\n");
const NOTES = { name: "ghi-chu-hop.txt", mimeType: "text/plain", buffer: Buffer.from(LONG_TEXT, "utf8") };

test("audio fetched from an allowed origin plays from the node, never by itself, and keeps where it was paused", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const urls = recordRequests(page);
  heard.length = 0;
  await openApp(page);

  const card = await place(page, "âm thanh từ nguồn mẫu", "audio");
  const player = card.locator("audio[data-audio-ref]");
  await expect(player).toHaveAttribute("data-audio-ref", /^artifact:/);
  await expect(player).toHaveAttribute("src", /^blob:/);
  await expect(player).toHaveAttribute("controls", "");
  await expect(player).toHaveAccessibleName("Bản tin buổi sáng");
  await expect(card.locator(".cc-audio figcaption")).toContainText("0:04");
  await expect(card.locator(".cc-audio figcaption")).toContainText(MEDIA_ORIGIN);
  await expect.poll(async () => (await audioState(player)).ready, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  // Loaded, not playing: nothing starts by itself.
  expect(await audioState(player)).toMatchObject({ paused: true, time: 0, autoplay: false });
  expect((await audioState(player)).duration).toBeCloseTo(4, 0);

  // The origin heard the node once, with nothing that identifies anybody; the page asked only the app and the node.
  expect(heard).toHaveLength(1);
  expect(heard[0]).toMatchObject({ path: "/tone.wav", userAgent: "ClarkCant-media/1", cookie: undefined, authorization: undefined, referer: undefined });
  expectOnlyOwnOrigins(urls);

  // The transcript is text, opened by a keyboard, with its hidden character drawn as a marker.
  const transcript = card.locator("details.cc-audio-transcript");
  await transcript.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(transcript).toHaveAttribute("open", "");
  await expect(transcript.locator("[data-hidden-char='U+202E']")).toHaveText("⟨U+202E⟩");
  expect((await transcript.textContent()) ?? "").not.toContain(BIDI);

  // The player is reached and driven from the keyboard: focus shows a ring, Space plays and pauses.
  await player.focus();
  await expect(player).toBeFocused();
  const ring = await player.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(ring, "a focused player shows a ring").not.toBe("none");
  await page.keyboard.press("Space");
  await expect.poll(async () => (await audioState(player)).time, { timeout: 10_000 }).toBeGreaterThan(1);
  await page.keyboard.press("Space");
  await expect.poll(async () => (await audioState(player)).paused).toBe(true);
  const pausedAt = (await audioState(player)).time;
  await card.scrollIntoViewIfNeeded();
  await settled(card);
  await page.screenshot({ path: testInfo.outputPath("audio-1280-dark.png") });

  // After a reload the player opens where it was paused, still paused.
  await page.waitForTimeout(1_500);
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  const reloaded = page.locator("[data-widget-role='audio'] audio[data-audio-ref]").last();
  await expect.poll(async () => (await audioState(reloaded)).time, { timeout: 15_000 }).toBeGreaterThan(pausedAt - 0.6);
  expect((await audioState(reloaded)).paused).toBe(true);

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => theme(page)).toBe("light");
  const lightCard = page.locator("[data-widget-role='audio']").last();
  await lightCard.scrollIntoViewIfNeeded();
  await settled(lightCard);
  await page.screenshot({ path: testInfo.outputPath("audio-1280-light.png") });
  expect(heard, "a reload plays from the node; the origin is not asked again").toHaveLength(1);
});

test("the stored audio is placed again by its ArtifactRef without another fetch", async ({ page }) => {
  test.setTimeout(90_000);
  const urls = recordRequests(page);
  heard.length = 0;
  await openApp(page);
  const fetched = await place(page, "âm thanh từ nguồn mẫu", "audio");
  const ref = await fetched.locator("audio").getAttribute("data-audio-ref");
  expect(heard).toHaveLength(1);

  const again = await place(page, "âm thanh đã lưu", "audio");
  await expect(again.locator("audio")).toHaveAttribute("data-audio-ref", ref ?? "");
  await expect(again.locator("audio")).toHaveAttribute("src", /^blob:/);
  await expect.poll(async () => (await audioState(again.locator("audio"))).ready, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  expect((await audioState(again.locator("audio"))).paused).toBe(true);
  // From the artifact, not from the origin: no second fetch, and still no foreign request from the page.
  expect(heard).toHaveLength(1);
  await expect(again.locator(".cc-audio figcaption")).not.toContainText(MEDIA_ORIGIN);
  expectOnlyOwnOrigins(urls);
});

test("audio is refused, with the rule it broke, from an origin the policy does not name or a redirect off it", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  const before = await page.locator("[data-widget-role='audio']").count();
  await say(page, "đặt âm thanh nguồn lạ");
  await expect(page.getByText("(media policy rule: origin-not-allowed)").last()).toBeVisible({ timeout: 20_000 });
  await say(page, "đặt âm thanh chuyển hướng ra ngoài");
  await expect(page.getByText("(media policy rule: redirect-off-origin)").last()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-widget-role='audio']")).toHaveCount(before);
});

test("a text document previews in pages a keyboard turns, marks hidden characters, and keeps its page", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  const urls = recordRequests(page);
  await openApp(page);
  await page.locator("[data-attachment-input]").setInputFiles([NOTES]);
  await expect(page.locator('[data-attachment-chip][data-attachment-state="ready"]')).toHaveCount(1, { timeout: 15_000 });
  // Sent first, on its own, as a person shares a file; the preview is asked for in the next message.
  await say(page, "ghi chú cuộc họp");
  await expect(page.getByText("Tui đọc tệp bạn gửi").last()).toBeVisible({ timeout: 20_000 });
  const card = await place(page, "xem trước tài liệu", "document");

  await expect(card.locator(".cc-viewer-name")).toHaveText("ghi-chu-hop.txt");
  const region = card.locator("[data-document-page]");
  await expect(region).toHaveAttribute("data-document-page", "0");
  await expect(region).toHaveAttribute("role", "region");
  await expect(region).toHaveAttribute("tabindex", "0");
  await expect(region.locator("[data-hidden-char='U+200B']")).toHaveCount(1);
  await expect(card.locator("[data-viewer-hidden='1']")).toBeVisible();
  expect((await region.textContent()) ?? "").not.toContain(ZERO_WIDTH);
  const position = card.locator("[data-document-position]");
  await expect(position).toHaveAttribute("aria-live", "polite");
  const count = Number(/\/(\d+)$/u.exec((await position.textContent()) ?? "")?.[1] ?? "0");
  expect(count).toBeGreaterThan(2);
  await expect(card.locator("[data-document-turn='previous']")).toHaveAttribute("aria-disabled", "true");

  // Tab from the page's text reaches the paging controls; Enter turns the page.
  // An unavailable control stays in the tab order (aria-disabled), so it is announced as unavailable rather than skipped.
  await region.focus();
  await page.keyboard.press("Tab");
  await expect(card.locator("[data-document-turn='previous']")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(region).toHaveAttribute("data-document-page", "0");
  await page.keyboard.press("Tab");
  await expect(card.locator("[data-document-turn='next']")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(region).toHaveAttribute("data-document-page", "1");
  await expect(position).toHaveText(`Trang 2/${String(count)}`);
  await page.keyboard.press("Enter");
  await expect(region).toHaveAttribute("data-document-page", "2");
  await card.scrollIntoViewIfNeeded();
  await settled(card);
  await page.screenshot({ path: testInfo.outputPath("document-1280-dark.png") });

  // The page held by the node comes back after a reload.
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  const reloaded = page.locator("[data-widget-role='document']").last();
  await expect(reloaded.locator("[data-document-page]")).toHaveAttribute("data-document-page", "2", { timeout: 15_000 });

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => theme(page)).toBe("light");
  await reloaded.scrollIntoViewIfNeeded();
  await settled(reloaded);
  await page.screenshot({ path: testInfo.outputPath("document-1280-light.png") });

  // Turning to the last page keeps the keyboard on the control that is now unavailable, and pressing it again does
  // nothing: focus never falls back to the page because a button switched off under it.
  const next = reloaded.locator("[data-document-turn='next']");
  const reloadedPage = reloaded.locator("[data-document-page]");
  await next.focus();
  for (let turned = 3; turned < count; turned += 1) {
    await page.keyboard.press("Enter");
    await expect(reloadedPage).toHaveAttribute("data-document-page", String(turned));
  }
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await expect(next).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(reloadedPage).toHaveAttribute("data-document-page", String(count - 1));
  await expect(next).toBeFocused();
  // A new page opens at its top.
  expect(await reloadedPage.evaluate((element) => element.scrollTop)).toBe(0);
  expectOnlyOwnOrigins(urls);
});

test("both read at phone width and add no motion when motion is reduced", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await openApp(page);
    const audio = await place(page, "âm thanh từ nguồn mẫu", "audio");
    await page.locator("[data-attachment-input]").setInputFiles([NOTES]);
    await expect(page.locator('[data-attachment-chip][data-attachment-state="ready"]')).toHaveCount(1, { timeout: 15_000 });
  // Sent first, on its own, as a person shares a file; the preview is asked for in the next message.
  await say(page, "ghi chú cuộc họp");
  await expect(page.getByText("Tui đọc tệp bạn gửi").last()).toBeVisible({ timeout: 20_000 });
    const document = await place(page, "xem trước tài liệu", "document");
    for (const card of [audio, document]) {
      const box = await card.boundingBox();
      expect(box?.width ?? 0, "a card fits the phone's width").toBeLessThanOrEqual(390);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    for (const target of [audio.locator("audio"), document.locator("[data-document-turn='next']"), document.locator("[data-document-page]")]) {
      const motion = await target.evaluate((element) => {
        const style = getComputedStyle(element);
        return { animation: style.animationName, transition: style.transitionDuration };
      });
      expect(motion.animation).toBe("none");
      expect(motion.transition.split(",").every((part) => Number.parseFloat(part) === 0)).toBe(true);
    }
    for (const [name, card] of [
      ["audio", audio],
      ["document", document],
    ] as const) {
      await card.scrollIntoViewIfNeeded();
      await settled(card);
      await page.screenshot({ path: testInfo.outputPath(`${name}-390.png`) });
    }
  } finally {
    await context.close();
  }
});

test("the library previews both through the production renderer without loading any media", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const urls = recordRequests(page);
  await openApp(page);
  await page.locator("[data-settings='true']").click();
  await expect(page.locator("#cc-tab-extensions")).toBeVisible({ timeout: 20_000 });
  await page.locator("#cc-tab-extensions").click();
  await page.locator("[data-widget-library-open='browse']").click();
  await expect(page.locator("[data-widget-library='true']")).toBeVisible({ timeout: 20_000 });

  // In the grid the audio card shows its text alternative, not a player.
  await expect(page.locator("[data-widget-preview-deferred='canvas.audio@1']").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-widget-grid] audio")).toHaveCount(0);

  await page.locator("[data-widget-card='canvas.audio@1']").click();
  const audio = page.locator("[data-widget-preview='canvas.audio@1']");
  await expect(audio).toBeVisible({ timeout: 20_000 });
  // A sample has no file on the node, and the preview says it cannot be played rather than pretending.
  await expect(audio).toContainText("Chưa phát được âm thanh");
  await expect(audio.locator("audio")).toHaveCount(0);
  await expect(audio.locator("details.cc-audio-transcript")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("library-canvas-audio-1.png") });
  await page.locator("[data-widget-library-back]").click();
  await expect(page.locator("[data-widget-grid]")).toBeVisible({ timeout: 20_000 });

  await page.locator("[data-widget-card='canvas.document@1']").click();
  const document = page.locator("[data-widget-preview='canvas.document@1']");
  await expect(document).toBeVisible({ timeout: 20_000 });
  await expect(document.locator("[data-document-page='0']").first()).toBeVisible();
  await settled(page.locator("[data-widget-library='true']"));
  await page.screenshot({ path: testInfo.outputPath("library-canvas-document-1.png") });
  expectOnlyOwnOrigins(urls);
});
