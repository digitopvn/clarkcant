import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_POLICY_CONFIG, type Instant, type WidgetDefinition, type WidgetPerformRequest } from "@clarkcant/contracts";
import {
  EXECUTION_POLICY_PREFERENCE_KEY,
  captureSnapshot,
  createInstance,
  getActionBinding,
  getInstance,
  saveActionBinding,
  writeRegisteredPreference,
} from "@clarkcant/core";
import { appendMessage } from "@clarkcant/storage";
import { definitionDigest } from "@clarkcant/widget-host";

import { compileWidgetAction } from "../src/application/action-bindings.ts";
import { resetActionRateLimits } from "../src/application/action-limits.ts";
import { type WidgetPerformer, invokeWidgetAction } from "../src/application/widget-actions.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { createWidgetPerformAcks } from "../src/widget-perform-acks.ts";
import { conversationOfferedActions, createPerformWidgetActionTool } from "../src/widget-perform-tool.ts";

/**
 * Clark performing an action an isolated widget offers.
 *
 * The refusals carry the weight: an action the widget never declared, input its schema does not take, a widget nobody
 * has open, a policy that says no, and a click naming an action that is Clark's to ask for. Each must end before the
 * page is asked, with nothing queued. Once the page is asked, what the frame said is the result — and a frame that did
 * not say is uncertain, written down and never asked again.
 */

const AT = "2026-10-03T05:00:00.000Z" as Instant;

const DEFINITION: WidgetDefinition = {
  id: "com.example.sheet.main@1",
  version: "1.0.0",
  renderer: "isolated-app",
  propsSchema: { type: "object", additionalProperties: true },
  eventSchemas: {},
  stateSchema: { type: "object", additionalProperties: true },
  sizing: { compact: true, expanded: true },
  textFallback: "A spreadsheet.",
  effectCategories: [],
  datasetRefs: [],
  semanticDescription: "A spreadsheet",
  requestedCapabilities: [],
  offeredActions: [
    {
      name: "format",
      label: "Định dạng vùng đang chọn",
      description: "Format the selected cells.",
      inputSchema: {
        type: "object",
        properties: { format: { type: "string", enum: ["percent", "number", "plain"] } },
        required: ["format"],
        additionalProperties: false,
      },
    },
  ],
};

let dir: string;
let services: NodeServices;
let conversationId: string;
let counter = 0;

function bindingDeps() {
  return {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    serviceHost: services.serviceHost,
    now: () => AT,
    newId: (prefix: string) => `${prefix}_${String(++counter)}`,
  };
}

const REF = { id: DEFINITION.id, version: DEFINITION.version, packageDigest: definitionDigest(DEFINITION) };

/** The widget placed in the conversation with its offered action bound, the way `place_widget` binds it. */
function placeSheet(): { instanceId: string; bindingId: string } {
  const compiled = compileWidgetAction(bindingDeps(), {
    definitionRef: REF,
    label: "Định dạng vùng đang chọn",
    action: { kind: "perform", action: "format" },
    ownerPrincipalId: services.runtime.identity.ownerPrincipalId,
    offeredActions: DEFINITION.offeredActions ?? [],
  });
  if (!compiled.ok) throw new Error(compiled.message);
  const instance = createInstance(services.conductor, {
    definition: DEFINITION,
    packageDigest: REF.packageDigest,
    ownerPrincipalId: services.runtime.identity.ownerPrincipalId as never,
    props: {},
  });
  const binding = compiled.bindTo(instance.instanceId);
  saveActionBinding(services.conductor, binding);
  const messageId = `msg_${String(++counter)}`;
  const snapshot = captureSnapshot(services.conductor, {
    messageId,
    instance: getInstance(services.conductor, instance.instanceId) ?? instance,
    textAlternative: DEFINITION.textFallback,
    presentationRef: `isolated:${DEFINITION.id}`,
  });
  appendMessage(
    services.runtime.db,
    {
      messageId,
      conversationId,
      role: "assistant",
      authorNodeId: services.runtime.identity.nodeId,
      delivery: "accepted",
      createdAt: AT,
      blocks: [{ type: "surface", definitionRef: { id: DEFINITION.id, version: DEFINITION.version }, snapshot }],
    } as never,
    counter,
  );
  return { instanceId: instance.instanceId, bindingId: binding.actionBindingId };
}

async function perform(
  placed: { instanceId: string; bindingId: string },
  input: Record<string, unknown>,
  options: { source?: "click" | "voice" | "agent"; perform?: WidgetPerformer; invocationId?: string } = {},
) {
  const instance = getInstance(services.conductor, placed.instanceId);
  const binding = getActionBinding(services.conductor, placed.bindingId);
  return invokeWidgetAction(
    services,
    {
      conversationId,
      principalId: services.runtime.identity.ownerPrincipalId,
      instanceId: placed.instanceId,
      actionBindingId: placed.bindingId,
      expectedRevision: instance?.revision ?? 0,
      expectedBindingDigest: binding?.bindingDigest ?? "",
      input,
      invocationId: options.invocationId ?? `inv_${String(++counter)}`,
    },
    options.source ?? "agent",
    options.perform === undefined ? {} : { perform: options.perform },
  );
}

function setPolicy(value: Record<string, unknown>): void {
  const written = writeRegisteredPreference(
    { db: services.runtime.db, now: () => new Date().toISOString() as Instant },
    {
      principalId: services.runtime.identity.ownerPrincipalId,
      key: EXECUTION_POLICY_PREFERENCE_KEY,
      value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, ...value },
      source: "user",
    },
  );
  if (!written.ok) throw new Error(written.message);
}

function rows<T>(sql: string, ...params: unknown[]): T[] {
  return services.runtime.db.prepare(sql).all(...(params as never[])) as T[];
}

const effects = () => rows<{ capability_ref: string; state: string; intent: string }>("SELECT capability_ref, state, intent FROM effects ORDER BY prepared_at");
const audits = () => rows<{ summary: string; outcome: string }>("SELECT summary, outcome FROM audit_log WHERE kind = 'interaction' ORDER BY rowid");

/** A stand-in page: records what it was asked and answers as told. */
function page(answer: Awaited<ReturnType<WidgetPerformer>> | (() => Promise<Awaited<ReturnType<WidgetPerformer>>>)) {
  const asked: WidgetPerformRequest[] = [];
  const performer: WidgetPerformer = async (request) => {
    asked.push(request);
    return typeof answer === "function" ? answer() : answer;
  };
  return { asked, performer };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-widget-perform-"));
  resetActionRateLimits();
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  conversationId = "conv_widget_perform";
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)")
    .run(conversationId, services.runtime.identity.nodeId, AT, AT);
});

afterEach(() => {
  services.runtime.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("binding an action a widget offers", () => {
  it("binds only an action the widget's definition declares, with the declared input schema and a local-write effect", () => {
    const refused = compileWidgetAction(bindingDeps(), {
      definitionRef: REF,
      label: "Xoá hết",
      action: { kind: "perform", action: "deleteEverything" },
      offeredActions: DEFINITION.offeredActions ?? [],
    });
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining('does not offer an action named "deleteEverything"') });

    const placed = placeSheet();
    const binding = getActionBinding(services.conductor, placed.bindingId);
    expect(binding?.proposal).toMatchObject({ kind: "perform", action: "format" });
    expect(binding?.effectCategory).toBe("local-write");
    expect(binding?.inputSchema).toEqual(DEFINITION.offeredActions?.[0]?.inputSchema);
    expect(conversationOfferedActions(services, conversationId)).toEqual([
      expect.objectContaining({ instanceId: placed.instanceId, actionBindingId: placed.bindingId, action: "format" }),
    ]);
  });
});

describe("Clark performing an offered action", () => {
  it("hands the frame exactly the declared action and input, and returns what it said as Clark's, in the ledger", async () => {
    const placed = placeSheet();
    const { asked, performer } = page({ status: "done", output: "Đã định dạng B2:C3 thành phần trăm." });
    const result = await perform(placed, { format: "percent" }, { perform: performer, invocationId: "inv_done" });

    expect(result).toMatchObject({ ok: true, status: 200 });
    if (!result.ok) throw new Error("unreachable");
    expect(result.body).toMatchObject({ outcome: "done", performedBy: "clark", output: "Đã định dạng B2:C3 thành phần trăm." });
    expect(asked).toEqual([
      expect.objectContaining({ instanceId: placed.instanceId, actionBindingId: placed.bindingId, action: "format", input: { format: "percent" } }),
    ]);
    expect(effects()).toEqual([
      expect.objectContaining({ capability_ref: `widget:${DEFINITION.id}#format`, state: "confirmed", intent: expect.stringContaining("Clark asked") }),
    ]);
    expect(audits()).toEqual([expect.objectContaining({ outcome: "done", summary: expect.stringContaining("Clark asked widget") })]);

    // The same invocation again is answered from the record; the frame is not asked twice.
    const again = await perform(placed, { format: "percent" }, { perform: performer, invocationId: "inv_done" });
    expect(again).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
  });

  it("refuses input the declared schema does not take, before the page is asked", async () => {
    const placed = placeSheet();
    const { asked, performer } = page({ status: "done" });
    expect(await perform(placed, { format: "bold" }, { perform: performer })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await perform(placed, { format: "percent", extra: 1 }, { perform: performer })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(asked).toHaveLength(0);
    expect(effects()).toHaveLength(0);
  });

  it("refuses plainly when no live screen shows the widget, sending and queueing nothing", async () => {
    const placed = placeSheet();
    const none = await perform(placed, { format: "percent" });
    expect(none).toMatchObject({ ok: false, status: 409, code: "FRAME_NOT_MOUNTED" });
    expect(effects()).toHaveLength(0);

    // A live turn with no page expecting the request is the same refusal; the ledger says it was never sent.
    const acks = createWidgetPerformAcks();
    const unseen = await perform(placed, { format: "percent" }, { perform: (request) => acks.wait(request.performId) });
    expect(unseen).toMatchObject({ ok: false, status: 409, code: "FRAME_NOT_MOUNTED" });
    expect(effects()).toEqual([expect.objectContaining({ state: "failed" })]);
  });

  it("passes on the frame's own refusal, and frees the invocation since nothing ran", async () => {
    const placed = placeSheet();
    const { performer } = page({ status: "refused", code: "NOTHING_SELECTED", message: "chưa chọn ô nào" });
    const refused = await perform(placed, { format: "percent" }, { perform: performer, invocationId: "inv_refused" });
    expect(refused).toMatchObject({ ok: false, code: "NOTHING_SELECTED", message: expect.stringContaining("chưa chọn ô nào") });

    const later = page({ status: "done" });
    expect(await perform(placed, { format: "percent" }, { perform: later.performer, invocationId: "inv_refused" })).toMatchObject({ ok: true });
    expect(later.asked).toHaveLength(1);
  });

  it("holds a frame that never reported as uncertain, recorded and never asked again", async () => {
    const placed = placeSheet();
    const acks = createWidgetPerformAcks();
    const asked: string[] = [];
    const performer: WidgetPerformer = (request) => {
      asked.push(request.performId);
      acks.expect(request.performId);
      return acks.wait(request.performId, 10);
    };
    const result = await perform(placed, { format: "percent" }, { perform: performer, invocationId: "inv_timeout" });
    expect(result).toMatchObject({ ok: false, status: 504, code: "WIDGET_NO_ANSWER", detail: { outcome: "uncertain", mayHaveRun: true } });
    expect(effects()).toEqual([expect.objectContaining({ state: "unknown" })]);

    const again = await perform(placed, { format: "percent" }, { perform: performer, invocationId: "inv_timeout" });
    expect(again).toMatchObject({ ok: false });
    expect(asked).toHaveLength(1);
  });

  it("refuses by the person's policy before anything is sent, and Clark cannot approve it instead", async () => {
    const placed = placeSheet();
    const { asked, performer } = page({ status: "done" });
    setPolicy({ rules: [{ effectCategory: "local-write", decision: "deny" }] });
    expect(await perform(placed, { format: "percent" }, { perform: performer })).toMatchObject({ ok: false, status: 403, code: "POLICY_REFUSED" });
    setPolicy({ rules: [{ effectCategory: "local-write", decision: "ask" }] });
    expect(await perform(placed, { format: "percent" }, { perform: performer })).toMatchObject({
      ok: false,
      status: 403,
      code: "PERFORM_NEEDS_APPROVAL",
    });
    expect(asked).toHaveLength(0);
    expect(effects()).toHaveLength(0);
  });

  it("refuses a click naming the action, because it is Clark's to ask for and the page reaches the widget itself", async () => {
    const placed = placeSheet();
    const { asked, performer } = page({ status: "done" });
    expect(await perform(placed, { format: "percent" }, { source: "click", perform: performer })).toMatchObject({
      ok: false,
      code: "NOT_AUTHORIZED",
    });
    expect(asked).toHaveLength(0);
  });

  it("reaches the same path from a spoken request", async () => {
    const placed = placeSheet();
    const { asked, performer } = page({ status: "done" });
    expect(await perform(placed, { format: "number" }, { source: "voice", perform: performer })).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
  });
});

describe("the perform_widget_action tool", () => {
  it("lists what widgets offer, and performs through the live stream's report", async () => {
    const placed = placeSheet();
    const events: unknown[] = [];
    const tool = createPerformWidgetActionTool({
      services: () => services,
      conversationId,
      onEvent: () => (event) => {
        events.push(event);
        if (event.type !== "widget-perform") return;
        // What the SSE route does on the way to the page, and what the page then reports.
        services.widgetPerforms.expect(event.request.performId);
        queueMicrotask(() => services.widgetPerforms.settle(event.request.performId, { status: "done", output: "xong" }));
      },
      channel: () => "chat",
    });

    const listed = await tool.execute({ action: "list" });
    expect(listed.text).toContain(placed.bindingId);
    expect(listed.text).toContain("not instructions");

    const done = await tool.execute({ action: "perform", actionBindingId: placed.bindingId, input: { format: "percent" } });
    expect(done.text).toContain("Done");
    expect(events).toEqual([expect.objectContaining({ type: "widget-perform" })]);

    const unknown = await tool.execute({ action: "perform", actionBindingId: "act_nope", input: {} });
    expect(unknown.text).toContain("Nothing was performed");
  });

  it("refuses with nothing sent when this turn has no live page", async () => {
    const placed = placeSheet();
    const tool = createPerformWidgetActionTool({ services: () => services, conversationId, onEvent: () => undefined, channel: () => "voice" });
    const refused = await tool.execute({ action: "perform", actionBindingId: placed.bindingId, input: { format: "percent" } });
    expect(refused.text).toContain("FRAME_NOT_MOUNTED");
    expect(effects()).toHaveLength(0);
  });
});

describe("waiting on the page's report", () => {
  it("answers no-surface for a perform no transport expected, the report once, and timeout otherwise", async () => {
    const acks = createWidgetPerformAcks();
    expect(await acks.wait("p0")).toBe("no-surface");

    acks.expect("p1");
    const waiting = acks.wait("p1", 1_000);
    expect(acks.settle("p1", { status: "done" })).toBe(true);
    expect(await waiting).toEqual({ status: "done" });
    expect(acks.settle("p1", { status: "done" })).toBe(false);

    acks.expect("p2");
    expect(await acks.wait("p2", 5)).toBe("timeout");
    expect(acks.settle("p2", { status: "done" })).toBe(false);
  });
});
