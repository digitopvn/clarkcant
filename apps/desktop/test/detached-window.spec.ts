import { describe, expect, it } from "vitest";

import {
  DETACHED_CHANNELS,
  PRIVILEGED_FIELDS,
  detachedBootstrap,
  detachedBounds,
  detachedWindowOptions,
  reviewDetachedBootstrap,
  reviewDetachedIntent,
} from "../src/detached-window.mjs";

/**
 * The detached window, checked as attacks.
 *
 * Phase 7 §Detach asks for a window that "receives only widget host bootstrap + instance ref, not full privileged
 * conversation context". The interesting half of that is the negative: what a detached window *cannot* reach. Each
 * test below names a way in — a token smuggled through the bootstrap, a field the bridge should not carry, an
 * instance reference nobody can show — and checks that the way in is closed.
 *
 * These run in Node against the module the main process imports, so the posture is checked on every test run
 * rather than confirmed once by opening a window.
 */

const PRELOAD = "/tmp/detached-preload.cjs";

describe("the detached bootstrap", () => {
  it("carries the widget host bootstrap and cannot be widened by its input", () => {
    /*
     * The security property is construction, not redaction. A caller that passes a token gets a bootstrap without
     * one because the token is not among the three things this reads — so there is no filter to get wrong later.
     */
    const bootstrap = detachedBootstrap({
      instanceRef: "widget_1",
      title: "Bảng điều khiển",
      widgetKind: "note",
      live: { compositionId: "comp_1", sections: [] },
      token: "local-secret",
      gateway: "http://127.0.0.1:4273",
      conversationId: "conv_1",
    });

    expect(Object.keys(bootstrap).sort()).toEqual(["instanceRef", "live", "title", "widgetKind"]);
    expect(JSON.stringify(bootstrap)).not.toContain("local-secret");
    expect(JSON.stringify(bootstrap)).not.toContain("4273");
    expect(JSON.stringify(bootstrap)).not.toContain("conv_1");
  });

  it("names every field that would make a detached window privileged", () => {
    // The list is asserted rather than trusted: it is what the absence tests below are written against.
    expect(PRIVILEGED_FIELDS).toContain("token");
    expect(PRIVILEGED_FIELDS).toContain("localToken");
    expect(PRIVILEGED_FIELDS).toContain("gateway");
    expect(PRIVILEGED_FIELDS).toContain("conversationId");
  });

  it("refuses a bootstrap carrying a credential rather than quietly stripping it", () => {
    /*
     * A payload that arrived with a token means something upstream intended to send one. Removing it here would
     * leave that intention in place for the next change to complete.
     */
    const reviewed = reviewDetachedBootstrap({ instanceRef: "widget_1", token: "local-secret" });
    expect(reviewed.ok).toBe(false);
    expect(reviewed.ok === false ? reviewed.reason : "").toContain("token");
  });

  it("refuses a field a detached window does not receive", () => {
    const reviewed = reviewDetachedBootstrap({ instanceRef: "widget_1", transcript: [] });
    expect(reviewed.ok).toBe(false);
    expect(reviewed.ok === false ? reviewed.reason : "").toContain("transcript");
  });

  it("refuses a window that has nothing to show", () => {
    // An empty frame would read as a widget that failed to load rather than as a request that made no sense.
    expect(reviewDetachedBootstrap({ instanceRef: "", title: "x" }).ok).toBe(false);
    expect(reviewDetachedBootstrap({ title: "x" }).ok).toBe(false);
    expect(reviewDetachedBootstrap(null).ok).toBe(false);
    expect(reviewDetachedBootstrap([]).ok).toBe(false);
  });

  it("accepts the bootstrap it builds", () => {
    const bootstrap = detachedBootstrap({
      instanceRef: "widget_1",
      title: "Bảng điều khiển",
      live: { compositionId: "comp_1", sections: [] },
    });
    expect(reviewDetachedBootstrap(bootstrap).ok).toBe(true);
  });

  it("refuses a window with no composition to draw", () => {
    // An empty frame reads as a widget that failed to load rather than as a detach that could not be prepared.
    const reviewed = reviewDetachedBootstrap({ instanceRef: "widget_1", title: "x" });
    expect(reviewed.ok).toBe(false);
    expect(reviewed.ok === false ? reviewed.reason : "").toContain("bootstrap");
  });
});

describe("the detached window itself", () => {
  it("is as hardened as the window it came from", () => {
    const options = detachedWindowOptions(PRELOAD, { x: 0, y: 0, width: 900, height: 700 });
    expect(options.preload).toBe(PRELOAD);
    expect(options.sandbox).toBe(true);
    expect(options.contextIsolation).toBe(true);
    expect(options.nodeIntegration).toBe(false);
    expect(options.webviewTag).toBe(false);
    // Detaching is a presentation change, so nothing here widens what renderer code may reach.
    expect(options.allowRunningInsecureContent).toBe(false);
  });

  it("refuses to build without a preload path", () => {
    expect(() => detachedWindowOptions("", { x: 0, y: 0, width: 900, height: 700 })).toThrow();
  });

  it("opens beside its parent and inside the work area", () => {
    const bounds = detachedBounds({ x: 100, y: 50, width: 1000, height: 800 }, { x: 0, y: 0, width: 1920, height: 1080 });
    expect(bounds.x).toBeGreaterThan(100);
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1920);
  });

  it("clamps a window that would otherwise open off-screen", () => {
    // A parent near the right edge must not push its detached view past the display, where nobody could reach it.
    const bounds = detachedBounds({ x: 1800, y: 1000, width: 900, height: 700 }, { x: 0, y: 0, width: 1920, height: 1080 });
    expect(bounds.x).toBeLessThanOrEqual(1920 - bounds.width);
    expect(bounds.y).toBeLessThanOrEqual(1080 - bounds.height);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
  });
});

describe("the relayed intent", () => {
  it("accepts the four fields an action needs and nothing else", () => {
    const reviewed = reviewDetachedIntent({
      instanceRef: "widget_1",
      actionBindingId: "bind_1",
      expectedRevision: 4,
      input: { text: "xin chào" },
    });
    expect(reviewed.ok).toBe(true);
  });

  it("refuses an intent that tries to act as the host", () => {
    /*
     * The window holds no token, so it cannot invoke anything itself. An intent carrying one is an attempt to act
     * as the host rather than to ask it — which is the distinction the relay exists to preserve.
     */
    const reviewed = reviewDetachedIntent({ instanceRef: "w", actionBindingId: "b", token: "local-secret" });
    expect(reviewed.ok).toBe(false);
    expect(reviewed.ok === false ? reviewed.reason : "").toContain("token");
  });

  it("refuses an intent that names no binding or no instance", () => {
    expect(reviewDetachedIntent({ instanceRef: "w" }).ok).toBe(false);
    expect(reviewDetachedIntent({ actionBindingId: "b" }).ok).toBe(false);
    expect(reviewDetachedIntent({ instanceRef: "w", actionBindingId: "b", conversationId: "c" }).ok).toBe(false);
  });
});

describe("the detached channels", () => {
  it("names each one, so the allowlist stays a list of things permitted", () => {
    expect(new Set(DETACHED_CHANNELS).size).toBe(DETACHED_CHANNELS.length);
    for (const channel of DETACHED_CHANNELS) {
      expect(channel.startsWith("desktop:") || channel.startsWith("detached:")).toBe(true);
    }
    // The conversation's own verbs and the detached window's own question are separate channels: detaching is an
    // act of the conversation, and asking for a bootstrap is only a detached window's business.
    expect(DETACHED_CHANNELS).toContain("desktop:detachWidget");
    expect(DETACHED_CHANNELS).toContain("detached:bootstrap");
  });
});
