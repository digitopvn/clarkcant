import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * A conversation far longer than one timeline page, in a real browser against a real node.
 *
 * The claims here are about what only a browser can show: which rows are in the document, where the row being read is
 * on screen when older history is put in front of it, and whether the history moves while a reply streams. Each is a
 * count or a position measured in the page, never a duration, so a slow machine does not fail it and a fast one does
 * not hide a regression.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");
const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;
const MESSAGES = 1_200;
/** The message holding a fold a person can open, inside the newest page. */
const FOLD_AT = 1_100;
/** Generous for a 720px screen with a screen of rows mounted on either side; the history holds 1,200. */
const MOUNTED_BOUND = 90;

function token(): string {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") throw new Error("no local token for the e2e node");
  return parsed.localToken;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed: ${String(response.status)} ${text}`);
  return JSON.parse(text) as T;
}

/** Text of uneven length, so rows are of uneven height the way a chat's are. */
function wording(sequence: number): string {
  const filler = "Một đoạn văn bản dài hơn để hàng này cao hơn những hàng khác. ".repeat(sequence % 7 === 0 ? 12 : sequence % 3);
  return `Tin nhắn số ${String(sequence)}. ${filler}`.trim();
}

/** A conversation with `MESSAGES` stored messages, written straight into the node's store in one transaction. */
async function seedConversation(): Promise<{ conversationId: string; idOf: (sequence: number) => string }> {
  const conversation = await api<{ conversationId: string }>("POST", "/conversations", { title: "long conversation" });
  const run = Date.now().toString(36);
  const idOf = (sequence: number): string => `msg_long_${run}_${String(sequence)}`;
  const db = new DatabaseSync(join(DATA_DIR, "node.sqlite"));
  try {
    const insert = db.prepare(
      `INSERT INTO messages (message_id, conversation_id, role, author_node_id, task_id, delivery, document, sequence, created_at)
       VALUES (?, ?, ?, ?, NULL, 'accepted', ?, ?, ?)`,
    );
    db.exec("BEGIN");
    for (let sequence = 1; sequence <= MESSAGES; sequence += 1) {
      const messageId = idOf(sequence);
      const role = sequence % 2 === 1 ? "user" : "assistant";
      const createdAt = new Date(Date.UTC(2026, 9, 1, 0, 0, sequence)).toISOString();
      const blocks =
        sequence === FOLD_AT
          ? [{ type: "reasoning", content: "Suy luận được ghi lại cho hàng có thể mở ra." }, { type: "text", format: "markdown", content: wording(sequence) }]
          : [{ type: "text", format: "markdown", content: wording(sequence) }];
      insert.run(
        messageId,
        conversation.conversationId,
        role,
        "node_e2e_fixture",
        JSON.stringify({
          messageId,
          conversationId: conversation.conversationId,
          role,
          authorNodeId: "node_e2e_fixture",
          delivery: "accepted",
          createdAt,
          blocks,
        }),
        sequence,
        createdAt,
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return { conversationId: conversation.conversationId, idOf };
}

async function openConversation(page: Page, conversationId: string): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await page.evaluate((id) => window.sessionStorage.setItem("cc_conversation", id), conversationId);
  await page.reload();
  await expect(page.locator("[data-composer]")).toBeVisible();
}

const scroller = (page: Page): Locator => page.locator(".cc-scroll");
const rows = (page: Page): Locator => page.locator(".cc-transcript-rows");
const row = (page: Page, id: string): Locator => page.locator(`[data-row-id="${id}"]`);

/** Let the transcript react to a scroll: its window and its anchor follow on the next frames. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }),
  );
}

async function scrollTo(page: Page, top: number): Promise<void> {
  await scroller(page).evaluate((node, to) => node.scrollTo({ top: to, behavior: "instant" }), top);
  await settle(page);
}

async function scrollBy(page: Page, delta: number): Promise<void> {
  await scroller(page).evaluate((node, by) => node.scrollTo({ top: node.scrollTop + by, behavior: "instant" }), delta);
  await settle(page);
}

/** The mounted row ids, in document order. */
async function mountedIds(page: Page): Promise<string[]> {
  return page.locator("[data-row-id]").evaluateAll((slots) => slots.map((slot) => (slot as HTMLElement).dataset.rowId ?? ""));
}

/** The first row on screen, and its top relative to the top of the screen. */
async function rowBeingRead(page: Page): Promise<{ id: string; top: number }> {
  return scroller(page).evaluate((node) => {
    const top = node.getBoundingClientRect().top;
    for (const slot of node.querySelectorAll<HTMLElement>("[data-row-id]")) {
      const rect = slot.getBoundingClientRect();
      if (rect.bottom > top + 1) return { id: slot.dataset.rowId ?? "", top: rect.top - top };
    }
    throw new Error("no row is on screen");
  });
}

async function topOf(page: Page, id: string): Promise<number> {
  return scroller(page).evaluate(
    (node, rowId) => {
      const slot = node.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`);
      if (slot === null) throw new Error(`row ${rowId} is not mounted`);
      return slot.getBoundingClientRect().top - node.getBoundingClientRect().top;
    },
    id,
  );
}

/** Scroll in screen-sized steps until a row is mounted, as a reader would. */
async function scrollUntilMounted(page: Page, id: string, direction: -1 | 1): Promise<void> {
  for (let step = 0; step < 200; step += 1) {
    if ((await row(page, id).count()) > 0) return;
    await scrollBy(page, direction * 600);
  }
  throw new Error(`row ${id} was never mounted`);
}

test.describe.configure({ mode: "serial" });

test("reopens a long conversation on its newest messages with a bounded number of rows mounted", async ({ page }) => {
  const { conversationId, idOf } = await seedConversation();
  await openConversation(page, conversationId);

  await expect(rows(page)).toHaveAttribute("data-rows-total", "200");
  await expect(row(page, idOf(MESSAGES))).toBeInViewport();
  await expect(row(page, idOf(MESSAGES))).toContainText(`Tin nhắn số ${String(MESSAGES)}.`);
  const mounted = await mountedIds(page);
  expect(mounted.length).toBeLessThanOrEqual(MOUNTED_BOUND);
  expect(mounted.at(-1)).toBe(idOf(MESSAGES));
  // The rest of the page is there as room, not rows: the scrollbar still spans the whole page.
  await expect(page.locator(".cc-transcript-gap").first()).toHaveAttribute("data-visibility", "suspended");
});

test("puts an older page in front without moving the row being read", async ({ page }) => {
  const { conversationId, idOf } = await seedConversation();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  // The first older page is held until the row being read has been measured, so the prepend is the only change.
  await page.route(/\/timeline\?before=/u, async (route) => {
    if (!held) {
      held = true;
      await gate;
    }
    await route.continue();
  });
  await openConversation(page, conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-total", "200");

  const asked = page.waitForRequest(/\/timeline\?before=/u);
  // Up towards the top of the newest page, row by row, until it is near enough to read the page before it.
  for (let step = 0; step < 100 && !held; step += 1) await scrollBy(page, -900);
  await asked;
  await expect(page.locator('[data-history="loading"]')).toBeVisible();
  await settle(page);
  const before = await rowBeingRead(page);

  release();
  await expect(rows(page)).toHaveAttribute("data-rows-total", "400");
  await settle(page);
  expect(Math.abs((await topOf(page, before.id)) - before.top)).toBeLessThanOrEqual(2);
  await expect(page.locator('[data-history="loading"]')).toHaveCount(0);
  // Nothing was mounted twice across the seam.
  const mounted = await mountedIds(page);
  expect(new Set(mounted).size).toBe(mounted.length);
  expect(mounted).toContain(before.id);
  // The page put in front is room above the rows being read, not rows mounted out of sight.
  expect(mounted).not.toContain(idOf(801));
});

test("scrolls back to the first of 1,200 messages, every page merged once and the mounted rows bounded", async ({ page }) => {
  const { conversationId, idOf } = await seedConversation();
  await openConversation(page, conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-total", "200");

  let largest = 0;
  for (let step = 0; step < 300; step += 1) {
    await scrollBy(page, -2_400);
    const mounted = await mountedIds(page);
    expect(new Set(mounted).size).toBe(mounted.length);
    largest = Math.max(largest, mounted.length);
    if ((await rows(page).getAttribute("data-rows-total")) === String(MESSAGES) && (await row(page, idOf(1)).count()) > 0) break;
  }
  await expect(rows(page)).toHaveAttribute("data-rows-total", String(MESSAGES));
  await scrollTo(page, 0);
  await expect(row(page, idOf(1))).toBeInViewport();
  await expect(row(page, idOf(1))).toContainText("Tin nhắn số 1.");
  expect(largest).toBeLessThanOrEqual(MOUNTED_BOUND);
  // The history arrived in order: the mounted rows at the top are the first messages, in sequence.
  const top = await mountedIds(page);
  expect(top.slice(0, 5)).toEqual([1, 2, 3, 4, 5].map(idOf));
});

test("keeps a focused row mounted far from the screen, and an opened fold open when its row comes back", async ({ page }) => {
  const { conversationId, idOf } = await seedConversation();
  await openConversation(page, conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-total", "200");

  const target = idOf(FOLD_AT);
  await scrollUntilMounted(page, target, -1);
  const summary = row(page, target).locator('[data-reasoning="true"] > summary');
  await summary.scrollIntoViewIfNeeded();
  await summary.click();
  await expect(row(page, target).locator('[data-reasoning="true"]')).toHaveAttribute("open", "");
  await expect(summary).toBeFocused();

  // Far below it, at the newest message: the focused row is still in the document, focus still on it.
  await scrollTo(page, await scroller(page).evaluate((node) => node.scrollHeight));
  await expect(row(page, idOf(MESSAGES))).toBeInViewport();
  await expect(row(page, target)).toHaveCount(1);
  await expect(summary).toBeFocused();

  // Focus elsewhere lets it go like any row far from the screen.
  await page.locator("[data-composer]").focus();
  await scrollBy(page, -300);
  await expect(row(page, target)).toHaveCount(0);

  // Scrolled back to, it is mounted again with the fold the person opened still open.
  await scrollUntilMounted(page, target, -1);
  await expect(row(page, target).locator('[data-reasoning="true"]')).toHaveAttribute("open", "");
});

/** Hold the reply stream open, so the test decides when each frame arrives (see reasoning-writing.spec.ts). */
async function scriptReply(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!/\/conversations\/[^/]+\/messages\/stream/u.test(url)) return original(input, init);
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // SAFETY: the seam this spec opens on purpose; nothing in the application reads it.
          (window as unknown as { __scriptedReply?: unknown }).__scriptedReply = {
            push: (frame: string) => controller.enqueue(encoder.encode(frame)),
            end: () => controller.close(),
          };
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    };
  });
}

async function frame(page: Page, event: string, payload: unknown): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __scriptedReply?: unknown }).__scriptedReply !== undefined);
  await page.evaluate(
    ({ name, data }) => {
      // SAFETY: the seam installed by `scriptReply`.
      const seam = (window as unknown as { __scriptedReply?: { push: (frame: string) => void } }).__scriptedReply;
      if (seam === undefined) throw new Error("the scripted reply was never opened");
      seam.push(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    { name: event, data: payload },
  );
}

test("streaming leaves settled history untouched and does not pull a reader back down; new content is one press away", async ({
  page,
}) => {
  const { conversationId, idOf } = await seedConversation();
  await scriptReply(page);
  await openConversation(page, conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-total", "200");

  const composer = page.locator("[data-composer]");
  await composer.click();
  await composer.fill("một câu hỏi mới");
  await composer.press("Enter");
  await frame(page, "delta", { text: "Bắt đầu trả lời." });
  await expect(page.locator("[data-live]")).toBeVisible();
  await settle(page);

  // Every settled row on screen, watched while the reply streams.
  await page.evaluate(() => {
    const watched = { mutations: 0 };
    const observer = new MutationObserver((records) => {
      watched.mutations += records.length;
    });
    for (const settled of document.querySelectorAll(".cc-transcript-slot > .cc-row")) {
      observer.observe(settled, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    // SAFETY: a counter this spec reads back; nothing in the application reads it.
    (window as unknown as { __settledMutations?: unknown }).__settledMutations = watched;
  });
  for (let index = 0; index < 30; index += 1) await frame(page, "delta", { text: ` từ ${String(index)}` });
  await expect(page.locator("[data-live]")).toContainText("từ 29");
  expect(await page.evaluate(() => (window as unknown as { __settledMutations: { mutations: number } }).__settledMutations.mutations)).toBe(0);

  // Reading further up while the reply goes on: the view stays where the reader put it.
  await scrollBy(page, -3_000);
  const reading = await rowBeingRead(page);
  for (let index = 0; index < 10; index += 1) await frame(page, "delta", { text: ` thêm ${String(index)}` });
  await settle(page);
  expect(Math.abs((await topOf(page, reading.id)) - reading.top)).toBeLessThanOrEqual(2);

  // The turn ends with the node's newest page: two messages more than the reader has seen.
  const latest = await api<{ messages: unknown[]; window: { sequences: number[] } } & Record<string, unknown>>(
    "GET",
    `/conversations/${encodeURIComponent(conversationId)}/timeline?window=latest`,
  );
  const at = new Date().toISOString();
  const asked = { messageId: `${idOf(MESSAGES)}_asked`, role: "user", blocks: [{ type: "text", format: "markdown", content: "một câu hỏi mới" }], createdAt: at };
  const answered = { messageId: `${idOf(MESSAGES)}_answered`, role: "assistant", blocks: [{ type: "text", format: "markdown", content: "Câu trả lời đã xong." }], createdAt: at };
  await frame(page, "done", {
    resolution: "answered",
    taskId: null,
    messageIds: [answered.messageId],
    timeline: {
      ...latest,
      cursor: Number(latest.cursor ?? 0) + 2,
      messages: [...latest.messages, asked, answered],
      window: { ...latest.window, toSequence: MESSAGES + 2, hasNewer: false, sequences: [...latest.window.sequences, MESSAGES + 1, MESSAGES + 2] },
    },
  });
  await page.evaluate(() => {
    // SAFETY: the seam installed by `scriptReply`.
    (window as unknown as { __scriptedReply?: { end: () => void } }).__scriptedReply?.end();
  });
  await expect(page.locator("[data-live]")).toHaveCount(0);
  await settle(page);
  expect(Math.abs((await topOf(page, reading.id)) - reading.top)).toBeLessThanOrEqual(2);

  const jump = page.locator("[data-jump-latest]");
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(row(page, answered.messageId)).toBeInViewport();
  await expect(jump).toHaveCount(0);
  await expect(scroller(page)).toBeFocused();
  // What arrived at the end is announced; history mounted by scrolling is not.
  await expect(row(page, answered.messageId)).not.toHaveAttribute("aria-live", "off");
  await expect(row(page, idOf(MESSAGES))).toHaveAttribute("aria-live", "off");
});
