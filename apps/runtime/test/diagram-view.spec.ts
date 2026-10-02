import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DIAGRAM_ID, DIAGRAM_SELECT_OPERATION, type Instant, type MessageBlock, canonicalSemanticDoc } from "@clarkcant/contracts";
import { getActionBinding, getInstance, liveStateOf } from "@clarkcant/core";
import { appendMessage } from "@clarkcant/storage";

import { invokeWidgetAction } from "../src/application/widget-actions.ts";
import { bootNodeServices, buildTimeline, type NodeServices } from "../src/services.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";
import { buildWidgetSemantic } from "../src/widget-semantic.ts";

const AT = "2026-10-02T05:00:00.000Z" as Instant;
const CONVERSATION = "conv_diagram_view";
const PROPS = {
  title: "Phát hành",
  nodes: [
    { id: "plan", label: "Lên kế hoạch", shape: "round" },
    { id: "build", label: "Xây dựng", group: "CI" },
    { id: "test", label: "Kiểm thử đạt?", shape: "diamond", group: "CI" },
    { id: "ship", label: "Phát hành", shape: "circle" },
  ],
  edges: [
    { from: "plan", to: "build" },
    { from: "build", to: "test" },
    { from: "test", to: "ship", label: "đạt" },
    { from: "test", to: "build", label: "chưa" },
  ],
};

let dir: string;
let services: NodeServices;
let counter = 0;

function owner(): string {
  return services.runtime.identity.ownerPrincipalId;
}

function instanceCount(): number {
  return (services.runtime.db.prepare("SELECT COUNT(*) AS n FROM widget_instances").get() as { n: number }).n;
}

async function place(props: Record<string, unknown>): Promise<string> {
  const view = buildViewCatalog(services.conductor).find((entry) => entry.id === DIAGRAM_ID);
  if (view === undefined) throw new Error("the diagram is not in the catalog");
  const messageId = `msg_${String(++counter)}`;
  const block = (await view.build({
    props,
    caption: "Here is the diagram",
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

async function select(instanceId: string, input: Record<string, unknown>) {
  const instance = getInstance(services.conductor, instanceId);
  const binding = instance?.actionBindingIds
    .map((id) => getActionBinding(services.conductor, id))
    .find((entry) => entry?.proposal.kind === "view" && entry.proposal.operation === DIAGRAM_SELECT_OPERATION);
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
  dir = mkdtempSync(join(tmpdir(), "clarkcant-diagram-view-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)")
    .run(CONVERSATION, services.runtime.identity.nodeId, AT, AT);
});

afterEach(() => {
  services.runtime.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("placing a diagram", () => {
  it("binds one host-checked selection and keeps an adjacency list as the text alternative", async () => {
    const instanceId = await place(PROPS);
    const instance = getInstance(services.conductor, instanceId);
    expect(instance?.actionBindingIds.map((id) => getActionBinding(services.conductor, id)?.proposal)).toEqual([
      { kind: "view", operation: DIAGRAM_SELECT_OPERATION, args: {} },
    ]);
    const text = buildTimeline(services, { conversationId: CONVERSATION, afterSequence: 0 }).snapshots[0]?.textAlternative ?? "";
    expect(text).toContain("Phát hành: 4 nodes, 4 edges");
    expect(text).toContain("- Kiểm thử đạt? [CI]: → Phát hành (đạt), → Xây dựng (chưa)");
  });

  it("reads a Mermaid flowchart into the model and stores the model, never the source", async () => {
    const instanceId = await place({ mermaid: "flowchart LR\n  a(Bản nháp) --> b{Duyệt?}\n  b -->|đồng ý| c((Đăng))", title: "Duyệt" });
    expect(getInstance(services.conductor, instanceId)?.props).toEqual({
      title: "Duyệt",
      direction: "LR",
      nodes: [
        { id: "a", label: "Bản nháp", shape: "round" },
        { id: "b", label: "Duyệt?", shape: "diamond" },
        { id: "c", label: "Đăng", shape: "circle" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c", label: "đồng ý" },
      ],
    });
  });

  it.each([
    ["an unknown shape", { nodes: [{ id: "a", label: "A", shape: "star" }] }, /"nodes\.0\.shape"/u],
    ["an edge to a missing node", { nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "b" }] }, /edge 1 names "b", which is not a node/u],
    ["repeated ids", { nodes: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }, /node ids repeat: a/u],
    ["an oversized graph", { nodes: Array.from({ length: 61 }, (_, index) => ({ id: `n${String(index)}`, label: "N" })) }, /61 nodes; at most 60/u],
    ["a hidden character", { nodes: [{ id: "a", label: "A​B" }] }, /U\+200B/u],
    ["a Mermaid click", { mermaid: "flowchart TB\na --> b\nclick a href" }, /"click" is not read/u],
    ["a Mermaid HTML label", { mermaid: 'flowchart TB\na["<b>x</b>"]' }, /HTML/u],
    ["a Mermaid init directive", { mermaid: "%%{init: {}}%%\nflowchart TB\na" }, /directives are not read/u],
    ["another Mermaid diagram type", { mermaid: "pie\n\"a\": 1" }, /"pie" is not a flowchart/u],
    ["a source given with a model", { mermaid: "flowchart TB\na", nodes: [] }, /not both/u],
  ])("refuses %s before creating an instance", async (_name, props, reason) => {
    const before = instanceCount();
    await expect(place(props)).rejects.toThrow(reason);
    expect(instanceCount()).toBe(before);
  });
});

describe("the selected node", () => {
  it("is checked, saved, carried in the timeline and read into a bounded semantic document", async () => {
    const instanceId = await place(PROPS);
    expect(await select(instanceId, { selectedId: "test" })).toMatchObject({ ok: true, body: { state: { selectedId: "test" } } });
    expect(liveStateOf(services.conductor, instanceId)?.body).toEqual({ selectedId: "test" });
    const carried = buildTimeline(services, { conversationId: CONVERSATION, afterSequence: 0 }).instances.find((entry) => entry.instanceId === instanceId);
    expect(carried?.state).toEqual({ selectedId: "test" });
    const document = buildWidgetSemantic(services.conductor, instanceId);
    expect(document).toMatchObject({
      definitionId: DIAGRAM_ID,
      title: "Phát hành",
      summary: "Diagram: 4 nodes, 4 edges, layered top to bottom; selected Kiểm thử đạt? (1 in, 2 out, 0 linked)",
      selectedIds: ["test"],
      values: { nodeCount: 4, edgeCount: 4, selectedLabel: "Kiểm thử đạt?", selectedGroup: "CI", previous: ["Xây dựng"], next: ["Phát hành (đạt)", "Xây dựng (chưa)"] },
      freshness: "unknown",
    });
    if (document === undefined) throw new Error("no semantic document");
    expect(canonicalSemanticDoc(document).length).toBeLessThanOrEqual(8_192);
  });

  it("is cleared by an empty id, and a node the diagram does not hold is refused without changing the state", async () => {
    const instanceId = await place(PROPS);
    expect((await select(instanceId, { selectedId: "build" })).ok).toBe(true);
    const revision = getInstance(services.conductor, instanceId)?.revision;
    expect(await select(instanceId, { selectedId: "ghost" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await select(instanceId, { selectedId: "build", html: "<b>" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(getInstance(services.conductor, instanceId)?.revision).toBe(revision);
    expect(liveStateOf(services.conductor, instanceId)?.body).toEqual({ selectedId: "build" });
    expect((await select(instanceId, { selectedId: "" })).ok).toBe(true);
    expect(liveStateOf(services.conductor, instanceId)?.body).toEqual({});
    expect(buildWidgetSemantic(services.conductor, instanceId)?.selectedIds).toEqual([]);
  });
});
