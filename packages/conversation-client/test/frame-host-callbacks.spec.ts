import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { GatewayError, type IsolatedFrameLiveResponse } from "../src/api.ts";
import { DetachedFrameView } from "../src/DetachedWidgetSurface.tsx";
import {
  type DetachedFrameBridge,
  type FrameHostTransport,
  detachedDevStatusClient,
  detachedFrameTransport,
  frameHostCallbacks,
} from "../src/frame-host-callbacks.ts";
import { readStoredLocale } from "../src/i18n/locale.ts";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";

/**
 * What a widget in its own frame is told, in the conversation and in a detached window.
 *
 * The two hosts reach the node differently: the conversation with its own client, a detached window through the desktop
 * host's relays. The widget must not be able to tell which one it runs in from what it hears back, so each case here is
 * run through both transports and the outcomes compared.
 */

const t = (key: MessageKey): string => CATALOGS.en[key];

const BINDING = { actionBindingId: "refresh", label: "Refresh", effectCategory: "read", bindingDigest: "sha256:binding" };

const LIVE: IsolatedFrameLiveResponse = {
  kind: "isolated-frame",
  instanceId: "widget_frame_1",
  revision: 4,
  readOnly: false,
  frame: {
    url: "http://127.0.0.1:4000/widgets/pkg/frame.html?grant=1",
    document: "build-1",
    isolation: "opaque-origin",
    grantedCapabilities: [],
    allowedOrigins: [],
  },
  bindings: [BINDING],
  props: {},
  stateRevision: 2,
  stateVersion: 1,
  state: { count: 1 },
  stateStatus: { kind: "writable" },
  ephemeralStateKeys: [],
};

/** A detached window's bridge that answers each relay as told and records what it was asked. */
function bridge(answers: Partial<DetachedFrameBridge>): DetachedFrameBridge & { asked: unknown[] } {
  const asked: unknown[] = [];
  const refuse = async (): Promise<{ ok: false; refused: string }> => ({ ok: false, refused: "not stubbed" });
  return {
    asked,
    frameRead: answers.frameRead ?? refuse,
    saveState: async (write) => {
      asked.push({ saveState: write });
      return (answers.saveState ?? refuse)(write);
    },
    publishSemantic: async (input) => {
      asked.push({ publishSemantic: input });
      return (answers.publishSemantic ?? refuse)(input);
    },
    intent: async (input) => {
      asked.push({ intent: input });
      return (answers.intent ?? refuse)(input);
    },
    devSession: answers.devSession ?? refuse,
  };
}

/** The conversation's transport over a client that throws what the gateway client throws. */
function conversationTransport(answer: { saveState?: () => Promise<never>; invokeAction?: () => Promise<never> }): FrameHostTransport {
  return {
    saveState: answer.saveState ?? (() => Promise.reject(new Error("not stubbed"))),
    publishSemantic: () => Promise.resolve(),
    invokeAction: answer.invokeAction ?? (() => Promise.reject(new Error("not stubbed"))),
  };
}

const press = { actionBindingId: "refresh", input: {}, expectedRevision: 4, invocationId: "inv_1" };

describe("a state write refused in either window", () => {
  it("tells the widget the same thing, with the state the node holds", async () => {
    const details = { state: { count: 7 }, stateRevision: 9, message: "the state moved on" };
    const conversation = frameHostCallbacks({
      transport: conversationTransport({ saveState: () => Promise.reject(new GatewayError(409, "STATE_REVISION_MISMATCH", "conflict", details)) }),
      bindings: LIVE.bindings,
      t,
    });
    const detached = frameHostCallbacks({
      transport: detachedFrameTransport(
        bridge({ saveState: async () => ({ ok: false, code: "STATE_REVISION_MISMATCH", refused: "conflict", details }) }),
        "widget_frame_1",
      ),
      bindings: LIVE.bindings,
      t,
    });
    const write = { expectedRevision: 2, patch: { count: 2 } };
    const fromConversation = await conversation.persistState(write);
    expect(fromConversation).toEqual({ ok: false, code: "STATE_REVISION_MISMATCH", message: "the state moved on", stateRevision: 9, state: { count: 7 } });
    expect(await detached.persistState(write)).toEqual(fromConversation);
  });

  it("is saved only when the host says the node committed it", async () => {
    const relays = bridge({ saveState: async (write) => ({ ok: true, saved: { stateRevision: write.expectedRevision + 1, state: write.patch } }) });
    const detached = frameHostCallbacks({ transport: detachedFrameTransport(relays, "widget_frame_1"), bindings: LIVE.bindings, t });
    expect(await detached.persistState({ expectedRevision: 2, patch: { count: 2 } })).toEqual({ ok: true, stateRevision: 3, state: { count: 2 } });
    // An answer that says "ok" without what was saved is not a save.
    const empty = frameHostCallbacks({ transport: detachedFrameTransport(bridge({ saveState: async () => ({ ok: true }) }), "w"), bindings: [], t });
    expect(await empty.persistState({ expectedRevision: 2, patch: {} })).toMatchObject({ ok: false, code: "MALFORMED_RESPONSE" });
  });
});

describe("a press in either window", () => {
  it("is refused the same way when the node refuses it", async () => {
    const onPressRefused = vi.fn();
    const conversation = frameHostCallbacks({
      transport: conversationTransport({ invokeAction: () => Promise.reject(new GatewayError(409, "STALE_REVISION", "the widget changed", {})) }),
      bindings: LIVE.bindings,
      t,
    });
    const detached = frameHostCallbacks({
      transport: detachedFrameTransport(bridge({ intent: async () => ({ ok: false, code: "STALE_REVISION", refused: "the widget changed" }) }), "w"),
      bindings: LIVE.bindings,
      t,
      onPressRefused,
    });
    const fromConversation = await conversation.invokeAction(press);
    expect(fromConversation).toEqual({ status: "refused", message: "STALE_REVISION: the widget changed" });
    expect(await detached.invokeAction(press)).toEqual(fromConversation);
    expect(onPressRefused).toHaveBeenCalledOnce();
  });

  it("is uncertain, not refused, when the node says it was sent and may have run", async () => {
    const onPressRefused = vi.fn();
    const details = { outcome: "uncertain", recorded: true };
    const conversation = frameHostCallbacks({
      transport: conversationTransport({ invokeAction: () => Promise.reject(new GatewayError(504, "SERVICE_TIMED_OUT", "no answer", details)) }),
      bindings: LIVE.bindings,
      t,
      onPressRefused,
    });
    const detached = frameHostCallbacks({
      transport: detachedFrameTransport(bridge({ intent: async () => ({ ok: false, code: "SERVICE_TIMED_OUT", refused: "no answer", details }) }), "w"),
      bindings: LIVE.bindings,
      t,
      onPressRefused,
    });
    const fromConversation = await conversation.invokeAction(press);
    // The node's own sentence, as the widget is given every other answer.
    expect(fromConversation).toEqual({ status: "uncertain", message: "SERVICE_TIMED_OUT: no answer" });
    expect(await detached.invokeAction(press)).toEqual(fromConversation);
    expect(onPressRefused).not.toHaveBeenCalled();
  });

  it("is uncertain, not refused, when the desktop host stopped waiting for the node", async () => {
    const onPressRefused = vi.fn();
    const detached = frameHostCallbacks({
      transport: detachedFrameTransport(
        bridge({ intent: async () => ({ ok: false, code: "NODE_TIMEOUT", refused: "the node did not answer in time", details: {} }) }),
        "w",
      ),
      bindings: LIVE.bindings,
      t,
      onPressRefused,
    });
    // Sent, and the node may still be running it: pressing again could take the effect twice.
    expect(await detached.invokeAction(press)).toEqual({
      status: "uncertain",
      message: `${t("widgets.action.uncertain")} ${t("widgets.action.uncertain.next.say")}`,
    });
    expect(onPressRefused).not.toHaveBeenCalled();
  });

  it("waiting on an approval is uncertain, never a success", async () => {
    const detached = frameHostCallbacks({
      transport: detachedFrameTransport(bridge({ intent: async () => ({ ok: true, result: { approvalRequired: { approvalId: "appr_1" } } }) }), "w"),
      bindings: LIVE.bindings,
      t,
    });
    expect(await detached.invokeAction(press)).toEqual({ status: "uncertain", message: t("shell.live.actionAwaitingApproval") });
  });

  it("sends the frame's words and idempotency key, and no digest: the host resolves that from its own read", async () => {
    const relays = bridge({ intent: async () => ({ ok: true, result: { output: "done" } }) });
    const detached = frameHostCallbacks({ transport: detachedFrameTransport(relays, "widget_frame_1"), bindings: LIVE.bindings, t });
    expect(await detached.invokeAction(press)).toEqual({ status: "accepted", message: t("shell.live.actionSent"), output: "done" });
    expect(relays.asked).toEqual([
      { intent: { instanceRef: "widget_frame_1", actionBindingId: "refresh", expectedRevision: 4, input: {}, invocationId: "inv_1" } },
    ]);
  });

  it("naming a binding the instance does not hold is refused before anything is sent", async () => {
    const relays = bridge({});
    const detached = frameHostCallbacks({ transport: detachedFrameTransport(relays, "w"), bindings: LIVE.bindings, t });
    expect(await detached.invokeAction({ ...press, actionBindingId: "delete_everything" })).toEqual({
      status: "refused",
      message: t("shell.live.actionUnbound"),
    });
    expect(relays.asked).toEqual([]);
  });
});

describe("a semantic publish from a detached window", () => {
  it("is given up when the frame gives it up, and a relayed refusal is an error", async () => {
    const pending = bridge({ publishSemantic: () => new Promise(() => undefined) });
    const controller = new AbortController();
    const published = detachedFrameTransport(pending, "w").publishSemantic({ summary: "s" } as never, controller.signal);
    controller.abort(new Error("given up"));
    await expect(published).rejects.toThrow("given up");

    const refused = bridge({ publishSemantic: async () => ({ ok: false, code: "RELAY_RATE_LIMITED", refused: "too many" }) });
    await expect(detachedFrameTransport(refused, "w").publishSemantic({ summary: "s" } as never, new AbortController().signal)).rejects.toMatchObject({
      code: "RELAY_RATE_LIMITED",
    });
  });
});

describe("the widget dev status in a detached window", () => {
  const AT = "2026-10-06T10:00:00.000Z";
  const running = {
    generation: 2,
    packageId: "com.example.timer",
    version: "0.1.0",
    digest: `sha256:${"2".padStart(64, "0")}`,
    builtAt: AT,
    trigger: "change",
    widgetIds: ["com.example.timer.main@1"],
    delta: {
      verdict: "unchanged",
      capabilities: { added: [], removed: [] },
      frameOrigins: { added: [], removed: [] },
      permissions: { added: [], removed: [] },
      facets: { added: [], removed: [] },
    },
    warnings: [],
  };
  const view = {
    sessionId: "wdev_1",
    status: "live",
    startedAt: AT,
    activation: { state: "active", generation: 2, generationId: "gen_2" },
    showingLastKnownGood: false,
    latest: running,
    running,
    lastBuild: { ok: true, at: AT, trigger: "change", generation: 2, diagnostics: [] },
  };

  it("reads the host's view, which carries no folder path", async () => {
    const client = detachedDevStatusClient({ devSession: async () => ({ ok: true, view }) });
    const read = await client.widgetDevSession("ignored");
    expect(read).toMatchObject({ sessionId: "wdev_1", running: { generation: 2 } });
    expect(read).not.toHaveProperty("root");
  });

  it("refuses a view that does not read, and passes a relayed refusal on", async () => {
    await expect(detachedDevStatusClient({ devSession: async () => ({ ok: true, view: { sessionId: 3 } }) }).widgetDevSession("x")).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
    await expect(
      detachedDevStatusClient({ devSession: async () => ({ ok: false, code: "NO_DEV_SESSION", refused: "no session" }) }).widgetDevSession("x"),
    ).rejects.toMatchObject({ code: "NO_DEV_SESSION" });
  });
});

describe("the detached window's frame", () => {
  const view = (overrides: Partial<Parameters<typeof DetachedFrameView>[0]>): string =>
    renderToStaticMarkup(
      createElement(DetachedFrameView, {
        relays: bridge({}),
        instanceRef: "widget_frame_1",
        title: "Timer",
        live: LIVE,
        problem: undefined,
        release: () => undefined,
        reload: () => undefined,
        renewUrl: () => Promise.reject(new Error("unused")),
        ...overrides,
      }),
    );

  it("mounts the same widget frame the conversation mounts, on the URL the host read", () => {
    const html = view({});
    expect(html).toContain('data-detached-frame="true"');
    expect(html).toContain('data-detached-instance="widget_frame_1"');
    expect(html).toContain('data-widget-frame="widget_frame_1"');
    expect(html).toContain('<iframe class="cc-widget-frame-document" src="http://127.0.0.1:4000/widgets/pkg/frame.html?grant=1" sandbox="allow-scripts"');
    expect(html).toContain('data-detached-release="true"');
  });

  it("shows the widget's text alternative when its package is gone", () => {
    const html = view({ live: { ...LIVE, frame: null, textFallback: "A timer, at 3 minutes" } });
    expect(html).toContain('data-widget-text-fallback="true"');
    expect(html).toContain("A timer, at 3 minutes");
    expect(html).not.toContain("<iframe");
  });

  it("says it cannot run the frame when the window has no relays, and mounts nothing", () => {
    const html = view({ relays: undefined, live: undefined });
    expect(html).toContain('data-detached-error="true"');
    expect(html).toContain(CATALOGS[readStoredLocale()]["widgets.detached.isolatedFrame"]);
    expect(html).not.toContain("<iframe");
  });

  it("says why the first read failed instead of showing an empty frame", () => {
    const html = view({ live: undefined, problem: "the node did not answer in time" });
    expect(html).toContain('data-detached-error="true"');
    expect(html).toContain("the node did not answer in time");
  });
});
