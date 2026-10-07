import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CapabilityRef, type Instant, type MessageBlock, BOARD_APPROVAL_OPERATION, BOARD_ID, BOARD_MOVE_OPERATION, BOARD_RESOLVE_OPERATION, canonicalSemanticDoc } from "@clarkcant/contracts";
import { getActionBinding, getInstance, liveStateOf, registerCapability } from "@clarkcant/core";
import { BOARD } from "@clarkcant/data-canvas";
import { appendMessage } from "@clarkcant/storage";

import { invokeWidgetAction } from "../src/application/widget-actions.ts";
import { bootNodeServices, buildTimeline, type NodeServices } from "../src/services.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";
import { buildWidgetSemantic } from "../src/widget-semantic.ts";
import { type ActionBindingDeps } from "../src/application/action-bindings.ts";
import { type ServiceCallOptions, type ServiceHost } from "../src/service-host.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

const AT = "2026-10-01T05:00:00.000Z" as Instant;
const CONVERSATION = "conv_board_view";
const PROPS = {
  title: "Delivery",
  columns: [{ id: "todo", title: "To do" }, { id: "doing", title: "Doing", limit: 2 }],
  cards: [{ id: "a", columnId: "todo", title: "Build" }, { id: "b", columnId: "todo", title: "Review", assignee: "Lee" }],
};
const MOVE_CAPABILITY = "com.example.board.move@1" as CapabilityRef;
const PACKAGE = "com.example.board";
const GENERATION = "com.example.board@1.0.0:code_1";
let calls: Record<string, unknown>[];

function bindingDeps(): ActionBindingDeps {
  return { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, serviceHost: services.serviceHost, now: () => AT, newId: (prefix) => `${prefix}_${String(++counter)}` };
}

let dir: string;
let services: NodeServices;
let counter = 0;
function owner(): string { return services.runtime.identity.ownerPrincipalId; }

async function place(props: Record<string, unknown> = PROPS): Promise<string> {
  const view = buildViewCatalog(services.conductor, undefined, bindingDeps).find((entry) => entry.id === BOARD_ID);
  if (view === undefined) throw new Error("the board is not in the catalog");
  const messageId = `msg_${String(++counter)}`;
  const block = (await view.build({ props, caption: "Delivery board", at: AT, principal: { principalId: owner(), kind: "user", nodeId: services.runtime.identity.nodeId } as never, messageId, conversationId: CONVERSATION })) as Extract<MessageBlock, { type: "surface" }>;
  appendMessage(services.runtime.db, { messageId, conversationId: CONVERSATION, role: "assistant", authorNodeId: services.runtime.identity.nodeId, delivery: "accepted", createdAt: AT, blocks: [block] } as never, counter);
  return block.snapshot.instanceId ?? "";
}

async function act(instanceId: string, operation: string, input: Record<string, unknown>) {
  const instance = getInstance(services.conductor, instanceId);
  const binding = instance?.actionBindingIds.map((id) => getActionBinding(services.conductor, id)).find((entry) => entry?.proposal.kind === "view" && entry.proposal.operation === operation);
  return invokeWidgetAction(services, { conversationId: CONVERSATION, principalId: owner() as never, instanceId, actionBindingId: binding?.actionBindingId ?? "", expectedRevision: instance?.revision ?? 0, expectedBindingDigest: binding?.bindingDigest ?? "", input, invocationId: `inv_${String(++counter)}` }, "click");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-board-view-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  calls = [];
  services.serviceHost = {
    serves: (ref: CapabilityRef) => ref === MOVE_CAPABILITY ? { packageId: PACKAGE, generationId: GENERATION } : undefined,
    call: async (_ref: CapabilityRef, args: Record<string, unknown>, _options?: ServiceCallOptions) => { calls.push(args); return { content: "moved" }; },
  } as unknown as ServiceHost;
  services.runtime.db.prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)").run(CONVERSATION, services.runtime.identity.nodeId, AT, AT);
});
afterEach(async () => { services.runtime.db.close(); await removeTestDirectory(dir); });

describe("placing a kanban board", () => {
  it("binds host-checked state operations and preserves a bounded text alternative", async () => {
    const instanceId = await place();
    const instance = getInstance(services.conductor, instanceId);
    expect(instance?.actionBindingIds).toHaveLength(4);
    expect(instance?.actionBindingIds.map((id) => getActionBinding(services.conductor, id)?.proposal)).toContainEqual({ kind: "view", operation: BOARD_MOVE_OPERATION, args: {} });
    const timeline = buildTimeline(services, { conversationId: CONVERSATION });
    expect(timeline.snapshots[0]?.textAlternative).toContain("To do:");
    expect(timeline.snapshots[0]?.textAlternative).toContain("- Build");
  });

  it("persists a local reorder, rejects stale move inputs, settles refusal and reports bounded meaning", async () => {
    const instanceId = await place();
    const moved = await act(instanceId, BOARD_MOVE_OPERATION, { cardId: "a", fromColumnId: "todo", toColumnId: "doing", position: 0, external: false });
    expect(moved).toMatchObject({ ok: true, body: { state: { order: { todo: ["b"], doing: ["a"] } } } });
    expect(liveStateOf(services.conductor, instanceId)?.body).toMatchObject({ order: { todo: ["b"], doing: ["a"] } });
    const revision = getInstance(services.conductor, instanceId)?.revision;
    const invalid = await act(instanceId, BOARD_MOVE_OPERATION, { cardId: "a", fromColumnId: "todo", toColumnId: "missing", position: 0, external: false });
    expect(invalid).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(getInstance(services.conductor, instanceId)?.revision).toBe(revision);
    const unboundMove = await act(instanceId, BOARD_MOVE_OPERATION, { cardId: "b", fromColumnId: "todo", toColumnId: "doing", position: 1, external: true });
    expect(unboundMove).toMatchObject({ ok: true, body: { state: { order: { todo: [], doing: ["a", "b"] } } } });
    expect(liveStateOf(services.conductor, instanceId)?.body).not.toHaveProperty("pendingMove");
    expect(buildWidgetSemantic(services.conductor, instanceId)).toMatchObject({ definitionId: BOARD.id, values: { columnCount: 2, cardCount: 2 } });
    const document = buildWidgetSemantic(services.conductor, instanceId);
    if (document === undefined) throw new Error("no semantic document");
    expect(canonicalSemanticDoc(document).length).toBeLessThanOrEqual(8_192);
  });

  it("keeps external moves pending until the bound invoke answers, then confirms or rolls back honestly", async () => {
    registerCapability({ db: services.runtime.db, nodeId: services.runtime.identity.nodeId }, {
      ref: MOVE_CAPABILITY,
      providedBy: { packageId: PACKAGE, version: "1.0.0", digest: "sha256:board", generation: GENERATION },
      executionNodeId: services.runtime.identity.nodeId,
      summary: "Move a board card",
      resourceKinds: [],
      effectCategory: "read",
      supportsCancellation: false,
      requiresConnection: false,
      readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
      uiAffordances: [],
      inputSchema: { type: "object", properties: { cardId: { type: "string" }, fromColumnId: { type: "string" }, toColumnId: { type: "string" }, position: { type: "integer" } }, required: ["cardId", "fromColumnId", "toColumnId", "position"], additionalProperties: false },
    });
    const instanceId = await place({ ...PROPS, action: {
      kind: "invoke", capabilityRef: MOVE_CAPABILITY, args: {},
      bindings: ["cardId", "fromColumnId", "toColumnId", "position"].map((target) => ({ target, source: "selected-event" })),
    } });
    const moved = await act(instanceId, BOARD_MOVE_OPERATION, { cardId: "a", fromColumnId: "todo", toColumnId: "doing", position: 0, external: false });
    expect(moved).toMatchObject({ ok: true, body: { state: { pendingMove: { cardId: "a", fromColumnId: "todo", toColumnId: "doing" } } } });
    const awaiting = await act(instanceId, BOARD_APPROVAL_OPERATION, { approvalId: "approval_board_1" });
    expect(awaiting).toMatchObject({ ok: true, body: { state: { pendingMove: { approvalId: "approval_board_1" } } } });
    const mismatched = await act(instanceId, BOARD_RESOLVE_OPERATION, { approvalId: "approval_other", outcome: "done" });
    expect(mismatched).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    const instance = getInstance(services.conductor, instanceId);
    const binding = instance?.actionBindingIds.map((id) => getActionBinding(services.conductor, id)).find((entry) => entry?.proposal.kind === "invoke");
    if (instance === undefined || binding === undefined) throw new Error("external action binding was not stored");
    const result = await invokeWidgetAction(services, {
      conversationId: CONVERSATION, principalId: owner() as never, instanceId, actionBindingId: binding.actionBindingId,
      expectedRevision: instance.revision, expectedBindingDigest: binding.bindingDigest,
      input: { cardId: "a", fromColumnId: "todo", toColumnId: "doing", position: 0 }, invocationId: `invoke_${String(++counter)}`,
    }, "click");
    expect(result).toMatchObject({ ok: true, body: { outcome: "done" } });
    expect(calls).toEqual([{ cardId: "a", fromColumnId: "todo", toColumnId: "doing", position: 0 }]);
    const confirmed = await act(instanceId, BOARD_RESOLVE_OPERATION, { approvalId: "approval_board_1", outcome: "done" });
    expect(confirmed).toMatchObject({ ok: true, body: { state: { order: { todo: ["b"], doing: ["a"] } } } });
    if (!confirmed.ok) throw new Error(confirmed.message);
    expect(confirmed.body.state).not.toHaveProperty("pendingMove");

    const next = await act(instanceId, BOARD_MOVE_OPERATION, { cardId: "b", fromColumnId: "todo", toColumnId: "doing", position: 1, external: false });
    expect(next).toMatchObject({ ok: true, body: { state: { pendingMove: { cardId: "b" } } } });
    const refused = await act(instanceId, BOARD_RESOLVE_OPERATION, { outcome: "refused" });
    expect(refused).toMatchObject({ ok: true, body: { state: { order: { todo: ["b"], doing: ["a"] } } } });
    if (!refused.ok) throw new Error(refused.message);
    expect(refused.body.state).not.toHaveProperty("pendingMove");
  });
});
