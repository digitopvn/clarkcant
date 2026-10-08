import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { appearanceSnapshotSchema } from "@clarkcant/contracts";
import { compileAppearance } from "@clarkcant/design-tokens";

import {
  DETACHED_CHANNELS,
  DETACHED_LEASE,
  PRIVILEGED_FIELDS,
  detachedBootstrap,
  detachedBounds,
  detachedWindowOptions,
  holdDetachedLease,
  keepDetachedLease,
  reviewDetachedBootstrap,
  reviewDetachedIntent,
  reviewDetachedAppearance,
  superviseDetachedWindow,
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

describe("the detached appearance boundary", () => {
  it("keeps the real Electron smoke fixture equal to current compiler output", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/appearance.json", import.meta.url), "utf8"));
    expect(fixture).toEqual({
      initial: compileAppearance({ scheme: "dark" }),
      next: compileAppearance({ scheme: "light", reducedMotion: true }),
    });
  });

  it("keeps every reference-package smoke snapshot equal to the installed theme compiler", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/reference-appearance.json", import.meta.url), "utf8"));
    const expected = [];
    for (const name of ["pixel-arcade", "neo-brutalism"]) {
      const theme = JSON.parse(readFileSync(new URL(`../../../examples/themes/${name}/themes/${name}.json`, import.meta.url), "utf8"));
      for (const scheme of ["dark", "light"] as const) {
        for (const reducedMotion of [false, true]) {
          const appearance = compileAppearance({ scheme, reducedMotion, theme, themeRef: `package:org.clarkcant.${name}#${name}` });
          expect(reviewDetachedAppearance(appearance)).toEqual({ ok: true, appearance });
          expected.push({ name, scheme, reducedMotion, appearance });
        }
      }
    }
    expect(fixture).toEqual(expected);
  });

  it("uses the current canonical schema, accepts a snapshot and refuses raw/privileged styling", () => {
    const generated = JSON.parse(readFileSync(new URL("../src/appearance-schema.json", import.meta.url), "utf8"));
    expect(generated).toEqual(appearanceSnapshotSchema.toJSONSchema());
    const appearance = compileAppearance({ scheme: "dark" });
    expect(reviewDetachedAppearance(appearance)).toEqual({ ok: true, appearance });
    expect(reviewDetachedAppearance({ ...appearance, token: "must-not-cross" }).ok).toBe(false);
    expect(reviewDetachedAppearance({ ...appearance, tokens: { ...appearance.tokens, token: "must-not-cross" } }).ok).toBe(false);
    expect(reviewDetachedAppearance({ ...appearance, tokens: { ...appearance.tokens, color: { ...appearance.tokens.color, canvas: "url(https://bad.test)" } } }).ok).toBe(false);
    expect(reviewDetachedAppearance({ ...appearance, themeRef: "x".repeat(40_000) }).ok).toBe(false);
    expect(reviewDetachedAppearance(undefined).ok).toBe(false);
    const bootstrap = detachedBootstrap({ instanceRef: "widget_1", live: {}, appearance });
    expect(reviewDetachedBootstrap(bootstrap).ok).toBe(true);
    expect(reviewDetachedBootstrap({ ...bootstrap, appearance: { ...appearance, rawTheme: {} } }).ok).toBe(false);
  });
});

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

  it("refuses to detach a widget that runs in its own frame", () => {
    // The window holds no credential, so an isolated frame there could not save its state or renew its URL.
    const reviewed = reviewDetachedBootstrap(
      detachedBootstrap({
        instanceRef: "widget_1",
        title: "Khung riêng",
        live: { kind: "isolated-frame", instanceId: "widget_1", frame: { url: "/widgets/frame" } },
      }),
    );
    expect(reviewed.ok).toBe(false);
    expect(reviewed.ok === false ? reviewed.reason : "").toContain("own frame");
  });
});

describe("the detached window itself", () => {
  it("is as hardened as the window it came from", () => {
    const options = detachedWindowOptions(PRELOAD, { x: 0, y: 0, width: 900, height: 700 });
    expect(options.webPreferences.preload).toBe(PRELOAD);
    expect(options.webPreferences.sandbox).toBe(true);
    expect(options.webPreferences.contextIsolation).toBe(true);
    expect(options.webPreferences.nodeIntegration).toBe(false);
    expect(options.webPreferences.webviewTag).toBe(false);
    // Detaching is a presentation change, so nothing here widens what renderer code may reach.
    expect(options.webPreferences.allowRunningInsecureContent).toBe(false);
  });

  it("puts the preload where Electron reads it, not spread across the window options", () => {
    /*
     * The regression this test exists for: a top-level `preload` is not an error and not a warning — Electron
     * simply ignores it, so the window opens with no bridge and looks entirely healthy. Asserting the key is
     * *absent* at the top level is what makes that visible, because every other assertion here passes either way.
     */
    const options = detachedWindowOptions(PRELOAD, { x: 0, y: 0, width: 900, height: 700 });
    /*
     * SAFETY: the assertion is that these keys are *absent*, which a typed read cannot express — the type has no
     * such properties precisely because they must not be there. Reading through a loose view is what makes the
     * absence testable at all.
     */
    const loose = options as unknown as Record<string, unknown>;
    expect(loose["preload"]).toBeUndefined();
    expect(loose["sandbox"]).toBeUndefined();
    expect(options.webPreferences.preload).toBe(PRELOAD);
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

describe("the detached window keeps its lease while it is open", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the conversation's own numbers, refreshing well inside the lease", () => {
    expect(DETACHED_LEASE).toEqual({ refreshMs: 30_000, leaseMs: 90_000, endWithinMs: 5_000 });
    expect(DETACHED_LEASE.refreshMs * 3).toBe(DETACHED_LEASE.leaseMs);
  });

  it("re-claims on every tick until stopped", async () => {
    vi.useFakeTimers();
    const claim = vi.fn(async () => ({ ok: true }));
    const onLost = vi.fn();
    const lease = keepDetachedLease({ claim, onLost });
    await vi.advanceTimersByTimeAsync(DETACHED_LEASE.refreshMs * 3);
    expect(claim).toHaveBeenCalledTimes(3);
    lease.stop();
    await vi.advanceTimersByTimeAsync(DETACHED_LEASE.refreshMs * 3);
    expect(claim).toHaveBeenCalledTimes(3);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("says the instance was lost, once, when another surface holds it now", async () => {
    vi.useFakeTimers();
    const refusal = { ok: false, code: "ALREADY_OWNED", refused: "the node refused: another surface holds it" };
    const claim = vi.fn(async () => refusal);
    const onLost = vi.fn();
    keepDetachedLease({ claim, onLost, refreshMs: 1_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith(refusal);
    // Stopped after the loss: a window that no longer owns the instance does not keep claiming it.
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("keeps trying through a node that is not answering, which is not a loss", async () => {
    vi.useFakeTimers();
    const claim = vi
      .fn<() => Promise<{ ok: boolean; code?: string }>>()
      .mockResolvedValueOnce({ ok: false, code: "NODE_UNREACHABLE" })
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue({ ok: true });
    const onLost = vi.fn();
    const lease = keepDetachedLease({ claim, onLost, refreshMs: 1_000 });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(claim).toHaveBeenCalledTimes(4);
    expect(onLost).not.toHaveBeenCalled();
    lease.stop();
  });

  it("does not queue claims behind a node slow to answer", async () => {
    vi.useFakeTimers();
    let answer: (value: { ok: boolean }) => void = () => undefined;
    const claim = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => (answer = resolve)));
    const lease = keepDetachedLease({ claim, onLost: vi.fn(), refreshMs: 1_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(claim).toHaveBeenCalledTimes(1);
    answer({ ok: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claim).toHaveBeenCalledTimes(2);
    lease.stop();
  });

  it("answers the refresh still on its way when stopped, so a release can wait for it", async () => {
    vi.useFakeTimers();
    let answer: (value: { ok: boolean }) => void = () => undefined;
    const claim = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => (answer = resolve)));
    const lease = keepDetachedLease({ claim, onLost: vi.fn(), refreshMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claim).toHaveBeenCalledTimes(1);

    let settled = false;
    const stopped = lease.stop();
    expect(stopped).toBeInstanceOf(Promise);
    void stopped.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    answer({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });
});

describe("the detached window's lease is never claimed after the window is gone", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function controlled<T>() {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
  }

  it("releases only after a refresh in flight at close has landed, and settles only after the release", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const refresh = controlled<{ ok: boolean }>();
    const release = controlled<void>();
    const claim = vi
      .fn<() => Promise<{ ok: boolean }>>()
      .mockResolvedValueOnce({ ok: true })
      .mockImplementationOnce(() => {
        order.push("refresh sent");
        return refresh.promise.then((answer) => {
          order.push("refresh landed");
          return answer;
        });
      });
    const lease = holdDetachedLease({
      claim,
      release: () => {
        order.push("release sent");
        return release.promise.then(() => order.push("release landed"));
      },
      onLost: vi.fn(),
      isOpen: () => true,
      refreshMs: 1_000,
    });
    expect(await lease.begin()).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(order).toEqual(["refresh sent"]);

    let ended = false;
    void lease.end().then(() => {
      ended = true;
      order.push("conversation told");
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["refresh sent"]);

    refresh.resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["refresh sent", "refresh landed", "release sent"]);
    expect(ended).toBe(false);

    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(true);
    expect(order).toEqual(["refresh sent", "refresh landed", "release sent", "release landed", "conversation told"]);
    // Stopped: no refresh follows the release.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it("does not claim for a window that closed while it was loading", async () => {
    const claim = vi.fn(async () => ({ ok: true }));
    const release = vi.fn(async () => undefined);
    const lease = holdDetachedLease({ claim, release, onLost: vi.fn(), isOpen: () => false });
    const answer = await lease.begin();
    expect(answer.ok).toBe(false);
    expect(claim).not.toHaveBeenCalled();
    await lease.end();
    // Nothing was claimed, so nothing is released either.
    expect(release).not.toHaveBeenCalled();
  });

  it("does not claim once the window has ended, even if asked to begin afterwards", async () => {
    const claim = vi.fn(async () => ({ ok: true }));
    const lease = holdDetachedLease({ claim, release: vi.fn(async () => undefined), onLost: vi.fn(), isOpen: () => true });
    await lease.end();
    expect((await lease.begin()).ok).toBe(false);
    expect(claim).not.toHaveBeenCalled();
  });

  it("releases after a first claim that was still on its way when the window closed, and keeps no refresh", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const first = controlled<{ ok: boolean }>();
    const claim = vi.fn(() => {
      order.push("claim sent");
      return first.promise.then((answer) => {
        order.push("claim landed");
        return answer;
      });
    });
    const lease = holdDetachedLease({
      claim,
      release: async () => {
        order.push("release sent");
      },
      onLost: vi.fn(),
      isOpen: () => true,
      refreshMs: 1_000,
    });
    const begun = lease.begin();
    const ended = lease.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["claim sent"]);
    first.resolve({ ok: true });
    await ended;
    expect(order).toEqual(["claim sent", "claim landed", "release sent"]);
    expect((await begun).ok).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(claim).toHaveBeenCalledTimes(1);
  });
});
describe("the detached window's lease cannot be held past its window by a node that does not answer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const never = <T>() => new Promise<T>(() => undefined);

  it("settles end() within its bound when a refresh in flight never lands", async () => {
    vi.useFakeTimers();
    const claim = vi
      .fn<() => Promise<{ ok: boolean }>>()
      .mockResolvedValueOnce({ ok: true })
      .mockImplementation(() => never());
    const release = vi.fn(async () => undefined);
    const lease = holdDetachedLease({ claim, release, onLost: vi.fn(), isOpen: () => true, refreshMs: 1_000 });
    await lease.begin();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claim).toHaveBeenCalledTimes(2);

    let ended = false;
    void lease.end().then(() => (ended = true));
    await vi.advanceTimersByTimeAsync(DETACHED_LEASE.endWithinMs - 1);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ended).toBe(true);
    // The release still waits for the refresh: past the bound it is the conversation that stops waiting, not the order.
    expect(release).not.toHaveBeenCalled();
  });

  it("settles end() within its bound when the release never lands", async () => {
    vi.useFakeTimers();
    const lease = holdDetachedLease({
      claim: async () => ({ ok: true }),
      release: () => never(),
      onLost: vi.fn(),
      isOpen: () => true,
      endWithinMs: 2_000,
    });
    await lease.begin();
    let ended = false;
    void lease.end().then(() => (ended = true));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ended).toBe(true);
  });

  it("claims once however often begin() is called, so end() stops every refresh", async () => {
    vi.useFakeTimers();
    const claim = vi.fn(async () => ({ ok: true }));
    const lease = holdDetachedLease({
      claim,
      release: vi.fn(async () => undefined),
      onLost: vi.fn(),
      isOpen: () => true,
      refreshMs: 1_000,
    });
    const first = lease.begin();
    const second = lease.begin();
    expect(second).toBe(first);
    await first;
    await lease.begin();
    expect(claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claim).toHaveBeenCalledTimes(2);

    await lease.end();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(claim).toHaveBeenCalledTimes(2);
  });
});

/**
 * The lease as the main process wires it to the window (`superviseDetachedWindow`), driven with a stand-in window.
 */
describe("the detached window as the main process wires its lease", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function standInWindow() {
    const closed: Array<() => void> = [];
    let destroyed = false;
    const window = {
      closeCalls: 0,
      on(event: "closed", listener: () => void) {
        if (event === "closed") closed.push(listener);
        return window;
      },
      close() {
        window.closeCalls += 1;
        if (destroyed) return;
        destroyed = true;
        for (const listener of closed) listener();
      },
      isDestroyed: () => destroyed,
    };
    return window;
  }

  it("tells the conversation to take the widget back within the bound when the node never answers the release", async () => {
    vi.useFakeTimers();
    const window = standInWindow();
    const order: string[] = [];
    const supervised = superviseDetachedWindow({
      window,
      isCurrent: () => true,
      claim: async () => ({ ok: true }),
      release: () => new Promise(() => undefined),
      onClosed: () => order.push("closed"),
      onEnded: () => order.push("reattach sent"),
    });
    expect((await supervised.begin()).ok).toBe(true);
    let released = false;
    void supervised.released.then(() => (released = true));

    window.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["closed"]);
    await vi.advanceTimersByTimeAsync(DETACHED_LEASE.endWithinMs);
    expect(order).toEqual(["closed", "reattach sent"]);
    expect(released).toBe(true);
  });

  it("tells the conversation only after the release has landed, when the node answers", async () => {
    vi.useFakeTimers();
    const window = standInWindow();
    const order: string[] = [];
    const supervised = superviseDetachedWindow({
      window,
      isCurrent: () => true,
      claim: async () => ({ ok: true }),
      release: async () => {
        order.push("release landed");
      },
      onEnded: () => order.push("reattach sent"),
    });
    await supervised.begin();
    window.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["release landed", "reattach sent"]);
  });

  it("closes the window when its first claim is refused, and claims nothing for a window that is no longer current", async () => {
    const refused = superviseDetachedWindow({
      window: standInWindow(),
      isCurrent: () => true,
      claim: async () => ({ ok: false, code: "ALREADY_OWNED", refused: "held elsewhere" }),
      release: vi.fn(async () => undefined),
      onEnded: vi.fn(),
    });
    expect(await refused.begin()).toMatchObject({ ok: false, refused: "held elsewhere" });

    const claim = vi.fn(async () => ({ ok: true }));
    const stale = superviseDetachedWindow({
      window: standInWindow(),
      isCurrent: () => false,
      claim,
      release: vi.fn(async () => undefined),
      onEnded: vi.fn(),
    });
    expect((await stale.begin()).ok).toBe(false);
    expect(claim).not.toHaveBeenCalled();
  });

  it("closes the window when a refresh finds another surface holding the instance", async () => {
    vi.useFakeTimers();
    const window = standInWindow();
    const onEnded = vi.fn();
    const supervised = superviseDetachedWindow({
      window,
      isCurrent: () => true,
      claim: vi
        .fn<() => Promise<{ ok: boolean; code?: string }>>()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValue({ ok: false, code: "ALREADY_OWNED" }),
      release: async () => undefined,
      onEnded,
      refreshMs: 1_000,
    });
    await supervised.begin();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(window.isDestroyed()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });
});
