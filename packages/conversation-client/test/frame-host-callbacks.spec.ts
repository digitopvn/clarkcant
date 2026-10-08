import { createElement } from "react";
import { artifactRefSchema } from "@clarkcant/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { GatewayError, type IsolatedFrameLiveResponse } from "../src/api.ts";
import { DetachedFrameView } from "../src/DetachedWidgetSurface.tsx";
import {
  type DetachedArtifactBridge,
  type DetachedFrameBridge,
  type FrameHostTransport,
  detachedArtifactFiles,
  detachedDevStatusClient,
  detachedFrameTransport,
  detachedJobTransport,
  detachedTokenTransport,
  frameHostCallbacks,
  frameJobBroker,
  frameTokenBroker,
  offersBrowserTokens,
  shellJobTransport,
  shellTokenTransport,
} from "../src/frame-host-callbacks.ts";
import { DesktopFileError } from "../src/artifact-messages.ts";
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
    artifacts: answers.artifacts ?? artifactRelays({}),
    jobs: answers.jobs ?? { get: refuse, list: refuse, cancel: refuse },
    tokens: answers.tokens ?? { request: refuse, end: refuse },
  };
}

/** The artifact relays, each answering as told and refusing otherwise. */
function artifactRelays(answers: Partial<DetachedArtifactBridge>): DetachedArtifactBridge {
  const refuse = async (): Promise<{ ok: false; refused: string }> => ({ ok: false, refused: "not stubbed" });
  return {
    pick: answers.pick ?? refuse,
    describe: answers.describe ?? refuse,
    create: answers.create ?? refuse,
    read: answers.read ?? refuse,
    write: answers.write ?? refuse,
    finalize: answers.finalize ?? refuse,
    export: answers.export ?? refuse,
    attach: answers.attach ?? refuse,
    discard: answers.discard ?? refuse,
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

  it("draws the host's file panel beside the frame, as the conversation does", () => {
    const html = view({});
    expect(html).toContain('data-artifact-announce="true"');
    expect(html.indexOf("<iframe")).toBeLessThan(html.indexOf('data-artifact-announce="true"'));
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

const REF = artifactRefSchema.parse({ v: 1, artifactId: "art_1", kind: "working", mimeType: "text/plain", sizeBytes: 5, name: "notes.txt" });
const DIGEST = `sha256:${"5".repeat(64)}`;
const ATTACHMENT = { attachmentId: "att_1", filename: "notes.txt", mime: "text/plain", kind: "text", sizeBytes: 5, sha256: DIGEST, blobRef: `${"a".repeat(32)}.txt` };
const LABELS = { filterName: "Files", replaceTitle: "Replace?", replaceMessage: "Replace it?", replace: "Replace", cancel: "Cancel" };

describe("a widget's files in a detached window", () => {
  it("reads every answer as the conversation's client reads the node's", async () => {
    const asked: unknown[] = [];
    const files = detachedArtifactFiles(
      artifactRelays({
        describe: async (input) => (asked.push({ describe: input }), { ok: true, artifactRef: REF }),
        create: async (input) => (asked.push({ create: input }), { ok: true, artifactRef: REF }),
        read: async (input) => (asked.push({ read: input }), { ok: true, artifactRef: REF, contentBase64: "aGVsbG8=", eof: true }),
        write: async (input) => (asked.push({ write: input }), { ok: true, artifactRef: REF }),
        finalize: async (input) => (asked.push({ finalize: input }), { ok: true, artifactRef: REF }),
        attach: async (input) => (
          asked.push({ attach: input }),
          { ok: true, artifactRef: { ...REF, kind: "finalized", digest: DIGEST }, attachmentRef: ATTACHMENT }
        ),
        discard: async (input) => (asked.push({ discard: input }), { ok: true }),
      }),
    );
    expect(files.desktop).toBe(true);
    expect(await files.describe("art_1")).toEqual(REF);
    expect(await files.create({ mimeType: "text/plain", name: "n.txt" })).toEqual(REF);
    expect(await files.read("art_1", { offset: 0, length: 5 })).toEqual({ artifactRef: REF, contentBase64: "aGVsbG8=", eof: true });
    expect(await files.write("art_1", { offset: 0, contentBase64: "aGk=" })).toEqual(REF);
    expect(await files.finalize("art_1")).toEqual(REF);
    expect((await files.attach("art_1", { name: "x.txt" })).attachmentRef).toEqual(ATTACHMENT);
    await files.discard("art_1");
    // The frame's own request and nothing else: no conversation, no instance.
    expect(asked).toEqual([
      { describe: { artifactId: "art_1" } },
      { create: { mimeType: "text/plain", name: "n.txt" } },
      { read: { artifactId: "art_1", offset: 0, length: 5 } },
      { write: { artifactId: "art_1", offset: 0, chunkBase64: "aGk=" } },
      { finalize: { artifactId: "art_1" } },
      { attach: { artifactId: "art_1", name: "x.txt" } },
      { discard: { artifactId: "art_1" } },
    ]);
  });

  it("refuses a malformed answer, passes the node's refusal on, and words a dialog's refusal as the desktop's", async () => {
    const malformed = detachedArtifactFiles(artifactRelays({ describe: async () => ({ ok: true, artifactRef: { artifactId: 3 } }) }));
    await expect(malformed.describe("art_1")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });

    const refused = detachedArtifactFiles(
      artifactRelays({ describe: async () => ({ ok: false, code: "ARTIFACT_NOT_GRANTED", refused: "not this widget's" }) }),
    );
    await expect(refused.describe("art_1")).rejects.toMatchObject({ code: "ARTIFACT_NOT_GRANTED", reason: "not this widget's" });

    const dialog = detachedArtifactFiles(artifactRelays({ pick: async () => ({ ok: false, desktop: true, refused: "READ_FAILED", errorCode: "EACCES" }) }));
    const error = await dialog.pickOnDesktop?.({ accept: ["text/plain"], title: "t", filterName: "f" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DesktopFileError);
    expect(error).toMatchObject({ code: "READ_FAILED", errorCode: "EACCES" });
  });

  it("picks in the host: the window learns the reference and the bare name, never a path or a handle", async () => {
    const files = detachedArtifactFiles(
      artifactRelays({ pick: async () => ({ ok: true, canceled: false, artifactRef: { ...REF, kind: "attachment", digest: DIGEST }, original: { name: "notes.txt" } }) }),
    );
    expect(files.storePicked).toBeUndefined();
    const picked = await files.pickOnDesktop?.({ accept: ["text/plain"], title: "t", filterName: "f" });
    expect(picked).toEqual({ canceled: false, ref: { ...REF, kind: "attachment", digest: DIGEST }, original: { name: "notes.txt", mimeType: "text/plain" } });
    const cancelled = detachedArtifactFiles(artifactRelays({ pick: async () => ({ ok: true, canceled: true }) }));
    expect(await cancelled.pickOnDesktop?.({ accept: [], title: "t", filterName: "f" })).toEqual({ canceled: true });
  });

  it("saves in the host, asking to replace only for the picked file, and says what became of it", async () => {
    const asked: unknown[] = [];
    const files = detachedArtifactFiles(
      artifactRelays({ export: async (input) => (asked.push(input), { ok: true, saved: true, name: "notes.txt" }) }),
    );
    expect(await files.save({ ref: REF, suggestedName: "notes.txt", original: undefined, labels: LABELS })).toEqual({ outcome: "saved", name: "notes.txt" });
    await files.save({ ref: REF, suggestedName: "notes.txt", original: { name: "a.txt", mimeType: "text/plain" }, labels: LABELS });
    expect(asked).toEqual([
      { artifactId: "art_1", suggestedName: "notes.txt", labels: LABELS },
      { artifactId: "art_1", suggestedName: "notes.txt", replace: true, labels: LABELS },
    ]);
    const cancelled = detachedArtifactFiles(artifactRelays({ export: async () => ({ ok: true, canceled: true }) }));
    expect(await cancelled.save({ ref: REF, suggestedName: "n.txt", original: undefined, labels: LABELS })).toEqual({ outcome: "cancelled", name: "n.txt" });
  });
});

const JOB = { jobId: "job_1", status: "running", resultRefs: [], createdAt: "2026-01-01T00:00:00.000Z" };
const TOKEN_REQUEST = { provider: "example.maps", scopes: ["tiles:read"] } as never;

describe("a widget's jobs and browser tokens, in either window", () => {
  it("answers a job the same through the conversation's client and through the host's relays", async () => {
    const client = {
      getWidgetJob: async () => JOB,
      listWidgetJobs: async () => [JOB],
      cancelWidgetJob: async () => undefined,
    };
    const conversation = frameJobBroker(shellJobTransport(client as never, "conv_1", "widget_frame_1"));
    const detached = frameJobBroker(
      detachedJobTransport({ get: async () => ({ ok: true, job: JOB }), list: async () => ({ ok: true, jobs: [JOB] }), cancel: async () => ({ ok: true }) }),
    );
    for (const request of [{ op: "get", jobId: "job_1" }, { op: "list" }, { op: "cancel", jobId: "job_1" }] as const) {
      expect(await detached(request)).toEqual(await conversation(request));
    }
    expect(await detached({ op: "list" })).toMatchObject({ status: "ok", jobs: [{ jobId: "job_1" }] });
  });

  it("refuses a job the same in both windows, and a malformed snapshot is refused", async () => {
    const conversation = frameJobBroker(
      shellJobTransport({ getWidgetJob: async () => Promise.reject(new GatewayError(404, "JOB_NOT_FOUND", "no such job")) } as never, "c", "w"),
    );
    const detached = frameJobBroker(
      detachedJobTransport({ get: async () => ({ ok: false, code: "JOB_NOT_FOUND", refused: "no such job" }), list: async () => ({ ok: true }), cancel: async () => ({ ok: true }) }),
    );
    expect(await detached({ op: "get", jobId: "job_1" })).toEqual(await conversation({ op: "get", jobId: "job_1" }));
    expect(await detached({ op: "get", jobId: "job_1" })).toMatchObject({ status: "refused", code: "JOB_NOT_FOUND" });
    const malformed = frameJobBroker(detachedJobTransport({ get: async () => ({ ok: true, job: { jobId: 3 } }), list: async () => ({ ok: true }), cancel: async () => ({ ok: true }) }));
    expect(await malformed({ op: "get", jobId: "job_1" })).toMatchObject({ status: "refused", code: "MALFORMED_RESPONSE" });
  });

  it("hands a token out and refuses one the same in both windows, and ends the session when the frame goes", async () => {
    const token = { provider: "example.maps", token: "t-value", scopes: ["tiles:read"], expiresAt: "2026-01-01T01:00:00.000Z" };
    const ended: string[] = [];
    const conversation = frameTokenBroker(
      shellTokenTransport(
        {
          requestBrowserToken: async () => ({ provider: "example.maps", value: "t-value", scopes: ["tiles:read"], expiresAt: token.expiresAt }),
          endBrowserTokens: async () => undefined,
        } as never,
        "c",
        "w",
      ),
    );
    const detached = frameTokenBroker(
      detachedTokenTransport({
        request: async () => ({ ok: true, token }),
        end: async (input) => (ended.push(input.session), { ok: true }),
      }),
    );
    expect(await detached.request(TOKEN_REQUEST, "s".repeat(32))).toEqual(await conversation.request(TOKEN_REQUEST, "s".repeat(32)));
    detached.release("s".repeat(32));
    await Promise.resolve();
    expect(ended).toEqual(["s".repeat(32)]);

    const refusedDetached = frameTokenBroker(
      detachedTokenTransport({ request: async () => ({ ok: false, code: "TOKEN_NOT_DECLARED", refused: "not declared" }), end: async () => ({ ok: true }) }),
    );
    const refusedConversation = frameTokenBroker(
      shellTokenTransport(
        { requestBrowserToken: async () => Promise.reject(new GatewayError(403, "TOKEN_NOT_DECLARED", "not declared")), endBrowserTokens: async () => undefined } as never,
        "c",
        "w",
      ),
    );
    expect(await refusedDetached.request(TOKEN_REQUEST, "s".repeat(32))).toEqual(await refusedConversation.request(TOKEN_REQUEST, "s".repeat(32)));
  });

  it("offers tokens only to a frame whose package declared some", () => {
    expect(offersBrowserTokens({})).toBe(false);
    expect(offersBrowserTokens({ browserTokens: [] })).toBe(false);
    expect(offersBrowserTokens({ browserTokens: [{ provider: "example.maps" }] })).toBe(true);
  });
});