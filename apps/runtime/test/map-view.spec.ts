import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type Instant,
  MAP_ID,
  MAP_SELECT_OPERATION,
  MAP_TILE_POLICY_PREFERENCE,
  MAP_VIEW_OPERATION,
  type MessageBlock,
  canonicalSemanticDoc,
} from "@clarkcant/contracts";
import { getActionBinding, getInstance, liveStateOf, writeRegisteredPreference } from "@clarkcant/core";
import { MAP } from "@clarkcant/data-canvas";
import { appendMessage } from "@clarkcant/storage";

import { invokeWidgetAction } from "../src/application/widget-actions.ts";
import { bootNodeServices, buildTimeline, type NodeServices } from "../src/services.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";
import { buildWidgetSemantic } from "../src/widget-semantic.ts";

const AT = "2026-10-02T05:00:00.000Z" as Instant;
const CONVERSATION = "conv_map_view";
const PROPS = {
  title: "Chặng giao hàng",
  features: [
    { id: "hanoi", label: "Hà Nội", description: "Kho xuất phát", geometry: { type: "Point", coordinates: [105.8342, 21.0278] } },
    { id: "hcm", label: "TP. Hồ Chí Minh", geometry: { type: "Point", coordinates: [106.6297, 10.8231] } },
    { id: "route", label: "Tuyến chính", geometry: { type: "LineString", coordinates: [[105.8342, 21.0278], [107.5909, 16.4637], [106.6297, 10.8231]] } },
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
  const view = buildViewCatalog(services.conductor).find((entry) => entry.id === MAP_ID);
  if (view === undefined) throw new Error("the map is not in the catalog");
  const messageId = `msg_${String(++counter)}`;
  const block = (await view.build({
    props,
    caption: "Here is the route",
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
  dir = mkdtempSync(join(tmpdir(), "clarkcant-map-view-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)")
    .run(CONVERSATION, services.runtime.identity.nodeId, AT, AT);
});

afterEach(() => {
  services.runtime.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("placing a map", () => {
  it("binds host-checked selection and view operations and keeps a text alternative", async () => {
    const instanceId = await place(PROPS);
    const operations = getInstance(services.conductor, instanceId)?.actionBindingIds.map((id) => getActionBinding(services.conductor, id)?.proposal);
    expect(operations).toEqual([
      { kind: "view", operation: MAP_SELECT_OPERATION, args: {} },
      { kind: "view", operation: MAP_VIEW_OPERATION, args: {} },
    ]);
    const text = buildTimeline(services, { conversationId: CONVERSATION }).snapshots[0]?.textAlternative ?? "";
    expect(text).toContain("Chặng giao hàng:");
    expect(text).toContain("- Hà Nội (point) — lat 21.0278, lon 105.8342 — Kho xuất phát");
    expect(text.length).toBeLessThanOrEqual(4_096);
  });

  it("refuses bad maps with the reason, before creating an instance", async () => {
    const before = instanceCount();
    await expect(place({ ...PROPS, tileUrl: "https://tiles.example/{z}/{x}/{y}.png" })).rejects.toThrow("map props carry no URLs (tileUrl)");
    await expect(place({ features: [{ id: "c", label: "C", geometry: { type: "Circle", coordinates: [0, 0] } }] })).rejects.toThrow(
      'geometry.type "Circle" is not one of Point, LineString, Polygon',
    );
    await expect(place({ features: [{ id: "a", label: "A", geometry: { type: "Point", coordinates: [200, 0] } }] })).rejects.toThrow("longitude");
    await expect(place({ features: [{ id: "a", label: "Hà‮Nội", geometry: { type: "Point", coordinates: [0, 0] } }] })).rejects.toThrow();
    await expect(
      place({ features: Array.from({ length: 201 }, (_, index) => ({ id: `p${String(index)}`, label: "P", geometry: { type: "Point", coordinates: [0, 0] } })) }),
    ).rejects.toThrow("at most 200 features");
    expect(instanceCount()).toBe(before);
  });
});

describe("selection and view state", () => {
  it("selects a feature, moves the view, survives a reload and reports bounded meaning", async () => {
    const instanceId = await place(PROPS);
    expect(await act(instanceId, MAP_SELECT_OPERATION, { selectedId: "hcm" })).toMatchObject({ ok: true, body: { state: { selectedId: "hcm" } } });
    expect(await act(instanceId, MAP_VIEW_OPERATION, { center: [106.5, 16], zoom: 6 })).toMatchObject({
      ok: true,
      body: { state: { selectedId: "hcm", center: [106.5, 16], zoom: 6 } },
    });
    expect(liveStateOf(services.conductor, instanceId)?.body).toEqual({ selectedId: "hcm", center: [106.5, 16], zoom: 6 });
    const carried = buildTimeline(services, { conversationId: CONVERSATION }).instances.find((entry) => entry.instanceId === instanceId);
    expect(carried?.state).toEqual({ selectedId: "hcm", center: [106.5, 16], zoom: 6 });
    const document = buildWidgetSemantic(services.conductor, instanceId);
    expect(document).toMatchObject({
      definitionId: MAP.id,
      selectedIds: ["hcm"],
      values: { featureCount: 3, points: 2, lines: 1, areas: 0, zoom: 6, tiles: "offline", selectedLabel: "TP. Hồ Chí Minh", selectedLatitude: 10.8231, selectedLongitude: 106.6297 },
    });
    expect(document?.summary).toContain("selected TP. Hồ Chí Minh at lat 10.8231, lon 106.6297; offline basemap, no tiles");
    if (document === undefined) throw new Error("no semantic document");
    expect(canonicalSemanticDoc(document).length).toBeLessThanOrEqual(8_192);

    expect(await act(instanceId, MAP_SELECT_OPERATION, { selectedId: "" })).toMatchObject({ ok: true, body: { state: { center: [106.5, 16], zoom: 6 } } });
    expect(liveStateOf(services.conductor, instanceId)?.body).toEqual({ center: [106.5, 16], zoom: 6 });
  });

  it("refuses unknown features, out-of-range views and extra fields without changing saved state", async () => {
    const instanceId = await place(PROPS);
    expect((await act(instanceId, MAP_SELECT_OPERATION, { selectedId: "hanoi" })).ok).toBe(true);
    const revision = getInstance(services.conductor, instanceId)?.revision;
    for (const [operation, input] of [
      [MAP_SELECT_OPERATION, { selectedId: "missing" }],
      [MAP_VIEW_OPERATION, { center: [106, 16], zoom: 30 }],
      [MAP_VIEW_OPERATION, { center: [106, 89], zoom: 3 }],
      [MAP_VIEW_OPERATION, { center: [106, 16], zoom: 3, tileUrl: "https://x.example" }],
    ] as const) {
      expect(await act(instanceId, operation, input as Record<string, unknown>), JSON.stringify(input)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect(getInstance(services.conductor, instanceId)?.revision).toBe(revision);
    expect(liveStateOf(services.conductor, instanceId)?.body).toEqual({ selectedId: "hanoi" });
  });

  it("names the tile provider in the map's meaning once the node's policy sets one", async () => {
    const instanceId = await place(PROPS);
    const written = writeRegisteredPreference(
      { db: services.runtime.db, now: () => AT },
      {
        principalId: owner(),
        key: MAP_TILE_POLICY_PREFERENCE,
        value: { origin: "https://tiles.example", template: "/{z}/{x}/{y}.png", attribution: "© Example", maxZoom: 17, credential: { secret: "maps:tiles", header: "x-api-key" } },
      },
    );
    expect(written.ok).toBe(true);
    const document = buildWidgetSemantic(services.conductor, instanceId);
    expect(document?.values.tiles).toBe("https://tiles.example");
    expect(document?.summary).toContain("tiles from https://tiles.example");
    expect(JSON.stringify(document)).not.toContain("x-api-key");
  });
});
