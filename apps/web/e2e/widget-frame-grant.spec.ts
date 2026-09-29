import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * A widget frame whose URL's grant lapsed while the frame stayed on screen.
 *
 * A frame URL carries a grant that works for five minutes; the frame showing it can stay mounted for hours. When that
 * frame has to load its document again after the grant lapsed — the browser reloads it, or it is mounted again from a
 * kept answer — the node refuses the URL, and without a fresh one the widget would turn into the node's refusal.
 *
 * The frame-grant fixture shortens the lifetime of the grants minted next, so the lapse takes seconds here. What these
 * prove, through a real browser and a real node:
 * - a reload after the lapse re-reads the instance for a fresh URL, once, and the widget runs again with its state;
 * - the lapsed URL, fetched on its own the way a copied link would be, is still refused;
 * - when the re-read fails as well, the failure is shown once, honestly, with a way to try again, and nothing loops.
 *
 * A grant in a URL is a credential. Nothing here prints one: URLs are compared, never written into an assertion message.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const EVIDENCE_DIR = join(process.cwd(), "plans", "reports", "evidence");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const NODE = `http://127.0.0.1:${NODE_PORT}`;

/** Long enough for the frame to open and save before it lapses, short enough to wait out. */
const SHORT_LIFETIME_MS = 6_000;

const SURFACE = "[data-pin-live] [data-widget-frame]";
const IFRAME = `${SURFACE} iframe`;
const LIVE_READ = /\/conversations\/[^/]+\/widgets\/[^/]+\/live$/;

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string") throw new Error("no local token");
  return parsed.localToken;
}

async function setLifetime(request: APIRequestContext, lifetimeMs: number | null): Promise<void> {
  const answer = await request.post(`${NODE}/frame-grant-fixture/lifetime`, {
    headers: { authorization: `Bearer ${token()}` },
    data: { lifetimeMs },
  });
  expect(answer.status(), "the node was started with the frame-grant fixture").toBe(200);
}

interface LiveReads {
  /** Reads of the live instance the page made since the count was last reset. */
  count: number;
  /** When set, the node is unreachable for these reads: each is answered 503 with this message. */
  failWith: string | undefined;
}

/**
 * Every read of the live instance, counted, and answered by the node without the bindings' service availability.
 *
 * A surface whose bindings report availability re-reads the instance every five seconds while it is on screen. That
 * poll is the surface's, not the frame's, and it never hands a running frame a new URL; left in, it would put reads
 * the frame never made into the one count these tests are about, at a moment that depends on the timer. Everything
 * else in the answer — the frame's URL and how long it lasts above all — is the node's own.
 */
async function interceptLiveReads(page: Page): Promise<LiveReads> {
  const reads: LiveReads = { count: 0, failWith: undefined };
  await page.route(LIVE_READ, async (route) => {
    const sent = route.request();
    if (sent.method() !== "GET") {
      await route.continue();
      return;
    }
    reads.count += 1;
    if (reads.failWith !== undefined) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "access-control-allow-origin": (await sent.headerValue("origin")) ?? "*" },
        body: JSON.stringify({ code: "NODE_BUSY", message: reads.failWith }),
      });
      return;
    }
    const answer = await route.fetch();
    const body = (await answer.json()) as { bindings?: Array<Record<string, unknown>> };
    if (Array.isArray(body.bindings)) {
      body.bindings = body.bindings.map(({ available: _available, unavailableReason: _reason, ...binding }) => binding);
    }
    await route.fulfill({ response: answer, json: body });
  });
  return reads;
}

/** Compose the fixture widget and open it, with the frames minted from here on lasting `SHORT_LIFETIME_MS`. */
async function openShortLivedFrame(page: Page, request: APIRequestContext): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(NODE)}`);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  const composer = page.locator("[data-composer='true']");
  await composer.waitFor();
  await composer.fill("widget cách ly");
  await composer.press("Enter");
  const open = page.locator("[data-open-live]").last();
  await expect(open).toBeVisible({ timeout: 20_000 });

  // Set just before the read that mints the frame's URL, so the lapse is counted from the frame opening.
  await setLifetime(request, SHORT_LIFETIME_MS);
  await open.click();
  await expect(page.locator(SURFACE)).toHaveAttribute("data-frame-status", "ready", { timeout: 20_000 });
}

async function frameUrl(page: Page): Promise<string> {
  const url = await page.locator(IFRAME).getAttribute("data-frame-url");
  if (url === null || url === "") throw new Error("the frame has no URL");
  return url;
}

/** Wait until the node refuses `url`: the grant has lapsed on the node's clock, which is the one that decides. */
async function waitForRefusal(request: APIRequestContext, url: string): Promise<void> {
  await expect
    .poll(async () => (await request.get(url)).status(), { timeout: SHORT_LIFETIME_MS + 10_000, intervals: [500] })
    .toBe(403);
}

/** What a browser reload of the frame does: the document navigates to its own URL again. */
async function reloadFrame(page: Page): Promise<void> {
  const frame = await (await page.locator(IFRAME).elementHandle())?.contentFrame();
  if (frame === null || frame === undefined) throw new Error("the frame has no document");
  // Scheduled rather than called, so the evaluation returns before the context it runs in is torn down.
  await frame.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });
}

/** The pinned surface in both themes, at desktop and phone width. The files are evidence, not committed. */
async function captureBothThemes(page: Page, surface: Locator, name: string): Promise<void> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveAttribute("data-cc-theme", colorScheme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      await surface.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(EVIDENCE_DIR, `233-${name}-${colorScheme}-${width}.png`) });
      // Nothing on the surface is wider than the viewport at either width.
      const overflow = await surface.evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

test.afterEach(async ({ request }) => {
  await setLifetime(request, null);
});

test("a frame reloaded after its URL lapsed reads a fresh URL once and runs again, with its state", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const reads = await interceptLiveReads(page);
  await openShortLivedFrame(page, request);
  const surface = page.locator(SURFACE);
  const document = page.frameLocator(IFRAME);

  // State the widget committed before the lapse, which the reloaded document must be handed again.
  await expect(document.locator("[data-widget-count]")).toHaveText("0", { timeout: 20_000 });
  await document.locator("[data-widget-increment]").click();
  await expect(document.locator("[data-widget-saved-state='saved']")).toBeVisible({ timeout: 20_000 });

  const lapsed = await frameUrl(page);
  expect((await request.get(lapsed)).status(), "the frame's URL works while its grant is fresh").toBe(200);
  await waitForRefusal(request, lapsed);

  const refusedDocuments: number[] = [];
  page.on("response", (answer) => {
    if (answer.request().resourceType() === "document" && answer.url().startsWith(`${NODE}/frame/`) && answer.status() === 403) {
      refusedDocuments.push(answer.status());
    }
  });
  reads.count = 0;

  await reloadFrame(page);

  // The browser's reload is refused by the node, and the frame answers that with a re-read and a fresh URL.
  await expect.poll(() => refusedDocuments.length, { timeout: 20_000 }).toBe(1);
  await expect(surface).toHaveAttribute("data-frame-status", "ready", { timeout: 20_000 });
  await expect(document.locator("[data-widget-title]")).toHaveText("Widget trong frame (fixture)");
  await expect(document.locator("[data-widget-count]")).toHaveText("1");
  await expect(surface.locator("[data-frame-failure]")).toHaveCount(0);
  await expect(page.locator(IFRAME)).toBeVisible();

  const fresh = await frameUrl(page);
  expect(fresh === lapsed, "the frame loads a freshly minted URL").toBe(false);
  // Exactly one re-read, and the fresh document was not refused.
  await page.waitForTimeout(1_000);
  expect(reads.count).toBe(1);
  expect(refusedDocuments).toHaveLength(1);

  // The lapsed URL stays refused however it is fetched: renewing the frame did not revive it.
  const copied = await request.get(lapsed);
  expect(copied.status()).toBe(403);
  expect(((await copied.json()) as { code?: unknown }).code).toBe("GRANT_EXPIRED");

  await captureBothThemes(page, page.locator("[data-pin-live]"), "frame-after-reload");
});

test("a lapsed frame URL fetched on its own is refused, with no bearer token to fall back on", async ({ page, request }) => {
  await openShortLivedFrame(page, request);
  const lapsed = await frameUrl(page);
  await waitForRefusal(request, lapsed);

  const refused = await request.get(lapsed);
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { code?: unknown }).code).toBe("GRANT_EXPIRED");

  // A bearer token does not stand in for the grant either: the frame route answers the grant alone.
  const withToken = await request.get(lapsed, { headers: { authorization: `Bearer ${token()}` } });
  expect(withToken.status()).toBe(403);
});

test("when the one re-read fails too, the failure is shown once with a way to try again, and nothing loops", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const reads = await interceptLiveReads(page);
  await openShortLivedFrame(page, request);
  const surface = page.locator(SURFACE);
  const lapsed = await frameUrl(page);
  await waitForRefusal(request, lapsed);

  // The node cannot answer the re-read.
  reads.count = 0;
  reads.failWith = "the node is busy (e2e)";

  await reloadFrame(page);

  await expect(surface).toHaveAttribute("data-frame-status", "failed", { timeout: 20_000 });
  const failure = surface.locator("[data-frame-failure]");
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute("role", "alert");
  await expect(failure.locator("[data-frame-failure-reason]")).toContainText("the node is busy (e2e)");
  // The node's refusal is never what the person sees.
  await expect(page.locator(IFRAME)).toBeHidden();

  // One re-read, then the failure — and no second attempt while it is on screen.
  await page.waitForTimeout(6_000);
  expect(reads.count).toBe(1);
  await expect(surface).toHaveAttribute("data-frame-status", "failed");

  await captureBothThemes(page, page.locator("[data-pin-live]"), "frame-reload-failed");
  expect(reads.count).toBe(1);

  // The person's retry is one more read; with the node answering again, the widget runs.
  reads.failWith = undefined;
  await failure.locator("[data-frame-retry]").click();
  await expect(surface).toHaveAttribute("data-frame-status", "ready", { timeout: 20_000 });
  await expect(page.frameLocator(IFRAME).locator("[data-widget-title]")).toHaveText("Widget trong frame (fixture)");
  await expect(surface.locator("[data-frame-failure]")).toHaveCount(0);
  expect(reads.count).toBe(2);
});
