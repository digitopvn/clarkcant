import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CompiledSection,
  type Instant,
  type WidgetDefinition,
  compileActionBinding,
} from "@clarkcant/contracts";
import { captureCompositeSurface } from "@clarkcant/core";
import { appendMessage, appendEvent, upsertTask } from "@clarkcant/storage";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, buildTimeline, type NodeServices } from "../src/services.ts";

/**
 * Composed-surface routes (Phase 4).
 *
 * The assertions that matter are the negative ones and the "no token anywhere" one. A route that
 * performs a view action correctly is easy; the failures worth engineering against are a second
 * surface claiming the same instance, a click landing on a view the user never saw, and an owner
 * token escaping into a payload that ends up in a log.
 */

const AT = "2026-09-17T05:00:00.000Z" as Instant;
const TZ = "Asia/Saigon";

const OVERVIEW: WidgetDefinition = {
  id: "canvas.overview@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: { type: "object", additionalProperties: true },
  eventSchemas: {},
  stateSchema: { type: "object" },
  stateVersion: 1,
  semanticDescription: "A composed overview",
  requestedCapabilities: [],
  sizing: { compact: true, expanded: true },
  textFallback: "An overview described in text.",
  effectCategories: ["read"],
  datasetRefs: [],
};

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let conversationId: string;

function sections(): CompiledSection[] {
  return [
    {
      sectionId: "metrics",
      slot: "metrics",
      definitionRef: { id: "canvas.metrics@1", version: "1.0.0", digest: "sha256:metrics" },
      props: { datasetRef: "ds_tasks" },
      dataRefs: ["ds_tasks"],
      rows: [{ label: "Hoàn thành", value: 1, unit: "task" }],
      textAlternative: "Một task hoàn thành.",
    },
    {
      sectionId: "filter",
      slot: "filter",
      definitionRef: { id: "canvas.filter@1", version: "1.0.0", digest: "sha256:filter" },
      props: { period: "week", timezone: TZ },
      dataRefs: [],
      textAlternative: "Bộ chọn khoảng thời gian ở tuần.",
    },
  ];
}

function compiled(operation: string, label: string) {
  const result = compileActionBinding({
    bindingId: `act_${operation.replace(".", "_")}`,
    instance: {
      instanceId: "winst_live",
      ownerNodeId: services.runtime.identity.nodeId,
      definitionRef: { id: OVERVIEW.id, version: OVERVIEW.version, packageDigest: "sha256:overview" },
      actionBindingRevision: 1,
    },
    packageGeneration: "sha256:overview",
    label,
    proposal: { kind: "view", operation, args: {} },
    inputSchema: { type: "object" },
    allowedDataRefs: ["ds_tasks"],
    fixedConstraints: {},
    effectCategory: "read",
    requiresApproval: false,
    limits: {},
    bindingDigest: `sha256:${operation}`,
    at: AT,
    knownCapabilities: new Set<string>(),
  });
  if (!result.ok) throw new Error(`fixture binding failed to compile: ${result.message}`);
  return result.binding;
}

export interface Seeds {
  instanceId: string;
  compositionId: string;
  snapshotId: string;
  bundleRef: string;
  periodBindingId: string;
  periodDigest: string;
  saveBindingId: string;
  saveDigest: string;
}

function seedComposition(): Seeds {
  // The instance id is allocated by the fixture so the bindings can name it: a binding that points
  // at a different instance is refused at invocation time, which is the behaviour under test.
  const instanceId = "winst_live";
  const period = compiled("period.change", "Đổi khoảng");
  const save = compiled("view.save", "Lưu bản xem");
  const captured = captureCompositeSurface(services.conductor, {
    instanceId,
    conversationId,
    messageId: "msg_surface",
    principalId: services.runtime.identity.ownerPrincipalId as never,
    definition: OVERVIEW,
    packageDigest: "sha256:overview",
    catalogDigest: "sha256:catalog",
    templateId: "overview",
    templateVersion: "1",
    sections: sections(),
    props: { compositionId: "comp_live" },
    initialState: { period: "week", timezone: TZ },
    provenance: {
      createdAt: AT,
      templateId: "overview",
      templateVersion: "1",
      selector: { mode: "explicit", policyVersion: "1" },
      sourceRevisions: [],
    },
    textAlternative: "Tổng quan tuần này.",
    dataRefs: ["ds_tasks"],
    bindings: [
      { binding: period, sectionId: "filter" },
      { binding: save, sectionId: "metrics" },
    ],
    at: AT,
  });
  if (!captured.ok) throw new Error(`fixture capture failed: ${captured.message}`);

  // The message that showed the surface. A timeline only carries the instances its messages
  // reference, so without this the page an action returns would not contain the thing that was
  // acted on.
  appendMessage(
    services.runtime.db,
    {
      messageId: "msg_surface",
      conversationId,
      role: "assistant",
      authorNodeId: services.runtime.identity.nodeId,
      delivery: "accepted",
      createdAt: AT,
      blocks: [
        {
          type: "surface",
          definitionRef: { id: OVERVIEW.id, version: OVERVIEW.version },
          snapshot: {
            snapshotId: captured.snapshot.snapshotId,
            instanceId: captured.instance.instanceId,
            messageId: "msg_surface",
            capturedRevision: 1,
            capturedAt: AT,
            textAlternative: "Tổng quan tuần này.",
            presentationRef: `catalog:${OVERVIEW.id}`,
            bundleRef: captured.bundle.bundleId,
            catalogDigest: "sha256:catalog",
            stale: false,
          },
        },
      ],
    } as never,
    1,
  );

  return {
    instanceId: captured.instance.instanceId,
    compositionId: captured.composition.compositionId,
    snapshotId: captured.snapshot.snapshotId,
    bundleRef: captured.bundle.bundleId,
    periodBindingId: period.actionBindingId,
    periodDigest: period.bindingDigest,
    saveBindingId: save.actionBindingId,
    saveDigest: save.bindingDigest,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-actions-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  deps = { services, now: () => AT };
  conversationId = "conv_actions";
  services.runtime.db
    .prepare(
      "INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)",
    )
    .run(conversationId, services.runtime.identity.nodeId, AT, AT);
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  options: { body?: unknown; authed?: boolean } = {},
): Promise<GatewayResponse> {
  const request: GatewayRequest = {
    method,
    path,
    query: {},
    headers: options.authed === false ? {} : { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: options.body === undefined ? "" : JSON.stringify(options.body),
  };
  return handleRequest(deps, request);
}

function data<T>(response: GatewayResponse): T {
  return response.body as T;
}

describe("view action route", () => {
  it("performs a period change and returns the page with a stale snapshot and the new state", async () => {
    const seeds = seedComposition();
    const response = await call("POST", `/conversations/${conversationId}/widgets/${seeds.instanceId}/actions`, {
      body: {
        instanceId: seeds.instanceId,
        actionBindingId: seeds.periodBindingId,
        expectedRevision: 1,
        expectedBindingDigest: seeds.periodDigest,
        input: { period: "month", timezone: TZ },
        invocationId: "inv_route_period",
      },
    });

    expect(response.status).toBe(200);
    const body = data<{
      duplicate: boolean;
      revision: number;
      state: Record<string, unknown>;
      stateRevision: number;
      timeline: { instances: { instanceId: string; state?: Record<string, unknown> }[]; snapshots: { stale: boolean; snapshotId: string }[] };
    }>(response);
    expect(body.duplicate).toBe(false);
    expect(body.revision).toBe(2);
    expect(body.state.period).toBe("month");
    expect(body.stateRevision).toBe(1);

    // The timeline separates the live instance from the historical capture, which is what stops a
    // transcript from being rewritten by a later change.
    const instance = body.timeline.instances.find((entry) => entry.instanceId === seeds.instanceId);
    expect(instance?.state?.period).toBe("month");
    const snapshot = body.timeline.snapshots.find((entry) => entry.snapshotId === seeds.snapshotId);
    expect(snapshot?.stale).toBe(true);
  });

  it("refuses a body that names a different instance than the path", async () => {
    const seeds = seedComposition();
    const response = await call("POST", `/conversations/${conversationId}/widgets/${seeds.instanceId}/actions`, {
      body: {
        instanceId: "winst_somewhere_else",
        actionBindingId: seeds.periodBindingId,
        expectedRevision: 1,
        expectedBindingDigest: seeds.periodDigest,
        input: { period: "month" },
        invocationId: "inv_mismatch",
      },
    });
    expect(response.status).toBe(400);
    expect(data<{ code: string }>(response).code).toBe("INSTANCE_MISMATCH");
  });

  it("answers a stale click with a conflict and the revision to re-read", async () => {
    const seeds = seedComposition();
    const response = await call("POST", `/conversations/${conversationId}/widgets/${seeds.instanceId}/actions`, {
      body: {
        actionBindingId: seeds.periodBindingId,
        expectedRevision: 9,
        expectedBindingDigest: seeds.periodDigest,
        input: { period: "month" },
        invocationId: "inv_conflict",
      },
    });
    expect(response.status).toBe(409);
    const body = data<{ code: string; currentRevision: number }>(response);
    expect(body.code).toBe("REVISION_MISMATCH");
    expect(body.currentRevision).toBe(1);
  });

  it("turns a double click into one effect and one pin", async () => {
    const seeds = seedComposition();
    const body = {
      actionBindingId: seeds.saveBindingId,
      expectedRevision: 1,
      expectedBindingDigest: seeds.saveDigest,
      input: { displayMode: "compact" },
      invocationId: "inv_save_double",
    };
    const first = await call("POST", `/conversations/${conversationId}/widgets/${seeds.instanceId}/actions`, { body });
    const second = await call("POST", `/conversations/${conversationId}/widgets/${seeds.instanceId}/actions`, { body });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(data<{ duplicate: boolean }>(first).duplicate).toBe(false);
    expect(data<{ duplicate: boolean }>(second).duplicate).toBe(true);

    const pins = services.runtime.db
      .prepare("SELECT COUNT(*) AS n FROM pins WHERE conversation_id = ?")
      .get(conversationId) as { n: number };
    expect(pins.n).toBe(1);
    const invocations = services.runtime.db.prepare("SELECT COUNT(*) AS n FROM action_invocations").get() as { n: number };
    expect(invocations.n).toBe(1);
  });

  it("refuses an action from a request that carries no token", async () => {
    const seeds = seedComposition();
    const response = await call(
      "POST",
      `/conversations/${conversationId}/widgets/${seeds.instanceId}/actions`,
      { body: { actionBindingId: seeds.periodBindingId, expectedRevision: 1, expectedBindingDigest: seeds.periodDigest, input: {}, invocationId: "x" }, authed: false },
    );
    expect(response.status).toBe(401);
  });
});

describe("live and snapshot reads", () => {
  it("resolves the live surface from current records, with availability per region", async () => {
    // One completed task this week, written the way the reducer writes it.
    const task = {
      taskId: "task_live",
      conversationId,
      homeNodeId: services.runtime.identity.nodeId,
      state: "succeeded" as const,
      revision: 1,
      goal: "seeded",
      createdAt: "2026-09-16T01:00:00.000Z" as never,
      updatedAt: "2026-09-16T02:00:00.000Z" as never,
    };
    upsertTask(services.runtime.db, task);
    appendEvent(services.runtime.db, {
      eventId: "evt_live",
      kind: "task.succeeded",
      stream: `task:${task.taskId}`,
      nodeId: services.runtime.identity.nodeId,
      taskId: task.taskId,
      conversationId,
      document: { state: "succeeded" },
      occurredAt: AT,
    });

    const seeds = seedComposition();
    const response = await call("GET", `/conversations/${conversationId}/widgets/${seeds.instanceId}/live`);

    expect(response.status).toBe(200);
    const body = data<{
      readOnly: boolean;
      sections: { sectionId: string; rows?: { label: string; value: number }[] }[];
      availability: Record<string, string>;
      revision: number;
      state: Record<string, unknown>;
      ownerSurface: string | null;
      period: string;
    }>(response);

    expect(body.readOnly).toBe(false);
    expect(body.revision).toBe(1);
    expect(body.period).toBe("week");
    expect(body.ownerSurface).toBeNull();

    const metricsSection = body.sections.find((section) => section.sectionId === "metrics");
    // The figures come from the row written above, not from the snapshot.
    expect(metricsSection?.rows?.some((row) => row.value === 1)).toBe(true);
    expect(body.availability.metrics).toBe("live");

    // A region with no rows is reported as missing rather than drawn with the snapshot's numbers.
    const filterSection = body.sections.find((section) => section.sectionId === "filter");
    expect(filterSection?.rows).toBeUndefined();
  });

  it("serves the captured bundle read-only, so history cannot be used to mutate anything", async () => {
    const seeds = seedComposition();
    const response = await call("GET", `/conversations/${conversationId}/snapshots/${seeds.snapshotId}/presentation`);

    expect(response.status).toBe(200);
    const body = data<{
      readOnly: boolean;
      bundleRef: string;
      sections: { sectionId: string; rows?: unknown[] }[];
      text: string;
    }>(response);
    expect(body.readOnly).toBe(true);
    expect(body.bundleRef).toBe(seeds.bundleRef);
    // The bundle keeps the values that were captured, which is the whole reason it exists.
    expect(body.sections.find((section) => section.sectionId === "metrics")?.rows).toHaveLength(1);
    expect(body.text).toContain("Tổng quan");

    const missing = await call("GET", `/conversations/${conversationId}/snapshots/wsnap_missing/presentation`);
    expect(missing.status).toBe(404);
  });
});

describe("live ownership route", () => {
  it("grants one claim, refuses a second with the holder named, and requires the token to release", async () => {
    const seeds = seedComposition();
    const path = `/conversations/${conversationId}/widgets/${seeds.instanceId}/live-owner`;

    const first = await call("POST", path, { body: { ownerToken: "token_a", surface: "inline", leaseMs: 60_000 } });
    expect(first.status).toBe(200);
    expect(data<{ surface: string }>(first).surface).toBe("inline");

    const second = await call("POST", path, { body: { ownerToken: "token_b", surface: "pin" } });
    expect(second.status).toBe(409);
    const conflict = data<{ code: string; heldBySurface: string }>(second);
    expect(conflict.code).toBe("ALREADY_OWNED");
    expect(conflict.heldBySurface).toBe("inline");

    const wrongRelease = await call("DELETE", path, { body: { ownerToken: "token_b" } });
    expect(wrongRelease.status).toBe(409);

    const release = await call("DELETE", path, { body: { ownerToken: "token_a" } });
    expect(release.status).toBe(200);

    const reclaim = await call("POST", path, { body: { ownerToken: "token_b", surface: "pin" } });
    expect(reclaim.status).toBe(200);
    const body = data<{ recovered?: boolean }>(reclaim);
    // A release is not a recovery: it names nothing to recover from.
    expect(body.recovered).toBeUndefined();
  });

  it("never puts an owner token in the timeline it returns", async () => {
    const seeds = seedComposition();
    const path = `/conversations/${conversationId}/widgets/${seeds.instanceId}/live-owner`;
    await call("POST", path, { body: { ownerToken: "token_secret_value", surface: "pin" } });

    const timeline = buildTimeline(services, { conversationId, afterSequence: 0 });
    const serialised = JSON.stringify(timeline);
    expect(serialised).not.toContain("token_secret_value");
    // The surface is reported, because the UI needs to say where the live view is.
    expect(timeline.instances.find((instance) => instance.instanceId === seeds.instanceId)?.ownerSurface).toBe("pin");
  });

  it("refuses a live read for an instance that belongs to another principal", async () => {
    const seeds = seedComposition();
    // Both the column and the stored document, because the instance is read back from its document.
    const row = services.runtime.db
      .prepare("SELECT document FROM widget_instances WHERE instance_id = ?")
      .get(seeds.instanceId) as { document: string };
    const document = JSON.parse(row.document) as Record<string, unknown>;
    document.ownerPrincipalId = "prin_someone_else";
    services.runtime.db
      .prepare("UPDATE widget_instances SET owner_principal_id = ?, document = ? WHERE instance_id = ?")
      .run("prin_someone_else", JSON.stringify(document), seeds.instanceId);
    const response = await call("GET", `/conversations/${conversationId}/widgets/${seeds.instanceId}/live`);
    expect(response.status).toBe(403);
  });
});

describe("timeline DTO", () => {
  it("carries snapshots and live instances as separate lists", async () => {
    const seeds = seedComposition();
    const timeline = buildTimeline(services, { conversationId, afterSequence: 0 });
    expect(timeline.snapshots).toHaveLength(1);
    expect(timeline.snapshots[0]?.bundleRef).toBe(seeds.bundleRef);
    const instance = timeline.instances.find((entry) => entry.instanceId === seeds.instanceId);
    expect(instance?.compositionId).toBe(seeds.compositionId);
    expect(instance?.actionBindingIds.length).toBe(2);
    expect(instance?.definitionDigest).toBe("sha256:overview");
  });
});
