import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Instant, type MessageBlock, TREE_ID, TREE_SELECT_OPERATION, TREE_TOGGLE_OPERATION, canonicalSemanticDoc } from "@clarkcant/contracts";
import { getActionBinding, getInstance, liveStateOf } from "@clarkcant/core";
import { TREE } from "@clarkcant/data-canvas";
import { appendMessage } from "@clarkcant/storage";

import { invokeWidgetAction } from "../src/application/widget-actions.ts";
import { bootNodeServices, buildTimeline, type NodeServices } from "../src/services.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";
import { buildWidgetSemantic } from "../src/widget-semantic.ts";

const AT = "2026-09-30T05:00:00.000Z" as Instant;
const CONVERSATION = "conv_tree_view";
const PROPS = {
  title: "Dự án",
  initiallyExpanded: ["project", "client"],
  nodes: [
    {
      id: "project",
      label: "ClarkCant",
      icon: "project",
      children: [
        {
          id: "client",
          label: "Ứng dụng",
          icon: "folder",
          children: [
            { id: "composer", label: "Trình soạn thảo", secondary: "Đang hoạt động", icon: "document" },
            { id: "library", label: "Thư viện widget", icon: "folder" },
          ],
        },
        { id: "runtime", label: "Runtime", icon: "branch", children: [{ id: "worker", label: "Worker", icon: "task" }] },
      ],
    },
    { id: "people", label: "Cộng tác viên", icon: "group", children: [{ id: "owner", label: "Chủ dự án", icon: "person" }] },
  ],
};

let dir: string;
let services: NodeServices;
let counter = 0;

function owner(): string {
  return services.runtime.identity.ownerPrincipalId;
}

async function place(props: Record<string, unknown>): Promise<string> {
  const view = buildViewCatalog(services.conductor).find((entry) => entry.id === TREE_ID);
  if (view === undefined) throw new Error("the tree is not in the catalog");
  const messageId = `msg_${String(++counter)}`;
  const block = (await view.build({
    props,
    caption: "Here is the hierarchy",
    at: AT,
    principal: { principalId: owner(), kind: "user", nodeId: services.runtime.identity.nodeId } as never,
    messageId,
    conversationId: CONVERSATION,
  })) as Extract<MessageBlock, { type: "surface" }>;
  appendMessage(
    services.runtime.db,
    { messageId, conversationId: CONVERSATION, role: "assistant", authorNodeId: services.runtime.identity.nodeId, delivery: "accepted", createdAt: AT, blocks: [block] } as never,
    counter,
  );
  return block.snapshot.instanceId ?? "";
}

async function act(instanceId: string, operation: string, input: Record<string, unknown>) {
  const instance = getInstance(services.conductor, instanceId);
  const binding = instance?.actionBindingIds
    .map((id) => getActionBinding(services.conductor, id))
    .find((entry) => entry?.proposal.kind === "view" && entry.proposal.operation === operation);
  return invokeWidgetAction(
    services,
    {
      conversationId: CONVERSATION,
      principalId: owner() as never,
      instanceId,
      actionBindingId: binding?.actionBindingId ?? "",
      expectedRevision: instance?.revision ?? 0,
      expectedBindingDigest: binding?.bindingDigest ?? "",
      input,
      invocationId: `inv_${String(++counter)}`,
    },
    "click",
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-tree-view-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)")
    .run(CONVERSATION, services.runtime.identity.nodeId, AT, AT);
});

afterEach(() => {
  services.runtime.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("placing a hierarchy", () => {
  it("binds host-checked selection and expansion operations and preserves the text alternative", async () => {
    const instanceId = await place(PROPS);
    const instance = getInstance(services.conductor, instanceId);
    expect(instance?.actionBindingIds).toHaveLength(2);
    const operations = instance?.actionBindingIds.map((id) => getActionBinding(services.conductor, id)?.proposal);
    expect(operations).toEqual([
      { kind: "view", operation: TREE_SELECT_OPERATION, args: {} },
      { kind: "view", operation: TREE_TOGGLE_OPERATION, args: {} },
    ]);
    const timeline = buildTimeline(services, { conversationId: CONVERSATION, afterSequence: 0 });
    expect(timeline.snapshots[0]?.textAlternative).toContain("- ClarkCant");
    expect(timeline.snapshots[0]?.textAlternative).toContain("  - Ứng dụng");
    expect(timeline.snapshots[0]?.textAlternative.length).toBeLessThanOrEqual(4_096);
  });

  it("refuses malformed graphs before creating an instance", async () => {
    const before = services.runtime.db.prepare("SELECT COUNT(*) AS n FROM widget_instances").get() as { n: number };
    await expect(place({ nodes: [{ id: "same", label: "A" }, { id: "same", label: "B" }] })).rejects.toThrow("node ids repeat");
    const after = services.runtime.db.prepare("SELECT COUNT(*) AS n FROM widget_instances").get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});

describe("selection and expansion state", () => {
  it("selects a node, collapses a branch, survives a reload and reports bounded meaning", async () => {
    const instanceId = await place(PROPS);
    const selected = await act(instanceId, TREE_SELECT_OPERATION, { selectedId: "composer" });
    expect(selected).toMatchObject({ ok: true, body: { state: { selectedId: "composer" } } });
    const collapsed = await act(instanceId, TREE_TOGGLE_OPERATION, { nodeId: "client", expanded: false });
    expect(collapsed).toMatchObject({ ok: true, body: { state: { expandedIds: ["project"], selectedId: "composer" } } });
    expect(liveStateOf(services.conductor, instanceId)?.body).toEqual({ expandedIds: ["project"], selectedId: "composer" });
    const carried = buildTimeline(services, { conversationId: CONVERSATION, afterSequence: 0 }).instances.find((entry) => entry.instanceId === instanceId);
    expect(carried?.state).toEqual({ expandedIds: ["project"], selectedId: "composer" });
    expect(buildWidgetSemantic(services.conductor, instanceId)).toMatchObject({
      definitionId: TREE.id,
      summary: "Hierarchy: 8 nodes across 3 levels; 1 expanded; selected ClarkCant / Ứng dụng / Trình soạn thảo",
      selectedIds: ["composer"],
      values: { nodeCount: 8, depth: 3, expandedNodes: 1, selectedLabel: "Trình soạn thảo" },
    });
    const document = buildWidgetSemantic(services.conductor, instanceId);
    if (document === undefined) throw new Error("no semantic document");
    expect(canonicalSemanticDoc(document).length).toBeLessThanOrEqual(8_192);
  });

  it("rejects unknown selections and non-branch toggles without changing saved state", async () => {
    const instanceId = await place(PROPS);
    expect((await act(instanceId, TREE_SELECT_OPERATION, { selectedId: "composer" })).ok).toBe(true);
    const revision = getInstance(services.conductor, instanceId)?.revision;
    const invalidSelection = await act(instanceId, TREE_SELECT_OPERATION, { selectedId: "missing" });
    expect(invalidSelection).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    const invalidToggle = await act(instanceId, TREE_TOGGLE_OPERATION, { nodeId: "composer", expanded: true });
    expect(invalidToggle).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(getInstance(services.conductor, instanceId)?.revision).toBe(revision);
    expect(liveStateOf(services.conductor, instanceId)?.body).toEqual({ selectedId: "composer" });
  });
});
