import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { toneWav } from "../../../apps/runtime/src/test-support/media-fixtures.ts";
import { NEAR_VIEWPORT_MARGIN } from "../../../packages/conversation-client/src/near-viewport.ts";

/**
 * A conversation with several players reads none of their bytes until one is needed.
 *
 * Opening a conversation used to read every video and audio file it held, in full, before anyone pressed play. Here
 * three players sit far apart in one conversation, and every request the page makes for media bytes is counted: none
 * when the conversation opens, one when a player is scrolled into view, one when a player is played with no observer
 * to say it came near, and the paused position still comes back. The clip is the local-video journey's real WebM,
 * answered for the numbered references the fixture places; the authenticated fetch, the object URL, the player and the
 * state the node holds are the production path.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error("CC_E2E_NODE_PORT is not set; run this suite through playwright.config.ts");
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const MEDIA_PORT = process.env.CC_E2E_MEDIA_PORT;
const MEDIA_CERT = process.env.CC_E2E_MEDIA_CERT;
const MEDIA_KEY = process.env.CC_E2E_MEDIA_KEY;
if (MEDIA_PORT === undefined || MEDIA_CERT === undefined || MEDIA_KEY === undefined) {
  throw new Error("the media origin's port and certificate are not set; run this suite through playwright.config.ts");
}
const TONE = Buffer.from(toneWav({ seconds: 4, frequency: 330 }));
const CLIP =readFileSync(join(process.cwd(), "apps", "web", "e2e", "fixtures", "media", "local-clip.webm"));
const REFS = ["video_e2e_lazy_1", "video_e2e_lazy_2", "video_e2e_lazy_3"] as const;
/**
 * Session-storage flag the init script reads to refuse the players' `IntersectionObserver`, as an engine without one
 * would. Only the players' observer is refused (it is the one asking for their margin): the orb and other surfaces
 * also observe, and taking the constructor away from the whole page would test them instead. A refused constructor
 * takes the same no-observer path as a missing one.
 */
const NO_OBSERVER = "cc_e2e_no_intersection_observer";
/** Cards placed before the first player and after each one, so every player is far more than the observer's margin away. */
const FILLERS_PER_GAP = 5;

/**
 * The https origin the node's media policy names, serving the tone the audio player is placed from. The node fetches it
 * once and keeps it as an artifact; the page reads the artifact from the node, which is what is counted.
 */
let origin: Server | undefined;

test.beforeAll(async () => {
  origin = createServer({ cert: readFileSync(MEDIA_CERT), key: readFileSync(MEDIA_KEY) }, (request, response) => {
    if (request.url === "/tone.wav") {
      response.writeHead(200, { "content-type": "audio/wav", "content-length": String(TONE.byteLength) });
      response.end(TONE);
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

async function ready(page: Page): Promise<void> {
  await expect(page.locator('.cc-status[data-connection="ready"]')).toBeVisible({ timeout: 15_000 });
}

async function say(page: Page, text: string): Promise<void> {
  const replies = page.locator('[data-role="assistant"]');
  const before = await replies.count();
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill(text);
  await composer.press("Enter");
  await expect(replies).toHaveCount(before + 1, { timeout: 30_000 });
}

/** The conversation the browser is reading, from its own timeline request. */
function watchConversation(page: Page): () => string {
  let id = "";
  page.on("request", (request) => {
    const match = /\/conversations\/([^/?]+)\/(?:timeline|messages)/u.exec(request.url());
    if (match !== null) id = decodeURIComponent(match[1] ?? "");
  });
  return () => {
    if (id === "") throw new Error("the app has not requested its conversation yet");
    return id;
  };
}

async function heldWidgetState(page: Page, conversationId: string, instanceId: string): Promise<Record<string, unknown>> {
  const response = await page.request.get(`${GATEWAY}/conversations/${encodeURIComponent(conversationId)}/timeline?after=0`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  expect(response.ok()).toBe(true);
  const timeline = (await response.json()) as { instances?: { instanceId: string; state?: Record<string, unknown> }[] };
  return timeline.instances?.find((entry) => entry.instanceId === instanceId)?.state ?? {};
}

/**
 * Every request the page makes for media bytes on the node: a picture or video by reference, an attachment's content
 * or an artifact's content. Reset by emptying the array.
 */
function recordMediaReads(page: Page): string[] {
  const reads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== GATEWAY) return;
    if (/^\/(?:images\/[^/]+|attachments\/[^/]+\/content|artifacts\/[^/]+\/content)$/u.test(url.pathname)) reads.push(url.pathname);
  });
  return reads;
}

/**
 * Answers the numbered clips with real bytes. It can hold one reference's answer until the test lets it go, and refuse
 * one reference as a node that cannot read the file would.
 */
async function serveClips(page: Page): Promise<{ hold: (ref: string) => () => void; refuse: (ref: string | undefined) => void }> {
  let held: { ref: string; until: Promise<void> } | undefined;
  let refused: string | undefined;
  await page.route(
    (url) => url.origin === GATEWAY && /^\/images\/video_e2e_lazy_\d+$/u.test(url.pathname),
    async (route) => {
      const ref = new URL(route.request().url()).pathname.split("/").pop() ?? "";
      if (held?.ref === ref) await held.until;
      if (refused === ref) {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "the file could not be read" }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "video/webm", body: CLIP });
    },
  );
  return {
    hold: (ref) => {
      let release = (): void => undefined;
      held = { ref, until: new Promise<void>((resolve) => (release = resolve)) };
      return () => release();
    },
    refuse: (ref) => {
      refused = ref;
    },
  };
}

/** How many reads each source had: a clip by its reference, an artifact or attachment by its path. */
function countsOf(reads: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const path of reads) {
    const key = path.startsWith("/images/") ? path.slice("/images/".length) : path;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Brings a player to the middle of the transcript at once, so no other player passes by on the way. */
async function scrollTo(page: Page, ref: string): Promise<void> {
  await page.locator(`[data-media-ref='${ref}']`).evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
}

/** The waiting audio player's stand-in: its reference is the artifact the node minted, so it is found by its button. */
function waitingAudio(page: Page): Locator {
  return page.locator("[data-media-ref]").filter({ has: page.locator("[data-media-play='audio']") });
}

/**
 * Puts `target` below the visible transcript, `fraction` of a transcript height away from its bottom edge, in one jump.
 * Inside the observer's half-screen margin when `fraction` is under one half, and still not visible.
 */
async function placeBelowView(target: Locator, fraction: number): Promise<void> {
  await target.evaluate((element, away) => {
    const scroller = element.closest(".cc-scroll");
    if (!(scroller instanceof HTMLElement)) throw new Error("the player is not inside the transcript");
    const view = scroller.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    scroller.scrollTo({ top: scroller.scrollTop + (box.top - view.bottom) - away * view.height, behavior: "instant" });
  }, fraction);
}

/**
 * `placeBelowView` for a player, repeated until the place holds.
 *
 * Transcript rows off screen keep a placeholder height until they are drawn (`content-visibility`), so the first jump
 * draws the rows it lands among, they take their real heights, and the player moves without any scroll. Placing again
 * until its distance holds across two frames puts it where the test says, inside the margin, before asserting a read.
 */
async function placeBelowViewSettled(page: Page, ref: string, fraction: number): Promise<void> {
  // The waiting stand-in, or the player that replaced it once its bytes were read on the way.
  const target = page.locator(`[data-media-ref='${ref}'], video[data-video-ref='${ref}']`).first();
  const frames = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await placeBelowView(target, fraction);
    await frames();
    const first = await belowView(target);
    await frames();
    const second = await belowView(target);
    if (Math.abs(first - fraction) < 0.02 && Math.abs(second - fraction) < 0.02) return;
  }
  throw new Error(`the player did not hold its place ${String(fraction)} of a view below the transcript`);
}

/** How far below the visible transcript the element's top is, in transcript heights; zero or less once it shows. */
async function belowView(target: Locator): Promise<number> {
  return target.evaluate((element) => {
    const scroller = element.closest(".cc-scroll");
    if (scroller === null) return 0;
    const view = scroller.getBoundingClientRect();
    return (element.getBoundingClientRect().top - view.bottom) / view.height;
  });
}

const playing = (video: Locator) => video.evaluate((element: HTMLMediaElement) => !element.paused && !element.ended);

/** For each waiting player, how far it is from the visible part of the transcript, in transcript heights. */
async function distancesFromView(page: Page): Promise<number[]> {
  return page.locator("[data-media-ref]").evaluateAll((elements) => {
    const scroller = document.querySelector(".cc-scroll");
    if (scroller === null) return [];
    const view = scroller.getBoundingClientRect();
    return elements.map((element) => {
      const box = element.getBoundingClientRect();
      const gap = box.top > view.bottom ? box.top - view.bottom : view.top > box.bottom ? view.top - box.bottom : 0;
      return gap / view.height;
    });
  });
}

/** The same distance for one waiting player. */
async function distanceFromView(page: Page, ref: string): Promise<number> {
  return page.locator(`[data-media-ref='${ref}']`).evaluate((element) => {
    const scroller = element.closest(".cc-scroll");
    if (scroller === null) return 0;
    const view = scroller.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const gap = box.top > view.bottom ? box.top - view.bottom : view.top > box.bottom ? view.top - box.bottom : 0;
    return gap / view.height;
  });
}

async function reopen(page: Page, reads: string[]): Promise<void> {
  reads.length = 0;
  await page.reload();
  await ready(page);
  await expect(page.locator("[data-media-play='video']")).toHaveCount(REFS.length, { timeout: 20_000 });
  await expect(page.locator("[data-media-play='audio']")).toHaveCount(1);
}

test("players read no media bytes until one comes near the screen or is played, and still reopen where they paused", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(({ flag, margin }) => {
    if (window.sessionStorage.getItem(flag) !== "1") return;
    const Native = window.IntersectionObserver;
    const Refusing = function (callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      if (options?.rootMargin === margin) throw new Error("IntersectionObserver is unavailable to players");
      return new Native(callback, options);
    };
    Refusing.prototype = Native.prototype;
    Object.defineProperty(window, "IntersectionObserver", { value: Refusing, configurable: true, writable: true });
  }, { flag: NO_OBSERVER, margin: NEAR_VIEWPORT_MARGIN });
  const clips = await serveClips(page);
  const reads = recordMediaReads(page);
  const conversation = watchConversation(page);
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await ready(page);

  // An audio player and three video players, with enough cards between and after them that, whichever end the
  // transcript opens at, each is well beyond the observer's margin. The audio comes first, so it opens at the far end.
  await say(page, "đặt âm thanh từ nguồn mẫu");
  await expect(page.locator("audio[data-audio-ref^='artifact:']")).toHaveCount(1, { timeout: 30_000 });
  for (let filler = 0; filler < FILLERS_PER_GAP; filler += 1) await say(page, "xem diff");
  for (const [index] of REFS.entries()) {
    await say(page, `đặt video cục bộ ${String(index + 1)}`);
    for (let filler = 0; filler < FILLERS_PER_GAP; filler += 1) await say(page, "xem diff");
  }

  // Opened again: every player waits behind its Play button, and nothing is read.
  await reopen(page, reads);
  const distances = await distancesFromView(page);
  expect(distances, "every player starts far from the visible transcript").toHaveLength(REFS.length + 1);
  for (const distance of distances) expect(distance, "the players are beyond the half-screen margin").toBeGreaterThan(0.6);
  await page.waitForTimeout(1_500);
  expect(reads, "opening the conversation reads no media bytes").toEqual([]);
  await expect(page.locator("video[data-video-ref^='video_e2e_lazy_'], audio")).toHaveCount(0);

  // Brought within the half-screen margin but not yet into view, the second player reads its bytes once, before anyone
  // can see it; the others still read nothing. It does not play.
  await placeBelowViewSettled(page, REFS[1], 0.25);
  const second = page.locator(`video[data-video-ref='${REFS[1]}']`);
  await expect(second).toHaveAttribute("src", /^blob:/u, { timeout: 15_000 });
  expect(await belowView(second), "the player was read before it came into view").toBeGreaterThan(0.1);
  for (const other of [REFS[0], REFS[2]]) {
    expect(await distanceFromView(page, other), "the other players stayed beyond the half-screen margin").toBeGreaterThan(0.6);
  }
  await expect.poll(() => second.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(1_000);
  expect(countsOf(reads)).toEqual({ [REFS[1]]: 1 });
  expect(await second.evaluate((element: HTMLVideoElement) => ({ paused: element.paused, autoplay: element.autoplay }))).toEqual({ paused: true, autoplay: false });

  // The audio player takes the same path: scrolled to, it reads its artifact from the node once, and does not play.
  reads.length = 0;
  await waitingAudio(page).evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
  const audio = page.locator("audio[data-audio-ref^='artifact:']");
  await expect(audio).toHaveAttribute("src", /^blob:/u, { timeout: 15_000 });
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(500);
  expect(reads, "the audio player reads its artifact once and nothing else").toHaveLength(1);
  expect(reads[0]).toMatch(/^\/artifacts\/[^/]+\/content$/u);
  expect(await audio.evaluate((element: HTMLAudioElement) => ({ paused: element.paused, autoplay: element.autoplay }))).toEqual({ paused: true, autoplay: false });

  // With no observer, scrolling reads nothing; pressing Play from the keyboard reads the bytes, says they are loading
  // meanwhile (no progress is invented), then hands the keyboard to the player and plays.
  await page.evaluate((flag) => window.sessionStorage.setItem(flag, "1"), NO_OBSERVER);
  const release = clips.hold(REFS[0]);
  await reopen(page, reads);
  await scrollTo(page, REFS[0]);
  await page.waitForTimeout(1_000);
  expect(reads, "without an observer, scrolling reads nothing").toEqual([]);
  const waiting = page.locator(`[data-media-ref='${REFS[0]}']`);
  const play = waiting.locator("[data-media-play='video']");
  await expect(play).toHaveAccessibleName(/^(?:Phát video|Play video): Đoạn phim thử số 1$/u);
  await play.focus();
  expect(await play.evaluate((element) => getComputedStyle(element).outlineStyle), "a focused Play button shows a ring").not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(waiting.locator("[data-media-loading='video']")).toHaveText(/^(?:Đang tải video…|Loading the video…)$/u);
  await expect(waiting.locator("[data-media-loading='video']")).toHaveAttribute("role", "status");
  await expect(play).toHaveAttribute("aria-disabled", "true");
  await expect(play).toBeFocused();
  await expect(waiting.locator("progress, [role='progressbar']")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("lazy-media-loading-1280-dark.png") });
  await expect.poll(() => countsOf(reads)).toEqual({ [REFS[0]]: 1 });
  // A second press while loading does nothing.
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect(countsOf(reads)).toEqual({ [REFS[0]]: 1 });
  release();

  const first = page.locator(`video[data-video-ref='${REFS[0]}']`);
  await expect(first).toBeFocused({ timeout: 15_000 });
  await expect.poll(() => first.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(1.5);
  await first.evaluate((element: HTMLVideoElement) => element.pause());
  const pausedAt = await first.evaluate((element: HTMLVideoElement) => element.currentTime);
  expect(countsOf(reads)).toEqual({ [REFS[0]]: 1 });
  const instanceId = await first.evaluate((element) => element.closest("[data-widget-instance]")?.getAttribute("data-widget-instance") ?? "");
  expect(instanceId).not.toBe("");
  await expect.poll(() => heldWidgetState(page, conversation(), instanceId)).toMatchObject({ status: "paused" });
  const held = await heldWidgetState(page, conversation(), instanceId);
  expect(Math.abs(Number(held.position) - pausedAt)).toBeLessThan(0.15);

  // The observer back: opening again reads nothing; scrolled to, the player reads once and reopens where it was
  // paused, without playing.
  await page.evaluate((flag) => window.sessionStorage.removeItem(flag), NO_OBSERVER);
  await reopen(page, reads);
  await page.waitForTimeout(1_000);
  expect(reads).toEqual([]);
  await scrollTo(page, REFS[0]);
  const restored = page.locator(`video[data-video-ref='${REFS[0]}']`);
  await expect.poll(() => restored.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(pausedAt - 0.5);
  expect(Math.abs((await restored.evaluate((element: HTMLVideoElement) => element.currentTime)) - Number(held.position))).toBeLessThan(0.15);
  expect(await restored.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  expect(await heldWidgetState(page, conversation(), instanceId)).toMatchObject({ status: "paused", position: held.position });
  expect(countsOf(reads)).toEqual({ [REFS[0]]: 1 });

  // Played from its Play button after a reload, a player with a stored position starts there, not from the beginning.
  await page.evaluate((flag) => window.sessionStorage.setItem(flag, "1"), NO_OBSERVER);
  await reopen(page, reads);
  await scrollTo(page, REFS[0]);
  await page.locator(`[data-media-ref='${REFS[0]}'] [data-media-play='video']`).focus();
  await page.keyboard.press("Enter");
  const resumed = page.locator(`video[data-video-ref='${REFS[0]}']`);
  await expect.poll(() => playing(resumed), { timeout: 15_000 }).toBe(true);
  expect(await resumed.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(Number(held.position) - 0.15);
  await resumed.evaluate((element: HTMLVideoElement) => element.pause());
  expect(countsOf(reads)).toEqual({ [REFS[0]]: 1 });

  // One active playback owner. A press still waiting for its bytes does not start once the person started another
  // player meanwhile; and starting a player pauses the one that was playing.
  const releaseThird = clips.hold(REFS[2]);
  await reopen(page, reads);
  await scrollTo(page, REFS[2]);
  await page.locator(`[data-media-ref='${REFS[2]}'] [data-media-play='video']`).click();
  await expect.poll(() => countsOf(reads)).toEqual({ [REFS[2]]: 1 });
  await scrollTo(page, REFS[1]);
  await page.locator(`[data-media-ref='${REFS[1]}'] [data-media-play='video']`).click();
  const started = page.locator(`video[data-video-ref='${REFS[1]}']`);
  await expect.poll(() => playing(started), { timeout: 15_000 }).toBe(true);
  releaseThird();
  const late = page.locator(`video[data-video-ref='${REFS[2]}']`);
  await expect.poll(() => late.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(800);
  expect(await late.evaluate((element: HTMLVideoElement) => element.paused), "a stale press does not start the player").toBe(true);
  expect(await playing(started), "the player the person started keeps playing").toBe(true);
  await late.evaluate((element: HTMLVideoElement) => element.play());
  await expect.poll(() => started.evaluate((element: HTMLVideoElement) => element.paused), { timeout: 5_000 }).toBe(true);
  await late.evaluate((element: HTMLVideoElement) => element.pause());

  // A source the node refuses after Play: the failure is said where the button was, and the keyboard goes there.
  clips.refuse(REFS[1]);
  await reopen(page, reads);
  await scrollTo(page, REFS[1]);
  await page.locator(`[data-media-ref='${REFS[1]}'] [data-media-play='video']`).focus();
  await page.keyboard.press("Enter");
  const failure = page.locator("[data-media-failed]");
  await expect(failure).toBeFocused({ timeout: 15_000 });
  await expect(failure).toHaveAttribute("role", "status");
  await expect(failure).toHaveText(/(?:Không đọc được video|The video could not be read).*(?:mở lại hội thoại để thử lại|open it again to try again)/u);
  await expect(page.locator(`video[data-video-ref='${REFS[1]}']`)).toHaveCount(0);
  expect(countsOf(reads)).toEqual({ [REFS[1]]: 1 });
  clips.refuse(undefined);

  // At a phone's width with motion reduced, in both themes, a waiting player fits and moves nothing.
  await page.evaluate((flag) => window.sessionStorage.setItem(flag, "1"), NO_OBSERVER);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await reopen(page, reads);
  await scrollTo(page, REFS[1]);
  const phone = page.locator(`[data-media-ref='${REFS[1]}']`);
  expect((await phone.boundingBox())?.width ?? 0).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // Reduced motion: the transcript does not glide when it scrolls, and nothing in the waiting player animates.
  expect(await page.locator(".cc-scroll").evaluate((element) => getComputedStyle(element).scrollBehavior)).toBe("auto");
  expect(
    await phone.evaluate((element) =>
      document.getAnimations().filter((animation) => {
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
        return target !== null && element.contains(target) && animation.playState === "running";
      }).length,
    ),
  ).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("lazy-media-390-light.png") });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-cc-theme"))).toBe("dark");
  await page.screenshot({ path: testInfo.outputPath("lazy-media-390-dark.png") });
  expect(reads).toEqual([]);
});
