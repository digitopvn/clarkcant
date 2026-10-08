import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  COMPOSER_SURFACE_HEADER as CONTRACT_COMPOSER_SURFACE_HEADER,
  appearanceSnapshotSchema,
  semanticProposalSchema,
} from "@clarkcant/contracts";
import { compileAppearance } from "@clarkcant/design-tokens";
import { DETACHED_RELAY_LIMITS, FRAME_BROKER_LIMITS, FRAME_MESSAGE_MAX_BYTES } from "@clarkcant/widget-host/session";

import {
  BROKER_RELAY_VERBS,
  COMPOSER_SURFACE_HEADER,
  DETACHED_CHANNELS,
  DETACHED_LEASE,
  PRIVILEGED_FIELDS,
  RELAY_BUCKETS,
  RELAY_LIMITS,
  detachedBootstrap,
  detachedBounds,
  detachedWindowOptions,
  holdDetachedLease,
  keepDetachedLease,
  redactDevSessionView,
  relayBudget,
  reviewDetachedBootstrap,
  reviewDetachedDevSession,
  reviewDetachedFrameAnswer,
  reviewDetachedFrameRead,
  reviewDetachedIntent,
  reviewDetachedAppearance,
  reviewDetachedBrokerRequest,
  reviewDetachedSemanticPublish,
  reviewDetachedStateSave,
  runRelay,
  superviseDetachedWindow,
  tokenSessions,
} from "../src/detached-window.mjs";
import { createNodeCaller } from "../src/node-call.mjs";

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

  it("accepts a widget that runs in its own frame, which the host's relays let the window run", () => {
    const reviewed = reviewDetachedBootstrap(
      detachedBootstrap({
        instanceRef: "widget_1",
        title: "Khung riêng",
        live: { kind: "isolated-frame", instanceId: "widget_1", frame: { url: "/widgets/frame" } },
      }),
    );
    expect(reviewed.ok).toBe(true);
  });

  it("refuses a frame whose package is gone, by name", () => {
    // `frame: null` leaves only the widget's text, which the conversation already shows; a window would run nothing.
    const reviewed = reviewDetachedBootstrap(
      detachedBootstrap({
        instanceRef: "widget_1",
        live: { kind: "isolated-frame", instanceId: "widget_1", frame: null, textFallback: "Bộ đếm" },
      }),
    );
    expect(reviewed.ok).toBe(false);
    expect(reviewed.ok === false ? reviewed.reason : "").toContain("frame: null");
  });
});

/** Every field a relay must refuse, by name, whatever else it carries. */
const SMUGGLED = [...PRIVILEGED_FIELDS, "instanceId"] as const;

describe("the frame relays", () => {
  it("accept exactly their own fields", () => {
    expect(reviewDetachedFrameRead(undefined)).toEqual({ ok: true });
    expect(reviewDetachedFrameRead({})).toEqual({ ok: true });
    expect(reviewDetachedDevSession(undefined)).toEqual({ ok: true });
    expect(reviewDetachedStateSave({ expectedRevision: 3, patch: { count: 1 } })).toEqual({
      ok: true,
      write: { expectedRevision: 3, patch: { count: 1 } },
    });
    expect(reviewDetachedSemanticPublish({ proposal: { summary: "Đang đếm", selectedIds: ["a"], values: { count: 1 } } })).toEqual({
      ok: true,
      proposal: { summary: "Đang đếm", selectedIds: ["a"], values: { count: 1 } },
    });
    expect(
      reviewDetachedIntent({ instanceRef: "w", actionBindingId: "b", expectedRevision: 1, input: {}, invocationId: "inv_1" }).ok,
    ).toBe(true);
  });

  it("refuse every privileged field and every id, by name", () => {
    for (const field of SMUGGLED) {
      const reviews = [
        reviewDetachedFrameRead({ [field]: "x" }),
        reviewDetachedDevSession({ [field]: "x" }),
        reviewDetachedStateSave({ expectedRevision: 0, patch: {}, [field]: "x" }),
        reviewDetachedSemanticPublish({ proposal: { summary: "s" }, [field]: "x" }),
        reviewDetachedIntent({ instanceRef: "w", actionBindingId: "b", expectedRevision: 0, [field]: "x" }),
      ];
      for (const reviewed of reviews) {
        expect(reviewed.ok).toBe(false);
        expect("reason" in reviewed ? String(reviewed.reason) : "").toContain(field);
      }
    }
  });

  it("refuse a field they do not take", () => {
    expect(reviewDetachedFrameRead({ path: "/conversations" }).ok).toBe(false);
    expect(reviewDetachedDevSession({ sessionId: "other" }).ok).toBe(false);
    expect(reviewDetachedStateSave({ expectedRevision: 0, patch: {}, path: "/x" }).ok).toBe(false);
    expect(reviewDetachedSemanticPublish({ proposal: { summary: "s" }, availableActions: [] }).ok).toBe(false);
    // Actions a widget offers are the host's bindings; a proposal that names its own is refused, not partly read.
    expect(reviewDetachedSemanticPublish({ proposal: { summary: "s", availableActions: [] } }).ok).toBe(false);
    expect(reviewDetachedIntent({ instanceRef: "w", actionBindingId: "b", expectedRevision: 0, expectedBindingDigest: "d" }).ok).toBe(false);
  });

  it("refuse a payload over its size", () => {
    const big = "x".repeat(RELAY_LIMITS["state.save"].maxBytes);
    expect(reviewDetachedStateSave({ expectedRevision: 0, patch: { big } }).ok).toBe(false);
    const values = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${String(index)}`, "y".repeat(600)]));
    expect(reviewDetachedSemanticPublish({ proposal: { summary: "s", values } }).ok).toBe(false);
    const input = { text: "z".repeat(RELAY_LIMITS.intent.maxBytes) };
    expect(reviewDetachedIntent({ instanceRef: "w", actionBindingId: "b", expectedRevision: 0, input }).ok).toBe(false);
  });

  it("refuse malformed ids, revisions and shapes", () => {
    expect(reviewDetachedIntent({ instanceRef: "w", actionBindingId: "b".repeat(129), expectedRevision: 0 }).ok).toBe(false);
    expect(reviewDetachedIntent({ instanceRef: "w", actionBindingId: "b", expectedRevision: 0, invocationId: "" }).ok).toBe(false);
    expect(reviewDetachedIntent({ instanceRef: "w", actionBindingId: "b", expectedRevision: 0, invocationId: 7 }).ok).toBe(false);
    expect(reviewDetachedIntent({ instanceRef: "w", actionBindingId: "b", expectedRevision: -1 }).ok).toBe(false);
    expect(reviewDetachedIntent({ instanceRef: "w", actionBindingId: "b", expectedRevision: 0, input: [] }).ok).toBe(false);
    expect(reviewDetachedStateSave({ expectedRevision: 1.5, patch: {} }).ok).toBe(false);
    expect(reviewDetachedStateSave({ expectedRevision: 0, patch: [] }).ok).toBe(false);
    expect(reviewDetachedStateSave(null).ok).toBe(false);
    expect(reviewDetachedSemanticPublish({ proposal: { summary: "" } }).ok).toBe(false);
    expect(reviewDetachedFrameRead([]).ok).toBe(false);
  });

  it("check the node's read is this instance, still in its own frame, framed from the node", () => {
    const bound = { instanceId: "widget_1", baseUrl: "http://127.0.0.1:4273" };
    const read = { kind: "isolated-frame", instanceId: "widget_1", frame: { url: "/frame/g1/index.html", document: "d1" } };
    expect(reviewDetachedFrameAnswer(read, bound)).toEqual({
      ok: true,
      live: { ...read, frame: { url: "http://127.0.0.1:4273/frame/g1/index.html", document: "d1" } },
    });
    expect(reviewDetachedFrameAnswer({ ...read, frame: null }, bound).ok).toBe(true);
    expect(reviewDetachedFrameAnswer({ ...read, instanceId: "widget_2" }, bound).ok).toBe(false);
    expect(reviewDetachedFrameAnswer({ ...read, kind: "composition" }, bound).ok).toBe(false);
    expect(reviewDetachedFrameAnswer({ ...read, frame: { url: "https://elsewhere.test/x" } }, bound).ok).toBe(false);
    expect(reviewDetachedFrameAnswer({ ...read, frame: { url: "//elsewhere.test/x" } }, bound).ok).toBe(false);
    expect(reviewDetachedFrameAnswer(undefined, bound).ok).toBe(false);
  });
});

describe("the relay budget", () => {
  it("spends a burst, then refuses until the bucket refills", () => {
    let now = 0;
    const budget = relayBudget({ now: () => now });
    const burst = RELAY_LIMITS["frame.read"].burst;
    for (let index = 0; index < burst; index += 1) {
      const taken = budget.take("frame.read");
      expect(taken.ok).toBe(true);
      if (taken.ok) taken.done();
    }
    expect(budget.take("frame.read")).toMatchObject({ ok: false, code: "RELAY_RATE_LIMITED" });
    // Another verb has its own bucket.
    expect(budget.take("state.save").ok).toBe(true);
    now += 1000 / RELAY_LIMITS["frame.read"].refillPerSecond;
    const refilled = budget.take("frame.read");
    expect(refilled.ok).toBe(true);
    expect(budget.take("frame.read")).toMatchObject({ ok: false, code: "RELAY_RATE_LIMITED" });
  });

  it("refuses rather than queues past the calls in flight, across every verb and for presses on their own", () => {
    const budget = relayBudget({ now: () => 0 });
    const presses = Array.from({ length: RELAY_LIMITS.intent.inFlight }, () => budget.take("intent"));
    expect(presses.every((taken) => taken.ok)).toBe(true);
    expect(budget.take("intent")).toMatchObject({ ok: false, code: "RELAY_BUSY" });
    const others = Array.from({ length: RELAY_LIMITS.inFlight - RELAY_LIMITS.intent.inFlight }, () => budget.take("state.save"));
    expect(others.every((taken) => taken.ok)).toBe(true);
    expect(budget.take("semantic.publish")).toMatchObject({ ok: false, code: "RELAY_BUSY" });
    // A call that settles frees its place, once, however often it says so.
    const first = presses[0];
    if (first?.ok) {
      first.done();
      first.done();
    }
    expect(budget.take("semantic.publish").ok).toBe(true);
    expect(budget.take("dev.session")).toMatchObject({ ok: false, code: "RELAY_BUSY" });
  });

  it("refuses a verb it has no limits for", () => {
    expect(relayBudget().take("node")).toMatchObject({ ok: false, code: "RELAY_UNKNOWN" });
    expect(relayBudget().take("inFlight")).toMatchObject({ ok: false, code: "RELAY_UNKNOWN" });
  });
});

describe("a node that accepts relayed calls and never answers", () => {
  const VERBS = ["frame.read", "state.save", "semantic.publish", "intent", "dev.session"] as const;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds every relayed verb in time", () => {
    for (const verb of VERBS) {
      const timeoutMs: unknown = (RELAY_LIMITS[verb] as { timeoutMs?: unknown }).timeoutMs;
      // A press waits out the node's longest action deadline (held in the runtime's `action-limits.spec.ts`); the rest
      // are single reads and writes.
      const ceiling = verb === "intent" ? 360_000 : 60_000;
      expect(typeof timeoutMs === "number" && timeoutMs > 0 && timeoutMs <= ceiling, verb).toBe(true);
    }
  });

  it.each(VERBS)("answers %s with NODE_TIMEOUT and frees its in-flight slot", async (verb) => {
    vi.useFakeTimers();
    const silent = createNodeCaller({
      readSession: () => ({ ok: true, baseUrl: "http://127.0.0.1:8765", token: "test-token-not-a-credential" }),
      fetch: (_url: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    // A budget with room for exactly one call, so the slot this call holds is the only one.
    const budget = relayBudget({ limits: { ...RELAY_LIMITS, inFlight: 1 } as unknown as typeof RELAY_LIMITS, now: () => 0 });
    const hung = runRelay(budget, verb, silent, (call) => call("/x", { method: "GET" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await runRelay(budget, verb, silent, async () => ({ ok: true }))).toMatchObject({ ok: false, code: "RELAY_BUSY" });
    await vi.advanceTimersByTimeAsync(RELAY_LIMITS[verb].timeoutMs);
    expect(await hung).toMatchObject({ ok: false, code: "NODE_TIMEOUT" });
    expect(await runRelay(budget, verb, silent, async () => ({ ok: true }))).toEqual({ ok: true });
  });

  it("refuses a call over the budget without reaching the node", async () => {
    const callNode = vi.fn();
    const budget = relayBudget({ limits: { ...RELAY_LIMITS, inFlight: 0 } as unknown as typeof RELAY_LIMITS, now: () => 0 });
    expect(await runRelay(budget, "frame.read", callNode, (call) => call("/x"))).toMatchObject({ ok: false, code: "RELAY_BUSY" });
    expect(callNode).not.toHaveBeenCalled();
  });
});

describe("the developer's folder path in a relayed dev-session status", () => {
  const diagnostics = (...messages: string[]) => ({
    lastBuild: { ok: false, diagnostics: messages.map((message) => ({ severity: "error", message })) },
  });
  const messagesOf = (view: Record<string, unknown>) =>
    (view["lastBuild"] as { diagnostics: { message: string }[] }).diagnostics.map((entry) => entry.message);

  it("drops the folder and where the session is placed", () => {
    const view = redactDevSessionView({ sessionId: "dev_1", root: "/home/someone/w", placed: { conversationId: "c", instanceId: "i" } });
    expect(view).toEqual({ sessionId: "dev_1" });
  });

  it("replaces the folder inside build messages, and keeps a file under it relative to the package", () => {
    const view = redactDevSessionView({
      root: "/home/someone/private-widget/",
      ...diagnostics(
        "/home/someone/private-widget/src/main.ts:3:7: Expected \";\"",
        "Could not read /home/someone/private-widget",
        "see file:///home/someone/private-widget/manifest.json",
        "/HOME/someone/Private-Widget/a.ts failed",
      ),
    });
    expect(messagesOf(view)).toEqual([
      "./src/main.ts:3:7: Expected \";\"",
      "Could not read .",
      "see file://./manifest.json",
      "./a.ts failed",
    ]);
    expect(JSON.stringify(view).toLowerCase()).not.toContain("private-widget");
  });

  it("finds a Windows folder in either slash direction and URL-encoded", () => {
    const view = redactDevSessionView({
      root: "C:\\Users\\Some One\\widget",
      ...diagnostics("C:\\Users\\Some One\\widget\\src\\a.ts: bad", "c:/users/some one/widget/src/a.ts: bad", "file:///C:/Users/Some%20One/widget/b.ts"),
    });
    expect(messagesOf(view)).toEqual([".\\src\\a.ts: bad", "./src/a.ts: bad", "file:///./b.ts"]);
  });

  it("leaves a sibling folder that only starts with the same name alone", () => {
    const view = redactDevSessionView({ root: "/w/widget", ...diagnostics("/w/widget2/a.ts and /w/widget-old/b.ts") });
    expect(messagesOf(view)).toEqual(["/w/widget2/a.ts and /w/widget-old/b.ts"]);
  });

  it("leaves a sibling whose name continues with a dot alone, and still redacts the folder before a full stop", () => {
    const view = redactDevSessionView({ root: "/w", ...diagnostics("/w.bak/x, /w/a.ts: and /w.") });
    expect(messagesOf(view)).toEqual(["/w.bak/x, ./a.ts: and .."]);
  });

  it("redacts every string in the view, not only messages", () => {
    const view = redactDevSessionView({ root: "/r/w", activation: { state: "refused", message: "refused /r/w/x" }, notes: ["/r/w"] });
    expect(view).toEqual({ activation: { state: "refused", message: "refused ./x" }, notes: ["."] });
  });
});

describe("the relay limits and schema, against the packages they copy", () => {
  it("holds the host's limits equal to the widget host's", () => {
    expect(JSON.parse(JSON.stringify(RELAY_LIMITS))).toEqual(JSON.parse(JSON.stringify(DETACHED_RELAY_LIMITS)));
    // A press is a frame message, so its ceiling is the frame session's own.
    expect(RELAY_LIMITS.intent.maxBytes).toBe(FRAME_MESSAGE_MAX_BYTES);
    // A widget's files, jobs and tokens are spent from the same buckets in the detached window as in the conversation.
    for (const bucket of ["artifacts", "jobs", "tokens"] as const) {
      const { timeoutMs: _timeout, ...rate } = RELAY_LIMITS[bucket];
      expect(rate).toEqual(FRAME_BROKER_LIMITS[bucket]);
    }
  });

  it("holds the semantic proposal schema equal to the contract", () => {
    const generated = JSON.parse(readFileSync(new URL("../src/semantic-proposal-schema.json", import.meta.url), "utf8"));
    expect(generated).toEqual(semanticProposalSchema.toJSONSchema());
  });

  it("marks a relayed press with the conversation's own surface header", () => {
    expect(COMPOSER_SURFACE_HEADER).toBe(CONTRACT_COMPOSER_SURFACE_HEADER);
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

const SESSION = "s".repeat(32);
const BROKER_ACCEPTED: Record<string, Record<string, unknown>> = {
  "artifacts.pick": { accept: ["text/plain", "image/*"], title: "Timer wants a file", filterName: "Files" },
  "artifacts.describe": { artifactId: "art_1" },
  "artifacts.create": { mimeType: "text/plain", name: "notes.txt" },
  "artifacts.read": { artifactId: "art_1", offset: 0, length: 262_144 },
  "artifacts.write": { artifactId: "art_1", offset: 5, chunkBase64: "aGVsbG8=" },
  "artifacts.finalize": { artifactId: "art_1" },
  "artifacts.export": {
    artifactId: "art_1",
    suggestedName: "notes.txt",
    replace: true,
    labels: { filterName: "Files", replaceTitle: "Replace?", replaceMessage: "Replace it?", replace: "Replace", cancel: "Cancel" },
  },
  "artifacts.attach": { artifactId: "art_1", name: "notes.txt" },
  "artifacts.discard": { artifactId: "art_1" },
  "jobs.get": { jobId: "job_1" },
  "jobs.list": {},
  "jobs.cancel": { jobId: "job_1" },
  "tokens.request": { session: SESSION, request: { provider: "example.maps", scopes: ["tiles:read"], ttlSeconds: 300 } },
  "tokens.end": { session: SESSION },
};
const BROKER_REFUSED: Record<string, Array<Record<string, unknown>>> = {
  "artifacts.pick": [{ accept: ["../etc/passwd"] }, { accept: Array.from({ length: 17 }, () => "text/plain") }, { title: 3 }],
  "artifacts.describe": [{ artifactId: "../art_1" }, {}],
  "artifacts.create": [{ mimeType: "x" }, { mimeType: "text/plain", name: "" }, { mimeType: "text/plain", name: "n".repeat(201) }],
  "artifacts.read": [{ artifactId: "art_1", offset: -1, length: 1 }, { artifactId: "art_1", offset: 0, length: 262_145 }, { artifactId: "art_1", offset: 0.5, length: 1 }],
  "artifacts.write": [{ artifactId: "art_1", offset: 0, chunkBase64: "not base64!" }, { artifactId: "art_1", offset: 0, chunkBase64: "A".repeat(349_532) }],
  "artifacts.finalize": [{ artifactId: 7 }],
  "artifacts.export": [
    { artifactId: "art_1", suggestedName: "" },
    { artifactId: "art_1", suggestedName: "a.txt", replace: "yes" },
    { artifactId: "art_1", suggestedName: "a.txt", labels: { path: "C:\\" } },
    // The path is the host's: a save names a file to replace by asking, never by where it is.
    { artifactId: "art_1", suggestedName: "a.txt", path: "C:\\Users\\me\\a.txt" },
  ],
  "artifacts.attach": [{ artifactId: "art_1", name: "" }, { artifactId: "art_1", conversationId: "conv_1" }],
  "artifacts.discard": [{ artifactId: "job_1" }],
  "jobs.get": [{ jobId: "art_1" }, {}],
  "jobs.list": [{ jobId: "job_1" }],
  "jobs.cancel": [{ jobId: "" }],
  "tokens.request": [
    { session: "short", request: { provider: "example.maps", scopes: ["tiles:read"] } },
    { session: SESSION, request: { provider: "Example Maps", scopes: ["tiles:read"] } },
    { session: SESSION, request: { provider: "example.maps", scopes: [] } },
    { session: SESSION, request: { provider: "example.maps", scopes: ["tiles:read"], ttlSeconds: 10 } },
    { session: SESSION, request: { provider: "example.maps", scopes: ["tiles:read"], audience: "elsewhere" } },
  ],
  "tokens.end": [{ session: "x" }, {}],
};

describe("the file, job and token relays", () => {
  it("cover every verb, each in its own bucket with a bound in time", () => {
    expect([...BROKER_RELAY_VERBS].sort()).toEqual(Object.keys(BROKER_ACCEPTED).sort());
    expect(Object.keys(RELAY_BUCKETS).sort()).toEqual([...BROKER_RELAY_VERBS].sort());
    for (const verb of BROKER_RELAY_VERBS) {
      for (const bucket of RELAY_BUCKETS[verb as keyof typeof RELAY_BUCKETS]) {
        const limits = RELAY_LIMITS[bucket as keyof typeof RELAY_LIMITS] as { timeoutMs?: number };
        expect(typeof limits.timeoutMs === "number" && limits.timeoutMs > 0 && limits.timeoutMs <= 60_000, `${verb} ${bucket}`).toBe(true);
      }
    }
  });

  it.each(Object.entries(BROKER_ACCEPTED))("accept %s with exactly its own fields", (verb, payload) => {
    expect(reviewDetachedBrokerRequest(verb, payload)).toEqual({ ok: true, payload });
  });

  it.each(Object.entries(BROKER_REFUSED))("refuse a malformed %s", (verb, payloads) => {
    for (const [index, payload] of payloads.entries()) expect(reviewDetachedBrokerRequest(verb, payload).ok, `${verb} #${String(index)}`).toBe(false);
  });

  it("refuse every privileged field and every id on every verb, by name", () => {
    for (const verb of BROKER_RELAY_VERBS) {
      for (const field of SMUGGLED) {
        const reviewed = reviewDetachedBrokerRequest(verb, { ...BROKER_ACCEPTED[verb], [field]: "x" });
        expect(reviewed.ok, `${verb} ${field}`).toBe(false);
        expect("reason" in reviewed ? String(reviewed.reason) : "").toContain(field);
      }
    }
  });

  it("refuse a verb the host does not relay, such as a generic node call", () => {
    expect(reviewDetachedBrokerRequest("node", { path: "/conversations" }).ok).toBe(false);
    expect(reviewDetachedBrokerRequest("perform", {}).ok).toBe(false);
  });
});

describe("the file dialog budget", () => {
  it("spends a pick from the file bucket and the dialog's, and holds one dialog open at a time", () => {
    const budget = relayBudget({ now: () => 0 });
    const first = budget.take("artifacts.export");
    expect(first.ok).toBe(true);
    expect(budget.take("artifacts.pick")).toMatchObject({ ok: false, code: "RELAY_BUSY" });
    // A read is not a dialog: it goes on while the person answers one.
    const read = budget.take("artifacts.read");
    expect(read.ok).toBe(true);
    if (first.ok) first.done();
    expect(budget.take("artifacts.pick").ok).toBe(true);
  });

  it("refuses a dialog past its burst without spending the file bucket", () => {
    let now = 0;
    const budget = relayBudget({ now: () => now });
    for (let index = 0; index < RELAY_LIMITS["artifacts.dialog"].burst; index += 1) {
      const taken = budget.take("artifacts.pick");
      expect(taken.ok).toBe(true);
      if (taken.ok) taken.done();
    }
    expect(budget.take("artifacts.pick")).toMatchObject({ ok: false, code: "RELAY_RATE_LIMITED" });
    // Every other file request still has the whole burst less the dialogs it shared.
    const spent = RELAY_LIMITS["artifacts.dialog"].burst;
    for (let index = 0; index < RELAY_LIMITS.artifacts.burst - spent; index += 1) {
      const taken = budget.take("artifacts.describe");
      expect(taken.ok, String(index)).toBe(true);
      if (taken.ok) taken.done();
    }
    expect(budget.take("artifacts.describe")).toMatchObject({ ok: false, code: "RELAY_RATE_LIMITED" });
    now += 1000 / RELAY_LIMITS["artifacts.dialog"].refillPerSecond;
    expect(budget.take("artifacts.pick").ok).toBe(true);
  });

  it("holds the token requests in flight to the frame host's own bound", () => {
    const budget = relayBudget({ now: () => 0 });
    const held = Array.from({ length: RELAY_LIMITS.tokens.inFlight }, () => budget.take("tokens.request"));
    expect(held.every((taken) => taken.ok)).toBe(true);
    expect(budget.take("tokens.request")).toMatchObject({ ok: false, code: "RELAY_BUSY" });
  });
});

describe("the token sessions a detached window was issued under", () => {
  it("are each ended once, and none is issued past the bound rather than forgotten", () => {
    const sessions = tokenSessions(2);
    sessions.record("a");
    sessions.record("a");
    sessions.record("b");
    expect(sessions.admits("a")).toBe(true);
    expect(sessions.admits("c")).toBe(false);
    sessions.record("c");
    expect(sessions.list()).toEqual(["a", "b"]);
    sessions.forget("a");
    expect(sessions.admits("c")).toBe(true);
    expect(sessions.drain()).toEqual(["b"]);
    expect(sessions.drain()).toEqual([]);
  });

  it("are ended after the lease is released and before the conversation takes the widget back", async () => {
    const closed: Array<() => void> = [];
    const window = { on: (_event: "closed", listener: () => void) => closed.push(listener), close: () => undefined, isDestroyed: () => false };
    const order: string[] = [];
    const supervised = superviseDetachedWindow({
      window,
      isCurrent: () => true,
      claim: async () => ({ ok: true }),
      release: async () => {
        order.push("lease released");
      },
      afterRelease: async () => {
        order.push("tokens ended");
      },
      onEnded: () => order.push("reattach sent"),
    });
    await supervised.begin();
    for (const listener of closed) listener();
    await supervised.released;
    await Promise.resolve();
    expect(order).toEqual(["lease released", "tokens ended", "reattach sent"]);
  });

  it("cannot keep the widget from going back when the node never answers the revoke", async () => {
    vi.useFakeTimers();
    try {
      const closed: Array<() => void> = [];
      const window = { on: (_event: "closed", listener: () => void) => closed.push(listener), close: () => undefined, isDestroyed: () => false };
      const onEnded = vi.fn();
      const supervised = superviseDetachedWindow({
        window,
        isCurrent: () => true,
        claim: async () => ({ ok: true }),
        release: async () => undefined,
        afterRelease: () => new Promise(() => undefined),
        onEnded,
      });
      await supervised.begin();
      for (const listener of closed) listener();
      await vi.advanceTimersByTimeAsync(0);
      expect(onEnded).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(DETACHED_LEASE.endWithinMs);
      expect(onEnded).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});