import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Instant, type MessageBlock, MAX_CHART_POINTS, SEMANTIC_LIMITS, canonicalSemanticDoc } from "@clarkcant/contracts";
import { getActionBinding, getInstance, liveStateOf } from "@clarkcant/core";
import { AREA_CHART, SCATTER_CHART } from "@clarkcant/data-canvas";
import { appendMessage, upsertDataset } from "@clarkcant/storage";

import { invokeWidgetAction } from "../src/application/widget-actions.ts";
import { bootNodeServices, buildTimeline, type NodeServices } from "../src/services.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";
import { buildWidgetSemantic } from "../src/widget-semantic.ts";

/**
 * Area and scatter charts, placed the way a model's `show_view` places them and used the way a person uses them.
 *
 * The node reads the rows before an instance exists, so a field that is not there or a value that is not a number is
 * refused in the same turn with the reason. What a person changes on a placed chart, the series hidden and the point
 * selected, is a view the node checks against the chart and the rows it holds, and is what voice and `inspect_ui` read.
 */

const AT = "2026-09-30T05:00:00.000Z" as Instant;
const CONVERSATION = "conv_xy_charts";

const USAGE = [
  { week: "W36", runs: 128, failures: 6, minutes: 4.2 },
  { week: "W37", runs: 141, failures: 4, minutes: 3.9 },
  { week: "W38", runs: 137, failures: 9, minutes: 4.6 },
  { week: "W39", runs: 164, failures: 3, minutes: 3.4 },
  { week: "W40", runs: 158, failures: 5, minutes: 3.6 },
];

const AREA_PROPS = { title: "Runs by week", datasetRef: "ds_usage", x: "week", y: ["runs", "failures"], labels: { runs: "Runs", failures: "Failures" } };
const SCATTER_PROPS = { datasetRef: "ds_usage", x: "minutes", y: ["runs"], pointLabel: "week", xUnit: "min" };

let dir: string;
let services: NodeServices;
let counter = 0;

function owner(): string {
  return services.runtime.identity.ownerPrincipalId;
}

function dataset(datasetId: string, rows: unknown[], ownerPrincipalId: string | undefined = owner(), columns?: string[]): void {
  upsertDataset(services.runtime.db, {
    datasetId,
    originNodeId: services.runtime.identity.nodeId,
    rowCount: rows.length,
    freshness: "live",
    updatedAt: AT,
    document: columns === undefined ? { rows } : { rows, columns },
    ...(ownerPrincipalId === undefined ? {} : { ownerPrincipalId }),
  });
}

function instanceRows(): number {
  return (services.runtime.db.prepare("SELECT COUNT(*) AS n FROM widget_instances").get() as { n: number }).n;
}

async function place(definitionId: string, props: Record<string, unknown>): Promise<string> {
  const view = buildViewCatalog(services.conductor).find((entry) => entry.id === definitionId);
  if (view === undefined) throw new Error(`${definitionId} is not in the catalog`);
  const messageId = `msg_${String(++counter)}`;
  const block = (await view.build({
    props,
    caption: "Here is the chart",
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

async function setView(instanceId: string, input: Record<string, unknown>, principalId = owner()) {
  const instance = getInstance(services.conductor, instanceId);
  const bindingId = instance?.actionBindingIds[0] ?? "";
  const binding = getActionBinding(services.conductor, bindingId);
  return invokeWidgetAction(
    services,
    {
      conversationId: CONVERSATION,
      principalId: principalId as never,
      instanceId,
      actionBindingId: bindingId,
      expectedRevision: instance?.revision ?? 0,
      expectedBindingDigest: binding?.bindingDigest ?? "",
      input,
      invocationId: `inv_${String(++counter)}`,
    },
    "click",
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-xy-charts-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)")
    .run(CONVERSATION, services.runtime.identity.nodeId, AT, AT);
  dataset("ds_usage", USAGE);
});

afterEach(() => {
  services.runtime.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("the model's vocabulary", () => {
  it("offers both charts and says that every field is named, never guessed", () => {
    const byId = new Map(buildViewCatalog(services.conductor).map((view) => [view.id, view]));
    for (const definition of [AREA_CHART, SCATTER_CHART]) {
      expect(byId.get(definition.id)?.notes).toContain("nothing is guessed");
      expect(byId.get(definition.id)?.notes).toContain(`first ${String(MAX_CHART_POINTS)} rows`);
    }
    expect(byId.get(AREA_CHART.id)?.notes).toContain("props.stacked:true");
    expect(byId.get(SCATTER_CHART.id)?.notes).toContain("props.pointLabel");
  });
});

describe("placing a chart", () => {
  it("keeps the chart's own words as its text alternative and binds one view action", async () => {
    const instanceId = await place(AREA_CHART.id, AREA_PROPS);
    const instance = getInstance(services.conductor, instanceId);
    expect(instance?.actionBindingIds).toHaveLength(1);
    const binding = getActionBinding(services.conductor, instance?.actionBindingIds[0] ?? "");
    expect(binding).toMatchObject({ proposal: { kind: "view", operation: "chart.view" }, effectCategory: "read", requiresApproval: false });
    const timeline = buildTimeline(services, { conversationId: CONVERSATION, afterSequence: 0 });
    expect(timeline.snapshots[0]?.textAlternative).toBe(
      "Runs by week: Area chart of Runs, Failures by week, 5 point(s); W36 to W40. Runs: 128 to 164; Failures: 3 to 9.",
    );
  });

  it.each([
    ["a field the rows do not have", AREA_CHART.id, { ...AREA_PROPS, y: ["runs", "cost"], labels: {} },
      'canvas.area@1 cannot be shown: the dataset has no field "cost"; its fields are "week", "runs", "failures", "minutes"'],
    ["x left out", SCATTER_CHART.id, { datasetRef: "ds_usage", y: ["runs"] },
      'canvas.scatter@1 has props that do not fit its schema: required property "x" is missing'],
    ["a scatter over text", SCATTER_CHART.id, { datasetRef: "ds_usage", x: "week", y: ["runs"] },
      'canvas.scatter@1 cannot be shown: row 1\'s "week" is "W36", not a number; row 2\'s "week" is "W37", not a number; ' +
        'row 3\'s "week" is "W38", not a number; row 4\'s "week" is "W39", not a number; row 5\'s "week" is "W40", not a number'],
    ["a dataset that is not there", AREA_CHART.id, { ...AREA_PROPS, datasetRef: "ds_missing" },
      'canvas.area@1 cannot be shown: dataset "ds_missing" is not on this node, or is not yours to read'],
    ["the same series twice", AREA_CHART.id, { datasetRef: "ds_usage", x: "week", y: ["runs", "runs"] },
      'canvas.area@1 cannot be shown: "y" names "runs" twice; each series is named once'],
  ])("refuses %s with the reason and leaves nothing behind", async (_name, definitionId, props, reason) => {
    const before = instanceRows();
    await expect(place(definitionId, props)).rejects.toThrow(new Error(reason));
    expect(instanceRows()).toBe(before);
  });

  it("refuses a value that is not a number with the row it is in", async () => {
    dataset("ds_bad", [{ week: "W1", runs: 3 }, { week: "W2", runs: "n/a" }]);
    await expect(place(AREA_CHART.id, { datasetRef: "ds_bad", x: "week", y: ["runs"] })).rejects.toThrow(
      'canvas.area@1 cannot be shown: row 2\'s "runs" is "n/a", not a number',
    );
  });

  it("does not read another principal's dataset", async () => {
    dataset("ds_theirs", USAGE, "prin_someone_else");
    await expect(place(AREA_CHART.id, { ...AREA_PROPS, datasetRef: "ds_theirs" })).rejects.toThrow("is not yours to read");
  });

  it("draws the first rows of a large dataset and says how many it left out", async () => {
    dataset("ds_big", Array.from({ length: MAX_CHART_POINTS + 40 }, (_, index) => ({ minutes: index, runs: index % 17 })));
    const instanceId = await place(SCATTER_CHART.id, { datasetRef: "ds_big", x: "minutes", y: ["runs"] });
    const doc = buildWidgetSemantic(services.conductor, instanceId);
    expect(doc?.values.truncated).toBe(`the first ${String(MAX_CHART_POINTS)} of ${String(MAX_CHART_POINTS + 40)} rows`);
    const timeline = buildTimeline(services, { conversationId: CONVERSATION, afterSequence: 0 });
    expect(timeline.snapshots[0]?.textAlternative).toContain(`the first ${String(MAX_CHART_POINTS)} of ${String(MAX_CHART_POINTS + 40)} rows`);
  });
});

describe("a person's view of a chart", () => {
  it("hides a series and selects a point, and the state and meaning say so", async () => {
    const instanceId = await place(AREA_CHART.id, AREA_PROPS);
    const outcome = await setView(instanceId, { hiddenSeries: ["failures"], selected: { series: "runs", index: 3 } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.body.state).toEqual({ hiddenSeries: ["failures"], selected: { series: "runs", index: 3 } });
    expect(liveStateOf(services.conductor, instanceId)?.body).toEqual({ hiddenSeries: ["failures"], selected: { series: "runs", index: 3 } });

    const doc = buildWidgetSemantic(services.conductor, instanceId);
    expect(doc).toMatchObject({
      definitionId: AREA_CHART.id,
      title: "Runs by week",
      freshness: "live",
      selectedIds: ["runs#3"],
      values: { series: ["Runs"], hiddenSeries: ["Failures"], selectedPoint: "Runs at W39: 164" },
    });
    if (doc === undefined) throw new Error("no document");
    expect(canonicalSemanticDoc(doc).length).toBeLessThanOrEqual(SEMANTIC_LIMITS.bytes);

    // The timeline carries the state, so a reload draws the chart the way the person left it.
    const timeline = buildTimeline(services, { conversationId: CONVERSATION, afterSequence: 0 });
    const carried = timeline.instances.find((instance) => instance.instanceId === instanceId) as { state?: unknown } | undefined;
    expect(carried?.state).toEqual({ hiddenSeries: ["failures"], selected: { series: "runs", index: 3 } });
  });

  it("replaces the whole view, so clearing the selection removes it", async () => {
    const instanceId = await place(AREA_CHART.id, AREA_PROPS);
    expect((await setView(instanceId, { hiddenSeries: [], selected: { series: "runs", index: 0 } })).ok).toBe(true);
    const cleared = await setView(instanceId, { hiddenSeries: [] });
    expect(cleared.ok).toBe(true);
    expect(liveStateOf(services.conductor, instanceId)?.body).toEqual({ hiddenSeries: [] });
    expect(buildWidgetSemantic(services.conductor, instanceId)?.selectedIds).toEqual([]);
  });

  it.each([
    ["every series hidden", { hiddenSeries: ["runs", "failures"] }, "at least one series stays shown"],
    ["a series the chart does not have", { hiddenSeries: ["cost"] }, '"cost" is not a series of this chart'],
    ["a point past the rows", { hiddenSeries: [], selected: { series: "runs", index: 5 } }, "point 5 is not on this chart, which draws 5 point(s)"],
    ["a point on a hidden series", { hiddenSeries: ["runs"], selected: { series: "runs", index: 0 } }, '"runs" is hidden, so none of its points can be selected'],
    ["a key a view does not carry", { hiddenSeries: [], zoom: 3 }, "a chart view carries hiddenSeries and selected, not zoom"],
  ])("refuses %s with the reason and changes nothing", async (_name, input, reason) => {
    const instanceId = await place(AREA_CHART.id, AREA_PROPS);
    const before = getInstance(services.conductor, instanceId)?.revision;
    const outcome = await setView(instanceId, input);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("INVALID_INPUT");
    expect(outcome.message).toBe(`the chart view was refused: ${reason}`);
    expect(getInstance(services.conductor, instanceId)?.revision).toBe(before);
    expect(liveStateOf(services.conductor, instanceId)).toBeUndefined();
  });

  it("refuses a view set by someone who does not own the chart", async () => {
    const instanceId = await place(AREA_CHART.id, AREA_PROPS);
    const outcome = await setView(instanceId, { hiddenSeries: ["failures"] }, "prin_someone_else");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("NOT_AUTHORIZED");
  });

  it("checks a point against the rows the node holds now, and says when a kept selection is gone", async () => {
    const instanceId = await place(SCATTER_CHART.id, SCATTER_PROPS);
    expect((await setView(instanceId, { hiddenSeries: [], selected: { series: "runs", index: 4 } })).ok).toBe(true);
    expect(buildWidgetSemantic(services.conductor, instanceId)?.values.selectedPoint).toBe("runs at minutes 3.6 min: 158 (W40)");

    dataset("ds_usage", USAGE.slice(0, 2));
    const doc = buildWidgetSemantic(services.conductor, instanceId);
    expect(doc?.values.selectedPoint).toBe("runs point 5, which is no longer in the data");
    expect(doc?.selectedIds).toEqual([]);
    const outcome = await setView(instanceId, { hiddenSeries: [], selected: { series: "runs", index: 3 } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toBe("the chart view was refused: point 3 is not on this chart, which draws 2 point(s)");
  });

  it("says a chart whose dataset is gone is not available, rather than empty", async () => {
    const instanceId = await place(AREA_CHART.id, AREA_PROPS);
    services.runtime.db.prepare("DELETE FROM datasets WHERE dataset_id = 'ds_usage'").run();
    const doc = buildWidgetSemantic(services.conductor, instanceId);
    expect(doc?.summary).toContain("its dataset is not available on this node");
    expect(doc?.freshness).toBe("unknown");
  });
});
