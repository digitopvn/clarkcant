import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test, type Page } from "@playwright/test";

/**
 * A widget rendered inside the conversation, in a real browser.
 *
 * This is the claim the whole view path exists to support, and it is the one that cannot be
 * checked from the node: over HTTP a `surface` block and its instance are just JSON, and JSON
 * that a client refuses to draw looks exactly like JSON that works. So this test drives the real
 * client against a real node and asserts that a *renderer* ran, not that a block arrived.
 *
 * The scripted recipe is used rather than a model turn on purpose. It needs no provider account,
 * so this runs in CI, and the widget it produces is the same catalog widget the model would ask
 * for through `show_view` — which is what makes it a fair proxy rather than a different code path.
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

/**
 * One transparent pixel, as a PNG.
 *
 * Written here rather than copied from another suite, because a picture is not the subject of this test: what
 * is being checked is that a reference the node minted resolves back to bytes, and one pixel does that.
 */
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";


function token(): string {
  const path = join(DATA_DIR, "identity.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    // The original error is attached rather than flattened into a string: when the node failed to
    // start, that error is the diagnosis and this message is only the context.
    throw new Error(`the node did not write its identity to ${path}`, { cause });
  }
  const parsed = JSON.parse(raw) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error(`no local token in ${path}`);
  }
  return parsed.localToken;
}

/** Open the app against the node this run started. The token is never logged. */
async function openApp(page: Page): Promise<void> {
  // The node's own suggestions are pinned to empty, so the four written chips are the ones on screen.
  //
  // This suite is about those chips - it clicks one by its text and expects what that chip opens. Once the node
  // can offer suggestions drawn from what a person was actually doing, which chips appear depends on what
  // happens to be in .data/e2e, so a test clicking a chip by text would be testing the database.
  await page.route("**/suggestions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("textarea[aria-label='Nhập tin nhắn']")).toBeVisible();
  // The status pill, not merely the textarea: the composer renders before the health check
  // answers, and sending a message to a node that is not up yet proves nothing.
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
}

/** The gateway, with the node's own token. Used to create records the way a client would. */
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

/**
 * Open one specific conversation.
 *
 * The app resumes the conversation it remembered in session storage — there is no query parameter for
 * it, deliberately, so a link cannot silently point someone at somebody else's conversation. So the
 * test sets what the app reads, then loads.
 */
async function openConversation(page: Page, conversationId: string): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await page.evaluate((id) => window.sessionStorage.setItem("cc_conversation", id), conversationId);
  await page.reload();
  await expect(page.locator("textarea[aria-label='Nhập tin nhắn']")).toBeVisible();
}

/** The conversation the browser is actively reading, captured from its own timeline request. */
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
  expect(response.ok(), "the node returns the live widget state with its timeline").toBe(true);
  const timeline = (await response.json()) as { instances?: { instanceId: string; state?: Record<string, unknown> }[] };
  return timeline.instances?.find((entry) => entry.instanceId === instanceId)?.state ?? {};
}

test("a scripted table recipe renders a real widget inside the conversation", async ({ page }) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await openApp(page);

  // The scripted table is the demo path: a typed message is answered with the node's own data now, so this
  // journey starts from the chip that says its data is a sample. Chip three is the table request.
  await page.locator("[data-suggestion]").nth(2).click();

  // A surface block that the client could not render falls back to its text alternative, and that
  // fallback is marked. Asserting the table is present *and* the fallback is absent is the
  // difference between "a widget was drawn" and "a widget was mentioned".
  const table = page.locator("table").first();
  await expect(table).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-widget-fallback='true']")).toHaveCount(0);

  // The dataset is the sample one, and the interface has to say so next to the view that uses it.
  await expect(page.locator("text=dữ liệu mẫu").first()).toBeVisible();

  // The rows come from the node's dataset rather than from the client's imagination.
  await expect(table.locator("tbody tr").first()).toBeVisible();

  await page.screenshot({ path: join(EVIDENCE, "widget-01-table-in-conversation.png"), fullPage: true });
});

test("a widget the client cannot render shows its text alternative instead of nothing", async ({ page }) => {
  // The complement of the first test, and the one that used to be vacuous: it asserted that an empty
  // conversation had no widgets, which is true and proves nothing about what happens when a widget
  // *is* there and the client cannot draw it. So this puts a real block in the store — a valid
  // surface whose definition no client ships — and asks the client to render it.
  //
  // If a missing renderer made the message disappear, history would lose the fact that something was
  // shown at all, so the fallback is a required behaviour rather than a consolation prize.
  const conversation = await api<{ conversationId: string }>("POST", "/conversations", { title: "unsupported view" });

  const db = new DatabaseSync(join(DATA_DIR, "node.sqlite"));
  try {
    const now = new Date().toISOString();
    // Unique per run: the e2e data directory is reused between runs, and a fixed id would collide
    // with the message the previous run left behind.
    const messageId = `msg_unsupported_view_${Date.now().toString(36)}`;
    const snapshotId = `wsnap_unsupported_${Date.now().toString(36)}`;
    db.prepare(
      `INSERT INTO messages (message_id, conversation_id, role, author_node_id, task_id, delivery, document, sequence, created_at)
       VALUES (?, ?, 'assistant', ?, NULL, 'accepted', ?, 1, ?)`,
    ).run(
      messageId,
      conversation.conversationId,
      "node_e2e_fixture",
      JSON.stringify({
        messageId,
        conversationId: conversation.conversationId,
        role: "assistant",
        authorNodeId: "node_e2e_fixture",
        delivery: "accepted",
        createdAt: now,
        blocks: [
          {
            type: "surface",
            definitionRef: { id: "canvas.quantum@1", version: "9.9.9" },
            snapshot: {
              snapshotId,
              instanceId: "winst_unsupported_view",
              messageId,
              capturedRevision: 1,
              capturedAt: now,
              textAlternative: "Một bảng lượng tử mà client này không có renderer cho nó.",
              presentationRef: "catalog:canvas.quantum@1",
              stale: false,
            },
          },
        ],
      }),
      now,
    );
  } finally {
    db.close();
  }

  await openConversation(page, conversation.conversationId);
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });

  // The message is readable and the fallback is what is shown — not a blank card, and not the
  // renderer that does not exist.
  await expect(page.locator("[data-widget-fallback='true']").first()).toContainText("bảng lượng tử");
  await expect(page.locator("[data-surface-composition]")).toHaveCount(0);

  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: join(EVIDENCE, "widget-02-unknown-renderer-fallback.png"), fullPage: true });
});

test("a gallery widget draws pictures the node actually holds", async ({ page }) => {
  // The pictures come from the node's own storage rather than from the fixture carrying its own, because a
  // fixture with its own image data would prove that a renderer ran and nothing about whether the host can
  // resolve a reference it minted. The upload goes through the production route with the node's own token, so
  // this is the path a person's imported picture takes.
  for (const altText of ["First gallery image", "Second gallery image"]) {
    const uploaded = await api<{ image: { imageId: string } }>("POST", "/images", {
      dataBase64: ONE_PIXEL_PNG,
      mimeType: "image/png",
      altText,
    });
    expect(uploaded.image.imageId).not.toBe("");
  }

  const conversation = watchConversation(page);
  await openApp(page);
  await page.locator("[data-composer]").click();
  await page.keyboard.type("thư viện ảnh");
  await page.keyboard.press("Enter");

  const frame = page.locator('[data-widget-role="media"]').first();
  await expect(frame).toBeVisible({ timeout: 20_000 });

  // A drawn picture rather than the text alternative: the alternative is what a client that could not resolve
  // the reference shows, and that looks like a widget in a screenshot.
  const image = frame.locator("img[data-image-ref]").first();
  await expect(image).toBeVisible();
  const source = await image.getAttribute("src");
  // A blob URL rather than an address: an `<img>` cannot carry the bearer token, so the bytes are fetched
  // through the authenticated client and handed to the DOM as a blob. Asserting an http address here would
  // assert the one thing that must not happen.
  expect(source ?? "").toMatch(/^blob:/);
  expect(await frame.locator("[data-widget-fallback='true']").count()).toBe(0);

  const selection = frame.locator(".cc-gallery-select").nth(1);
  await expect(selection).toBeVisible();
  const selectedAlt = await selection.getAttribute("aria-label");
  // Chosen from the keyboard, with the focus ring still visible over the selected picture's ring.
  await selection.focus();
  await page.keyboard.press("Enter");
  expect(await selection.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  await expect(selection).toHaveAttribute("aria-pressed", "true");
  const instanceId = await frame.evaluate((element) => element.closest("[data-widget-instance]")?.getAttribute("data-widget-instance") ?? "");
  expect(instanceId).not.toBe("");
  await expect.poll(() => heldWidgetState(page, conversation(), instanceId)).toMatchObject({ selectedIndex: 1 });

  await page.locator("[data-composer='true']").fill("kiểm tra giao diện");
  await page.locator("[data-composer='true']").press("Enter");
  const inspection = page.locator('[data-role="assistant"]').last();
  await expect(inspection).toContainText('selectedIndex: 2', { timeout: 20_000 });
  if (selectedAlt !== null) await expect(inspection).toContainText(selectedAlt);

  await page.screenshot({ path: join(EVIDENCE, "widget-03-gallery.png"), fullPage: true });
});

test("a carousel selection reaches the next turn and survives pin restore", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  for (const altText of ["First carousel image", "Second carousel image"]) {
    const uploaded = await api<{ image: { imageId: string } }>("POST", "/images", {
      dataBase64: ONE_PIXEL_PNG,
      mimeType: "image/png",
      altText,
    });
    expect(uploaded.image.imageId).not.toBe("");
  }

  const conversation = watchConversation(page);
  await openApp(page);
  const composer = page.locator("[data-composer='true']");
  await composer.fill("đặt bộ ảnh");
  await composer.press("Enter");

  const carousel = page.locator("[data-carousel-index]").last();
  await expect(carousel).toBeVisible({ timeout: 20_000 });
  await expect(carousel.locator(".cc-carousel-controls button")).toHaveCount(2);
  await expect(carousel.locator(".cc-carousel-controls .cc-freshness")).toHaveText("1/2");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const next = carousel.locator(".cc-carousel-controls button").last();
  await next.focus();
  expect(await next.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(carousel).toHaveAttribute("data-carousel-index", "1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  const selectedAlt = await carousel.locator("figcaption").textContent();
  expect(selectedAlt).not.toBeNull();

  const instanceId = await carousel.evaluate((element) => element.closest("[data-widget-instance]")?.getAttribute("data-widget-instance") ?? "");
  expect(instanceId).not.toBe("");
  await expect.poll(() => heldWidgetState(page, conversation(), instanceId)).toMatchObject({ selectedIndex: 1 });

  await composer.fill("giao diện đang cho thấy gì");
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(selectedAlt ?? "", { timeout: 20_000 });

  await page.locator(`[data-pin-instance='${instanceId}']`).click();
  await expect(page.locator("[data-pin-shelf] [data-pin-definition='canvas.carousel@1']")).toBeVisible();
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-pin-shelf] [data-pin-definition='canvas.carousel@1']")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-carousel-index]").last()).toHaveAttribute("data-carousel-index", "1", { timeout: 20_000 });
  await expect.poll(() => heldWidgetState(page, conversation(), instanceId)).toMatchObject({ selectedIndex: 1 });
});

/**
 * The page's media policy, read from the document the browser actually loaded.
 *
 * A local video reaches `<video>` as an object URL the client made from bytes it fetched with the node's token, so the
 * policy must allow `blob:` for media - and nothing more: no remote media origin, no `data:`.
 */
async function mediaPolicy(page: Page): Promise<string[]> {
  const content = await page.locator("meta[http-equiv='Content-Security-Policy']").getAttribute("content");
  const directive = (content ?? "").split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("media-src "));
  return directive === undefined ? [] : directive.split(/\s+/u).slice(1);
}

/**
 * A short real clip for the local-video journey: eight seconds of a VP8 test pattern, no audio.
 *
 * Made with `ffmpeg -f lavfi -i testsrc=duration=8:size=96x64:rate=10 -c:v libvpx -b:v 40k -g 10 -an`. The node has no
 * video import yet, so the journey answers the one reference the fixture places; the authenticated fetch, the object
 * URL, the page policy, the player and the state the node holds are the production path.
 */
const LOCAL_CLIP = readFileSync(join(process.cwd(), "apps", "web", "e2e", "fixtures", "media", "local-clip.webm"));
const LOCAL_CLIP_REF = "video_e2e_local_clip";

test("a paused local video is read back by inspect_ui and restored without playing", async ({ page }) => {
  test.setTimeout(90_000);
  let authorized = true;
  await page.route(`${GATEWAY}/images/${LOCAL_CLIP_REF}`, (route) => {
    // The bytes are requested through the same authenticated client as every picture; a bare request would be a
    // different path.
    if (route.request().headers().authorization !== `Bearer ${token()}`) authorized = false;
    return route.fulfill({ status: 200, contentType: "video/webm", body: LOCAL_CLIP });
  });

  const conversation = watchConversation(page);
  await openApp(page);
  expect(await mediaPolicy(page), "media plays only from the page itself and object URLs it created").toEqual(["'self'", "blob:"]);

  const composer = page.locator("[data-composer='true']");
  await composer.fill("đặt video cục bộ");
  await composer.press("Enter");

  const video = page.locator(`video[data-video-ref='${LOCAL_CLIP_REF}']`).last();
  await expect(video).toBeVisible({ timeout: 20_000 });
  expect(await video.getAttribute("src")).toMatch(/^blob:/u);
  // The policy let the object URL load: the player read the clip's own duration rather than refusing the source.
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.error?.code ?? 0)).toBe(0);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => Math.round(element.duration)), { timeout: 15_000 }).toBe(8);
  expect(authorized).toBe(true);
  expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);

  const instanceId = await video.evaluate((element) => element.closest("[data-widget-instance]")?.getAttribute("data-widget-instance") ?? "");
  expect(instanceId).not.toBe("");

  await video.evaluate((element: HTMLVideoElement) => element.play());
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(1.5);
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  const pausedAt = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
  expect(pausedAt).toBeGreaterThan(1.5);
  expect(pausedAt).toBeLessThan(8);

  // The pause is flushed at once, not held for the next interval.
  await expect.poll(() => heldWidgetState(page, conversation(), instanceId)).toMatchObject({ status: "paused", duration: 8 });
  const held = await heldWidgetState(page, conversation(), instanceId);
  expect(Math.abs(Number(held.position) - pausedAt)).toBeLessThan(0.05);

  await composer.fill("kiểm tra giao diện");
  await composer.press("Enter");
  const inspection = page.locator('[data-role="assistant"]').last();
  await expect(inspection).toContainText('status: "paused"', { timeout: 20_000 });
  await expect(inspection).toContainText(`position: ${String(Math.round(pausedAt * 10) / 10)}`);
  await expect(inspection).toContainText("Đoạn phim thử tám giây");

  // At a phone's width the player stays inside the conversation, with nothing scrolling sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);

  // Pinned, then the page reloaded: both players reopen where it stopped, and neither starts playing.
  await page.locator(`[data-pin-instance='${instanceId}']`).click();
  await expect(page.locator("[data-pin-shelf] [data-pin-definition='canvas.video@1']")).toBeVisible();
  await page.reload();
  await expect(page.locator("text=Ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-pin-shelf] [data-pin-definition='canvas.video@1']")).toBeVisible({ timeout: 20_000 });
  const restored = page.locator(`video[data-video-ref='${LOCAL_CLIP_REF}']`);
  await expect(restored.first()).toBeVisible({ timeout: 20_000 });
  for (const player of await restored.all()) {
    await expect.poll(() => player.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(1.5);
    expect(Math.abs((await player.evaluate((element: HTMLVideoElement) => element.currentTime)) - Number(held.position))).toBeLessThan(0.15);
    expect(await player.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  }
  // A restore is not a write: the node still holds the paused position it was given.
  expect(await heldWidgetState(page, conversation(), instanceId)).toMatchObject({ status: "paused", position: held.position });

  await page.screenshot({ path: join(EVIDENCE, "widget-05-local-video.png"), fullPage: true });
});

test("a youtube widget embeds the video the host named, and nothing else", async ({ page }) => {
  await openApp(page);
  await page.locator("[data-composer]").click();
  await page.keyboard.type("video youtube");
  await page.keyboard.press("Enter");

  const frame = page.locator('[data-widget-role="media"]').first();
  await expect(frame).toBeVisible({ timeout: 20_000 });

  const iframe = frame.locator("iframe[data-video-id]");
  await expect(iframe).toBeVisible();
  const source = await iframe.getAttribute("src");
  // The address is the host's, built from the identifier it validated. Asserting both halves is the point:
  // a client that embedded a `src` the model supplied would satisfy the first and fail the second.
  expect(source ?? "").toContain("youtube-nocookie.com/embed/");
  expect(await iframe.getAttribute("data-video-id")).toBe("dQw4w9WgXcQ");

  await page.screenshot({ path: join(EVIDENCE, "widget-04-youtube.png"), fullPage: true });
});
