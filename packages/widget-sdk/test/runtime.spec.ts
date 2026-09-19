import { describe, expect, it } from "vitest";

import { BRIDGE_PROTOCOL, BRIDGE_VERSION } from "../src/index.ts";
import { createWidgetRuntime, type MessageEndpoint } from "../src/runtime.ts";

/**
 * The widget side of the handshake.
 *
 * The claims worth testing here are about what the runtime will *not* do. A runtime that speaks before it has a
 * nonce, or that sends a capability request the host never brokered, is not a convenience — it is a frame acting
 * beyond what it was given. The happy paths are tested too, but they are the easy half.
 */

const NONCE = "nonce-issued-for-this-frame";

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
  it("has no identity to speak with until init arrives", () => {
    const bus = channel();
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint });

    expect(runtime.status()).toBe("awaiting-init");
    // Not queued, not defaulted: calling before init is a programming error, and inventing a nonce is how one
    // frame comes to speak as another.
    expect(() => runtime.api()).toThrow(/trước init/);
    expect(bus.sent).toHaveLength(0);
  });

  it("answers init with ready carrying the nonce it was issued", () => {
    const bus = channel();
    const runtime = createWidgetRuntime({ endpoint: bus.endpoint });
    let mounted = 0;
    bus.deliver(initMessage());
    runtime.api().lifecycle.onMount(() => {
      mounted += 1;
    });
    bus.deliver(initMessage());

    expect(runtime.status()).toBe("ready");
    expect(runtime.instanceId()).toBe("inst_1");
    expect(bus.sent[0]).toEqual({ kind: "ready", nonce: NONCE });
    // A second init is a second identity, so it is refused rather than accepted.
    expect(bus.sent.filter((message) => message.kind === "ready")).toHaveLength(1);
    expect(mounted).toBe(0);
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

    await api.state.update(0, { tab: "x" });
    expect(bus.sent[0]).toMatchObject({ kind: "state.update", expectedRevision: 0, nonce: NONCE });
  });

  it("emits events and publishes a semantic summary", () => {
    const { api, bus } = ready();

    api.events.emit("filter.changed", { from: "2026-09-01" });
    api.semantic.publish("đang xem doanh thu tháng 9", ["row_1"]);

    expect(bus.sent[0]).toMatchObject({ kind: "event", name: "filter.changed" });
    expect(bus.sent[1]).toMatchObject({ kind: "semantic.publish", summary: "đang xem doanh thu tháng 9" });
  });

  it("resolves an action only when the host answers it", async () => {
    const { api, bus } = ready();

    const pending = api.actions.invoke("act_1", {}, "inv_1");
    expect(bus.sent[0]).toMatchObject({ kind: "action.invoke", actionBindingId: "act_1", invocationId: "inv_1" });

    bus.deliver({ kind: "action-result", nonce: NONCE, actionBindingId: "act_1", status: "accepted", message: "ok" });
    await expect(pending).resolves.toBeUndefined();
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
