import { describe, expect, it } from "vitest";

import { GatewayClient, type IsolatedFrameLiveResponse } from "../src/api.ts";
import { keepMountedFrame } from "../src/DesktopSurfaces.tsx";
import { afterFrameLoad, grantLapsed, startFrameMount } from "../src/WidgetFrame.tsx";

/**
 * A kept frame whose URL's grant lapsed, from the client's side.
 *
 * The grant in a frame URL is short-lived and the frame is not. What these pin is the bookkeeping the browser journey
 * rests on: the client knows when a URL stops working without parsing it, it re-reads before loading a URL it knows
 * is refused, a refused load gets one re-read and then the failure, and a re-read of a running frame never hands it a
 * different URL to reload.
 */

const renewUrl = async (): Promise<{ url: string; urlExpiresAt: number }> => ({ url: "fresh", urlExpiresAt: 2_000 });

describe("when a frame URL's grant has lapsed", () => {
  it("counts a URL as lapsed from its expiry on, and a URL with no known expiry as never lapsing", () => {
    expect(grantLapsed(1_000, 999)).toBe(false);
    expect(grantLapsed(1_000, 1_000)).toBe(true);
    expect(grantLapsed(undefined, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("loads a URL that still works, and reads a fresh one first for a URL that does not", () => {
    expect(startFrameMount({ url: "kept", urlExpiresAt: 1_000, renewUrl }, 500)).toEqual({
      given: "kept",
      source: { url: "kept", urlExpiresAt: 1_000 },
      renewed: false,
      failure: undefined,
    });
    // The re-read before mounting is the one re-read: a refused load of the fresh URL is the failure.
    expect(startFrameMount({ url: "kept", urlExpiresAt: 1_000, renewUrl }, 1_500)).toEqual({
      given: "kept",
      source: undefined,
      renewed: true,
      failure: undefined,
    });
    // With no way to re-read, the frame loads what it was given, as it always did.
    expect(startFrameMount({ url: "kept", urlExpiresAt: 1_000 }, 1_500).source).toEqual({ url: "kept", urlExpiresAt: 1_000 });
  });

  it("answers a refused load with exactly one re-read, and then with the failure", () => {
    const mounted = startFrameMount({ url: "kept", urlExpiresAt: 1_000, renewUrl }, 500);
    // A load before the expiry is the widget's own document; nothing changes.
    expect(afterFrameLoad(mounted, true, 900)).toBe(mounted);

    const renewing = afterFrameLoad(mounted, true, 1_500);
    expect(renewing).toEqual({ ...mounted, source: undefined, renewed: true });

    // The fresh URL is loaded and refused as well: the re-read is spent, so this is the failure and not a second one.
    const refusedAgain = { ...renewing, source: { url: "fresh", urlExpiresAt: 1_600 } };
    expect(afterFrameLoad(refusedAgain, true, 1_700)).toEqual({ ...refusedAgain, failure: "" });
  });

  it("shows the failure at once for a refused load when there is no way to re-read", () => {
    const mounted = startFrameMount({ url: "kept", urlExpiresAt: 1_000 }, 500);
    expect(afterFrameLoad(mounted, false, 1_500).failure).toBe("");
  });
});

describe("keeping a running frame's URL across a re-read", () => {
  it("keeps the old URL together with its own expiry, never the new read's", () => {
    const frame = (url: string, at: number) =>
      ({
        kind: "isolated-frame",
        frame: { url, document: "com.example.board@1.0.0/widgets/main/index.html", urlExpiresInMs: 300_000, urlExpiresAt: at },
        bindings: [],
      }) as unknown as IsolatedFrameLiveResponse;

    const kept = keepMountedFrame(frame("/frame/one/index.html", 1_000), frame("/frame/two/index.html", 9_000));
    expect((kept as IsolatedFrameLiveResponse).frame).toMatchObject({ url: "/frame/one/index.html", urlExpiresAt: 1_000 });
  });
});

describe("reading a live frame", () => {
  it("stamps when its URL stops working in this client's clock, counted from when the request went out", async () => {
    const body = {
      kind: "isolated-frame",
      instanceId: "inst_1",
      frame: { url: "/frame/grant/widgets/main/index.html", urlExpiresInMs: 300_000 },
      bindings: [],
    };
    const client = new GatewayClient({
      baseUrl: "http://127.0.0.1:8765",
      token: "tok",
      fetchImpl: (async () =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
    });

    const before = Date.now();
    const live = (await client.liveWidget("conv_1", "inst_1")) as IsolatedFrameLiveResponse;
    const after = Date.now();

    const expiresAt = live.frame?.urlExpiresAt ?? 0;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 300_000);
    expect(live.frame?.url).toBe(body.frame.url);
  });

  it("stamps nothing when the node did not say how long the URL lasts", async () => {
    const client = new GatewayClient({
      baseUrl: "http://127.0.0.1:8765",
      token: "tok",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ kind: "isolated-frame", frame: { url: "/frame/g/index.html" }, bindings: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    const live = (await client.liveWidget("conv_1", "inst_1")) as IsolatedFrameLiveResponse;
    expect(live.frame?.urlExpiresAt).toBeUndefined();
  });
});
