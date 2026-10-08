import { describe, expect, it } from "vitest";

import type { MediaPlaybackState } from "@clarkcant/contracts";

import { GatewayClient } from "../src/api.ts";
import { createPlaybackCoalescer, flushPlaybackOnLeave } from "../src/playback-coalescer.ts";
import { planViewWrite } from "../src/use-surface-renderer.tsx";

describe("local playback state coalescing", () => {
  it("writes the initial state and coalesces frequent clock updates to the interval", () => {
    let time = 0;
    const writes: unknown[] = [];
    const { report } = createPlaybackCoalescer({ now: () => time, intervalMs: 3_000, write: (state) => writes.push(state) });
    report({ status: "playing", position: 0, duration: 60 }, "playing");
    time = 500;
    report({ status: "playing", position: 1, duration: 60 }, "timeupdate");
    time = 2_999;
    report({ status: "playing", position: 4, duration: 60 }, "timeupdate");
    time = 3_000;
    report({ status: "playing", position: 5, duration: 60 }, "timeupdate");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({ status: "playing", position: 5, duration: 60 });
  });

  it("writes a minute of continuous play a bounded number of times, not once per tick", () => {
    let time = 0;
    let writes = 0;
    const { report } = createPlaybackCoalescer({ now: () => time, write: () => (writes += 1) });
    report({ status: "playing", position: 0, duration: 120 }, "playing");
    // A browser reports the clock about four times a second while a video plays.
    let ticks = 0;
    for (time = 250; time <= 60_000; time += 250) {
      report({ status: "playing", position: time / 1000, duration: 120 }, "timeupdate");
      ticks += 1;
    }
    expect(ticks).toBe(240);
    // The first write, then at most one every three seconds of the sixty.
    expect(writes).toBeLessThanOrEqual(21);
    expect(writes).toBeGreaterThan(1);
  });

  it("flushes pause, seek and end transitions immediately", () => {
    const writes: string[] = [];
    const { report } = createPlaybackCoalescer({ now: () => 1, write: (state) => writes.push(`${state.status}:${state.position}`) });
    report({ status: "playing", position: 0, duration: 30 }, "playing");
    report({ status: "paused", position: 1, duration: 30 }, "pause");
    report({ status: "paused", position: 8, duration: 30 }, "seek");
    report({ status: "ended", position: 30, duration: 30 }, "ended");
    expect(writes).toEqual(["playing:0", "paused:1", "paused:8", "ended:30"]);
  });

  it("does not repeat an unchanged state and never writes a non-finite clock", () => {
    const writes: unknown[] = [];
    const { report } = createPlaybackCoalescer({ now: () => 1, write: (state) => writes.push(state) });
    report({ status: "paused", position: 4, duration: 10 }, "pause");
    report({ status: "paused", position: 4, duration: 10 }, "pause");
    report({ status: "paused", position: Number.NaN, duration: Number.POSITIVE_INFINITY }, "seek");
    expect(writes).toEqual([
      { status: "paused", position: 4, duration: 10 },
      { status: "paused", position: 0, duration: 0 },
    ]);
  });

  it("writes again after a refusal even when the player has not moved", () => {
    const writes: string[] = [];
    const coalescer = createPlaybackCoalescer({ now: () => 1, write: (state) => writes.push(`${state.status}:${String(state.position)}`) });
    coalescer.report({ status: "paused", position: 4, duration: 10 }, "pause");
    coalescer.report({ status: "paused", position: 4, duration: 10 }, "flush");
    coalescer.forget();
    coalescer.report({ status: "paused", position: 4, duration: 10 }, "flush");
    expect(writes).toEqual(["paused:4", "paused:4"]);
  });
});

describe("leaving a playing local video", () => {
  const harness = (state: MediaPlaybackState | undefined) => {
    const page = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    let time = 0;
    const writes: MediaPlaybackState[] = [];
    // A long interval, so only the flush path can write after the first report.
    const coalescer = createPlaybackCoalescer({ now: () => time, intervalMs: 60_000, write: (next) => writes.push(next) });
    let current = state;
    const stop = flushPlaybackOnLeave({ page, document: doc, read: () => current, report: coalescer.report });
    return {
      page,
      doc,
      writes,
      coalescer,
      stop,
      move: (next: MediaPlaybackState) => {
        current = next;
        time += 250;
      },
    };
  };

  it("writes the player paused where it was when the player is removed", () => {
    const run = harness({ status: "playing", position: 0, duration: 60 });
    run.coalescer.report({ status: "playing", position: 0, duration: 60 }, "playing");
    run.move({ status: "playing", position: 7.5, duration: 60 });
    run.coalescer.report({ status: "playing", position: 7.5, duration: 60 }, "timeupdate");
    expect(run.writes).toHaveLength(1);
    run.stop();
    expect(run.writes).toEqual([
      { status: "playing", position: 0, duration: 60 },
      { status: "paused", position: 7.5, duration: 60 },
    ]);
    // Removed listeners: a later page event writes nothing more.
    run.page.dispatchEvent(new Event("pagehide"));
    expect(run.writes).toHaveLength(2);
  });

  it("writes the player paused when the page is left, and as it is when the page is hidden", () => {
    const run = harness({ status: "playing", position: 0, duration: 60 });
    run.coalescer.report({ status: "playing", position: 0, duration: 60 }, "playing");
    run.move({ status: "playing", position: 3, duration: 60 });
    run.doc.visibilityState = "hidden";
    run.doc.dispatchEvent(new Event("visibilitychange"));
    run.move({ status: "playing", position: 5, duration: 60 });
    run.page.dispatchEvent(new Event("pagehide"));
    expect(run.writes.slice(1)).toEqual([
      { status: "playing", position: 3, duration: 60 },
      { status: "paused", position: 5, duration: 60 },
    ]);
  });

  it("marks only the write made as the page goes away as leaving", () => {
    const page = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const writes: { state: MediaPlaybackState; leaving: boolean }[] = [];
    const coalescer = createPlaybackCoalescer({ now: () => 0, intervalMs: 60_000, write: (state, { leaving }) => writes.push({ state, leaving }) });
    let current: MediaPlaybackState = { status: "playing", position: 0, duration: 60 };
    const stop = flushPlaybackOnLeave({ page, document: doc, read: () => current, report: coalescer.report });
    coalescer.report(current, "playing");
    current = { status: "playing", position: 4, duration: 60 };
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    current = { status: "playing", position: 6, duration: 60 };
    page.dispatchEvent(new Event("pagehide"));
    stop();
    expect(writes.map((write) => write.leaving)).toEqual([false, false, true]);
    expect(writes[2]?.state).toEqual({ status: "paused", position: 6, duration: 60 });
  });

  it("keeps an ended player ended and writes nothing for a player that never reported", () => {
    const ended = harness({ status: "ended", position: 60, duration: 60 });
    ended.stop();
    expect(ended.writes).toEqual([{ status: "ended", position: 60, duration: 60 }]);
    const untouched = harness(undefined);
    untouched.page.dispatchEvent(new Event("pagehide"));
    untouched.stop();
    expect(untouched.writes).toEqual([]);
  });
});

describe("sending the write a page makes as it goes away", () => {
  it("sends it at once at the revision a write in flight leads to, and an ordinary change waits", () => {
    expect(planViewWrite(undefined, 4, false)).toEqual({ send: true, expectedRevision: 4, keepalive: false });
    expect(planViewWrite({ inFlight: false }, 4, true)).toEqual({ send: true, expectedRevision: 4, keepalive: true });
    expect(planViewWrite({ inFlight: true, revision: 4 }, 4, false)).toEqual({ send: false });
    // A view write moves the revision by one, so the leaving write is not refused for the one ahead of it.
    expect(planViewWrite({ inFlight: true, revision: 4 }, 4, true)).toEqual({ send: true, expectedRevision: 5, keepalive: true });
  });

  it("sends a change made before the page drew the last answer at the revision the node answered with", () => {
    // The node answered 5; the page still holds 4 until it draws that answer.
    expect(planViewWrite({ inFlight: false, revision: 5 }, 4, false)).toEqual({ send: true, expectedRevision: 5, keepalive: false });
    expect(planViewWrite({ inFlight: false, revision: 5 }, 4, true)).toEqual({ send: true, expectedRevision: 5, keepalive: true });
    // A newer timeline, another device's change or the model's, is what the page draws, and wins.
    expect(planViewWrite({ inFlight: false, revision: 5 }, 7, false)).toEqual({ send: true, expectedRevision: 7, keepalive: false });
  });

  it("asks the browser to keep the request alive past the page only when told to", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const client = new GatewayClient({
      baseUrl: "http://127.0.0.1:8765",
      token: "tok",
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        inits.push(init);
        return new Response(JSON.stringify({ outcome: "done", revision: 5, timeline: { instances: [] } }), { status: 200 });
      }) as typeof fetch,
    });
    const invocation = { actionBindingId: "act_view", expectedRevision: 4, expectedBindingDigest: "sha256:x", input: {}, invocationId: "inv_1" };
    await client.invokeAction("conv_1", "winst_1", invocation, { keepalive: true });
    await client.invokeAction("conv_1", "winst_1", { ...invocation, invocationId: "inv_2" });
    expect(inits[0]?.keepalive).toBe(true);
    expect(inits[1]?.keepalive).toBeUndefined();
  });
});

describe("the state-only write a player sends", () => {
  it("goes to the same action route as its typed variant, and is kept alive past the page only when told to", async () => {
    const sent: { url: string; body: unknown; keepalive: boolean | undefined }[] = [];
    const client = new GatewayClient({
      baseUrl: "http://127.0.0.1:8765",
      token: "tok",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        sent.push({ url: String(input), body: JSON.parse(String(init?.body)), keepalive: init?.keepalive });
        return new Response(
          JSON.stringify({ variant: "view-state", duplicate: false, instanceId: "winst_1", revision: 4, stateRevision: 7, state: { status: "playing", position: 3, duration: 60 } }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    const invocation = {
      actionBindingId: "act_view",
      expectedRevision: 4,
      expectedBindingDigest: "sha256:x",
      input: { status: "playing", position: 3, duration: 60 },
      invocationId: "inv_1",
      sequence: 1_000,
    };
    const result = await client.writeViewState("conv_1", "winst_1", invocation);
    await client.writeViewState("conv_1", "winst_1", { ...invocation, invocationId: "inv_2", sequence: 1_001 }, { keepalive: true });
    expect(sent[0]?.url).toMatch(/\/conversations\/conv_1\/widgets\/winst_1\/actions$/u);
    expect(sent[0]?.body).toEqual({ instanceId: "winst_1", ...invocation, variant: "view-state" });
    expect([sent[0]?.keepalive, sent[1]?.keepalive]).toEqual([undefined, true]);
    // The answer is the state alone: the revision the page holds and nothing to re-render.
    expect(result).toMatchObject({ revision: 4, stateRevision: 7, state: { position: 3 } });
    expect(result.timeline).toBeUndefined();
  });
});
