import { describe, expect, it } from "vitest";
import { compileAppearance } from "@clarkcant/design-tokens";

import { createFrameSession, type FrameSessionInput } from "../src/session.ts";

/**
 * The host end of a widget frame.
 *
 * Most of what follows is about what the host refuses. A frame is the least trusted thing in the system — it is
 * opaque-origin code somebody else wrote — so the interesting properties are the ones that hold when it asks for
 * something it should not have: a stale write, an action binding the host never accepted, a capability the host did
 * not broker, a message that is simply too big. Happy paths are tested too, but they are the easy half, and a
 * session that only passes them has demonstrated nothing about isolation.
 */

const NONCE = "nonce-issued-for-this-frame";

function makeSession(overrides: Partial<FrameSessionInput> = {}) {
  const posted: { kind: string; [key: string]: unknown }[] = [];
  const chrome = { focus: 0, resize: [] as number[], pin: 0, external: [] as string[] };
  const ran: string[] = [];
  const session = createFrameSession({
    instanceId: "inst_1",
    nonce: NONCE,
    props: { title: "doanh thu" },
    // The revision the host initialized the frame at; a test that omits it is testing a frame that would be refused
    // by the node for acting on a revision it never saw.
    revision: 0,
    brokeredCapabilities: ["dataset.read@1"],
    allowedOrigins: ["https://example.test"],
    knownActionBindings: ["act_1"],
    invokeAction: async ({ invocationId }) => {
      ran.push(invocationId);
      return { status: "accepted", message: "ok" };
    },
    chrome: {
      focus: () => {
        chrome.focus += 1;
      },
      resize: (height) => chrome.resize.push(height),
      requestPin: () => {
        chrome.pin += 1;
      },
      openExternal: (url) => chrome.external.push(url),
    },
    post: (message) => posted.push(message as { kind: string }),
    ...overrides,
  });
  return { session, posted, chrome, ran };
}

/** A message that passes the nonce and source checks, so the dispatch under test is what decides. */
function fromFrame(data: Record<string, unknown>, sourceMatches = true) {
  return { data: { nonce: NONCE, ...data }, sourceMatchesExpectedWindow: sourceMatches };
}

it("initializes with the current appearance and restyles without a semantic/state write or remount", () => {
  const dark = compileAppearance({ scheme: "dark" });
  const light = compileAppearance({ scheme: "light" });
  const { session, posted, ran } = makeSession({ appearance: dark, revision: 7, stateRevision: 3 });
  session.announceAppearance(light);
  expect(posted).toEqual([]);
  expect(session.init()).toMatchObject({ appearance: light, extensions: ["appearance@1"], revision: 7, stateRevision: 3 });
  session.announceAppearance(light);
  expect(posted).toHaveLength(1);
  session.announceAppearance(dark);
  expect(posted.at(-1)).toMatchObject({ kind: "appearance.changed", nonce: NONCE, revision: dark.revision, appearance: dark });
  expect(posted.map((message) => message.kind)).toEqual(["init", "appearance.changed"]);
  expect(ran).toEqual([]);
  expect(session.transcript()).toEqual([]);
  session.dispose();
  const count = posted.length;
  session.announceAppearance(light);
  expect(posted).toHaveLength(count);
});

describe("what the host advertises at init", () => {
  it("sends the exact nonce, and only the capabilities it will broker", () => {
    const { session, posted } = makeSession();

    const init = session.init();

    expect(init.nonce).toBe(NONCE);
    expect(init.brokeredCapabilities).toEqual(["dataset.read@1"]);
    expect(init.allowedOrigins).toEqual(["https://example.test"]);
    expect(session.status()).toBe("ready");
    // Posted rather than returned only, since the frame is a different process holding a different object.
    expect(posted[0]?.kind).toBe("init");
  });

  it("posts exactly one init for one call, so a caller that only calls it cannot make the frame see two", () => {
    const { session, posted } = makeSession();

    const returned = session.init();

    // A second init is what the widget runtime refuses as DUPLICATE_INIT; the frame component relies on this count.
    expect(posted.filter((message) => message.kind === "init")).toHaveLength(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual(returned);
  });
});

describe("what the host refuses", () => {
  it("refuses a message from a window that is not this instance's frame", () => {
    const { session } = makeSession();
    session.init();

    const result = session.accept(fromFrame({ kind: "event", name: "x", payload: {} }, false));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SOURCE_MISMATCH");
  });

  it("refuses a forged nonce, which is the check origin cannot make for an opaque frame", () => {
    const { session } = makeSession();
    session.init();

    // Every opaque origin is "null", so this is the only thing that says which widget is speaking.
    const result = session.accept({
      data: { kind: "event", nonce: "someone-elses-nonce", name: "x", payload: {} },
      sourceMatchesExpectedWindow: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NONCE_MISMATCH");
  });

  it("refuses a message that is not in the codec at all", () => {
    const { session } = makeSession();
    session.init();

    // Including the shape a convenience-driven bridge tends to grow: a generic call by name.
    const result = session.accept(fromFrame({ kind: "invoke", method: "readAllSecrets", args: {} }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SCHEMA_INVALID");
  });

  it("bounds a message before reading it", () => {
    const { session } = makeSession({ maxMessageBytes: 200 });
    session.init();

    const result = session.accept(fromFrame({ kind: "event", name: "x", payload: { blob: "a".repeat(500) } }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TOO_LARGE");
  });

  it("stops a frame that keeps talking", () => {
    const { session } = makeSession({ maxMessages: 2 });
    session.init();
    const event = fromFrame({ kind: "event", name: "x", payload: {} });

    expect(session.accept(event).ok).toBe(true);
    expect(session.accept(event).ok).toBe(true);
    const third = session.accept(event);

    // A budget, because a frame is untrusted code and one that can send without limit can spend the host's time.
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.code).toBe("MESSAGE_BUDGET_EXCEEDED");
  });

  it("refuses a write planned against a revision that has moved", () => {
    const { session } = makeSession();
    session.init();

    session.accept(fromFrame({ kind: "state.update", expectedRevision: 0, patch: { tab: "a" } }));
    const stale = session.accept(fromFrame({ kind: "state.update", expectedRevision: 0, patch: { tab: "b" } }));

    // Refused, not merged: accepting an old write is two frames editing in whatever order the messages arrived.
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("STALE_REVISION");
  });

  it("refuses an action binding the host never accepted for this instance", () => {
    const { session, ran } = makeSession();
    session.init();

    const result = session.accept(
      fromFrame({ kind: "action.invoke", actionBindingId: "act_secret", expectedRevision: 0, input: {}, invocationId: "inv_1" }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ACTION_UNKNOWN");
    // Nothing ran. There is no path from an id in a message to a generic call.
    expect(ran).toEqual([]);
  });

  it("refuses a capability it did not broker", () => {
    const { session } = makeSession();
    session.init();

    const result = session.accept(
      fromFrame({ kind: "capability.request", capabilityRef: "filesystem.write@1", justification: "cần ghi file" }),
    );

    /*
     * The host answered this question when it decided what to broker. Considering it again because the frame asked
     * louder is how a bounded capability list becomes advisory.
     */
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CAPABILITY_NOT_BROKERED");
  });

  it("refuses anything after disposal", () => {
    const { session } = makeSession();
    session.init();
    session.dispose();

    const result = session.accept(fromFrame({ kind: "event", name: "x", payload: {} }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DISPOSED");
  });
});

describe("what the host does with an accepted message", () => {
  it("applies a state write, bumps the revision, and echoes it back", () => {
    const { session, posted } = makeSession();
    session.init();

    const result = session.accept(fromFrame({ kind: "state.update", expectedRevision: 0, patch: { tab: "costs" } }));

    expect(result.ok).toBe(true);
    const echo = posted.find((message) => message.kind === "state");
    expect(echo).toMatchObject({ kind: "state", revision: 1, state: { tab: "costs" } });
  });

  it("names the state revision at init apart from the instance revision, and accepts a write against it", () => {
    const { session, posted } = makeSession({ revision: 5, stateRevision: 2, state: { tab: "a" } });

    const init = session.init();
    expect(init).toMatchObject({ revision: 5, stateRevision: 2 });

    // Planned against the state revision the frame was shown — not the instance revision, which is a different count.
    const result = session.accept(fromFrame({ kind: "state.update", expectedRevision: 2, patch: { tab: "b" } }));
    expect(result.ok).toBe(true);
    expect(posted.at(-1)).toMatchObject({ kind: "state", revision: 3, state: { tab: "b" } });
  });

  it("answers a write only after the node commits it, keeping view-state keys the node never stored", async () => {
    const persisted: { expectedRevision: number; patch: Record<string, unknown> }[] = [];
    let commit: (value: { ok: true; stateRevision: number; state: Record<string, unknown> }) => void = () => undefined;
    const { session, posted } = makeSession({
      state: { body: "cũ", zoom: 1 },
      stateRevision: 4,
      ephemeralStateKeys: ["zoom"],
      persistState: (input) => {
        persisted.push(input);
        return new Promise((resolve) => {
          commit = resolve;
        });
      },
    });
    session.init();
    posted.length = 0;

    const result = session.accept(fromFrame({ kind: "state.update", expectedRevision: 4, patch: { body: "mới", zoom: 2 } }));
    expect(result).toMatchObject({ ok: true, detail: "pending" });
    // Nothing is echoed yet: an echo before the commit would be the host saying "saved" about something that is not.
    expect(posted).toEqual([]);
    expect(persisted).toEqual([{ expectedRevision: 4, patch: { body: "mới", zoom: 2 } }]);

    // A second write while the first is in flight is refused and answered, not queued behind a revision about to move.
    const second = session.accept(fromFrame({ kind: "state.update", expectedRevision: 4, patch: { body: "khác" } }));
    expect(second.ok).toBe(false);
    expect(posted.at(-1)).toMatchObject({ kind: "state", refused: { code: "STATE_REVISION_STALE" } });

    commit({ ok: true, stateRevision: 5, state: { body: "mới" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(posted.at(-1)).toMatchObject({ kind: "state", revision: 5, state: { body: "mới", zoom: 2 } });
  });

  it("keeps a write of view-state keys alone in the frame, without a round trip or a new revision", () => {
    const persisted: unknown[] = [];
    const { session, posted } = makeSession({
      state: { body: "cũ", zoom: 1 },
      stateRevision: 4,
      ephemeralStateKeys: ["zoom"],
      persistState: async (input) => {
        persisted.push(input);
        return { ok: true, stateRevision: 5, state: {} };
      },
    });
    session.init();

    const result = session.accept(fromFrame({ kind: "state.update", expectedRevision: 4, patch: { zoom: 3 } }));

    expect(result).toMatchObject({ ok: true, detail: "view-only" });
    expect(persisted).toEqual([]);
    expect(posted.at(-1)).toMatchObject({ kind: "state", revision: 4, state: { body: "cũ", zoom: 3 } });
  });

  it("answers a refused write with the committed state and the node's reason", async () => {
    const { session, posted } = makeSession({
      state: { body: "cũ" },
      stateRevision: 1,
      persistState: async () => ({
        ok: false,
        code: "STATE_REVISION_STALE",
        message: "another surface saved first",
        stateRevision: 3,
        state: { body: "từ nơi khác" },
      }),
    });
    session.init();

    session.accept(fromFrame({ kind: "state.update", expectedRevision: 1, patch: { body: "của tôi" } }));
    await Promise.resolve();
    await Promise.resolve();

    expect(posted.at(-1)).toMatchObject({
      kind: "state",
      revision: 3,
      state: { body: "từ nơi khác" },
      refused: { code: "STATE_REVISION_STALE", message: "another surface saved first" },
    });
  });

  it("runs an accepted action once and answers it", async () => {
    const { session, posted, ran } = makeSession();
    session.init();

    session.accept(
      fromFrame({ kind: "action.invoke", actionBindingId: "act_1", expectedRevision: 0, input: {}, invocationId: "inv_1" }),
    );
    await Promise.resolve();

    expect(ran).toEqual(["inv_1"]);
    const answer = posted.find((message) => message.kind === "action-result");
    expect(answer).toMatchObject({ kind: "action-result", actionBindingId: "act_1", status: "accepted" });
  });

  it("passes a service's answer to the frame, and only when there is one", async () => {
    const { session, posted } = makeSession({
      invokeAction: async () => ({ status: "accepted", message: "ok", output: "Saved. 1 note(s): mua sữa" }),
    });
    session.init();

    session.accept(
      fromFrame({ kind: "action.invoke", actionBindingId: "act_1", expectedRevision: 0, input: {}, invocationId: "inv_1" }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(posted.find((message) => message.kind === "action-result")).toMatchObject({
      status: "accepted",
      output: "Saved. 1 note(s): mua sữa",
    });

    // An action with no answer sends no field, so a runtime from before outputs existed still reads the message.
    const plain = makeSession();
    plain.session.init();
    plain.session.accept(
      fromFrame({ kind: "action.invoke", actionBindingId: "act_1", expectedRevision: 0, input: {}, invocationId: "inv_2" }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(plain.posted.find((message) => message.kind === "action-result")).not.toHaveProperty("output");
  });

  it("names the invocation it answers, and keeps the reason short enough for the frame to accept", async () => {
    const { session, posted } = makeSession({
      invokeAction: async () => ({ status: "refused", message: "x".repeat(5_000) }),
    });
    session.init();
    session.accept(
      fromFrame({ kind: "action.invoke", actionBindingId: "act_1", expectedRevision: 0, input: {}, invocationId: "inv_9" }),
    );
    await Promise.resolve();
    await Promise.resolve();

    const answer = posted.find((message) => message.kind === "action-result");
    expect(answer).toMatchObject({ actionBindingId: "act_1", invocationId: "inv_9", status: "refused" });
    expect(String(answer?.message)).toHaveLength(1_000);

    // An empty reason would be refused by the frame's codec, and the widget would wait forever.
    const silent = makeSession({ invokeAction: async () => ({ status: "refused", message: "" }) });
    silent.session.init();
    silent.session.accept(
      fromFrame({ kind: "action.invoke", actionBindingId: "act_1", expectedRevision: 0, input: {}, invocationId: "inv_1" }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(silent.posted.find((message) => message.kind === "action-result")).toMatchObject({ message: "refused" });
  });

  it("answers a repeated invocation id without running it again", async () => {
    const { session, ran } = makeSession();
    session.init();
    const click = fromFrame({
      kind: "action.invoke",
      actionBindingId: "act_1",
      expectedRevision: 0,
      input: {},
      invocationId: "inv_1",
    });

    session.accept(click);
    await Promise.resolve();
    session.accept(click);
    await Promise.resolve();

    // A double click is one effect. Re-running because a pointer bounced is how one intent does two things.
    expect(ran).toEqual(["inv_1"]);
  });

  it("routes every host request to the host's own chrome", () => {
    const { session, chrome } = makeSession();
    session.init();

    session.accept(fromFrame({ kind: "host.request", request: "focus" }));
    session.accept(fromFrame({ kind: "host.request", request: "resize", argument: "480" }));
    session.accept(fromFrame({ kind: "host.request", request: "request-pin" }));
    session.accept(fromFrame({ kind: "host.request", request: "open-external", argument: "https://example.test/x" }));

    // The frame asked; the host did. A frame with `window.open` would be the host doing what it was only asked to
    // consider, which is the difference between a request and an effect.
    expect(chrome).toEqual({ focus: 1, resize: [480], pin: 1, external: ["https://example.test/x"] });
  });

  it("records a semantic summary for a reader who cannot see the widget", () => {
    const { session } = makeSession();
    session.init();

    session.accept(fromFrame({ kind: "semantic.publish", summary: "đang xem doanh thu tháng 9", selectedIds: [] }));

    expect(session.transcript()).toEqual(
      expect.arrayContaining([{ kind: "semantic.publish", detail: "đang xem doanh thu tháng 9" }]),
    );
  });

  it("hands what the frame says it shows to the host as a proposal, never with actions", () => {
    const proposals: unknown[] = [];
    const { session } = makeSession({ publishSemantic: (proposal) => proposals.push(proposal) });
    session.init();

    session.accept(
      fromFrame({ kind: "semantic.publish", summary: "3 việc, 1 đã ghim", selectedIds: ["n2"], values: { filter: "pinned" } }),
    );
    session.accept(fromFrame({ kind: "semantic.publish", summary: "không có bộ lọc", selectedIds: [] }));
    // A frame that tries to say which actions it offers is refused by the bridge schema, before the host hears it.
    const forged = session.accept(
      fromFrame({ kind: "semantic.publish", summary: "x", selectedIds: [], availableActions: [{ actionBindingId: "delete-all" }] }),
    );

    expect(forged.ok).toBe(false);
    expect(proposals).toEqual([
      { summary: "3 việc, 1 đã ghim", selectedIds: ["n2"], values: { filter: "pinned" } },
      { summary: "không có bộ lọc", selectedIds: [] },
    ]);
  });
});

describe("the frame lifecycle from the host side", () => {
  it("tells the frame it is suspended, and why", () => {
    const { session, posted } = makeSession();
    session.init();

    session.suspend("offscreen");

    expect(session.status()).toBe("suspended");
    expect(posted.find((message) => message.kind === "suspend")).toMatchObject({ kind: "suspend", reason: "offscreen" });
  });

  it("disposes once and says so", () => {
    const { session, posted } = makeSession();
    session.init();

    session.dispose();
    session.dispose();

    expect(posted.filter((message) => message.kind === "dispose")).toHaveLength(1);
  });

  it("keeps a list of what it refused, so a session can be audited", () => {
    const { session } = makeSession();
    session.init();
    session.accept(fromFrame({ kind: "event", name: "x", payload: {} }, false));
    session.accept(fromFrame({ kind: "capability.request", capabilityRef: "fs@1", justification: "cần" }));

    expect(session.refused()).toEqual(["SOURCE_MISMATCH", "CAPABILITY_NOT_BROKERED"]);
  });
});

describe("which service-backed actions can run", () => {
  it("holds what it is told until init, then tells the frame once", () => {
    const { session, posted } = makeSession();

    session.announceActions([{ actionBindingId: "act_1", available: false, reason: "needs Docker or Podman" }]);
    expect(posted).toHaveLength(0);

    session.init();
    expect(posted.map((message) => message.kind)).toEqual(["init", "actions"]);
    expect(posted[1]).toEqual({
      kind: "actions",
      nonce: NONCE,
      actions: [{ actionBindingId: "act_1", available: false, reason: "needs Docker or Podman" }],
    });
  });

  it("sends a change and nothing for the same answer twice", () => {
    const { session, posted } = makeSession();
    session.init();

    session.announceActions([{ actionBindingId: "act_1", available: true }]);
    session.announceActions([{ actionBindingId: "act_1", available: true }]);
    session.announceActions([{ actionBindingId: "act_1", available: false, reason: "the service stopped" }]);

    const sent = posted.filter((message) => message.kind === "actions");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ actions: [{ available: false, reason: "the service stopped" }] });
  });

  it("says nothing for a frame with no service-backed actions, so an older widget runtime never sees the message", () => {
    const { session, posted } = makeSession();
    session.announceActions([]);
    session.init();
    expect(posted.filter((message) => message.kind === "actions")).toHaveLength(0);
  });
});

describe("the artifacts@1 extension", () => {
  const REF = {
    v: 1 as const,
    artifactId: "art_one",
    kind: "finalized" as const,
    name: "ghi-chu.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
  };
  const read = (requestId: string, artifactId = "art_one") =>
    fromFrame({ kind: "artifact.request", requestId, request: { op: "read", artifactId, offset: 0, length: 5 } });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("is advertised only when the host has a broker to hand requests to", () => {
    expect(makeSession().session.init().extensions).toBeUndefined();
    const { session } = makeSession({ artifacts: async () => ({ status: "cancelled" }) });
    expect(session.init().extensions).toEqual(["artifacts@1"]);
  });

  it("refuses a request the host did not offer, and still answers it so the widget is not left waiting", () => {
    const { session, posted } = makeSession();
    session.init();

    const result = session.accept(read("artreq-1"));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EXTENSION_NOT_OFFERED");
    expect(posted.at(-1)).toMatchObject({ kind: "artifact-result", requestId: "artreq-1", status: "refused" });
  });

  it("hands the typed request to the broker and posts its answer back under the same id", async () => {
    const seen: unknown[] = [];
    const { session, posted } = makeSession({
      artifacts: async (request) => {
        seen.push(request);
        return { status: "ok", ref: REF, chunkBase64: "aGVsbG8=", eof: true };
      },
    });
    session.init();

    const result = session.accept(read("artreq-2"));
    await flush();

    expect(result).toMatchObject({ ok: true, kind: "artifact.request", detail: "read art_one" });
    expect(seen).toEqual([{ op: "read", artifactId: "art_one", offset: 0, length: 5 }]);
    expect(posted.at(-1)).toEqual({
      kind: "artifact-result",
      nonce: NONCE,
      requestId: "artreq-2",
      status: "ok",
      ref: REF,
      chunkBase64: "aGVsbG8=",
      eof: true,
    });
  });

  it("records the operation and the id, never the name or type the widget asked with", async () => {
    const { session } = makeSession({ artifacts: async () => ({ status: "cancelled" }) });
    session.init();

    session.accept(
      fromFrame({
        kind: "artifact.request",
        requestId: "artreq-3",
        request: { op: "export", artifactId: "art_one", suggestedName: "bao-cao-bi-mat.csv" },
      }),
    );
    session.accept(fromFrame({ kind: "artifact.request", requestId: "artreq-4", request: { op: "pick", accept: ["text/csv"] } }));
    await flush();

    const recorded = JSON.stringify(session.transcript());
    expect(recorded).toContain("export art_one");
    expect(recorded).not.toContain("bao-cao-bi-mat");
    expect(recorded).not.toContain("text/csv");
  });

  it("turns a broker failure into a fixed refusal, never the message the broker threw", async () => {
    const { session, posted } = makeSession({
      artifacts: async () => {
        throw new Error("EBUSY: resource busy or locked, open 'C:\\Users\\x\\f.csv'");
      },
    });
    session.init();

    session.accept(read("artreq-5"));
    await flush();

    expect(posted.at(-1)).toEqual({
      kind: "artifact-result",
      nonce: NONCE,
      requestId: "artreq-5",
      status: "refused",
      code: "ARTIFACT_UNAVAILABLE",
      message: "the file request could not be completed",
    });
    expect(JSON.stringify(posted)).not.toContain("Users");
  });

  it("bounds how many requests may wait at once, and refuses a duplicate id that is still waiting", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session, posted } = makeSession({
      maxArtifactInFlight: 2,
      artifacts: async () => {
        await gate;
        return { status: "ok", ref: REF };
      },
    });
    session.init();

    expect(session.accept(read("artreq-a")).ok).toBe(true);
    const duplicate = session.accept(read("artreq-a"));
    expect(session.accept(read("artreq-b")).ok).toBe(true);
    const third = session.accept(read("artreq-c"));

    expect(duplicate).toMatchObject({ ok: false, code: "ARTIFACT_BUSY", answered: true });
    // Answered, so the host leaves it to the widget instead of marking the whole frame refused.
    expect(third).toMatchObject({ ok: false, code: "ARTIFACT_BUSY", answered: true });
    expect(posted.filter((message) => message.kind === "artifact-result" && message.requestId === "artreq-c")).toHaveLength(1);

    release();
    await flush();
    // Once answered, the slots are free again.
    expect(session.accept(read("artreq-d")).ok).toBe(true);
  });

  it("paces job reads at their own rate, so watching a job does not spend the frame's message budget", async () => {
    let now = 1_000_000;
    const { session, posted } = makeSession({
      maxMessages: 1,
      jobBurst: 2,
      jobRefillPerSecond: 1,
      now: () => now,
      jobs: async (request) => ({ status: "ok", job: { jobId: request.jobId, status: "running", resultRefs: [], createdAt: "2026-10-01T00:00:00.000Z" } }),
    });
    session.init();
    const job = (requestId: string) => fromFrame({ kind: "job.request", requestId, request: { op: "get", jobId: "job_1" } });

    expect(session.accept(job("jobreq-1")).ok).toBe(true);
    await flush();
    expect(session.accept(job("jobreq-2")).ok).toBe(true);
    await flush();
    expect(session.accept(job("jobreq-3"))).toMatchObject({ ok: false, code: "JOB_RATE_LIMITED", answered: true });
    expect(posted.at(-1)).toMatchObject({ kind: "job-result", requestId: "jobreq-3", status: "refused", code: "JOB_RATE_LIMITED" });
    expect(session.accept(fromFrame({ kind: "event", name: "x", payload: {} })).ok).toBe(true);
    now += 1_000;
    expect(session.accept(job("jobreq-4")).ok).toBe(true);
  });

  it("paces artifact requests at a rate apart from other messages, and answers the one it turns away", async () => {
    let now = 1_000_000;
    const { session, posted } = makeSession({
      maxMessages: 1,
      artifactBurst: 2,
      artifactRefillPerSecond: 1,
      now: () => now,
      artifacts: async () => ({ status: "ok", ref: REF }),
    });
    session.init();

    expect(session.accept(read("artreq-1")).ok).toBe(true);
    await flush();
    expect(session.accept(read("artreq-2")).ok).toBe(true);
    await flush();
    const third = session.accept(read("artreq-3"));

    expect(third).toMatchObject({ ok: false, code: "ARTIFACT_RATE_LIMITED", answered: true });
    expect(posted.at(-1)).toMatchObject({ kind: "artifact-result", requestId: "artreq-3", status: "refused", code: "ARTIFACT_RATE_LIMITED" });
    // The one ordinary message the budget allows is still there: a file does not spend the frame's other budget.
    expect(session.accept(fromFrame({ kind: "event", name: "x", payload: {} })).ok).toBe(true);

    // A rate, not a lifetime budget: a second later there is room for one more.
    now += 1_000;
    expect(session.accept(read("artreq-4")).ok).toBe(true);
    await flush();
    expect(session.accept(read("artreq-5")).ok).toBe(false);
  });

  it("spends the rate on every message that claims to be a file request, before checking it", () => {
    let seen = 0;
    const { session } = makeSession({
      artifactBurst: 3,
      artifactRefillPerSecond: 1,
      maxArtifactMessageBytes: 500,
      now: () => 5_000,
      artifacts: async () => {
        seen += 1;
        return { status: "ok", ref: REF };
      },
    });
    session.init();

    // Too large, then malformed: from this frame, neither is valid, and each still counts.
    const big = fromFrame({ kind: "artifact.request", requestId: "artreq-big", request: { op: "read", pad: "x".repeat(1_000) } });
    expect(session.accept(big)).toMatchObject({ ok: false });
    expect(session.accept(fromFrame({ kind: "artifact.request", requestId: "artreq-x", request: { op: "nope" } })).ok).toBe(false);
    const valid = session.accept(read("artreq-z"));
    expect(valid.ok).toBe(true);

    expect(session.accept(read("artreq-after"))).toMatchObject({ ok: false, code: "ARTIFACT_RATE_LIMITED" });
    expect(seen).toBe(1);
  });

  it("spends nothing on a message from another window, so another widget cannot use up this frame's rate or budget", async () => {
    let seen = 0;
    const { session, posted } = makeSession({
      maxMessages: 1,
      artifactBurst: 1,
      artifactRefillPerSecond: 0,
      now: () => 5_000,
      artifacts: async () => {
        seen += 1;
        return { status: "ok", ref: REF };
      },
    });
    session.init();
    const before = posted.length;

    // Another widget's window, even one that knows this frame's nonce, however many times it sends.
    for (let index = 0; index < 50; index += 1) {
      expect(session.accept({ ...read(`artreq-f${String(index)}`), sourceMatchesExpectedWindow: false })).toMatchObject({ ok: false, code: "SOURCE_MISMATCH" });
      expect(session.accept({ ...fromFrame({ kind: "event", name: "x", payload: {} }), sourceMatchesExpectedWindow: false }).ok).toBe(false);
    }
    // Nothing was answered to it, and this frame still has its one file request and its one other message.
    expect(posted.length).toBe(before);
    expect(session.accept(read("artreq-own")).ok).toBe(true);
    expect(session.accept(fromFrame({ kind: "event", name: "x", payload: {} })).ok).toBe(true);
    await flush();
    expect(seen).toBe(1);
  });

  it("does not answer a rate-limited message that is not this frame's to answer", () => {
    const { session, posted } = makeSession({ artifactBurst: 0, artifactRefillPerSecond: 0, artifacts: async () => ({ status: "ok" }) });
    session.init();
    const before = posted.length;

    const foreign = session.accept({ ...read("artreq-f"), sourceMatchesExpectedWindow: false });
    const wrongNonce = session.accept({ data: { kind: "artifact.request", nonce: "x".repeat(20), requestId: "artreq-n" }, sourceMatchesExpectedWindow: true });

    expect(foreign).toMatchObject({ ok: false, code: "SOURCE_MISMATCH" });
    expect("answered" in foreign).toBe(false);
    expect(wrongNonce).toMatchObject({ ok: false, code: "ARTIFACT_RATE_LIMITED" });
    expect("answered" in wrongNonce).toBe(false);
    expect(posted.length).toBe(before);
  });

  it("keeps only the latest entries of what the frame said, so a frame that keeps asking cannot grow the record", async () => {
    const { session } = makeSession({ maxTranscriptEntries: 5, artifactBurst: 100, artifacts: async () => ({ status: "ok", ref: REF }) });
    session.init();
    session.accept(fromFrame({ kind: "ready" }));
    for (let index = 0; index < 40; index += 1) {
      expect(session.accept(read(`artreq-t${String(index)}`)).ok).toBe(true);
      await flush();
    }
    const kept = session.transcript();
    expect(kept).toHaveLength(5);
    expect(kept.at(-1)).toEqual({ kind: "artifact.request", detail: "read art_one" });
    expect(kept.some((entry) => entry.kind === "ready")).toBe(false);
  });

  it("keeps only the latest refusals, so a frame that keeps failing cannot grow the record", () => {
    const { session } = makeSession({ maxRecordedRefusals: 3 });
    session.init();

    for (let index = 0; index < 10; index += 1) session.accept(fromFrame({ kind: "nope" }));
    session.accept(fromFrame({ kind: "capability.request", capabilityRef: "fs.write@1", justification: "x" }));

    expect(session.refused()).toEqual(["SCHEMA_INVALID", "SCHEMA_INVALID", "CAPABILITY_NOT_BROKERED"]);
  });

  it("lets one chunk through under its own ceiling, and still bounds it", () => {
    const { session } = makeSession({ maxArtifactMessageBytes: 4096, artifacts: async () => ({ status: "ok" }) });
    session.init();
    const write = (chunk: string) =>
      fromFrame({
        kind: "artifact.request",
        requestId: `artreq-${String(chunk.length)}`,
        request: { op: "write", artifactId: "art_one", offset: 0, chunkBase64: chunk },
      });

    // Larger than the ordinary 64 KiB default would matter for; here the point is the artifact ceiling applies.
    expect(session.accept(write("A".repeat(2000))).ok).toBe(true);
    const tooBig = session.accept(write("A".repeat(8000)));
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.code).toBe("TOO_LARGE");
  });

  it("does not answer after the frame is gone", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session, posted } = makeSession({
      artifacts: async () => {
        await gate;
        return { status: "ok", ref: REF };
      },
    });
    session.init();
    session.accept(read("artreq-late"));
    session.dispose();
    const before = posted.length;

    release();
    await flush();

    expect(posted.length).toBe(before);
  });
});
