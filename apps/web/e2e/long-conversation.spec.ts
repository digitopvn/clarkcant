import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { widgetInstanceSchema, widgetSnapshotSchema } from "../../../packages/contracts/src/index.ts";
import { PRESENTATION_RETENTION } from "../../../packages/conversation-client/src/presentation-retention.ts";
import { definitionDigest } from "../../../packages/widget-host/src/index.ts";
import { IMAGE } from "../../../packs/data-canvas/src/index.ts";

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

function identity(): { localToken: string; nodeId: string; ownerPrincipalId: string } {
  const parsed = JSON.parse(readFileSync(join(DATA_DIR, "identity.json"), "utf8")) as Record<string, unknown>;
  const { localToken, nodeId, ownerPrincipalId } = parsed;
  if (typeof localToken !== "string" || localToken === "") throw new Error("no local token for the e2e node");
  if (typeof nodeId !== "string" || typeof ownerPrincipalId !== "string") throw new Error("the e2e node's identity names no node or owner");
  return { localToken, nodeId, ownerPrincipalId };
}

function token(): string {
  return identity().localToken;
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

interface SeededMessage {
  role: "user" | "assistant";
  blocks: Record<string, unknown>[];
}

/**
 * A conversation with `count` stored messages, written straight into the node's store in one transaction.
 *
 * `write` gives each message its role and blocks, and may write the records a block names (an instance, a snapshot)
 * through the same open store, so a message and what it draws land together.
 */
async function seed(
  count: number,
  write: (input: { db: DatabaseSync; sequence: number; messageId: string; createdAt: string }) => SeededMessage,
  run = Date.now().toString(36),
): Promise<{ conversationId: string; idOf: (sequence: number) => string }> {
  const conversation = await api<{ conversationId: string }>("POST", "/conversations", { title: "long conversation" });
  const idOf = (sequence: number): string => `msg_long_${run}_${String(sequence)}`;
  const db = new DatabaseSync(join(DATA_DIR, "node.sqlite"));
  try {
    const insert = db.prepare(
      `INSERT INTO messages (message_id, conversation_id, role, author_node_id, task_id, delivery, document, sequence, created_at)
       VALUES (?, ?, ?, ?, NULL, 'accepted', ?, ?, ?)`,
    );
    db.exec("BEGIN");
    for (let sequence = 1; sequence <= count; sequence += 1) {
      const messageId = idOf(sequence);
      const createdAt = new Date(Date.UTC(2026, 9, 1, 0, 0, sequence)).toISOString();
      const { role, blocks } = write({ db, sequence, messageId, createdAt });
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

/** A conversation of `MESSAGES` text messages, one of them holding a fold a person can open. */
async function seedConversation(): Promise<{ conversationId: string; idOf: (sequence: number) => string }> {
  return seed(MESSAGES, ({ sequence }) => ({
    role: sequence % 2 === 1 ? "user" : "assistant",
    blocks:
      sequence === FOLD_AT
        ? [{ type: "reasoning", content: "Suy luận được ghi lại cho hàng có thể mở ra." }, { type: "text", format: "markdown", content: wording(sequence) }]
        : [{ type: "text", format: "markdown", content: wording(sequence) }],
  }));
}

/**
 * Every row of it is mounted: no spacer stands for a row, so no estimate of a row's height catching up with what was
 * measured moves the view, and the moves a test makes are the only ones.
 */
const SHORT_MESSAGES = 40;

async function seedShortConversation(): Promise<{ conversationId: string; idOf: (sequence: number) => string }> {
  return seed(SHORT_MESSAGES, ({ sequence }) => ({
    role: sequence % 2 === 1 ? "user" : "assistant",
    blocks: [{ type: "text", format: "markdown", content: wording(sequence) }],
  }));
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

/**
 * End a scripted turn with the node's newest page plus the two messages the turn added, as the node's `done` does.
 *
 * The two are not written to the store: the page is what the client is told, which is what these claims are about.
 */
async function finishTurn(
  page: Page,
  conversationId: string,
  prefix: string,
): Promise<{ asked: { messageId: string }; answered: { messageId: string } }> {
  const latest = await api<{ messages: unknown[]; window: { sequences: number[] } } & Record<string, unknown>>(
    "GET",
    `/conversations/${encodeURIComponent(conversationId)}/timeline?window=latest`,
  );
  const at = new Date().toISOString();
  const asked = { messageId: `${prefix}_asked`, role: "user", blocks: [{ type: "text", format: "markdown", content: "một câu hỏi mới" }], createdAt: at };
  const answered = { messageId: `${prefix}_answered`, role: "assistant", blocks: [{ type: "text", format: "markdown", content: "Câu trả lời đã xong." }], createdAt: at };
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
  return { asked, answered };
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
  const { answered } = await finishTurn(page, conversationId, idOf(MESSAGES));
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

/** Remember a row's element, so a later check can tell whether it is the same node or a remounted one. */
async function rememberRow(page: Page, name: string, id: string): Promise<void> {
  await row(page, id).evaluate((slot, key) => {
    // SAFETY: a registry this spec reads back; nothing in the application reads it.
    const holder = window as unknown as { __keptRows?: Record<string, Element> };
    holder.__keptRows ??= {};
    holder.__keptRows[key] = slot;
  }, name);
}

async function sameRow(page: Page, name: string, id: string): Promise<boolean> {
  return row(page, id).evaluate(
    (slot, key) => (window as unknown as { __keptRows?: Record<string, Element> }).__keptRows?.[key] === slot,
    name,
  );
}

async function toNewest(page: Page): Promise<void> {
  await scrollTo(page, await scroller(page).evaluate((node) => node.scrollHeight));
}

test("rows a person is using stay the same nodes while spacers come and go around them", async ({ page }) => {
  const { conversationId, idOf } = await seedConversation();
  await openConversation(page, conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-total", "200");
  const newest = idOf(MESSAGES);
  await expect(row(page, newest)).toBeInViewport();
  await rememberRow(page, "newest", newest);
  // Its entrance, kept to compare: a row that entered again would carry another one.
  await row(page, newest).evaluate((slot) => {
    // SAFETY: a registry this spec reads back; nothing in the application reads it.
    (window as unknown as { __entrances?: Animation[] }).__entrances = slot.getAnimations({ subtree: true });
  });

  // A focused fold, and a passage selected in another row.
  const focused = idOf(FOLD_AT);
  await scrollUntilMounted(page, focused, -1);
  const summary = row(page, focused).locator('[data-reasoning="true"] > summary');
  await summary.scrollIntoViewIfNeeded();
  await summary.focus();
  await expect(summary).toBeFocused();
  await rememberRow(page, "focused", focused);
  const selected = idOf(FOLD_AT - 2);
  await scrollUntilMounted(page, selected, -1);
  await rememberRow(page, "selected", selected);
  const passage = await row(page, selected).evaluate((slot) => {
    const text = slot.querySelector(".cc-row p");
    if (text === null) throw new Error("no passage to select");
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return selection?.toString() ?? "";
  });
  expect(passage).toContain(`Tin nhắn số ${String(FOLD_AT - 2)}.`);

  // Far above all three, then back to the newest: every spacer between them appeared and went again.
  for (let step = 0; step < 6; step += 1) await scrollBy(page, -2_400);
  await expect(page.locator(".cc-transcript-gap")).not.toHaveCount(0);
  for (const id of [newest, focused, selected]) await expect(row(page, id)).toHaveCount(1);
  await toNewest(page);
  await expect(row(page, newest)).toBeInViewport();

  expect(await sameRow(page, "newest", newest)).toBe(true);
  expect(await sameRow(page, "focused", focused)).toBe(true);
  expect(await sameRow(page, "selected", selected)).toBe(true);
  await expect(summary).toBeFocused();
  expect(await page.evaluate(() => document.getSelection()?.toString() ?? "")).toBe(passage);
  // The newest row did not enter a second time.
  expect(
    await row(page, newest).evaluate((slot) => {
      const before = (window as unknown as { __entrances?: Animation[] }).__entrances ?? [];
      return slot.getAnimations({ subtree: true }).every((animation) => before.includes(animation));
    }),
  ).toBe(true);
});

test("a playing row, and the row of the embedded frame last used, stay mounted far from the screen", async ({ page }) => {
  const { conversationId, idOf } = await seedConversation();
  await openConversation(page, conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-total", "200");

  // A player's play event, as a real player in the row raises it (the transcript listens in the capture phase).
  const playing = idOf(MESSAGES - 40);
  await scrollUntilMounted(page, playing, -1);
  await row(page, playing).evaluate((slot) => slot.querySelector(".cc-row")?.dispatchEvent(new Event("play")));
  // An embedded frame, used: focus goes into a document of its own and this one only sees the window blur.
  const embedded = idOf(MESSAGES - 44);
  await scrollUntilMounted(page, embedded, -1);
  await row(page, embedded).evaluate((slot) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("data-test-embed", "true");
    frame.srcdoc = "<button>phát</button>";
    slot.querySelector(".cc-row")?.append(frame);
  });
  await page.frameLocator('[data-test-embed="true"]').locator("button").click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("IFRAME");

  await toNewest(page);
  await expect(row(page, playing)).toHaveCount(1);
  await expect(row(page, embedded)).toHaveCount(1);

  // Focus back in the page: the embed's row is still the one last used, so it stays.
  await page.locator("[data-composer]").focus();
  await scrollBy(page, -300);
  await expect(row(page, embedded)).toHaveCount(1);
  // Paused, the playing row goes like any row far from the screen.
  await row(page, playing).evaluate((slot) => slot.querySelector(".cc-row")?.dispatchEvent(new Event("pause")));
  await scrollBy(page, 300);
  await expect(row(page, playing)).toHaveCount(0);
});

test("a row that arrived is announced once, and not again when it is mounted again", async ({ page }) => {
  const { conversationId, idOf } = await seedConversation();
  await scriptReply(page);
  await openConversation(page, conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-total", "200");

  const composer = page.locator("[data-composer]");
  await composer.click();
  await composer.fill("một câu hỏi mới");
  await composer.press("Enter");
  await frame(page, "delta", { text: "Trả lời." });
  const { asked, answered } = await finishTurn(page, conversationId, idOf(MESSAGES));
  await expect(row(page, asked.messageId)).toBeInViewport();
  await expect(row(page, asked.messageId)).not.toHaveAttribute("aria-live", "off");
  await expect(row(page, answered.messageId)).not.toHaveAttribute("aria-live", "off");

  // Away and back: the question is mounted again as history; the newest row never left.
  for (let step = 0; step < 4; step += 1) await scrollBy(page, -2_400);
  await expect(row(page, asked.messageId)).toHaveCount(0);
  await toNewest(page);
  await expect(row(page, asked.messageId)).toBeInViewport();
  await expect(row(page, asked.messageId)).toHaveAttribute("aria-live", "off");
  await expect(row(page, asked.messageId)).toHaveAttribute("data-enter", "none");
  await expect(row(page, answered.messageId)).not.toHaveAttribute("aria-live", "off");
});

test("an answer drawn before the browser reports a scroll up does not take the reader back down", async ({ page }) => {
  const { conversationId } = await seedConversation();
  await openConversation(page, conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-total", "200");
  // The scripted proposal: a card whose answer, once decided, is a message more in the transcript.
  await page.locator("[data-composer]").fill("chạy lệnh thử");
  await page.locator("[data-send]").click();
  const card = page.locator('[data-host-card="approval"][data-decision="pending"]').last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await settle(page);

  // The decision's answer is held, so it arrives at a moment this test chooses.
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let answered = false;
  await page.route("**/approvals/*/decide", async (route) => {
    await held;
    await route.continue();
    answered = true;
  });
  await card.locator("[data-deny]").click();
  // The reader is at the bottom, following, and the browser has said so.
  await scroller(page).evaluate((node) => node.scrollTo({ top: node.scrollHeight, behavior: "instant" }));
  await settle(page);

  // A browser reports a scroll on its next frame, so an answer can be drawn between a scroll and its report: what a
  // reader's scroll up, or a `scrollIntoView` before a press, looks like when the answer lands in that gap. The report
  // is held back here until the answer is drawn.
  await holdScrollReports(page);
  await scroller(page).evaluate((node) => node.scrollTo({ top: node.scrollTop - 900, behavior: "instant" }));
  const reading = await rowBeingRead(page);
  release();
  await expect.poll(() => answered).toBe(true);
  await expect(page.locator('[data-tool-name="decide_approval"]').last()).toBeAttached({ timeout: 20_000 });
  await settle(page);
  expect(Math.abs((await topOf(page, reading.id)) - reading.top)).toBeLessThanOrEqual(2);

  // Once the scroll is reported, the answer counts as arrived below the reader, so the way back to it is offered.
  await releaseScrollReports(page);
  await expect(page.locator("[data-jump-latest]")).toBeVisible();
});

/** How far the view is above the bottom of the transcript. */
async function distanceToBottom(page: Page): Promise<number> {
  return scroller(page).evaluate((node) => Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight));
}

/**
 * Hold back every scroll report until `releaseScrollReports`: a browser reports a scroll on its next frame, and this is
 * what a page looks like when something is drawn inside that gap.
 */
async function holdScrollReports(page: Page): Promise<void> {
  await page.evaluate(() => {
    // SAFETY: a switch this spec reads; nothing in the application reads it.
    const holder = window as unknown as { __holdScrollReports?: boolean };
    holder.__holdScrollReports = true;
    document.addEventListener(
      "scroll",
      (event) => {
        if (holder.__holdScrollReports === true) event.stopImmediatePropagation();
      },
      { capture: true },
    );
  });
}

async function releaseScrollReports(page: Page): Promise<void> {
  await scroller(page).evaluate((node) => {
    (window as unknown as { __holdScrollReports?: boolean }).__holdScrollReports = false;
    node.dispatchEvent(new Event("scroll"));
  });
}

/**
 * Collapse the rows just above the screen, at least 200px of them, as folds closing or pictures failing to load would,
 * and return how far that moved the view up: the transcript keeps the row being read in place, so the view goes up with
 * what shrank.
 *
 * With `growBelow`, the streamed reply below is made taller by more than that in the same task, so the two changes land
 * in one layout and the view is never at the bottom for the browser to pull up: the move is the transcript's own.
 */
async function collapseRowsAbove(page: Page, { growBelow = false } = {}): Promise<number> {
  const before = await scroller(page).evaluate((node) => node.scrollTop);
  const collapsed = await scroller(page).evaluate((node, grow) => {
    const top = node.getBoundingClientRect().top;
    const above = [...node.querySelectorAll<HTMLElement>("[data-row-id]")].filter((slot) => slot.getBoundingClientRect().bottom <= top);
    // Every height is read before anything is changed: a read after a change would lay the page out in between.
    const hidden: HTMLElement[] = [];
    let height = 0;
    for (const slot of above.reverse()) {
      const content = slot.querySelector<HTMLElement>(".cc-row");
      if (content === null) continue;
      height += content.getBoundingClientRect().height;
      hidden.push(content);
      if (height >= 200) break;
    }
    const live = grow ? node.querySelector<HTMLElement>("[data-live]") : null;
    if (grow && live === null) throw new Error("no reply is being written");
    for (const content of hidden) content.style.display = "none";
    if (live !== null) live.style.paddingBottom = `${String(height + 200)}px`;
    return height;
  }, growBelow);
  expect(collapsed).toBeGreaterThanOrEqual(200);
  await settle(page);
  return before - (await scroller(page).evaluate((node) => node.scrollTop));
}

test("rows above the screen collapsing while a reply arrives do not stop the transcript following it", async ({ page }) => {
  const { conversationId } = await seedConversation();
  await scriptReply(page);
  await openConversation(page, conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-total", "200");
  await startReply(page);

  // The rows above collapse, and the reply goes on, before the browser reports the moves that kept the row being read in
  // place. Those moves are the transcript's, not the reader's: the reader never left the bottom.
  await holdScrollReports(page);
  expect(await collapseRowsAbove(page)).toBeGreaterThan(48);
  await expect.poll(() => distanceToBottom(page)).toBeLessThanOrEqual(2);
  for (const marker of ["đoạn một", "đoạn hai", "đoạn ba", "đoạn bốn"]) {
    await growReply(page, marker);
    await expect.poll(() => distanceToBottom(page)).toBeLessThanOrEqual(2);
  }

  // Once the moves are reported, the reader is still following: the reply keeps being followed as it grows.
  await releaseScrollReports(page);
  await growReply(page, "đoạn năm");
  await expect.poll(() => distanceToBottom(page)).toBeLessThanOrEqual(2);
});

test("more of the reply arriving while the transcript glides down to it is followed too", async ({ page }) => {
  const { conversationId } = await seedConversation();
  await scriptReply(page);
  await openConversation(page, conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-total", "200");
  await startReply(page);

  // The reply grows and the transcript glides down to it. A step of the glide is reported while the view is still more
  // than the slack from the bottom, and more of the reply lands before the glide ends: the reader never left the bottom.
  const reportedAt = await page.evaluate(async (texts) => {
    // SAFETY: the seam installed by `scriptReply`.
    const seam = (window as unknown as { __scriptedReply: { push: (frame: string) => void } }).__scriptedReply;
    const node = document.querySelector<HTMLElement>(".cc-scroll");
    if (node === null) throw new Error("no transcript");
    const distance = (): number => node.scrollHeight - node.scrollTop - node.clientHeight;
    const start = node.scrollTop;
    // Listened to after the transcript's own listeners, so a step heard here has been reported to them.
    const reported = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no step of the glide was reported far from the bottom")), 5_000);
      const onScroll = (): void => {
        if (node.scrollTop <= start || distance() <= 48) return;
        node.removeEventListener("scroll", onScroll);
        clearTimeout(timer);
        resolve(distance());
      };
      node.addEventListener("scroll", onScroll);
    });
    seam.push(`event: delta\ndata: ${JSON.stringify({ text: texts[0] })}\n\n`);
    const at = await reported;
    seam.push(`event: delta\ndata: ${JSON.stringify({ text: texts[1] })}\n\n`);
    return at;
  }, [paragraph("đoạn một"), paragraph("đoạn hai")]);
  expect(reportedAt).toBeGreaterThan(48);
  await expect(page.locator("[data-live]")).toContainText("đoạn hai");
  await settle(page);
  await expect.poll(() => distanceToBottom(page)).toBeLessThanOrEqual(2);
});

test("a reader's small scroll up while the transcript glides down to the reply is not taken back down", async ({ page }) => {
  const { conversationId } = await seedConversation();
  await scriptReply(page);
  await openConversation(page, conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-total", "200");
  await startReply(page);
  await holdScrollReports(page);
  await page.evaluate(() => {
    (window as unknown as { __holdScrollReports?: boolean }).__holdScrollReports = false;
  });

  // The reply grows and the transcript glides down to it. A step of the glide is reported while the view is still more
  // than the slack from the bottom; then the reader scrolls up by less than the slack, and more of the reply is drawn
  // before the browser reports that scroll. The reader left the bottom, however little.
  const reading = await page.evaluate(async (texts) => {
    // SAFETY: the seam installed by `scriptReply`.
    const seam = (window as unknown as { __scriptedReply: { push: (frame: string) => void } }).__scriptedReply;
    const holder = window as unknown as { __holdScrollReports?: boolean };
    const node = document.querySelector<HTMLElement>(".cc-scroll");
    if (node === null) throw new Error("no transcript");
    const distance = (): number => node.scrollHeight - node.scrollTop - node.clientHeight;
    const start = node.scrollTop;
    // Listened to after the transcript's own listeners, so a step heard here has been reported to them.
    const stepped = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no step of the glide was reported far from the bottom")), 5_000);
      const onScroll = (): void => {
        if (node.scrollTop <= start || distance() <= 48) return;
        node.removeEventListener("scroll", onScroll);
        clearTimeout(timer);
        resolve();
      };
      node.addEventListener("scroll", onScroll);
    });
    seam.push(`event: delta\ndata: ${JSON.stringify({ text: texts[0] })}\n\n`);
    await stepped;
    holder.__holdScrollReports = true;
    node.scrollTo({ top: node.scrollTop - 30, behavior: "instant" });
    const top = node.getBoundingClientRect().top;
    let read: { id: string; top: number } | undefined;
    for (const slot of node.querySelectorAll<HTMLElement>("[data-row-id]")) {
      const rect = slot.getBoundingClientRect();
      if (rect.bottom > top + 1) {
        read = { id: slot.dataset.rowId ?? "", top: rect.top - top };
        break;
      }
    }
    if (read === undefined) throw new Error("no row is on screen");
    seam.push(`event: delta\ndata: ${JSON.stringify({ text: texts[1] })}\n\n`);
    return read;
  }, [paragraph("đoạn một"), paragraph("đoạn hai")]);
  await expect(page.locator("[data-live]")).toContainText("đoạn hai");
  // A follow would glide, so the view is read once it has stopped moving.
  await scroller(page).evaluate(
    (node) =>
      new Promise<void>((resolve) => {
        let last = node.scrollTop;
        let still = 0;
        const check = (): void => {
          still = node.scrollTop === last ? still + 1 : 0;
          last = node.scrollTop;
          if (still >= 10) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }),
  );
  expect(Math.abs((await topOf(page, reading.id)) - reading.top)).toBeLessThanOrEqual(2);

  // Reported, the scroll up still stands: more of the reply does not take the reader down either.
  await releaseScrollReports(page);
  await growReply(page, "đoạn ba");
  expect(Math.abs((await topOf(page, reading.id)) - reading.top)).toBeLessThanOrEqual(2);
});

test("a reader who scrolls up while rows above collapse is not taken back down", async ({ page }) => {
  const { conversationId } = await seedConversation();
  await scriptReply(page);
  await openConversation(page, conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-total", "200");
  await startReply(page);

  // The same layout moves, then the reader's own scroll up on top of them, none of it reported when the reply grows.
  await holdScrollReports(page);
  expect(await collapseRowsAbove(page)).toBeGreaterThan(48);
  for (const marker of ["đoạn một", "đoạn hai", "đoạn ba"]) {
    await growReply(page, marker);
    await expect.poll(() => distanceToBottom(page)).toBeLessThanOrEqual(2);
  }
  await scroller(page).evaluate((node) => node.scrollTo({ top: node.scrollTop - 300, behavior: "instant" }));
  const reading = await rowBeingRead(page);
  await growReply(page, "đoạn bốn");
  expect(Math.abs((await topOf(page, reading.id)) - reading.top)).toBeLessThanOrEqual(2);

  // Reported, the scroll up still stands: more of the reply does not take the reader down either.
  await releaseScrollReports(page);
  await growReply(page, "đoạn năm");
  expect(Math.abs((await topOf(page, reading.id)) - reading.top)).toBeLessThanOrEqual(2);
});

test("a row above shrinking in the frame the reply grows below is the transcript's move, not the reader's", async ({ page }) => {
  const { conversationId } = await seedShortConversation();
  await scriptReply(page);
  await openConversation(page, conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-mounted", String(SHORT_MESSAGES));
  await startReply(page);

  // In one task, rows above collapse and the reply below grows by more than they lost, so both land in the same layout.
  // There is room below, so the browser does not pull the view up: the transcript scrolls up itself to keep the row
  // being read in place, and none of it is reported before more of the reply arrives.
  await holdScrollReports(page);
  const reading = await rowBeingRead(page);
  expect(await collapseRowsAbove(page, { growBelow: true })).toBeGreaterThan(48);
  expect(Math.abs((await topOf(page, reading.id)) - reading.top)).toBeLessThanOrEqual(2);
  expect(await distanceToBottom(page)).toBeGreaterThan(48);

  for (const marker of ["đoạn một", "đoạn hai"]) {
    await growReply(page, marker);
    await expect.poll(() => distanceToBottom(page)).toBeLessThanOrEqual(2);
  }
});

test("the transcript growing taller under a reader following the reply does not stop the following", async ({ page }) => {
  const { conversationId } = await seedShortConversation();
  await scriptReply(page);
  await openConversation(page, conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-mounted", String(SHORT_MESSAGES));
  // Held 300px shorter than it would be, as a docked panel or an open soft keyboard would hold it.
  await scroller(page).evaluate((node) => {
    node.style.maxHeight = `${String(node.clientHeight - 300)}px`;
  });
  await startReply(page);

  // The constraint goes, and the transcript gets taller without being drawn again: the browser pulls the view up to the
  // bottom that came closer, and the reply goes on before that move is reported.
  await holdScrollReports(page);
  const before = await scroller(page).evaluate((node) => node.scrollTop);
  await scroller(page).evaluate((node) => node.style.removeProperty("max-height"));
  await settle(page);
  expect(before - (await scroller(page).evaluate((node) => node.scrollTop))).toBeGreaterThan(48);

  for (const marker of ["đoạn một", "đoạn hai"]) {
    await growReply(page, marker);
    await expect.poll(() => distanceToBottom(page)).toBeLessThanOrEqual(2);
  }
});

test("the transcript's own scroll to the bottom does not hide a reader's scroll up right after it", async ({ page }) => {
  // Reduced motion: the follow is one instant move, the case a smooth glide reports frame by frame.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { conversationId } = await seedConversation();
  await scriptReply(page);
  await openConversation(page, conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-total", "200");
  await startReply(page);

  // The reply grows and the transcript follows it down; then the reader scrolls up by as much, before either move is
  // reported. Measured from the last report the view did not move, but the reader left the bottom.
  await holdScrollReports(page);
  const before = await scroller(page).evaluate((node) => node.scrollTop);
  await growReply(page, "đoạn một");
  await expect.poll(() => distanceToBottom(page)).toBeLessThanOrEqual(2);
  const followed = (await scroller(page).evaluate((node) => node.scrollTop)) - before;
  expect(followed).toBeGreaterThan(2 * 48);
  await scroller(page).evaluate((node, by) => node.scrollTo({ top: node.scrollTop - by, behavior: "instant" }), followed);
  const reading = await rowBeingRead(page);

  await growReply(page, "đoạn hai");
  expect(Math.abs((await topOf(page, reading.id)) - reading.top)).toBeLessThanOrEqual(2);
});

/** Send a question and let the reply start, with the reader following it at the bottom. */
async function startReply(page: Page): Promise<void> {
  const composer = page.locator("[data-composer]");
  await composer.click();
  await composer.fill("một câu hỏi mới");
  await composer.press("Enter");
  await frame(page, "delta", { text: "Bắt đầu trả lời." });
  await expect(page.locator("[data-live]")).toBeVisible();
  await expect.poll(() => distanceToBottom(page)).toBeLessThanOrEqual(2);
}

/** Several lines more of the streamed reply, under `marker`. */
function paragraph(marker: string): string {
  return ` ${marker}: ${"Một dòng nữa của câu trả lời đang được viết ra. ".repeat(12)}`;
}

/** Several lines more of the streamed reply, drawn. */
async function growReply(page: Page, marker: string): Promise<void> {
  await frame(page, "delta", { text: paragraph(marker) });
  await expect(page.locator("[data-live]")).toContainText(marker);
  await settle(page);
}

/*
 * Pictures in a long conversation.
 *
 * Every message below draws an imported image the way a placed `canvas.image@1` does: a surface block naming its
 * instance, the instance and the snapshot the message keeps, all written into the node's store. The picture bytes are
 * answered for those references by the page's network layer, each tagged with its reference after the image's end, so
 * every object URL the page makes can be traced back to the picture it holds. The authenticated read, the object URL,
 * the renderer and what the conversation keeps or lets go are the production path.
 */

/** One page of the timeline: the whole conversation is held, so every read here is a picture's, not a page's. */
const PICTURE_MESSAGES = 200;
/** A one-pixel PNG; what is counted is which pictures are held, not what they show. */
const PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const PICTURE_TAG = "#picture:";

interface PictureConversation {
  conversationId: string;
  idOf: (sequence: number) => string;
  refOf: (sequence: number) => string;
  instanceOf: (sequence: number) => string;
  /** The picture a mounted row draws, from its message id. */
  refOfRow: (messageId: string) => string;
}

/** A conversation of `PICTURE_MESSAGES` messages, each drawing its own imported picture. */
async function seedPictureConversation(): Promise<PictureConversation> {
  const owner = identity();
  const packageDigest = definitionDigest(IMAGE);
  const run = Date.now().toString(36);
  const refOf = (sequence: number): string => `img_long_${run}_${String(sequence)}`;
  const instanceOf = (sequence: number): string => `winst_long_${run}_${String(sequence)}`;
  const seeded = await seed(PICTURE_MESSAGES, ({ db, sequence, messageId, createdAt }) => {
    const imageRef = refOf(sequence);
    const alt = `Ảnh số ${String(sequence)}`;
    const instance = widgetInstanceSchema.parse({
      instanceId: instanceOf(sequence),
      definitionRef: { id: IMAGE.id, version: IMAGE.version, packageDigest },
      ownerNodeId: owner.nodeId,
      ownerPrincipalId: owner.ownerPrincipalId,
      revision: 1,
      presentationRevision: 1,
      dataRevision: 1,
      actionBindingRevision: 1,
      props: { imageRef, alt, title: alt },
      dataRefs: [],
      connectionRefs: [],
      actionBindingIds: [],
      lifecycle: "ready",
    });
    const snapshot = widgetSnapshotSchema.parse({
      snapshotId: `wsnap_${instance.instanceId}`,
      instanceId: instance.instanceId,
      messageId,
      capturedRevision: instance.revision,
      capturedAt: createdAt,
      textAlternative: alt,
      presentationRef: `catalog:${IMAGE.id}`,
      stale: false,
    });
    db.prepare(
      `INSERT INTO widget_instances
         (instance_id, definition_id, definition_version, package_digest, owner_node_id, owner_principal_id,
          revision, presentation_revision, data_revision, action_binding_revision, lifecycle, document, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      instance.instanceId,
      instance.definitionRef.id,
      instance.definitionRef.version,
      instance.definitionRef.packageDigest,
      instance.ownerNodeId,
      instance.ownerPrincipalId,
      instance.revision,
      instance.presentationRevision,
      instance.dataRevision,
      instance.actionBindingRevision,
      instance.lifecycle,
      JSON.stringify(instance),
      createdAt,
    );
    db.prepare(
      `INSERT INTO widget_snapshots (snapshot_id, instance_id, message_id, captured_revision, captured_at, stale, document)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).run(snapshot.snapshotId, instance.instanceId, messageId, snapshot.capturedRevision, snapshot.capturedAt, JSON.stringify(snapshot));
    return {
      role: "assistant",
      blocks: [
        { type: "text", format: "markdown", content: wording(sequence) },
        { type: "surface", definitionRef: { id: IMAGE.id, version: IMAGE.version }, snapshot },
        { type: "widget-ref", instanceId: instance.instanceId, displayMode: "inline", textAlternative: alt },
      ],
    };
  }, run);
  const prefix = seeded.idOf(0).slice(0, -1);
  return {
    conversationId: seeded.conversationId,
    idOf: seeded.idOf,
    refOf,
    instanceOf,
    refOfRow: (messageId) => refOf(Number(messageId.slice(prefix.length))),
  };
}

/**
 * Answers the seeded picture references with real image bytes, and counts every read of each.
 *
 * The bytes carry their reference after the image's end, where a decoder stops reading, so an object URL made from
 * them names the picture it holds (`pictureUrls`).
 */
async function servePictures(page: Page): Promise<Map<string, number>> {
  const reads = new Map<string, number>();
  await page.route(
    (url) => url.origin === GATEWAY && /^\/images\/img_long_/u.test(url.pathname),
    async (route) => {
      const ref = new URL(route.request().url()).pathname.split("/").pop() ?? "";
      reads.set(ref, (reads.get(ref) ?? 0) + 1);
      await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.concat([PIXEL_PNG, Buffer.from(`${PICTURE_TAG}${ref}`)]) });
    },
  );
  return reads;
}

/** Remember every object URL the page makes and every one it revokes; both still reach the browser's own. */
async function watchObjectUrls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const created = new Map<string, Blob>();
    const revoked = new Set<string>();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource): string => {
      const url = create(object);
      if (object instanceof Blob) created.set(url, object);
      return url;
    };
    URL.revokeObjectURL = (url: string): void => {
      revoked.add(url);
      revoke(url);
    };
    // SAFETY: a record this spec reads back; nothing in the application reads it.
    (window as unknown as { __objectUrls?: unknown }).__objectUrls = { created, revoked };
  });
}

interface PictureUrl {
  url: string;
  ref: string;
  revoked: boolean;
}

/** Every object URL made for a seeded picture, with the picture it holds and whether it was revoked. */
async function pictureUrls(page: Page): Promise<PictureUrl[]> {
  return page.evaluate(async (tag) => {
    // SAFETY: the record installed by `watchObjectUrls`.
    const seen = (window as unknown as { __objectUrls?: { created: Map<string, Blob>; revoked: Set<string> } }).__objectUrls;
    if (seen === undefined) throw new Error("object URLs are not being watched");
    const found: { url: string; ref: string; revoked: boolean }[] = [];
    for (const [url, blob] of seen.created) {
      const tail = await blob.slice(Math.max(0, blob.size - 128)).text();
      const at = tail.lastIndexOf(tag);
      if (at >= 0) found.push({ url, ref: tail.slice(at + tag.length), revoked: seen.revoked.has(url) });
    }
    return found;
  }, PICTURE_TAG);
}

/**
 * Whether the page can still draw an object URL: a revoked one is gone from the browser, not only from a list.
 *
 * Loaded as a picture, the way the transcript uses it, rather than fetched: the page's policy lets pictures, not
 * scripts, read `blob:` addresses.
 */
async function readable(page: Page, url: string): Promise<boolean> {
  return page.evaluate(
    (target) =>
      new Promise<boolean>((resolve) => {
        const probe = new Image();
        probe.onload = () => resolve(true);
        probe.onerror = () => resolve(false);
        probe.src = target;
      }),
    url,
  );
}

/** The pictures drawn now: those of the mounted rows, and the pinned one. */
async function drawnRefs(page: Page, pictures: PictureConversation, pinned: string | undefined): Promise<Set<string>> {
  const drawn = new Set((await mountedIds(page)).map(pictures.refOfRow));
  if (pinned !== undefined) drawn.add(pinned);
  return drawn;
}

/** The pictures with an object URL the page still holds. Each is held by one URL, never two. */
function liveRefs(urls: readonly PictureUrl[]): string[] {
  const live = urls.filter((entry) => !entry.revoked).map((entry) => entry.ref);
  expect(new Set(live).size, "no picture is held by two live object URLs").toBe(live.length);
  return live;
}

test("pictures scrolled past the budget have their object URLs revoked; drawn and pinned ones stay live", async ({ page }) => {
  const pictures = await seedPictureConversation();
  const newest = PICTURE_MESSAGES;
  // A picture near the newest is pinned, so it is drawn wherever the transcript is. Not the newest itself: the newest
  // row stays mounted wherever the transcript is, and would be drawn without the pin.
  const pinnedAt = newest - 2;
  const pinned = pictures.refOf(pinnedAt);
  await api("POST", `/conversations/${encodeURIComponent(pictures.conversationId)}/pins`, {
    instanceId: pictures.instanceOf(pinnedAt),
    displayMode: "compact",
  });
  await watchObjectUrls(page);
  const reads = await servePictures(page);
  await openConversation(page, pictures.conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-total", String(PICTURE_MESSAGES));
  const shown = row(page, pictures.idOf(newest)).locator(`img[data-image-ref="${pictures.refOf(newest)}"]`);
  await expect(shown).toBeInViewport();
  await expect(shown).toHaveAttribute("src", /^blob:/u);

  // Up to the first message: at every stop, only what is drawn and at most a budget of recently drawn pictures are held.
  const budget = PRESENTATION_RETENTION.pictures;
  for (let step = 0; step < 300; step += 1) {
    await scrollBy(page, -2_400);
    await expect
      .poll(async () => {
        const live = liveRefs(await pictureUrls(page));
        const drawn = await drawnRefs(page, pictures, pinned);
        return live.filter((ref) => !drawn.has(ref)).length;
      }, { message: "pictures held beyond those drawn" })
      .toBeLessThanOrEqual(budget);
    if ((await row(page, pictures.idOf(1)).count()) > 0 && (await scroller(page).evaluate((node) => node.scrollTop)) === 0) break;
  }
  await expect(row(page, pictures.idOf(1))).toBeInViewport();

  // At rest at the top: every drawn picture is held, and exactly a budget's worth of the most recently drawn others.
  await expect
    .poll(async () => {
      const live = new Set(liveRefs(await pictureUrls(page)));
      const drawn = await drawnRefs(page, pictures, pinned);
      return { drawnHeld: [...drawn].every((ref) => live.has(ref)), others: [...live].filter((ref) => !drawn.has(ref)).length };
    })
    .toEqual({ drawnHeld: true, others: budget });

  const urls = await pictureUrls(page);
  // Far more pictures were drawn on the way up than the budget keeps; each was read once, never again.
  expect(new Set(urls.map((entry) => entry.ref)).size).toBeGreaterThan(budget * 2);
  for (const [ref, count] of reads) expect(count, `${ref} was read once`).toBe(1);

  // The picture just above the newest was drawn first and let go long ago: its URL is revoked in the browser.
  const released = urls.filter((entry) => entry.ref === pictures.refOf(newest - 1));
  expect(released.length).toBe(1);
  expect(released[0]?.revoked).toBe(true);
  expect(await readable(page, released[0]?.url ?? "")).toBe(false);

  // The pinned picture is still held, by the URL it was first read into.
  const kept = urls.filter((entry) => entry.ref === pinned);
  expect(kept.map((entry) => entry.revoked)).toEqual([false]);
  expect(await readable(page, kept[0]?.url ?? "")).toBe(true);

  // Every picture on screen draws from a live URL.
  const sources = await page.locator(".cc-transcript-rows img[data-image-ref]").evaluateAll((images) =>
    images.map((image) => ({ ref: image.getAttribute("data-image-ref") ?? "", src: image.getAttribute("src") ?? "" })),
  );
  expect(sources.length).toBeGreaterThan(0);
  const revoked = new Set(urls.filter((entry) => entry.revoked).map((entry) => entry.url));
  for (const source of sources) {
    expect(revoked.has(source.src), `${source.ref} draws from a revoked URL`).toBe(false);
    expect(await readable(page, source.src)).toBe(true);
  }
});

test("a picture scrolled a little way off is kept, and drawn again without being read again", async ({ page }) => {
  const pictures = await seedPictureConversation();
  // The one before the newest: the newest row stays mounted wherever the transcript is.
  const newest = pictures.idOf(PICTURE_MESSAGES - 1);
  const ref = pictures.refOf(PICTURE_MESSAGES - 1);
  await watchObjectUrls(page);
  const reads = await servePictures(page);
  await openConversation(page, pictures.conversationId);
  await expect(rows(page)).toHaveAttribute("data-rows-total", String(PICTURE_MESSAGES));
  const shown = row(page, newest).locator(`img[data-image-ref="${ref}"]`);
  await expect(shown).toHaveAttribute("src", /^blob:/u);
  const source = await shown.getAttribute("src");

  // Up until its row is no longer mounted, and no further.
  for (let step = 0; step < 20 && (await row(page, newest).count()) > 0; step += 1) await scrollBy(page, -600);
  await expect(row(page, newest)).toHaveCount(0);
  expect(reads.size, "fewer pictures were drawn on the way than the budget keeps").toBeLessThanOrEqual(PRESENTATION_RETENTION.pictures);
  await settle(page);
  expect((await pictureUrls(page)).filter((entry) => entry.ref === ref).map((entry) => entry.revoked)).toEqual([false]);

  // Back down: the same URL draws it at once, and the node was asked for it only the first time.
  await toNewest(page);
  await expect(shown).toBeInViewport();
  await expect(shown).toHaveAttribute("src", source ?? "");
  expect(reads.get(ref)).toBe(1);
});
