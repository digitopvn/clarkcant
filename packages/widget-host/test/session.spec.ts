import { describe, expect, it } from "vitest";

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
