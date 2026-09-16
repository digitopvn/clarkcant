import { describe, expect, it } from "vitest";

import { FakePiAdapter, RealPiAdapter, READ_ONLY_TOOLS, mapPiEvent } from "../src/index.ts";

describe("fake adapter used by CI and E2E", () => {
  it("runs a scripted turn and emits the same event shapes as the real adapter", async () => {
    const adapter = new FakePiAdapter({ script: ["the fixture file contains three records"] });
    const session = await adapter.createWorkerSession({
      goal: "summarise the fixture",
      projectRoots: ["/tmp/fixture"],
      allowedCapabilityRefs: [],
    });

    const events: string[] = [];
    adapter.subscribe(session.sessionId, (event) => events.push(event.type));
    const text = await adapter.run(session.sessionId, "summarise the fixture");

    expect(text).toContain("three records");
    expect(events).toContain("text-delta");
    expect(events).toContain("turn-end");
    // `settled` is emitted, but it is not success: only the verifier decides that.
    expect(events).toContain("settled");
  });

  it("refuses to subscribe the same listener twice (T25)", async () => {
    const adapter = new FakePiAdapter();
    const session = await adapter.createWorkerSession({ goal: "g", projectRoots: [], allowedCapabilityRefs: [] });
    const listener = (): void => {};
    adapter.subscribe(session.sessionId, listener);
    expect(() => adapter.subscribe(session.sessionId, listener)).toThrow(/twice/);
  });

  it("releases listeners on dispose so a swap cannot double-deliver", async () => {
    const adapter = new FakePiAdapter();
    const session = await adapter.createWorkerSession({ goal: "g", projectRoots: [], allowedCapabilityRefs: [] });
    adapter.subscribe(session.sessionId, () => {});
    expect(adapter.listenerCount(session.sessionId)).toBe(1);
    await adapter.dispose(session.sessionId);
    expect(() => adapter.listenerCount(session.sessionId)).toThrow();
  });

  it("refuses to register the same tool name twice", async () => {
    const adapter = new FakePiAdapter();
    const session = await adapter.createWorkerSession({ goal: "g", projectRoots: [], allowedCapabilityRefs: [] });
    const tool = {
      name: "read_fixture",
      label: "Read fixture",
      description: "reads the fixture file",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ text: "contents" }),
    };
    await adapter.registerTool(session.sessionId, tool);
    await expect(adapter.registerTool(session.sessionId, tool)).rejects.toThrow(/already registered/);
  });

  it("only runs a tool that is both registered and active", async () => {
    const adapter = new FakePiAdapter();
    const session = await adapter.createWorkerSession({ goal: "g", projectRoots: [], allowedCapabilityRefs: [] });
    await adapter.registerTool(session.sessionId, {
      name: "read_fixture",
      label: "Read fixture",
      description: "reads the fixture file",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ text: "contents" }),
    });
    await expect(adapter.callTool(session.sessionId, "read_fixture", {})).rejects.toThrow(/not active/);
    await adapter.setActiveTools(session.sessionId, ["read_fixture"]);
    expect(await adapter.callTool(session.sessionId, "read_fixture", {})).toBe("contents");
  });

  it("reports the refresh scope it actually applied", async () => {
    const adapter = new FakePiAdapter();
    const session = await adapter.createWorkerSession({ goal: "g", projectRoots: [], allowedCapabilityRefs: [] });
    const applied = await adapter.refreshResources(session.sessionId, { scope: "ui", reason: "theme changed" });
    // A UI-only change must not be reported as a worker restart.
    expect(applied.applied).toBe("ui");
    expect(applied.note).toContain("ui");
  });

  it("creates a successor session on handoff without dropping the original", async () => {
    const adapter = new FakePiAdapter();
    const session = await adapter.createWorkerSession({ goal: "g", projectRoots: [], allowedCapabilityRefs: [] });
    const { successor, note } = await adapter.handoff(session.sessionId, {
      goal: "g2",
      projectRoots: [],
      allowedCapabilityRefs: [],
    });
    expect(successor.sessionId).not.toBe(session.sessionId);
    expect(note).toContain("preserved");
    // The previous session is still addressable until the caller disposes it.
    expect(adapter.usage(session.sessionId).turns).toBe(0);
  });
});

describe("real SDK adapter availability (P0.1)", () => {
  it(
    "loads the installed Pi SDK and reports the required exports as present",
    async () => {
      const adapter = new RealPiAdapter({ cwd: process.cwd(), builtinTools: READ_ONLY_TOOLS });
      const availability = await adapter.availability();
      expect(availability.available).toBe(true);
      expect(availability.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    },
    // Loading the SDK is genuinely heavy, and this test runs alongside suites that spawn a
    // Chromium and several child processes. At the 20 second default it measured the machine's
    // load rather than the adapter, and failed intermittently for that reason alone. The timeout
    // is stated so a real regression here is still reported as a failure rather than as slowness.
    60_000,
  );
});

describe("SDK event mapping", () => {
  it("drops events it does not recognise rather than forwarding an unvalidated shape", () => {
    expect(mapPiEvent("s1", { type: "some_future_event" } as never)).toBeUndefined();
  });

  it("maps a tool failure to an error tool-end", () => {
    const mapped = mapPiEvent("s1", {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "c1",
      isError: true,
    } as never);
    expect(mapped).toEqual({
      type: "tool-end",
      sessionId: "s1",
      toolName: "bash",
      toolCallId: "c1",
      isError: true,
    });
  });
});
