import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Instant, LAYOUT_COMPOSITION_SCHEMA_VERSION, MAX_LAYOUT_DEPTH } from "@clarkcant/contracts";
import { appendMessage, findBundleForMessage, findCompositionByMessage, insertLocalImage, type Database } from "@clarkcant/storage";
import { definitionDigest } from "@clarkcant/widget-host";

import { type ComposeDeps } from "../src/compose-mini-app.ts";
import { compileLayout, composeLayout } from "../src/compose-layout.ts";
import { handleRequest, type GatewayDeps } from "../src/gateway.ts";
import { rowsBySlotOf } from "../src/compose-mini-app.ts";
import { publishMiniAppData } from "../src/mini-app-data.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";

/**
 * A surface the model arranges as a tree.
 *
 * What matters is that the tree adds arrangement and nothing else: every leaf is checked the way a template's region
 * is, a tree the host cannot honour is refused with the reason before anything is written, and history draws the tree
 * from the bundle it was stored in.
 */

const AT = "2026-09-29T05:00:00.000Z" as Instant;
const CONVERSATION = "conv_layout";
const PRINCIPAL = "prin_owner" as never;

let dir: string;
let services: NodeServices;
let compose: ComposeDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-layout-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  compose = services.compose;
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)")
    .run(CONVERSATION, services.runtime.identity.nodeId, AT, AT);
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

function db(): Database {
  return services.runtime.db;
}

const leaf = (widget: string, props: Record<string, unknown> = {}, label?: string): Record<string, unknown> => ({
  kind: "widget",
  widget,
  props,
  ...(label === undefined ? {} : { label }),
});

/**
 * A dashboard tree whose card holds the period selector beside a searchable table, so it also shows a region that binds
 * its own action keeping that binding inside a tree. The issue's exact tree, with the search box, is compiled in
 * `input-primitives.spec.ts`.
 */
const DASHBOARD = {
  kind: "grid",
  columns: 3,
  children: [
    leaf("canvas.metrics@1", { title: "Việc trong kỳ" }),
    leaf("canvas.metrics@1", { title: "Nhịp làm việc" }),
    { kind: "card", label: "Chi tiết theo ngày", children: [leaf("canvas.filter@1"), leaf("canvas.table@1", { searchable: true })] },
  ],
};

function compile(proposal: unknown, imageRef?: { imageId: string; altText: string }) {
  const published = publishMiniAppData(
    { db: db(), nodeId: services.runtime.identity.nodeId, dataDir: dir, now: () => AT, newId: compose.newId },
    { principalId: PRINCIPAL, period: "week", timezone: "UTC" },
  );
  return compileLayout({
    proposal,
    registry: compose.registry,
    rowsBySlot: rowsBySlotOf(published),
    initialState: { period: "week", timezone: "UTC" },
    pictureRefs: published.pictureRefs,
    ...(imageRef === undefined ? {} : { imageRef }),
  });
}

function problemsOf(proposal: unknown, imageRef?: { imageId: string; altText: string }): string {
  const result = compile(proposal, imageRef);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.problems.join(" | ");
}

describe("compiling a proposed layout", () => {
  it("compiles a grid of two metric tiles and a card holding a filter and a table, with no template for it", () => {
    const result = compile(DASHBOARD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.sections.map((section) => section.sectionId)).toEqual(["metrics-1", "metrics-2", "filter-1", "table-1"]);
    expect(result.layout).toEqual({
      kind: "grid",
      columns: 3,
      children: [
        { kind: "widget", sectionId: "metrics-1" },
        { kind: "widget", sectionId: "metrics-2" },
        { kind: "card", label: "Chi tiết theo ngày", children: [{ kind: "widget", sectionId: "filter-1" }, { kind: "widget", sectionId: "table-1" }] },
      ],
    });
    // Each leaf is pinned to the digest the catalog holds now, like a template's region.
    for (const section of result.sections) {
      const entry = compose.registry.get(section.definitionRef.id);
      expect(entry).toBeDefined();
      if (entry !== undefined) expect(section.definitionRef.digest).toBe(definitionDigest(entry.definition));
    }
    // The model's title is kept; the data a tile reads is the host's.
    expect(result.sections[0]?.props).toMatchObject({ title: "Việc trong kỳ", datasetRef: "inline:metrics:week" });
    expect(result.sections[3]?.props).toMatchObject({ searchable: true, datasetRef: "inline:table:week", title: "Bảng số liệu" });
    expect(result.textAlternative).toContain("Chi tiết theo ngày:");
  });

  it("puts the host's data reference over one a model wrote", () => {
    const result = compile(leaf("canvas.metrics@1", { datasetRef: "inline:someone-else" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sections[0]?.props.datasetRef).toBe("inline:metrics:week");
  });

  it("refuses a tree past the bounds, before reading any of it", () => {
    let deep: Record<string, unknown> = leaf("canvas.metrics@1");
    for (let level = 0; level < MAX_LAYOUT_DEPTH; level += 1) deep = { kind: "stack", children: [deep] };
    expect(problemsOf(deep)).toContain(`more than ${String(MAX_LAYOUT_DEPTH)} levels deep`);

    const crowded = { kind: "stack", children: Array.from({ length: 4 }, () => ({ kind: "row", children: Array.from({ length: 12 }, () => ({ kind: "divider" })) })) };
    expect(problemsOf(crowded)).toContain("more than 40 nodes");

    const many = { kind: "stack", children: [{ kind: "row", children: Array.from({ length: 7 }, () => leaf("canvas.metrics@1")) }, { kind: "row", children: Array.from({ length: 6 }, () => leaf("canvas.metrics@1")) }] };
    expect(problemsOf(many)).toContain("places 13 widgets; at most 12");
  });

  it("refuses a widget this node does not hold, or one that cannot be a leaf, and says which", () => {
    expect(problemsOf({ kind: "grid", children: [leaf("canvas.metrics@1"), leaf("canvas.sparkle@1")] })).toContain(
      'layout.2 names "canvas.sparkle@1", which is not a widget this node\'s catalog holds',
    );
    expect(problemsOf(leaf("canvas.overview@1"))).toContain("names the container");
    expect(problemsOf(leaf("canvas.action@1"))).toContain("a button is placed with its own show_view");
    expect(problemsOf(leaf("canvas.video@1", { videoRef: "video_x", alt: "A clip" }))).toContain("no source for it yet");
  });

  it("refuses a field a node does not have, rather than dropping it", () => {
    expect(problemsOf({ kind: "card", label: "x", children: [leaf("canvas.metrics@1")], onClick: "run()" })).toContain(
      "fields a card does not have: onClick",
    );
    expect(problemsOf({ kind: "iframe", children: [] })).toContain('kind "iframe"');
    expect(problemsOf({ kind: "widget", widget: "canvas.metrics@1", url: "https://example.test" })).toContain("url");
  });

  it("holds containers to their rules and leaves to their schemas", () => {
    expect(problemsOf({ kind: "tabs", children: [leaf("canvas.metrics@1"), leaf("canvas.filter@1")] })).toContain("tab 1 needs a label");
    expect(problemsOf({ kind: "split", children: [leaf("canvas.metrics@1"), leaf("canvas.filter@1"), leaf("canvas.line@1")] })).toContain(
      "a split has two",
    );
    expect(problemsOf(leaf("canvas.table@1", { pageSize: 1000 }))).toContain("do not fit its schema");
    expect(problemsOf(leaf("canvas.image@1"))).toContain("no imported image on this node");
  });
});

describe("placing the person's pictures in a layout", () => {
  /** Imported pictures, oldest first, so the newest is the last one named here. */
  function importPictures(count: number): string[] {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const imageId = `image_layout_${String(index).padStart(2, "0")}`;
      insertLocalImage(db(), {
        imageId,
        ownerPrincipalId: PRINCIPAL,
        nodeId: services.runtime.identity.nodeId,
        artifactId: `art_${imageId}`,
        mimeType: "image/png",
        byteSize: 68,
        width: 1,
        height: 1,
        digest: `sha256:${imageId}`,
        altText: `Picture ${String(index)}`,
        blobPath: `unused-${imageId}`,
        createdAt: new Date(Date.parse(AT) + index * 1000).toISOString() as Instant,
      });
      ids.push(imageId);
    }
    return ids;
  }

  it("lists a gallery and a carousel among the widgets a leaf may name, and still not a video", () => {
    const named = compose.registry.entries().map((entry) => entry.definition.id);
    expect(named).toContain("canvas.gallery@1");
    const result = compile(leaf("canvas.video@1", { videoRef: "video_x", alt: "A clip" }));
    expect(result.ok).toBe(false);
  });

  it("fills a gallery and a carousel with the node's own pictures, newest first, cut to what each holds", () => {
    const ids = importPictures(30);
    const newestFirst = [...ids].reverse();
    const result = compile({
      kind: "stack",
      children: [
        // A model names a title; which pictures, and what they say, is the node's.
        leaf("canvas.gallery@1", { title: "Ảnh của tôi", imageRefs: ["image_someone_else"], alts: ["Not mine"] }),
        leaf("canvas.carousel@1"),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [gallery, carousel] = result.sections;
    expect(gallery?.sectionId).toBe("pictures-1");
    expect(gallery?.slot).toBe("pictures");
    expect(gallery?.props).toMatchObject({ title: "Ảnh của tôi", imageRefs: newestFirst, alts: newestFirst.map((id) => `Picture ${String(Number(id.slice(-2)))}`) });
    expect(gallery?.props.imageRefs).not.toContain("image_someone_else");
    // A carousel holds at most 24; it shows the newest 24 rather than being refused.
    expect(carousel?.sectionId).toBe("pictures-2");
    expect(carousel?.props.imageRefs).toEqual(newestFirst.slice(0, 24));
    // What history and a screen reader are told names only the pictures the carousel holds.
    expect(carousel?.rows).toHaveLength(24);
    expect(carousel?.textAlternative).toContain("Picture 6");
    expect(carousel?.textAlternative).not.toContain("Picture 5");
    expect(gallery?.rows).toHaveLength(30);
    expect(gallery?.textAlternative).toContain("Hình ảnh đã nhập: Picture 29; Picture 28");
  });

  it("refuses a gallery or carousel when the node holds no picture to show", () => {
    expect(problemsOf(leaf("canvas.gallery@1"))).toContain("asks for pictures, and there is no imported image on this node to show");
    expect(problemsOf(leaf("canvas.carousel@1"))).toContain("asks for pictures");
  });
});

describe("storing a proposed layout", () => {
  const COUNTS = {
    widget_instances: "SELECT COUNT(*) AS n FROM widget_instances",
    surface_compositions: "SELECT COUNT(*) AS n FROM surface_compositions",
    presentation_bundles: "SELECT COUNT(*) AS n FROM presentation_bundles",
  } as const;
  const count = (table: keyof typeof COUNTS): number => Number((db().prepare(COUNTS[table]).get() as { n: number }).n);

  it("stores a version 2 spec with the tree, in the bundle history reads", () => {
    const outcome = composeLayout(compose, {
      conversationId: CONVERSATION,
      messageId: "msg_layout",
      principalId: PRINCIPAL,
      intent: "",
      layout: DASHBOARD,
      title: "Bảng điều khiển",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.templateId).toBe("layout");
    expect(outcome.selectorMode).toBe("explicit");

    const spec = findCompositionByMessage(db(), "msg_layout", PRINCIPAL);
    expect(spec?.schemaVersion).toBe(LAYOUT_COMPOSITION_SCHEMA_VERSION);
    expect(spec?.layout?.kind).toBe("grid");
    const bundle = findBundleForMessage(db(), "msg_layout", PRINCIPAL);
    expect(bundle?.composition.layout).toEqual(spec?.layout);
    expect(bundle?.sections.map((section) => section.sectionId)).toEqual(["metrics-1", "metrics-2", "filter-1", "table-1"]);
    // The filter still acts: its binding is its own, named by its section.
    expect(spec?.actions.map((action) => action.sectionId)).toEqual(["filter-1"]);

    const again = composeLayout(compose, {
      conversationId: CONVERSATION,
      messageId: "msg_layout",
      principalId: PRINCIPAL,
      intent: "",
      layout: DASHBOARD,
    });
    expect(again.ok && again.compositionId).toBe(outcome.compositionId);
    expect(count("surface_compositions")).toBe(1);
  });

  it("gives each filter in a tree its own binding", () => {
    const outcome = composeLayout(compose, {
      conversationId: CONVERSATION,
      messageId: "msg_two_filters",
      principalId: PRINCIPAL,
      intent: "",
      layout: { kind: "split", children: [leaf("canvas.filter@1"), leaf("canvas.filter@1")] },
    });
    expect(outcome.ok).toBe(true);
    const spec = findCompositionByMessage(db(), "msg_two_filters", PRINCIPAL);
    expect(spec?.actions.map((action) => action.sectionId)).toEqual(["filter-1", "filter-2"]);
  });

  it("writes nothing for a tree it refuses", () => {
    const outcome = composeLayout(compose, {
      conversationId: CONVERSATION,
      messageId: "msg_refused",
      principalId: PRINCIPAL,
      intent: "",
      layout: { kind: "grid", children: [leaf("canvas.sparkle@1")] },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("COMPILE_FAILED");
    expect(count("widget_instances")).toBe(0);
    expect(count("surface_compositions")).toBe(0);
    expect(count("presentation_bundles")).toBe(0);
  });

  it("writes nothing when the turn was cancelled", () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = composeLayout(compose, {
      conversationId: CONVERSATION,
      messageId: "msg_cancelled",
      principalId: PRINCIPAL,
      intent: "",
      layout: DASHBOARD,
      signal: controller.signal,
    });
    expect(outcome.ok === false && outcome.code).toBe("CANCELLED");
    expect(count("surface_compositions")).toBe(0);
  });
});

describe("a model proposing a layout through show_view", () => {
  it("is told the tree's grammar, its bounds and the widgets a leaf may name", () => {
    const overview = buildViewCatalog(services.conductor, compose).find((view) => view.id === "canvas.overview@1");
    expect(overview?.notes).toContain("props.layout");
    expect(overview?.notes).toContain("canvas.table@1");
    expect(overview?.notes).not.toContain("canvas.action@1");
    expect(overview?.notes).toContain(`At most ${String(MAX_LAYOUT_DEPTH)} levels`);
  });

  it("reads a refusal in the same turn, with the reason", async () => {
    const overview = buildViewCatalog(services.conductor, compose).find((view) => view.id === "canvas.overview@1");
    if (overview === undefined) throw new Error("no composed view");
    await expect(
      overview.build({
        props: { layout: { kind: "grid", children: [leaf("canvas.sparkle@1")] } },
        caption: "",
        at: AT,
        principal: { principalId: PRINCIPAL, kind: "user", nodeId: services.runtime.identity.nodeId as never },
        messageId: "msg_view_refused",
        conversationId: CONVERSATION,
      }),
    ).rejects.toThrow(/canvas\.sparkle@1/u);
  });

  it("draws history from the stored bundle, tree included", async () => {
    const overview = buildViewCatalog(services.conductor, compose).find((view) => view.id === "canvas.overview@1");
    if (overview === undefined) throw new Error("no composed view");
    // History is read as the node's owner, so the surface is composed as the owner too.
    const owner = services.runtime.identity.ownerPrincipalId as never;
    const block = await overview.build({
      props: { layout: DASHBOARD, title: "Bảng điều khiển" },
      caption: "",
      at: AT,
      principal: { principalId: owner, kind: "user", nodeId: services.runtime.identity.nodeId as never },
      messageId: "msg_history",
      conversationId: CONVERSATION,
    });
    if (block.type !== "surface") throw new Error("expected a surface");
    appendMessage(
      db(),
      {
        messageId: "msg_history",
        conversationId: CONVERSATION,
        role: "assistant",
        authorNodeId: services.runtime.identity.nodeId,
        delivery: "accepted",
        createdAt: AT,
        blocks: [block],
      } as never,
      1,
    );

    const deps: GatewayDeps = { services, now: () => AT };
    const get = (path: string) =>
      handleRequest(deps, {
        method: "GET",
        path,
        query: {},
        headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
        body: "",
      });

    const presented = await get(`/conversations/${CONVERSATION}/snapshots/${block.snapshot.snapshotId}/presentation`);
    expect(presented.status).toBe(200);
    const history = presented.body as { spec?: { layout?: unknown }; sections: { sectionId: string; rows?: unknown[] }[] };
    expect(history.spec?.layout).toEqual(findCompositionByMessage(db(), "msg_history", owner)?.layout);
    expect(history.sections.map((section) => section.sectionId)).toEqual(["metrics-1", "metrics-2", "filter-1", "table-1"]);

    const live = await get(`/conversations/${CONVERSATION}/widgets/${block.snapshot.instanceId ?? ""}/composition`);
    expect(live.status).toBe(200);
    expect((live.body as { spec: { layout?: { kind: string } } }).spec.layout?.kind).toBe("grid");
  });
});
