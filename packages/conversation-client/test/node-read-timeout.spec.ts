import { resolveObjectURL } from "node:buffer";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FIRST_RESPONSE_TIMEOUT_MS, GatewayClient, GatewayError, NODE_NOT_ANSWERING } from "../src/api.ts";
import { createObjectUrlSet } from "../src/use-object-urls.ts";

/**
 * A read of node-owned bytes that the node never starts answering.
 *
 * Without a bound, a card preparing a download waits forever with its button disabled, and a player or picture waits
 * with it. The bound is on the wait for the response's headers only: a large file arriving slowly after a prompt answer
 * must never be cut off.
 */

/** A fetch the test answers by hand, which honours its signal the way a browser's does. */
function manualNode() {
  const signals: AbortSignal[] = [];
  const answers: ((response: Response) => void)[] = [];
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? new AbortController().signal;
      signals.push(signal);
      answers.push(resolve);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
  const client = new GatewayClient({ baseUrl: "http://127.0.0.1:8765", token: "tok", fetchImpl });
  return { client, signals, answers };
}

/** A body that sends one chunk every `everyMs`, so the whole file takes much longer than the headers bound. */
function slowBody(chunks: readonly string[], everyMs: number): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull: (controller) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          const chunk = chunks[index];
          index += 1;
          if (chunk === undefined) controller.close();
          else controller.enqueue(new TextEncoder().encode(chunk));
          resolve();
        }, everyMs);
      }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a read of node-owned bytes waits a bounded time for the node to start answering", () => {
  it("fails a read whose headers never arrive once the bound passes, and aborts the request", async () => {
    const node = manualNode();
    let outcome: unknown = "pending";
    void node.client.attachmentObjectUrl("att_1").then(
      (url) => (outcome = url),
      (cause: unknown) => (outcome = cause),
    );

    await vi.advanceTimersByTimeAsync(FIRST_RESPONSE_TIMEOUT_MS - 1);
    expect(outcome).toBe("pending");
    expect(node.signals[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(GatewayError);
    expect((outcome as GatewayError).code).toBe(NODE_NOT_ANSWERING);
    expect(node.signals[0]?.aborted).toBe(true);
  });

  it("does not bound a body that arrives slowly after prompt headers", async () => {
    const node = manualNode();
    const chunks = ["mot ", "hai ", "ba ", "bon"];
    const reading = node.client.attachmentObjectUrl("att_1");
    await vi.advanceTimersByTimeAsync(10);
    node.answers[0]?.(new Response(slowBody(chunks, FIRST_RESPONSE_TIMEOUT_MS), { status: 200 }));

    // The whole body takes five times the bound to arrive.
    await vi.advanceTimersByTimeAsync(FIRST_RESPONSE_TIMEOUT_MS * (chunks.length + 1));
    const url = await reading;
    expect(node.signals[0]?.aborted).toBe(false);
    expect(await resolveObjectURL(url)?.text()).toBe(chunks.join(""));
    URL.revokeObjectURL(url);
  });

  it("applies the same bound to pictures and to a player's artifact source", async () => {
    const node = manualNode();
    const picture = node.client.imageObjectUrl("img_1").catch((cause: unknown) => cause);
    const source = node.client.artifactContent("art_1").catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(FIRST_RESPONSE_TIMEOUT_MS);
    expect(((await picture) as GatewayError).code).toBe(NODE_NOT_ANSWERING);
    expect(((await source) as GatewayError).code).toBe(NODE_NOT_ANSWERING);
  });

  it("aborts the request when its caller stops wanting it, before or after the headers", async () => {
    const node = manualNode();
    const before = new AbortController();
    const waiting = node.client.attachmentObjectUrl("att_1", before.signal).catch((cause: unknown) => cause);
    before.abort();
    expect(node.signals[0]?.aborted).toBe(true);
    expect(await waiting).not.toBeInstanceOf(GatewayError);

    const after = new AbortController();
    void node.client.attachmentObjectUrl("att_2", after.signal).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    node.answers[1]?.(new Response(slowBody(["a", "b"], 1_000), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    after.abort();
    expect(node.signals[1]?.aborted).toBe(true);
  });
});

describe("a stalled read in the object-URL set", () => {
  it("becomes a failure the person can try again, and the retry reads once more", async () => {
    const node = manualNode();
    const set = createObjectUrlSet({
      fetchUrl: (reference, signal) => node.client.attachmentObjectUrl(reference, signal),
      revoke: (url) => URL.revokeObjectURL(url),
      onChange: () => undefined,
    });
    set.want([], ["att_1"]);
    set.request("att_1");
    expect(set.status("att_1")).toBe("loading");

    await vi.advanceTimersByTimeAsync(FIRST_RESPONSE_TIMEOUT_MS);
    expect(set.status("att_1")).toBe("failed");

    set.retry("att_1");
    expect(node.signals).toHaveLength(2);
    node.answers[1]?.(new Response("noi dung", { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(set.status("att_1")).toBe("ready");
    set.release();
  });

  it("aborts a read in flight when its owner unmounts, without calling it a failure", async () => {
    const node = manualNode();
    const set = createObjectUrlSet({
      fetchUrl: (reference, signal) => node.client.attachmentObjectUrl(reference, signal),
      revoke: (url) => URL.revokeObjectURL(url),
      onChange: () => undefined,
    });
    set.want(["img_1"]);
    set.release();
    expect(node.signals[0]?.aborted).toBe(true);

    // Mounted again, as a development remount does: the reference is read afresh, not left failed by the abort.
    set.want(["img_1"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(node.signals).toHaveLength(2);
    expect(set.status("img_1")).toBe("loading");
    node.answers[1]?.(new Response("anh", { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(set.status("img_1")).toBe("ready");
    set.release();
  });
});
