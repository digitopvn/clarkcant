import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CapabilityRef, type Instant, type MessageBlock } from "@clarkcant/contracts";
import { getActionBinding, getInstance, registerCapability } from "@clarkcant/core";
import { ACTION } from "@clarkcant/data-canvas";
import { appendMessage } from "@clarkcant/storage";
import { definitionDigest } from "@clarkcant/widget-host";

import {
  type ActionBindingDeps,
  bindingAvailability,
  compileWidgetAction,
} from "../src/application/action-bindings.ts";
import { invokeWidgetAction } from "../src/application/widget-actions.ts";
import type { ServiceHost } from "../src/service-host.ts";
import { bootNodeServices, buildTimeline, type NodeServices } from "../src/services.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";
import type { ViewDescriptor } from "../src/model-turn.ts";

/**
 * The generic action button: what a model may bind it to, what the host says about whether it can run, and what a
 * press of each kind does.
 *
 * The negative cases carry the weight. A button whose action the host did not compile, a capability the model named
 * but no service provides, or a kind the node cannot run must each end as a sentence — to the model while it places
 * the button, and on the button when it is drawn — never as a control that looks live and does nothing.
 */

const AT = "2026-09-29T05:00:00.000Z" as Instant;
const LIST = "com.example.notes.list@1" as CapabilityRef;
const ADD = "com.example.notes.add@1" as CapabilityRef;
const PACKAGE = "com.example.notes";
const GENERATION = "com.example.notes@1.0.0:code_1";

let dir: string;
let services: NodeServices;
let conversationId: string;
let served: Map<string, { packageId: string; generationId: string }>;
let composed: { text: string; note: string | undefined }[];
let counter = 0;

function bindingDeps(): ActionBindingDeps {
  return {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    serviceHost: services.serviceHost,
    now: () => AT,
    newId: (prefix) => `${prefix}_${String(++counter)}`,
  };
}

function register(ref: CapabilityRef, effectCategory: "read" | "local-write", healthy = true): void {
  registerCapability(
    { db: services.runtime.db, nodeId: services.runtime.identity.nodeId },
    {
      ref,
      providedBy: { packageId: PACKAGE, version: "1.0.0", digest: "sha256:notes", generation: GENERATION },
      executionNodeId: services.runtime.identity.nodeId,
      summary: ref === LIST ? "List notes" : "Add a note",
      resourceKinds: [],
      effectCategory,
      supportsCancellation: false,
      requiresConnection: false,
      readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy },
      uiAffordances: [],
      inputSchema:
        ref === LIST
          ? { type: "object", properties: {}, additionalProperties: false }
          : { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    },
  );
}

function actionView(): ViewDescriptor {
  const view = buildViewCatalog(services.conductor, undefined, bindingDeps).find((entry) => entry.id === ACTION.id);
  if (view === undefined) throw new Error("the action view is not in the catalog");
  return view;
}

/** Place a button the way a model's `show_view` does, and put it in a message so the timeline carries it. */
async function place(props: Record<string, unknown>): Promise<string> {
  const messageId = `msg_${String(++counter)}`;
  const block = (await actionView().build({
    props,
    caption: "",
    at: AT,
    principal: { principalId: services.runtime.identity.ownerPrincipalId, kind: "user", nodeId: services.runtime.identity.nodeId } as never,
    messageId,
    conversationId,
  })) as Extract<MessageBlock, { type: "surface" }>;
  appendMessage(
    services.runtime.db,
    {
      messageId,
      conversationId,
      role: "assistant",
      authorNodeId: services.runtime.identity.nodeId,
      delivery: "accepted",
      createdAt: AT,
      blocks: [block],
    } as never,
    counter,
  );
  return block.snapshot.instanceId ?? "";
}

function instanceRows(): number {
  return (services.runtime.db.prepare("SELECT COUNT(*) AS n FROM widget_instances").get() as { n: number }).n;
}

function timelineActions(instanceId: string) {
  return buildTimeline(services, { conversationId, afterSequence: 0 }).instances.find(
    (entry) => entry.instanceId === instanceId,
  )?.actions;
}

async function press(instanceId: string, invocationId: string) {
  const instance = getInstance(services.conductor, instanceId);
  const bindingId = instance?.actionBindingIds[0] ?? "";
  const binding = getActionBinding(services.conductor, bindingId);
  return invokeWidgetAction(
    services,
    {
      conversationId,
      principalId: services.runtime.identity.ownerPrincipalId,
      instanceId,
      actionBindingId: bindingId,
      expectedRevision: instance?.revision ?? 0,
      expectedBindingDigest: binding?.bindingDigest ?? "",
      input: {},
      invocationId,
    },
    "click",
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-action-widget-"));
  composed = [];
  served = new Map();
  services = bootNodeServices({
    dataDir: dir,
    label: "test node",
    // Stands in for the model: records what the turn was asked, and answers.
    composeFromIntent: async (input) => {
      composed.push({ text: input.text, note: input.note });
      const reply = `Đã làm: ${input.text}`;
      return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
    },
  });
  // Only `serves` is read on these paths: which package generation, if any, provides a capability right now.
  services.serviceHost = { serves: (ref: CapabilityRef) => served.get(ref) } as unknown as ServiceHost;
  conversationId = "conv_action_widget";
  services.runtime.db
    .prepare(
      "INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)",
    )
    .run(conversationId, services.runtime.identity.nodeId, AT, AT);
});

afterEach(() => {
  services.runtime.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const REF = { id: ACTION.id, version: ACTION.version, packageDigest: definitionDigest(ACTION) };

describe("compiling what a model asked a button to do", () => {
  it("allows pinning as the one view operation, because the others need input a button does not carry", () => {
    const pin = compileWidgetAction(bindingDeps(), {
      definitionRef: REF,
      label: "Ghim",
      action: { kind: "view", operation: "view.save", args: {} },
    });
    expect(pin.ok).toBe(true);
    if (!pin.ok) throw new Error("unreachable");
    expect(pin.bindTo("winst_1")).toMatchObject({ instanceId: "winst_1", effectCategory: "local-write" });

    const period = compileWidgetAction(bindingDeps(), {
      definitionRef: REF,
      label: "Đổi",
      action: { kind: "view", operation: "period.change", args: {} },
    });
    expect(period).toMatchObject({ ok: false });
    if (period.ok) throw new Error("unreachable");
    expect(period.message).toContain("view.save");
  });

  it("binds a capability only when a running service provides it, and takes its effect and generation from the node", () => {
    register(ADD, "local-write");
    const action = { kind: "invoke", capabilityRef: ADD, args: { text: "mua sữa" } };
    const unserved = compileWidgetAction(bindingDeps(), { definitionRef: REF, label: "Thêm", action });
    expect(unserved).toMatchObject({ ok: false });
    if (unserved.ok) throw new Error("unreachable");
    expect(unserved.message).toContain("not provided by an active package's service");

    served.set(ADD, { packageId: PACKAGE, generationId: GENERATION });
    const bound = compileWidgetAction(bindingDeps(), { definitionRef: REF, label: "Thêm", action });
    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error("unreachable");
    // Neither is the model's to say: the registry names the effect, the service host the generation.
    expect(bound.bindTo("winst_1")).toMatchObject({ effectCategory: "local-write", packageGeneration: GENERATION });
  });

  it("refuses a capability call a button could not complete: input from the press, or arguments the capability rejects", () => {
    register(ADD, "local-write");
    served.set(ADD, { packageId: PACKAGE, generationId: GENERATION });
    const fromPress = compileWidgetAction(bindingDeps(), {
      definitionRef: REF,
      label: "Thêm",
      action: { kind: "invoke", capabilityRef: ADD, args: {}, bindings: [{ target: "text", source: "user-input" }] },
    });
    expect(fromPress).toMatchObject({ ok: false });
    if (fromPress.ok) throw new Error("unreachable");
    expect(fromPress.message).toContain("a button carries no input");

    const wrongArgs = compileWidgetAction(bindingDeps(), {
      definitionRef: REF,
      label: "Thêm",
      action: { kind: "invoke", capabilityRef: ADD, args: { body: "mua sữa" } },
    });
    expect(wrongArgs).toMatchObject({ ok: false });
    if (wrongArgs.ok) throw new Error("unreachable");
    expect(wrongArgs.message).toContain("does not accept those arguments");

    const literal = compileWidgetAction(bindingDeps(), {
      definitionRef: REF,
      label: "Thêm",
      action: { kind: "invoke", capabilityRef: ADD, args: {}, bindings: [{ target: "text", source: "literal", value: "mua sữa" }] },
    });
    expect(literal.ok).toBe(true);
  });

  it("takes an agent request with no context, and refuses context references it cannot resolve yet", () => {
    expect(
      compileWidgetAction(bindingDeps(), { definitionRef: REF, label: "Tóm tắt", action: { kind: "agent", intent: "Tóm tắt" } }).ok,
    ).toBe(true);
    const withContext = compileWidgetAction(bindingDeps(), {
      definitionRef: REF,
      label: "Tóm tắt",
      action: { kind: "agent", intent: "Tóm tắt", contextRefs: ["msg_1"] },
    });
    expect(withContext).toMatchObject({ ok: false });
  });

  it("says what is wrong with a proposal that is not an action at all", () => {
    const refused = compileWidgetAction(bindingDeps(), { definitionRef: REF, label: "X", action: { kind: "launch" } });
    expect(refused).toMatchObject({ ok: false });
    if (refused.ok) throw new Error("unreachable");
    expect(refused.message).toContain("the action is not one a button can hold");
  });

  it("describes a workflow by the most severe thing any of its steps may do", () => {
    register(LIST, "read");
    register(ADD, "local-write");
    served.set(LIST, { packageId: PACKAGE, generationId: GENERATION });
    served.set(ADD, { packageId: PACKAGE, generationId: GENERATION });
    const compiled = compileWidgetAction(bindingDeps(), {
      definitionRef: REF,
      label: "Quy trình",
      action: {
        kind: "workflow",
        steps: [
          { stepId: "list", kind: "invoke", capabilityRef: LIST, args: {}, dependsOn: [] },
          { stepId: "add", kind: "invoke", capabilityRef: ADD, args: { text: "x" }, dependsOn: ["list"] },
        ],
      },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("unreachable");
    expect(compiled.bindTo("winst_1").effectCategory).toBe("local-write");
  });
});

describe("whether a bound button can run now", () => {
  it("answers from the service host and the registry at the moment it is asked", () => {
    register(LIST, "read");
    served.set(LIST, { packageId: PACKAGE, generationId: GENERATION });
    const compiled = compileWidgetAction(bindingDeps(), {
      definitionRef: REF,
      label: "Tải",
      action: { kind: "invoke", capabilityRef: LIST, args: {} },
    });
    if (!compiled.ok) throw new Error(compiled.message);
    const binding = compiled.bindTo("winst_1");
    expect(bindingAvailability(bindingDeps(), binding)).toEqual({ available: true });

    register(LIST, "read", false);
    expect(bindingAvailability(bindingDeps(), binding)).toMatchObject({ available: false, code: "CAPABILITY_NOT_READY" });

    served.delete(LIST);
    expect(bindingAvailability(bindingDeps(), binding)).toMatchObject({
      available: false,
      code: "NOT_A_SERVICE_CAPABILITY",
      capabilityRef: LIST,
    });
  });
});

describe("placing a button through the model's view", () => {
  it("stores what the button shows and keeps the action with the host", async () => {
    const instanceId = await place({ label: "Tóm tắt", icon: "send", action: { kind: "agent", intent: "Tóm tắt lại" } });
    const instance = getInstance(services.conductor, instanceId);
    expect(instance?.props).toEqual({ label: "Tóm tắt", icon: "send" });
    expect(instance?.actionBindingIds).toHaveLength(1);
    expect(getActionBinding(services.conductor, instance?.actionBindingIds[0] ?? "")?.proposal).toEqual({
      kind: "agent",
      intent: "Tóm tắt lại",
      contextRefs: [],
    });
  });

  it("refuses a proposal before anything is stored, so no button without an action is left behind", async () => {
    const before = instanceRows();
    await expect(place({ label: "Thêm", action: { kind: "invoke", capabilityRef: ADD, args: {} } })).rejects.toThrow(
      "not provided by an active package's service",
    );
    await expect(place({ label: "Không có gì" })).rejects.toThrow("needs props.action");
    expect(instanceRows()).toBe(before);
  });

  it("puts each button's availability in the timeline, with the node's reason for one that cannot run", async () => {
    register(LIST, "read");
    served.set(LIST, { packageId: PACKAGE, generationId: GENERATION });
    const agent = await place({ label: "Tóm tắt", action: { kind: "agent", intent: "Tóm tắt" } });
    const workflow = await place({
      label: "Quy trình",
      action: { kind: "workflow", steps: [{ stepId: "list", kind: "invoke", capabilityRef: LIST, args: {}, dependsOn: [] }] },
    });
    const invoke = await place({ label: "Tải", action: { kind: "invoke", capabilityRef: LIST, args: {} } });

    expect(timelineActions(agent)).toEqual([expect.objectContaining({ label: "Tóm tắt", available: true })]);
    expect(timelineActions(workflow)).toEqual([
      expect.objectContaining({ available: false, unavailableCode: "WORKFLOW_UNSUPPORTED" }),
    ]);
    expect(timelineActions(invoke)).toEqual([expect.objectContaining({ available: true, effectCategory: "read" })]);

    // The service stopping is a disabled button with that reason, not a live one that fails when pressed.
    served.delete(LIST);
    expect(timelineActions(invoke)).toEqual([
      expect.objectContaining({ available: false, unavailableCode: "NOT_A_SERVICE_CAPABILITY" }),
    ]);
  });
});

describe("pressing a bound button", () => {
  it("starts a turn whose message is exactly the button's label, with the offered intent as guidance", async () => {
    const instanceId = await place({ label: "Tóm tắt cuộc trò chuyện", action: { kind: "agent", intent: "Ba dòng thôi." } });
    const result = await press(instanceId, "inv_agent_1");
    expect(result).toMatchObject({ ok: true, status: 200 });
    if (!result.ok) throw new Error("unreachable");
    // The composer answers with a sentence and a block that repeat each other; both are the reply.
    expect(result.body).toMatchObject({ duplicate: false, output: expect.stringContaining("Đã làm: Tóm tắt cuộc trò chuyện") });

    expect(composed).toHaveLength(1);
    expect(composed[0]?.text).toBe("Tóm tắt cuộc trò chuyện");
    expect(composed[0]?.note).toContain("You offered it for: Ba dòng thôi.");
    const users = buildTimeline(services, { conversationId, afterSequence: 0 }).messages.filter(
      (message) => (message as { role?: unknown }).role === "user",
    );
    expect(JSON.stringify(users.at(-1))).toContain("Tóm tắt cuộc trò chuyện");
  });

  it("answers a repeated press with the same id from the record, without starting a second turn", async () => {
    const instanceId = await place({ label: "Tóm tắt", action: { kind: "agent", intent: "Tóm tắt" } });
    const first = await press(instanceId, "inv_agent_2");
    const again = await press(instanceId, "inv_agent_2");
    if (!first.ok || !again.ok) throw new Error("both presses should be answered");
    const output = (first.body as { output?: unknown }).output;
    expect(output).toEqual(expect.stringContaining("Đã làm: Tóm tắt"));
    expect(again.body).toMatchObject({ duplicate: true, output });
    expect(composed).toHaveLength(1);
  });

  it("refuses while Clark is still answering in the conversation, and starts nothing", async () => {
    const instanceId = await place({ label: "Tóm tắt", action: { kind: "agent", intent: "Tóm tắt" } });
    services.turnControl = { running: () => [conversationId] } as unknown as NonNullable<NodeServices["turnControl"]>;
    const refused = await press(instanceId, "inv_agent_3");
    expect(refused).toMatchObject({ ok: false, status: 409, code: "TURN_IN_PROGRESS" });
    expect(composed).toHaveLength(0);
  });

  it("refuses a workflow with the real reason, and a press naming a binding the button does not hold", async () => {
    register(LIST, "read");
    served.set(LIST, { packageId: PACKAGE, generationId: GENERATION });
    const workflow = await place({
      label: "Quy trình",
      action: { kind: "workflow", steps: [{ stepId: "list", kind: "invoke", capabilityRef: LIST, args: {}, dependsOn: [] }] },
    });
    expect(await press(workflow, "inv_wf_1")).toMatchObject({
      ok: false,
      status: 400,
      code: "UNSUPPORTED_ACTION",
      message: "this node cannot run a workflow action yet",
    });

    const agent = await place({ label: "Tóm tắt", action: { kind: "agent", intent: "Tóm tắt" } });
    const instance = getInstance(services.conductor, agent);
    const unknown = await invokeWidgetAction(
      services,
      {
        conversationId,
        principalId: services.runtime.identity.ownerPrincipalId,
        instanceId: agent,
        actionBindingId: "act_not_here",
        expectedRevision: instance?.revision ?? 0,
        expectedBindingDigest: "sha256:none",
        input: {},
        invocationId: "inv_unknown_1",
      },
      "click",
    );
    expect(unknown).toMatchObject({ ok: false });
    expect(composed).toHaveLength(0);
  });

  it("refuses a press carrying a digest other than the one the button was drawn with", async () => {
    const instanceId = await place({ label: "Tóm tắt", action: { kind: "agent", intent: "Tóm tắt" } });
    const instance = getInstance(services.conductor, instanceId);
    const stale = await invokeWidgetAction(
      services,
      {
        conversationId,
        principalId: services.runtime.identity.ownerPrincipalId,
        instanceId,
        actionBindingId: instance?.actionBindingIds[0] ?? "",
        expectedRevision: instance?.revision ?? 0,
        expectedBindingDigest: "sha256:an-older-button",
        input: {},
        invocationId: "inv_stale_1",
      },
      "click",
    );
    expect(stale).toMatchObject({ ok: false, code: "BINDING_STALE" });
    expect(composed).toHaveLength(0);
  });

  it("pins the button for a view binding", async () => {
    const instanceId = await place({ label: "Ghim", action: { kind: "view", operation: "view.save", args: {} } });
    const pinned = await press(instanceId, "inv_view_1");
    expect(pinned).toMatchObject({ ok: true });
    if (!pinned.ok) throw new Error("unreachable");
    expect(pinned.body).toMatchObject({ pinId: expect.any(String) });
    expect(buildTimeline(services, { conversationId, afterSequence: 0 }).pins.map((pin) => pin.instanceId)).toContain(instanceId);
  });
});
