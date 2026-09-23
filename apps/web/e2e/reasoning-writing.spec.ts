import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The reasoning block says it is still being written, and stops saying so when the writing stops.
 *
 * Scripted at the fetch boundary rather than through the node's model fixture, because a fixture node has no model
 * turn and therefore produces no reasoning at all: this state exists only while frames are arriving, so a test that
 * cannot decide when each frame arrives cannot observe it. Patching `fetch` before any page script runs puts the test
 * in charge of every frame, which makes each assertion a statement about the code rather than about how fast the
 * machine happens to be.
 *
 * What this does not prove is that a provider sends reasoning at all. That is the model turn's job, and it is measured
 * against a live provider rather than asserted here.
 */

const DATA_DIR = join(process.cwd(), ".data", "e2e");

const NODE_PORT = process.env.CC_E2E_NODE_PORT;
if (NODE_PORT === undefined || NODE_PORT === "") {
  throw new Error(
    "CC_E2E_NODE_PORT is not set, so this suite does not know which node it is testing; run it through playwright.config.ts",
  );
}
const GATEWAY = `http://127.0.0.1:${NODE_PORT}`;

function token(): string {
  const path = join(DATA_DIR, "identity.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { localToken?: unknown };
  if (typeof parsed.localToken !== "string" || parsed.localToken === "") {
    throw new Error(`no local token in ${path}`);
  }
  return parsed.localToken;
}

/**
 * Hold the reply stream open, so this test decides when each frame arrives.
 *
 * Installed before the page loads, because the client binds `fetch` when it is constructed: a patch applied afterwards
 * would arrive too late and the real node would answer instead, which is a test that passes while measuring nothing.
 */
async function scriptReply(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const match = /\/conversations\/([^/]+)\/messages\/stream/u.exec(url);
      if (match === null) return original(input, init);
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // SAFETY: the seam this spec opens on purpose. The page has no type for it because it exists only while a
          // test is driving the stream, and nothing in the application reads it.
          (window as unknown as { __scriptedReply?: unknown }).__scriptedReply = {
            conversationId: decodeURIComponent(match[1] ?? ""),
            push: (frame: string) => controller.enqueue(encoder.encode(frame)),
            end: () => controller.close(),
          };
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    };
  });
}

/** Push one server-sent frame, exactly as the node would write it. */
async function frame(page: Page, event: string, payload: unknown): Promise<void> {
  /*
   * Wait for the request first.
   *
   * Sending does not await the stream: the app creates the conversation and only then asks for the reply, so at the
   * moment a test is ready to push the first frame the seam may not exist yet. Waiting here is what makes the helper
   * a statement about the application rather than about the order this file happens to run in.
   */
  await page.waitForFunction(() => {
    // SAFETY: the seam installed by `scriptReply`.
    return (window as unknown as { __scriptedReply?: unknown }).__scriptedReply !== undefined;
  });
  await page.evaluate(
    ({ name, data }) => {
      // SAFETY: the seam installed by `scriptReply`.
      const seam = (window as unknown as { __scriptedReply?: { push: (frame: string) => void } }).__scriptedReply;
      if (seam === undefined) throw new Error("the scripted reply was never opened, so the stream is not under test");
      seam.push(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    { name: event, data: payload },
  );
}

/** End the stream the way the node ends it, so the turn finishes instead of failing on a truncated reply. */
async function endReply(page: Page): Promise<void> {
  await page.evaluate(() => {
    // SAFETY: the seam installed by `scriptReply`.
    const seam = (window as unknown as { __scriptedReply?: { end: () => void } }).__scriptedReply;
    if (seam === undefined) throw new Error("the scripted reply was never opened, so the stream is not under test");
    seam.end();
  });
}

/** The conversation the app asked for, read off the request it made for the stream. */
async function requestedConversation(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    // SAFETY: the seam installed by `scriptReply`.
    const seam = (window as unknown as { __scriptedReply?: { conversationId: string } }).__scriptedReply;
    return seam?.conversationId ?? "";
  });
  if (id === "") throw new Error("no reply stream was requested, so there is no conversation to record a turn in");
  return id;
}

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${token()}&gateway=${encodeURIComponent(GATEWAY)}`);
  await expect(page.locator("[data-composer]")).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator("[data-composer]");
  await composer.click();
  await composer.fill(text);
  await composer.press("Enter");
}

/** The node's own record of the finished turn, so the reply stops being live and becomes history. */
function timeline(conversationId: string, blocks: Record<string, unknown>[]): Record<string, unknown> {
  const at = new Date().toISOString();
  return {
    conversationId,
    cursor: 2,
    messages: [
      { messageId: "m-1", role: "user", blocks: [{ type: "text", format: "markdown", content: "hỏi" }], createdAt: at },
      { messageId: "m-2", role: "assistant", blocks, createdAt: at },
    ],
    pins: [],
    instances: [],
    snapshots: [],
    metadata: { messageCount: 2, taskCount: 0, updatedAt: at },
    activeTaskIds: [],
  };
}

test("the reasoning block says it is still being written, and stops when the writing stops", async ({ page }) => {
  await scriptReply(page);
  await openApp(page);
  await send(page, "kiểm tra chỉ báo suy luận");

  await frame(page, "reasoning", { text: "Cân nhắc xem nên trả lời thế nào" });

  const block = page.locator('[data-reasoning="true"]');
  await expect(block).toHaveAttribute("data-writing", "true");
  await expect(block.locator(".cc-reasoning-writing")).toHaveText("đang viết…");

  // A second frame keeps it saying so: this is a state, not a one-off note pinned to the first frame.
  await frame(page, "reasoning", { text: " và thêm một bước nữa" });
  await expect(block).toHaveAttribute("data-writing", "true");

  // The first word of the answer is what ends it, because the reasoning is no longer the most recent thing produced.
  await frame(page, "delta", { text: "Xong." });
  await expect(block).not.toHaveAttribute("data-writing", "true");
  await expect(block.locator(".cc-reasoning-writing")).toHaveCount(0);

  await frame(page, "done", {
    resolution: "answered",
    taskId: null,
    messageIds: ["m-2"],
    timeline: timeline(await requestedConversation(page), [
      { type: "reasoning", content: "Cân nhắc xem nên trả lời thế nào và thêm một bước nữa" },
      { type: "text", format: "markdown", content: "Xong." },
    ]),
  });
  await endReply(page);

  // The live view is replaced by the node's record, so nothing on screen is left claiming to be arriving.
  await expect(page.locator("[data-live]")).toHaveCount(0);
  await expect(page.locator('[data-writing="true"]')).toHaveCount(0);
});

test("a reasoning block the node recorded never claims to be still being written", async ({ page }) => {
  await scriptReply(page);
  await openApp(page);
  await send(page, "kiểm tra suy luận đã ghi lại");

  await frame(page, "reasoning", { text: "Suy luận đã xong" });
  const conversationId = await requestedConversation(page);
  await frame(page, "done", {
    resolution: "answered",
    taskId: null,
    messageIds: ["m-2"],
    timeline: timeline(conversationId, [
      { type: "reasoning", content: "Suy luận đã xong" },
      { type: "text", format: "markdown", content: "Đáp án." },
    ]),
  });
  await endReply(page);

  const stored = page.locator('[data-reasoning="true"]');
  await expect(stored).toBeVisible();
  // The reasoning is there — collapsed, but present — and the live marker is not on it.
  expect(await stored.textContent()).toContain("Suy luận đã xong");
  await expect(page.locator('[data-writing="true"]')).toHaveCount(0);
});
