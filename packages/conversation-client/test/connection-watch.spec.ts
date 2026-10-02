import { describe, expect, it } from "vitest";

import { GatewayClient, GatewayError } from "../src/api.ts";
import {
  CHECK_TIMEOUT_MS,
  MAX_AUTOMATIC_CHECKS,
  RETRY_DELAYS_MS,
  type ConnectionStatus,
  documentVisibility,
  watchConnection,
} from "../src/connection-watch.ts";
import { connectionNoticeText } from "../src/connection-notice.tsx";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";

/** A clock and timer queue the test moves by hand, so a backoff of thirty seconds takes no time at all. */
function fakeTime() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer: (id: unknown): void => {
      timers.delete(id as number);
    },
    pending: () => [...timers.values()].map((timer) => timer.at - now).sort((a, b) => a - b),
    /** Moves the clock forward, firing every timer that falls due on the way, in order. */
    advance: async (ms: number): Promise<void> => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function fakeVisibility(hidden = false) {
  const listeners = new Set<() => void>();
  return {
    hidden,
    isHidden(): boolean {
      return this.hidden;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: boolean): void {
      this.hidden = next;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

/** A node that is unreachable until `up` is set, the way a fetch rejects while nothing listens on the port. */
function fakeNode() {
  const node = {
    up: false,
    calls: 0,
    check: async (_signal: AbortSignal): Promise<unknown> => {
      node.calls++;
      if (!node.up) throw new TypeError("Failed to fetch");
      return { status: "ok" };
    },
  };
  return node;
}

function start(overrides: Partial<Parameters<typeof watchConnection>[0]> = {}) {
  const time = fakeTime();
  const node = fakeNode();
  const visibility = fakeVisibility();
  const seen: ConnectionStatus[] = [];
  const watch = watchConnection({
    check: node.check,
    onChange: (status) => seen.push(status),
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    visibility,
    ...overrides,
  });
  return { time, node, visibility, seen, watch, last: () => seen[seen.length - 1] };
}

describe("watching whether the node answers", () => {
  it("recovers without a reload when the first check fails and a later one succeeds", async () => {
    const { time, node, last } = start();
    await settle();
    expect(last()).toMatchObject({ state: "offline", failure: { kind: "unreachable" }, checking: false });
    expect(last()?.nextCheckAt).toBe(time.now() + RETRY_DELAYS_MS[0]!);

    await time.advance(RETRY_DELAYS_MS[0]!);
    expect(node.calls).toBe(2);
    expect(last()).toMatchObject({ state: "offline" });

    node.up = true;
    await time.advance(RETRY_DELAYS_MS[1]!);
    expect(node.calls).toBe(3);
    expect(last()).toEqual({ state: "ready", checking: false, attempts: 0 });
    // Once the node answers there is nothing left to wait for: no timer stays behind.
    expect(time.pending()).toEqual([]);
  });

  it("says it is connecting during the first check, and checking during each retry, never ready before the node answers", async () => {
    const { time, seen, node } = start();
    expect(seen[0]).toMatchObject({ state: "connecting", checking: true });
    await settle();
    await time.advance(RETRY_DELAYS_MS[0]!);
    // The retry is announced as a check in progress while the person still sees the node is offline.
    expect(seen.some((status) => status.state === "offline" && status.checking)).toBe(true);
    expect(seen.some((status) => status.state === "ready")).toBe(false);
    expect(node.calls).toBe(2);
  });

  it("backs off and caps the wait between checks", async () => {
    const { time } = start();
    await settle();
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      const [wait] = time.pending();
      waits.push(wait!);
      await time.advance(wait!);
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000, 30_000]);
    expect(Math.max(...RETRY_DELAYS_MS)).toBe(30_000);
  });

  it("stops checking on its own after a bounded number of checks, says so, and still checks when asked", async () => {
    const { time, node, watch, last } = start();
    await settle();
    while (time.pending().length > 0) await time.advance(time.pending()[0]!);
    expect(node.calls).toBe(MAX_AUTOMATIC_CHECKS);
    expect(last()).toMatchObject({ state: "offline", checking: false, gaveUp: true });
    expect(last()?.nextCheckAt).toBeUndefined();

    node.up = true;
    watch.checkNow();
    await settle();
    expect(last()).toMatchObject({ state: "ready" });
  });

  it("stops every timer and ignores a late answer once stopped", async () => {
    const { time, node, watch, seen, visibility } = start();
    await settle();
    expect(time.pending()).toHaveLength(1);
    watch.stop();
    expect(time.pending()).toEqual([]);
    expect(visibility.listenerCount()).toBe(0);
    const before = seen.length;
    node.up = true;
    await time.advance(120_000);
    watch.checkNow();
    await settle();
    expect(node.calls).toBe(1);
    expect(seen).toHaveLength(before);
  });

  it("aborts the check in flight when stopped", async () => {
    let aborted = false;
    const { watch } = start({
      check: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    watch.stop();
    await settle();
    expect(aborted).toBe(true);
  });

  it("pauses while the page is hidden and checks as soon as it is shown again", async () => {
    const { time, node, visibility, last } = start();
    await settle();
    visibility.set(true);
    expect(time.pending()).toEqual([]);
    expect(last()).toMatchObject({ state: "offline", paused: true });
    expect(last()?.nextCheckAt).toBeUndefined();
    await time.advance(600_000);
    expect(node.calls).toBe(1);

    node.up = true;
    visibility.set(false);
    await settle();
    expect(node.calls).toBe(2);
    expect(last()).toMatchObject({ state: "ready" });
  });

  it("does not start checking while the page opens hidden, and checks once it is shown", async () => {
    const visibility = fakeVisibility(true);
    const { node, last } = start({ visibility });
    await settle();
    expect(node.calls).toBe(0);
    expect(last()).toMatchObject({ state: "connecting", checking: false, paused: true });
    visibility.set(false);
    await settle();
    expect(node.calls).toBe(1);
  });

  it("checks at once when asked, instead of waiting out the backoff", async () => {
    const { time, node, watch, last } = start();
    await settle();
    node.up = true;
    watch.checkNow();
    await settle();
    expect(node.calls).toBe(2);
    expect(last()).toMatchObject({ state: "ready" });
    expect(time.pending()).toEqual([]);
  });

  it("does not run two checks at once when asked during a check", async () => {
    let calls = 0;
    const { watch } = start({ check: () => (calls++, new Promise(() => {})) });
    watch.checkNow();
    watch.checkNow();
    expect(calls).toBe(1);
  });

  it("gives up on a check that does not answer in time, and says it timed out", async () => {
    const { time, last } = start({
      check: (signal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    });
    await time.advance(CHECK_TIMEOUT_MS);
    expect(last()).toMatchObject({ state: "offline", failure: { kind: "timeout" } });
    expect(time.pending()).toEqual([RETRY_DELAYS_MS[0]]);
  });

  it("tells a node that answered with a refusal apart from one that did not answer", async () => {
    const { last } = start({
      check: async () => {
        throw new GatewayError(503, "NOT_READY", "the node is starting");
      },
    });
    await settle();
    expect(last()).toMatchObject({ state: "offline", failure: { kind: "refused", status: 503 } });
  });

  it("checks through the gateway's health route with the watcher's signal", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const client = new GatewayClient({
      baseUrl: "http://node.test",
      token: "t",
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        signals.push(init?.signal);
        return new Response(JSON.stringify({ status: "ok", runtime: { node: "22", platform: "linux", arch: "x64" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    const controller = new AbortController();
    await client.health({ signal: controller.signal });
    expect(signals[0]).toBe(controller.signal);
  });

  it("follows the page's visibility through the document's own event", () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const visibility = documentVisibility(doc);
    let changes = 0;
    const unsubscribe = visibility.subscribe(() => changes++);
    expect(visibility.isHidden()).toBe(false);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(visibility.isHidden()).toBe(true);
    unsubscribe();
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(changes).toBe(1);
  });
});

describe("what the page says while the node does not answer", () => {
  const en = (key: MessageKey): string => CATALOGS.en[key];
  const vi = (key: MessageKey): string => CATALOGS.vi[key];
  const now = 1_000_000;

  it("says nothing before the first check failed or once the node answered", () => {
    expect(connectionNoticeText({ state: "connecting", checking: true, attempts: 0 }, now, en)).toBeUndefined();
    expect(connectionNoticeText({ state: "ready", checking: false, attempts: 0 }, now, en)).toBeUndefined();
  });

  it("says what failed, that the writing is kept, and when the next real check runs", () => {
    const status: ConnectionStatus = { state: "offline", checking: false, attempts: 3, failure: { kind: "unreachable" }, nextCheckAt: now + 7_400 };
    expect(connectionNoticeText(status, now, en)).toEqual({
      failed: "The node could not be reached.",
      kept: "What you wrote stays here.",
      next: "Checking again in 8 s.",
    });
    expect(connectionNoticeText(status, now, vi)?.next).toBe("Sẽ kiểm tra lại sau 8 giây.");
  });

  it("names a refusal and a timeout, a check in flight, a hidden page and the end of the automatic checks", () => {
    const base = { state: "offline" as const, attempts: 2 };
    expect(connectionNoticeText({ ...base, checking: false, failure: { kind: "refused", status: 503 }, gaveUp: true }, now, en)).toEqual({
      failed: "The node answered with an error (503).",
      kept: "What you wrote stays here.",
      next: "Stopped checking on its own. Try again once the node is running.",
    });
    expect(connectionNoticeText({ ...base, checking: true, failure: { kind: "timeout" } }, now, en)).toMatchObject({
      failed: "The node did not answer in time.",
      next: "Checking again…",
    });
    expect(connectionNoticeText({ ...base, checking: false, failure: { kind: "unreachable" }, paused: true }, now, en)?.next).toBe(
      "Checks again when you come back to this page.",
    );
  });
});