import { afterEach, describe, expect, it, vi } from "vitest";

import { compileAppearance } from "@clarkcant/design-tokens";
import { APPEARANCE_EXTENSION, BRIDGE_PROTOCOL, BRIDGE_VERSION } from "../src/index.ts";
import { createWidgetRuntime, type MessageEndpoint } from "../src/runtime.ts";

/**
 * The widget side of the handshake.
 *
 * The claims worth testing here are about what the runtime will *not* do. A runtime that speaks before it has a
 * nonce, or that sends a capability request the host never brokered, is not a convenience — it is a frame acting
 * beyond what it was given. The happy paths are tested too, but they are the easy half.
 */

const NONCE = "nonce-issued-for-this-frame";

describe("read-only widget appearance", () => {
  it("publishes init before mount, freezes a copy and changes no semantic or state revision", async () => {
    const bus = channel();
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint });
    const dark = compileAppearance({ scheme: "dark" });
    const light = compileAppearance({ scheme: "light" });
    const revisions: string[] = [];
    const unsubscribe = runtime.api().appearance.subscribe((snapshot) => revisions.push(snapshot.revision));
    expect(runtime.api().appearance.current()).toBeUndefined();
    let mounts = 0;
    runtime.api().lifecycle.onMount(() => {
      mounts += 1;
      expect(runtime.api().appearance.current()?.revision).toBe(dark.revision);
    });
    bus.deliver(initMessage({ appearance: dark, extensions: [APPEARANCE_EXTENSION], revision: 7, stateRevision: 3 }));
    const initial = runtime.api().appearance.current();
    expect(Object.isFrozen(initial?.tokens.color)).toBe(true);
    expect(Reflect.set(initial!.tokens.color, "canvas", "#ffffff")).toBe(false);
    expect(initial?.tokens.color.canvas).toBe(dark.tokens.color.canvas);
    dark.tokens.color.canvas = "#ffffff";
    expect(initial?.tokens.color.canvas).not.toBe(dark.tokens.color.canvas);
    bus.sent.length = 0;
    const changed = { kind: "appearance.changed", nonce: NONCE, revision: light.revision, appearance: light };
    bus.deliver(changed);
    bus.deliver(changed);
    expect(revisions).toEqual([initial!.revision, light.revision]);
    expect(mounts).toBe(1);
    expect(runtime.api().props.read()).toEqual({ title: "doanh thu" });
    expect(bus.sent).toEqual([]);
    const action = runtime.api().actions.invoke("keep-revision", {}, "appearance-action");
    expect(bus.sent.at(-1)).toMatchObject({ kind: "action.invoke", expectedRevision: 7 });
    const invocation = bus.sent.at(-1) as { invocationId: string };
    bus.deliver({ kind: "action-result", nonce: NONCE, actionBindingId: "keep-revision", invocationId: invocation.invocationId, status: "accepted", message: "done" });
    await action;
    expect(runtime.api().state.revision()).toBe(3);
    unsubscribe();
    bus.deliver({ kind: "appearance.changed", nonce: NONCE, revision: initial!.revision, appearance: initial });
    expect(revisions).toHaveLength(2);
    bus.deliver({ kind: "dispose", nonce: NONCE });
    bus.deliver(changed);
    expect(runtime.status()).toBe("disposed");
    expect(revisions).toHaveLength(2);
  });

  it("refuses foreign nonce, inconsistent revisions, raw documents and malformed token values", () => {
    const bus = channel();
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint });
    const dark = compileAppearance({ scheme: "dark" });
    const light = compileAppearance({ scheme: "light" });
    bus.deliver(initMessage({ appearance: dark, extensions: [APPEARANCE_EXTENSION] }));
    const message = { kind: "appearance.changed", nonce: NONCE, revision: light.revision, appearance: light };
    bus.deliver({ ...message, nonce: "another-frame-nonce" });
    bus.deliver({ ...message, revision: dark.revision });
    bus.deliver({ ...message, appearance: { ...light, rawTheme: { css: "body{}" } } });
    bus.deliver({ ...message, appearance: { ...light, tokens: { ...light.tokens, color: { ...light.tokens.color, canvas: "url(https://bad.test)" } } } });
    expect(runtime.api().appearance.current()?.revision).toBe(dark.revision);
  });

  it("still handshakes with a v1 host and ignores an unoffered appearance extension", () => {
    const bus = channel();
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint });
    bus.deliver(initMessage({ version: 1 }));
    expect(runtime.status()).toBe("ready");
    const appearance = compileAppearance({ scheme: "light" });
    bus.deliver({ kind: "appearance.changed", nonce: NONCE, revision: appearance.revision, appearance });
    expect(runtime.api().appearance.current()).toBeUndefined();
  });
});

function channel() {
  const sent: { kind?: string }[] = [];
  let listener: ((event: { data: unknown }) => void) | undefined;
  let removed = 0;
  const endpoint: MessageEndpoint = {
    postMessage: (message) => sent.push(message as { kind?: string }),
    addEventListener: (_type, handler) => {
      listener = handler;
    },
    removeEventListener: () => {
      removed += 1;
      listener = undefined;
    },
  };
  return {
    sent,
    endpoint,
    deliver: (data: unknown) => listener?.({ data }),
    listenerPresent: () => listener !== undefined,
    removals: () => removed,
  };
}

function initMessage(overrides: Record<string, unknown> = {}) {
  return {
    kind: "init",
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_VERSION,
    instanceId: "inst_1",
    nonce: NONCE,
    props: { title: "doanh thu" },
    brokeredCapabilities: ["dataset.read@1"],
    allowedOrigins: ["https://example.test"],
    ...overrides,
  };
}

describe("the widget runtime handshake", () => {
  it("sends nothing until init arrives, but can be subscribed to before it", () => {
    const bus = channel();
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint });
    let mounted = 0;

    expect(runtime.status()).toBe("awaiting-init");
    // Nothing has been sent, and nothing can be: inventing a nonce is how one frame comes to speak as another.
    expect(bus.sent).toHaveLength(0);
    expect(() => runtime.api().events.emit("too-early", {})).toThrow(/chưa init/);
    expect(() => runtime.api().host.focus()).toThrow(/chưa init/);

    /*
     * Reading and subscribing are not sends, and this is the case that has to work: a widget registers `onMount`
     * before init, because init is what fires it. A runtime that refused the API until init made mount impossible
     * to observe — which the conformance suite found, and which is why the guard is on sending rather than on the
     * API as a whole.
     */
    expect(runtime.api().props.read()).toEqual({});
    runtime.api().lifecycle.onMount(() => {
      mounted += 1;
    });

    bus.deliver(initMessage());

    expect(runtime.status()).toBe("ready");
    expect(runtime.instanceId()).toBe("inst_1");
    expect(bus.sent[0]).toEqual({ kind: "ready", nonce: NONCE });
    expect(mounted).toBe(1);
  });

  it("refuses a second init, so a frame cannot be given two identities", () => {
    const bus = channel();
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint });
    let mounted = 0;
    runtime.api().lifecycle.onMount(() => {
      mounted += 1;
    });

    bus.deliver(initMessage());
    bus.deliver(initMessage());

    expect(runtime.status()).toBe("ready");
    // One ready, one mount: the duplicate was refused before it could fire anything or hand out a new nonce.
    expect(bus.sent.filter((message) => message.kind === "ready")).toHaveLength(1);
    expect(mounted).toBe(1);
  });

  it("refuses a host that speaks a different protocol", () => {
    const bus = channel();
    const rejections: string[] = [];
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint, onRejected: (r) => rejections.push(r.code) });

    bus.deliver(initMessage({ version: 99 }));

    expect(runtime.status()).toBe("awaiting-init");
    expect(rejections).toContain("PROTOCOL_MISMATCH");
    expect(bus.sent).toHaveLength(0);
  });

  it("ignores a message whose nonce is not this frame's", () => {
    const bus = channel();
    const rejections: string[] = [];
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint, onRejected: (r) => rejections.push(r.code) });
    bus.deliver(initMessage());

    bus.deliver({ kind: "props", nonce: "someone-elses-nonce", props: { title: "hijacked" } });

    expect(rejections).toContain("NONCE_MISMATCH");
    // The forged props did not land, which is the point of comparing the nonce rather than the origin.
    expect(runtime.api().props.read()).toEqual({ title: "doanh thu" });
  });

  it("forwards props to subscribers and lets them be read", () => {
    const bus = channel();
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint });
    bus.deliver(initMessage());
    const seen: Record<string, unknown>[] = [];
    runtime.api().props.subscribe((props) => seen.push(props));

    bus.deliver({ kind: "props", nonce: NONCE, props: { title: "chi phí" } });

    expect(runtime.api().props.read()).toEqual({ title: "chi phí" });
    expect(seen).toEqual([{ title: "chi phí" }]);
  });
});

describe("what the runtime sends", () => {
  function ready() {
    const bus = channel();
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint });
    bus.deliver(initMessage());
    bus.sent.length = 0;
    return { bus, runtime, api: runtime.api() };
  }

  it("refuses a stale write locally instead of asking the host to arbitrate it", async () => {
    const { api, bus } = ready();

    await expect(api.state.update(7, { tab: "x" })).rejects.toThrow(/cũ/);
    expect(bus.sent).toHaveLength(0);

    const written = api.state.update(0, { tab: "x" });
    expect(bus.sent[0]).toMatchObject({ kind: "state.update", expectedRevision: 0, nonce: NONCE });
    bus.deliver({ kind: "state", nonce: NONCE, state: { tab: "x" }, revision: 1 });
    await written;
    expect(api.state.revision()).toBe(1);
  });

  it("keeps the state revision apart from the instance revision", async () => {
    const bus = channel();
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint });
    // An instance that has moved three times, whose state has been written once.
    bus.deliver(initMessage({ revision: 3, stateRevision: 1, state: { tab: "a" } }));
    const api = runtime.api();
    bus.sent.length = 0;

    // The first write names the state revision it was shown, and is sent rather than refused as stale.
    const written = api.state.update(1, { tab: "b" });
    expect(bus.sent[0]).toMatchObject({ kind: "state.update", expectedRevision: 1 });
    bus.deliver({ kind: "state", nonce: NONCE, state: { tab: "b" }, revision: 2 });
    await written;

    // An action still carries the instance revision, untouched by the state write.
    void api.actions.invoke("act_1", {}, "inv_1");
    expect(bus.sent.at(-1)).toMatchObject({ kind: "action.invoke", expectedRevision: 3 });
  });

  it("resolves a write only once the host commits it, and rejects with the host's reason", async () => {
    const { api, bus } = ready();
    const seen: number[] = [];
    api.state.subscribe((_state, revision) => seen.push(revision));

    const written = api.state.update(0, { body: "nháp" });
    // One write in flight at a time: the answer decides the revision the next write names.
    await expect(api.state.update(0, { body: "khác" })).rejects.toThrow(/chưa được host xác nhận/);

    bus.deliver({
      kind: "state",
      nonce: NONCE,
      state: { body: "đã lưu" },
      revision: 4,
      refused: { code: "STATE_REVISION_STALE", message: "another surface saved first" },
    });
    await expect(written).rejects.toThrow(/STATE_REVISION_STALE/);
    // The committed value replaces the optimistic one, and the widget is told the revision to plan against.
    expect(api.state.get()).toEqual({ body: "đã lưu" });
    expect(api.state.revision()).toBe(4);
    expect(seen).toEqual([4]);
  });

  it("emits events and publishes a semantic summary", () => {
    const { api, bus } = ready();

    api.events.emit("filter.changed", { from: "2026-09-01" });
    api.semantic.publish("đang xem doanh thu tháng 9", ["row_1"]);

    expect(bus.sent[0]).toMatchObject({ kind: "event", name: "filter.changed" });
    expect(bus.sent[1]).toMatchObject({ kind: "semantic.publish", summary: "đang xem doanh thu tháng 9" });
    expect(bus.sent[1]).not.toHaveProperty("values");
  });

  it("publishes the named values a widget shows, only when it gives some", () => {
    const { api, bus } = ready();

    api.semantic.publish("3 việc, 1 đã ghim", ["n2"], { filter: "pinned", page: 2 });

    expect(bus.sent[0]).toMatchObject({ kind: "semantic.publish", selectedIds: ["n2"], values: { filter: "pinned", page: 2 } });
  });

  it("resolves an action only when the host answers it", async () => {
    const { api, bus } = ready();

    const pending = api.actions.invoke("act_1", {}, "inv_1");
    expect(bus.sent[0]).toMatchObject({ kind: "action.invoke", actionBindingId: "act_1", invocationId: "inv_1" });

    bus.deliver({ kind: "action-result", nonce: NONCE, actionBindingId: "act_1", status: "accepted", message: "ok" });
    await expect(pending).resolves.toBeUndefined();
  });

  it("resolves an action with what the service answered", async () => {
    const { api, bus } = ready();

    const pending = api.actions.invoke("act_1", { text: "mua sữa" }, "inv_1");
    bus.deliver({
      kind: "action-result",
      nonce: NONCE,
      actionBindingId: "act_1",
      status: "accepted",
      message: "ok",
      output: "Saved. 1 note(s): mua sữa",
    });
    await expect(pending).resolves.toBe("Saved. 1 note(s): mua sữa");
  });

  it("gives each call of the same action its own answer, whichever comes back first", async () => {
    const { api, bus } = ready();

    const first = api.actions.invoke("act_1", { text: "một" }, "inv_1");
    const second = api.actions.invoke("act_1", { text: "hai" }, "inv_2");
    bus.deliver({
      kind: "action-result",
      nonce: NONCE,
      actionBindingId: "act_1",
      invocationId: "inv_2",
      status: "accepted",
      message: "ok",
      output: "hai",
    });
    bus.deliver({
      kind: "action-result",
      nonce: NONCE,
      actionBindingId: "act_1",
      invocationId: "inv_1",
      status: "refused",
      message: "no answer from the service",
    });

    await expect(second).resolves.toBe("hai");
    await expect(first).rejects.toThrow("no answer from the service");
  });

  it("does not settle a call with an answer that names another action", async () => {
    const { api, bus } = ready();

    const pending = api.actions.invoke("act_1", {}, "inv_1");
    bus.deliver({ kind: "action-result", nonce: NONCE, actionBindingId: "act_2", invocationId: "inv_1", status: "accepted", message: "ok" });
    bus.deliver({ kind: "action-result", nonce: NONCE, actionBindingId: "act_1", invocationId: "inv_1", status: "accepted", message: "ok", output: "đúng" });
    await expect(pending).resolves.toBe("đúng");
  });

  it("tells the widget which service-backed actions can run, and why one cannot", () => {
    const { api, bus } = ready();
    const seen: unknown[] = [];
    expect(api.actions.availability()).toEqual([]);
    api.actions.subscribe((actions) => seen.push(actions));

    bus.deliver({
      kind: "actions",
      nonce: NONCE,
      actions: [{ actionBindingId: "act_1", available: false, reason: "needs Docker or Podman" }],
    });

    expect(api.actions.availability()).toEqual([
      { actionBindingId: "act_1", available: false, reason: "needs Docker or Podman" },
    ]);
    expect(seen).toHaveLength(1);
    // Hearing it sends nothing back: availability is the host's to say, not something the frame negotiates.
    expect(bus.sent).toHaveLength(0);
  });

  it("ignores an availability message from the wrong nonce", () => {
    const { api, bus } = ready();
    bus.deliver({ kind: "actions", nonce: "someone-elses", actions: [{ actionBindingId: "act_1", available: true }] });
    expect(api.actions.availability()).toEqual([]);
  });

  it("rejects an action the host refused, and says what the host said", async () => {
    const { api, bus } = ready();

    const pending = api.actions.invoke("act_1", {}, "inv_1");
    bus.deliver({
      kind: "action-result",
      nonce: NONCE,
      actionBindingId: "act_1",
      status: "refused",
      message: "policy requires approval",
    });

    await expect(pending).rejects.toThrow("policy requires approval");
  });

  it("refuses to even ask for a capability the host did not broker", async () => {
    const { api, bus } = ready();

    /*
     * The refusal happens here rather than at the host. The host has already answered this by not brokering it, and
     * sending it anyway would have the host arbitrate a settled question and answer somewhere the caller is not
     * looking.
     */
    await expect(api.capabilities.request("filesystem.write@1", "cần ghi file")).rejects.toThrow(/không broker/);
    expect(bus.sent).toHaveLength(0);

    await api.capabilities.request("dataset.read@1", "cần đọc dữ liệu");
    expect(bus.sent[0]).toMatchObject({ kind: "capability.request", capabilityRef: "dataset.read@1" });
  });

  it("asks the host for chrome instead of performing it", () => {
    const { api, bus } = ready();

    api.host.focus();
    api.host.resize({ height: 480 });
    api.host.requestPin();
    api.host.openExternal("https://example.test/x");

    // Every one is a request. A widget that could open a window or resize itself would be doing the host's job.
    expect(bus.sent.map((message) => message)).toEqual([
      { kind: "host.request", nonce: NONCE, request: "focus" },
      { kind: "host.request", nonce: NONCE, request: "resize", argument: "480" },
      { kind: "host.request", nonce: NONCE, request: "request-pin" },
      { kind: "host.request", nonce: NONCE, request: "open-external", argument: "https://example.test/x" },
    ]);
  });
});

describe("the widget lifecycle", () => {
  it("suspends, resumes on the next props update, and disposes once", () => {
    const bus = channel();
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint });
    bus.deliver(initMessage());

    const events: string[] = [];
    const api = runtime.api();
    api.lifecycle.onSuspend((reason) => events.push(`suspend:${reason}`));
    api.lifecycle.onResume(() => events.push("resume"));
    api.lifecycle.onDispose(() => events.push("dispose"));

    bus.deliver({ kind: "suspend", nonce: NONCE, reason: "offscreen" });
    expect(runtime.status()).toBe("suspended");
    expect(events).toEqual(["suspend:offscreen"]);

    // There is no resume message in the codec, so a props update is what brings a suspended frame back.
    bus.deliver({ kind: "props", nonce: NONCE, props: { title: "lại" } });
    expect(runtime.status()).toBe("ready");
    expect(events).toContain("resume");
    // The props really were replaced, which is how the resume was noticed in the first place.
    expect(runtime.api().props.read()).toEqual({ title: "lại" });

    bus.deliver({ kind: "dispose", nonce: NONCE });
    bus.deliver({ kind: "dispose", nonce: NONCE });
    expect(runtime.status()).toBe("disposed");
    // Disposed once, listener removed: a frame that kept listening would act after its lifetime ended.
    expect(events.filter((event) => event === "dispose")).toHaveLength(1);
    expect(bus.listenerPresent()).toBe(false);

    // Reading stays possible, because a disposed widget may still be on screen for a frame — but sending does
    // not, since nothing is listening for it any more.
    expect(runtime.api().props.read()).toEqual({ title: "lại" });
    expect(() => runtime.api().events.emit("late", {})).toThrow(/dispose/);
  });

  it("refuses to send anything after disposal", () => {
    const bus = channel();
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint });
    bus.deliver(initMessage());
    bus.deliver({ kind: "dispose", nonce: NONCE });

    expect(() => runtime.api().events.emit("late", {})).toThrow(/dispose/);
    expect(() => runtime.api().host.focus()).toThrow(/dispose/);
  });

  it("rejects a pending action when the host disposes the frame", async () => {
    const bus = channel();
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint });
    bus.deliver(initMessage());

    const pending = runtime.api().actions.invoke("act_1", {}, "inv_1");
    bus.deliver({ kind: "dispose", nonce: NONCE });

    // Told, rather than left hanging: an unanswered promise is a widget that looks busy forever.
    await expect(pending).rejects.toThrow(/dispose/);
  });
});

describe("the artifacts@1 extension", () => {
  const ref = (sizeBytes: number, kind: "working" | "finalized" = "working") => ({
    v: 1 as const,
    artifactId: "art_one",
    kind,
    name: "ghi-chu.txt",
    mimeType: "text/plain",
    sizeBytes,
  });
  type Sent = { kind?: string; requestId?: string; request?: { op: string; offset?: number; chunkBase64?: string } };

  function ready(extensions?: string[]) {
    const bus = channel();
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint });
    bus.deliver(initMessage(extensions === undefined ? {} : { extensions }));
    const requests = () => (bus.sent as Sent[]).filter((message) => message.kind === "artifact.request");
    const answer = (requestId: string, result: Record<string, unknown>) =>
      bus.deliver({ kind: "artifact-result", nonce: NONCE, requestId, ...result });
    return { bus, runtime, requests, answer };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("refuses locally when the host did not offer it, and sends nothing", async () => {
    const { runtime, requests } = ready();

    expect(runtime.api().artifacts.available()).toBe(false);
    await expect(runtime.api().artifacts.pick({ accept: ["text/plain"] })).rejects.toThrow(/artifacts@1/);
    expect(requests()).toHaveLength(0);
  });

  it("resolves a pick the person closed as nothing chosen, not as an error", async () => {
    const { runtime, requests, answer } = ready(["artifacts@1"]);
    expect(runtime.api().artifacts.available()).toBe(true);

    const picked = runtime.api().artifacts.pick({ accept: ["text/plain"] });
    const [request] = requests();
    expect(request?.request).toEqual({ op: "pick", accept: ["text/plain"] });
    answer(request?.requestId ?? "", { status: "cancelled" });

    await expect(picked).resolves.toBeUndefined();
  });

  it("reads a range as bytes and reports whether the file ended", async () => {
    const { runtime, requests, answer } = ready(["artifacts@1"]);

    const reading = runtime.api().artifacts.read(ref(5), { offset: 0, length: 5 });
    answer(requests()[0]?.requestId ?? "", { status: "ok", chunkBase64: btoa("hello"), eof: true });
    const { bytes, eof } = await reading;

    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect(eof).toBe(true);
  });

  it("carries a host refusal to the widget with its code", async () => {
    const { runtime, requests, answer } = ready(["artifacts@1"]);

    const reading = runtime.api().artifacts.read(ref(5), { offset: 0, length: 5 });
    answer(requests()[0]?.requestId ?? "", { status: "refused", code: "ARTIFACT_GRANT_EXPIRED", message: "hết hạn" });

    await expect(reading).rejects.toThrow(/ARTIFACT_GRANT_EXPIRED/);
  });

  it("sends writes in order, each at the offset the previous one left, and finalizes after the last", async () => {
    const { runtime, requests, answer } = ready(["artifacts@1"]);
    const api = runtime.api().artifacts;
    const encoder = new TextEncoder();

    const first = api.write(ref(0), encoder.encode("abc"));
    const second = api.write(ref(0), encoder.encode("de"));
    const finalized = api.finalize(ref(0));
    await flush();

    // Only the first is out: the second waits for the size the first leaves.
    expect(requests()).toHaveLength(1);
    expect(requests()[0]?.request).toMatchObject({ op: "write", offset: 0 });
    answer(requests()[0]?.requestId ?? "", { status: "ok", ref: ref(3) });
    await first;
    await flush();

    expect(requests()).toHaveLength(2);
    expect(requests()[1]?.request).toMatchObject({ op: "write", offset: 3 });
    answer(requests()[1]?.requestId ?? "", { status: "ok", ref: ref(5) });
    await second;
    await flush();

    expect(requests()[2]?.request).toEqual({ op: "finalize", artifactId: "art_one" });
    answer(requests()[2]?.requestId ?? "", { status: "ok", ref: ref(5, "finalized") });
    await expect(finalized).resolves.toMatchObject({ kind: "finalized", sizeBytes: 5 });
  });

  it("refuses a chunk larger than one bridge message before sending it", async () => {
    const { runtime, requests } = ready(["artifacts@1"]);

    await expect(runtime.api().artifacts.write(ref(0), new Uint8Array(256 * 1024 + 1))).rejects.toThrow(/262144/);
    expect(requests()).toHaveLength(0);
  });

  it("offers no filesystem on the author surface", () => {
    const { runtime } = ready(["artifacts@1"]);
    const surface = runtime.api() as unknown as Record<string, unknown>;

    expect(surface["fs"]).toBeUndefined();
    expect(Object.keys(runtime.api().artifacts).sort()).toEqual(
      ["attachToConversation", "available", "create", "discard", "export", "finalize", "pick", "read", "write"].sort(),
    );
  });

  it("queues requests past the host's in-flight limit and sends each as an earlier one is answered", async () => {
    const { runtime, requests, answer } = ready(["artifacts@1"]);
    const api = runtime.api().artifacts;

    const reads = Array.from({ length: 6 }, (_, index) => api.read(ref(60), { offset: index * 10, length: 10 }));
    await flush();

    // Four out, two waiting: the host would answer a fifth with ARTIFACT_BUSY.
    expect(requests()).toHaveLength(4);
    answer(requests()[0]?.requestId ?? "", { status: "ok", chunkBase64: btoa("a"), eof: false });
    await flush();
    expect(requests()).toHaveLength(5);
    expect(requests()[4]?.request).toMatchObject({ op: "read", offset: 40 });

    for (const request of requests().slice(1)) answer(request.requestId ?? "", { status: "ok", chunkBase64: btoa("b"), eof: false });
    await flush();
    answer(requests()[5]?.requestId ?? "", { status: "ok", chunkBase64: btoa("c"), eof: true });

    const results = await Promise.all(reads);
    expect(results).toHaveLength(6);
    expect(results.at(-1)?.eof).toBe(true);
  });

  it("rejects the requests still queued when the host disposes the frame", async () => {
    const { bus, runtime, requests } = ready(["artifacts@1"]);
    const api = runtime.api().artifacts;

    const reads = Array.from({ length: 5 }, () => api.read(ref(5), { offset: 0, length: 5 }).catch((error: Error) => error.message));
    await flush();
    bus.deliver({ kind: "dispose", nonce: NONCE });

    const outcomes = await Promise.all(reads);
    expect(requests()).toHaveLength(4);
    expect(outcomes.every((outcome) => typeof outcome === "string" && outcome.includes("disposed"))).toBe(true);
  });

  it("discards a file after the writes still on their way, and carries a refusal with its code", async () => {
    const { runtime, requests, answer } = ready(["artifacts@1"]);
    const api = runtime.api().artifacts;

    const writing = api.write(ref(0), new TextEncoder().encode("abc"));
    const discarded = api.discard(ref(0));
    await flush();
    expect(requests().map((request) => request.request?.op)).toEqual(["write"]);
    answer(requests()[0]?.requestId ?? "", { status: "ok", ref: ref(3) });
    await writing;
    await flush();

    expect(requests()[1]?.request).toEqual({ op: "discard", artifactId: "art_one" });
    answer(requests()[1]?.requestId ?? "", { status: "ok" });
    await expect(discarded).resolves.toBeUndefined();

    const refused = api.discard(ref(3, "finalized"));
    await flush();
    answer(requests()[2]?.requestId ?? "", { status: "refused", code: "ARTIFACT_NOT_CREATOR", message: "not yours" });
    await expect(refused).rejects.toThrow(/ARTIFACT_NOT_CREATOR/);
  });
});

describe("the jobs@1 extension", () => {
  const jobId = "job_123";
  const snapshot = (status: "queued" | "running" | "completed" = "running") => ({
    jobId,
    status,
    resultRefs: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    ...(status === "completed" ? { endedAt: "2026-10-01T00:00:02.000Z" } : {}),
  });
  type Sent = { kind?: string; requestId?: string; request?: { op: string; jobId: string } };

  function ready(extensions: string[] = ["jobs@1"]) {
    const bus = channel();
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint });
    bus.deliver(initMessage({ extensions }));
    const requests = () => (bus.sent as Sent[]).filter((message) => message.kind === "job.request");
    const answer = (requestId: string, result: Record<string, unknown>) =>
      bus.deliver({ kind: "job-result", nonce: NONCE, requestId, ...result });
    return { bus, runtime, requests, answer };
  }

  afterEach(() => vi.useRealTimers());

  it("refuses locally when jobs@1 is not offered", async () => {
    const { runtime, requests } = ready([]);
    expect(runtime.api().jobs.available()).toBe(false);
    await expect(runtime.api().jobs.get(jobId)).rejects.toThrow(/jobs@1/);
    expect(() => runtime.api().jobs.subscribe(jobId, () => undefined)).toThrow(/jobs@1/);
    expect(requests()).toHaveLength(0);
  });

  it("re-authorizes get and cancel through separate host requests", async () => {
    const { runtime, requests, answer } = ready();
    expect(runtime.api().jobs.available()).toBe(true);
    const getting = runtime.api().jobs.get(jobId);
    expect(requests()[0]?.request).toEqual({ op: "get", jobId });
    answer(requests()[0]?.requestId ?? "", { status: "ok", job: snapshot() });
    const job = await getting;
    expect(job).toMatchObject({ jobId, status: "running" });
    expect(Object.isFrozen(job)).toBe(true);

    const cancelling = runtime.api().jobs.cancel(jobId);
    expect(requests()[1]?.request).toEqual({ op: "cancel", jobId });
    answer(requests()[1]?.requestId ?? "", { status: "ok" });
    await expect(cancelling).resolves.toBeUndefined();
  });

  it("resumes from a snapshot, serializes polling and stops when terminal", async () => {
    vi.useFakeTimers();
    const { bus, runtime, requests, answer } = ready();
    const seen: string[] = [];
    const unsubscribe = runtime.api().jobs.subscribe(jobId, (job) => seen.push(job.status));
    expect(requests()).toHaveLength(1);
    expect(requests()[0]?.request).toEqual({ op: "get", jobId });

    // A slow host response must not cause overlapping polls.
    await vi.advanceTimersByTimeAsync(5000);
    expect(requests()).toHaveLength(1);
    answer(requests()[0]?.requestId ?? "", { status: "ok", job: snapshot("running") });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(seen).toEqual(["running"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests()).toHaveLength(2);
    answer(requests()[1]?.requestId ?? "", { status: "ok", job: snapshot("completed") });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(seen).toEqual(["running", "completed"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(requests()).toHaveLength(2);
    unsubscribe();
    bus.deliver({ kind: "dispose", nonce: NONCE });
  });

  it("rejects pending calls and clears subscription timers on dispose", async () => {
    vi.useFakeTimers();
    const { bus, runtime, requests } = ready();
    const pending = runtime.api().jobs.get(jobId);
    const unsubscribe = runtime.api().jobs.subscribe("job_other", () => undefined);
    expect(requests()).toHaveLength(2);
    bus.deliver({ kind: "dispose", nonce: NONCE });
    await expect(pending).rejects.toThrow(/disposed/);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(5000);
    expect(requests()).toHaveLength(2);
  });
});
