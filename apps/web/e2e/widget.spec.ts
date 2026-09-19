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
  const uploaded = await fetch(`${GATEWAY}/images`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify({
      dataBase64: ONE_PIXEL_PNG,
      mimeType: "image/png",
      altText: "Một điểm ảnh, do bài kiểm thử này tải lên",
    }),
  });
  expect(uploaded.ok).toBe(true);

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

  await page.screenshot({ path: join(EVIDENCE, "widget-03-gallery.png"), fullPage: true });
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

