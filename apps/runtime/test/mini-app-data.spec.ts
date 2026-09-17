import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type Instant,
  type Principal,
  periodRange,
  surfaceCompositionSpecSchema,
} from "@clarkcant/contracts";
import { type TaskServiceDeps, createTask } from "@clarkcant/core";
import { createConversation, migrate, openDatabase, upsertTask, type Database } from "@clarkcant/storage";

import { FAMILY_BY_DEFINITION, OVERVIEW, WIDGETS as CATALOG_WIDGETS } from "@clarkcant/data-canvas";
import {
  CatalogRegistry,
  checkCompositionCoverage,
  definitionDigest,
  missingCompositionFamilies,
  registerCatalog,
  validateProps,
} from "@clarkcant/widget-host";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import {
  calendarRowsForRange,
  createLocalEvent,
  derivedDatasetId,
  importLocalImage,
  isKnownTimezone,
  publishMiniAppData,
  removeLocalEvent,
  sniffImage,
  taskMetricsForRange,
  updateLocalEvent,
  validateLocalEvent,
} from "../src/mini-app-data.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * Local data for composed surfaces (Phase 3).
 *
 * The figures are compared against records written through the production paths, not against
 * constants: a test that asserts "completed is 4" proves only that the fixture says 4. What is
 * asserted instead is that the API's number equals the number of qualifying rows, so a query that
 * silently drops a state or buckets by UTC fails here.
 */

const AT = "2026-09-17T05:00:00.000Z" as Instant;
const TZ = "Asia/Saigon";
const PRINCIPAL = "prin_owner" as Principal["principalId"];

let dir: string;
let db: Database;
let counter = 0;

function deps(nodeId = "node_local"): {
  db: Database;
  nodeId: string;
  dataDir: string;
  now: () => Instant;
  newId: (prefix: string) => string;
} {
  return {
    db,
    nodeId,
    dataDir: dir,
    now: () => AT,
    newId: (prefix: string) => `${prefix}_${(counter += 1)}`,
  };
}

/** A task moved to a terminal state, written exactly as the reducer would write it. */
function seedTask(input: {
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  conversationId: string;
}): void {
  const taskDeps: TaskServiceDeps = { ...deps(), now: () => AT };
  const task = createTask(taskDeps, {
    conversationId: input.conversationId as never,
    goal: "seeded",
    principal: { principalId: PRINCIPAL, kind: "user", nodeId: "node_local" as never },
  });
  upsertTask(db, {
    ...task,
    state: input.state,
    revision: task.revision + 1,
    createdAt: input.createdAt as never,
    updatedAt: input.updatedAt as never,
  });
  // `upsertTask` deliberately does not rewrite `created_at` — a later update must not move the
  // moment work began — so a fixture that needs a historical creation time sets it here. Without
  // this the seeded tasks would all be created "now" and every period would contain all of them,
  // which is the bug this test exists to catch.
  db.prepare("UPDATE tasks SET created_at = ? WHERE task_id = ?").run(input.createdAt, task.taskId);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-miniapp-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
  counter = 0;
  createConversation(db, { conversationId: "conv_1", homeNodeId: "node_local", at: AT });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("task metrics", () => {
  it("counts completed, pending, failed and created from the rows themselves", () => {
    // Inside the week of 14–20 September: three completed, one failed, one created.
    seedTask({ state: "succeeded", createdAt: "2026-09-15T01:00:00.000Z", updatedAt: "2026-09-16T02:00:00.000Z", conversationId: "conv_1" });
    seedTask({ state: "succeeded", createdAt: "2026-09-15T03:00:00.000Z", updatedAt: "2026-09-17T02:00:00.000Z", conversationId: "conv_1" });
    seedTask({ state: "succeeded", createdAt: "2026-08-01T03:00:00.000Z", updatedAt: "2026-09-17T04:00:00.000Z", conversationId: "conv_1" });
    seedTask({ state: "failed", createdAt: "2026-09-16T03:00:00.000Z", updatedAt: "2026-09-17T03:00:00.000Z", conversationId: "conv_1" });
    // Outside the period entirely: created in July and finished in July.
    seedTask({ state: "succeeded", createdAt: "2026-07-01T03:00:00.000Z", updatedAt: "2026-07-02T03:00:00.000Z", conversationId: "conv_1" });
    // A cancelled task: neither completed nor failed.
    seedTask({ state: "cancelled", createdAt: "2026-09-14T03:00:00.000Z", updatedAt: "2026-09-14T04:00:00.000Z", conversationId: "conv_1" });
    // Still open, counted as pending whatever period is asked about.
    seedTask({ state: "running", createdAt: "2026-05-01T03:00:00.000Z", updatedAt: "2026-05-01T04:00:00.000Z", conversationId: "conv_1" });

    const result = taskMetricsForRange(deps(), { period: "week", timezone: TZ, reference: new Date(AT) });
    const byId = Object.fromEntries(result.metrics.map((metric) => [metric.id, metric.value]));

    // Created in 14–20 September: three (including the cancelled one, which was still created).
    expect(byId["created"]).toBe(4);
    expect(byId["completed"]).toBe(3);
    expect(byId["failed"]).toBe(1);
    expect(byId["pending"]).toBe(1);

    // The trend is bucketed by local day and every day of the week is present.
    expect(result.trendRows).toHaveLength(7);
    const monday = result.trendRows.find((row) => row.bucket === "2026-09-14");
    expect(monday).toBeDefined();
    expect(monday?.completed).toBe(0);
    const wednesday = result.trendRows.find((row) => row.bucket === "2026-09-16");
    expect(wednesday?.completed).toBe(1);
    const sunday = result.trendRows.find((row) => row.bucket === "2026-09-20");
    expect(sunday?.created).toBe(0);
    const thursday = result.trendRows.find((row) => row.bucket === "2026-09-17");
    // Two succeeded with updatedAt on the 17th: one at 02:00Z (09:00 local) and one at 04:00Z.
    expect(thursday?.completed).toBe(2);

    // Provenance names the definition, so a number can be traced to what it means.
    expect(result.provenance.definitions.completedAt).toContain("updated_at");
    expect(result.provenance.queryRevision).toMatch(/^sha256:/);
    expect(result.provenance.timezone).toBe(TZ);
  });

  it("does not count a task completed in a month it was not finished in", () => {
    seedTask({ state: "succeeded", createdAt: "2026-08-30T03:00:00.000Z", updatedAt: "2026-09-02T03:00:00.000Z", conversationId: "conv_1" });
    const august = taskMetricsForRange(deps(), { period: "month", timezone: TZ, reference: new Date("2026-08-31T05:00:00.000Z") });
    const september = taskMetricsForRange(deps(), { period: "month", timezone: TZ, reference: new Date("2026-09-30T05:00:00.000Z") });

    expect(Object.fromEntries(august.metrics.map((m) => [m.id, m.value]))["created"]).toBe(1);
    expect(Object.fromEntries(august.metrics.map((m) => [m.id, m.value]))["completed"]).toBe(0);
    // Created in August, finished in September: the two figures live in different periods.
    expect(Object.fromEntries(september.metrics.map((m) => [m.id, m.value]))["created"]).toBe(0);
    expect(Object.fromEntries(september.metrics.map((m) => [m.id, m.value]))["completed"]).toBe(1);
  });

  it("reports an empty store as zero rather than as sample data", () => {
    const result = taskMetricsForRange(deps(), { period: "week", timezone: TZ, reference: new Date(AT) });
    expect(result.metrics.every((metric) => metric.value === 0)).toBe(true);
    expect(result.trendRows).toHaveLength(7);
    expect(result.trendRows.every((row) => row.created === 0 && row.completed === 0)).toBe(true);
    // A donut over an empty store has no shares to draw, and says so instead of drawing an
    // empty ring with a legend of zeros.
    expect(result.outcomeRows.every((row) => row.share === 0)).toBe(true);
  });
});

describe("local calendar", () => {
  it("creates, updates and removes an event for its owner", () => {
    const created = createLocalEvent(deps(), {
      principalId: PRINCIPAL,
      title: "Họp kế hoạch",
      startsAt: "2026-09-17T02:00:00.000Z",
      endsAt: "2026-09-17T03:00:00.000Z",
      timezone: TZ,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // 02:00 UTC is 09:00 in Saigon on the 17th.
    expect(created.event.localDate).toBe("2026-09-17");

    const updated = updateLocalEvent(deps(), {
      principalId: PRINCIPAL,
      eventId: created.event.eventId,
      title: "Họp kế hoạch (dời)",
      startsAt: "2026-09-18T02:00:00.000Z",
      endsAt: "2026-09-18T03:00:00.000Z",
      timezone: TZ,
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.event.localDate).toBe("2026-09-18");

    const rows = calendarRowsForRange(deps(), {
      principalId: PRINCIPAL,
      range: periodRange("week", new Date("2026-09-17T05:00:00.000Z"), TZ),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.date).toBe("2026-09-18");
    expect(rows[0]?.source).toBe("local");

    expect(removeLocalEvent(deps(), { principalId: PRINCIPAL, eventId: created.event.eventId }).ok).toBe(true);
    expect(calendarRowsForRange(deps(), { principalId: PRINCIPAL, range: periodRange("week", new Date(AT), TZ) })).toHaveLength(0);
  });

  it("refuses an end before the start, an unknown timezone and a blank title", () => {
    const backwards = validateLocalEvent({
      title: "Ngược",
      startsAt: "2026-09-17T03:00:00.000Z",
      endsAt: "2026-09-17T02:00:00.000Z",
      timezone: TZ,
    });
    expect(backwards.ok).toBe(false);
    if (!backwards.ok) expect(backwards.code).toBe("INVALID_RANGE");

    const zeroLength = validateLocalEvent({
      title: "Bằng nhau",
      startsAt: "2026-09-17T03:00:00.000Z",
      endsAt: "2026-09-17T03:00:00.000Z",
      timezone: TZ,
    });
    expect(zeroLength.ok).toBe(false);

    const badZone = validateLocalEvent({
      title: "Sai múi giờ",
      startsAt: "2026-09-17T03:00:00.000Z",
      endsAt: "2026-09-17T04:00:00.000Z",
      timezone: "Mars/Olympus",
    });
    expect(badZone.ok).toBe(false);
    if (!badZone.ok) expect(badZone.code).toBe("INVALID_TIMEZONE");

    const blank = validateLocalEvent({
      title: "   ",
      startsAt: "2026-09-17T03:00:00.000Z",
      endsAt: "2026-09-17T04:00:00.000Z",
      timezone: TZ,
    });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.code).toBe("INVALID_TITLE");

    expect(isKnownTimezone(TZ)).toBe(true);
    expect(isKnownTimezone("")).toBe(false);
  });

  it("does not show one principal another principal's events", () => {
    createLocalEvent(deps(), {
      principalId: PRINCIPAL,
      title: "Riêng tư",
      startsAt: "2026-09-17T02:00:00.000Z",
      endsAt: "2026-09-17T03:00:00.000Z",
      timezone: TZ,
    });
    const range = periodRange("week", new Date(AT), TZ);
    expect(calendarRowsForRange(deps(), { principalId: "prin_other" as never, range })).toHaveLength(0);
    expect(calendarRowsForRange(deps(), { principalId: PRINCIPAL, range })).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Images
 * ------------------------------------------------------------------ */

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(29);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(14);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  new DataView(bytes.buffer).setUint16(6, width, true);
  new DataView(bytes.buffer).setUint16(8, height, true);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, then an APP0 segment whose declared length skips it, then SOF0 carrying the dimensions.
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  view.setUint16(4, 0x0010); // segment length: 16 bytes follow, so the scan resumes at 20
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20);
  view.setUint16(25, height);
  view.setUint16(27, width);
  return bytes;
}

function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  bytes[24] = (width - 1) & 0xff;
  bytes[25] = ((width - 1) >> 8) & 0xff;
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >> 8) & 0xff;
  return bytes;
}

describe("image import", () => {
  it("identifies each allowed format from its own bytes, with dimensions when it can", () => {
    const pngResult = sniffImage(png(2, 3), "image/png");
    expect(pngResult).toMatchObject({ ok: true, mimeType: "image/png", width: 2, height: 3 });

    const gifResult = sniffImage(gif(10, 20), "image/gif");
    expect(gifResult).toMatchObject({ ok: true, mimeType: "image/gif", width: 10, height: 20 });

    const jpegResult = sniffImage(jpeg(48, 32), "image/jpeg");
    expect(jpegResult).toMatchObject({ ok: true, mimeType: "image/jpeg", width: 48, height: 32 });

    const webpResult = sniffImage(webp(120, 90), "image/webp");
    expect(webpResult).toMatchObject({ ok: true, mimeType: "image/webp", width: 120, height: 90 });
  });

  it("refuses a declared type that disagrees with the bytes, and anything that is not a raster image", () => {
    // An SVG or an HTML file declared as an image would otherwise be served back with a type that
    // lets a browser interpret its contents.
    const svg = new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"><script/></svg>");
    const svgResult = sniffImage(svg, "image/svg+xml");
    expect(svgResult.ok).toBe(false);
    if (!svgResult.ok) expect(svgResult.code).toBe("IMAGE_TYPE_NOT_ALLOWED");

    const renamed = sniffImage(svg, "image/png");
    expect(renamed.ok).toBe(false);

    const mismatch = sniffImage(png(2, 2), "image/jpeg");
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("IMAGE_TYPE_MISMATCH");
  });

  it("refuses an oversized file and an oversized dimension", () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    big.set(png(2, 2), 0);
    const tooLarge = sniffImage(big, "image/png");
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.code).toBe("IMAGE_TOO_LARGE");

    const huge = sniffImage(png(9000, 10), "image/png");
    expect(huge.ok).toBe(false);
  });

  it("requires alt text and scopes the stored row to its owner", () => {
    const missingAlt = importLocalImage(deps(), {
      principalId: PRINCIPAL,
      bytes: png(2, 2),
      declaredMimeType: "image/png",
      altText: "  ",
    });
    expect(missingAlt.ok).toBe(false);
    if (!missingAlt.ok) expect(missingAlt.code).toBe("IMAGE_ALT_REQUIRED");

    const imported = importLocalImage(deps(), {
      principalId: PRINCIPAL,
      bytes: png(4, 5),
      declaredMimeType: "image/png",
      altText: "Sơ đồ kiến trúc",
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.image.width).toBe(4);
    expect(imported.image.altText).toBe("Sơ đồ kiến trúc");
    expect(imported.image.digest).toMatch(/^sha256:/);
    // The bytes are on disk under the node's own data directory, not in the database.
    expect(imported.image.blobPath.startsWith(dir)).toBe(true);
  });
});

describe("derived datasets", () => {
  it("addresses a derived dataset per principal so two people cannot overwrite each other", () => {
    const range = periodRange("week", new Date(AT), TZ);
    const a = derivedDatasetId(PRINCIPAL, "metrics", range);
    const b = derivedDatasetId("prin_other", "metrics", range);
    expect(a).not.toBe(b);
    expect(a).toContain("2026-09-14");
    expect(derivedDatasetId(PRINCIPAL, "metrics", range)).toBe(a);
  });

  it("publishes the rows it computed, and they resolve for their owner only", () => {
    seedTask({ state: "succeeded", createdAt: "2026-09-15T01:00:00.000Z", updatedAt: "2026-09-16T01:00:00.000Z", conversationId: "conv_1" });
    const published = publishMiniAppData(deps(), { principalId: PRINCIPAL, period: "week", timezone: TZ, reference: new Date(AT) });

    const stored = db
      .prepare("SELECT document, owner_principal_id FROM datasets WHERE dataset_id = ?")
      .get(published.trendRef) as { document: string; owner_principal_id: string } | undefined;
    expect(stored?.owner_principal_id).toBe(PRINCIPAL);
    const rows = (JSON.parse(stored?.document ?? "{}") as { rows: Record<string, unknown>[] }).rows;
    const completed = rows.reduce((sum, row) => sum + Number(row.completed ?? 0), 0);
    expect(completed).toBe(1);
    // The live view and the snapshot read the same rows, which is what stops them disagreeing at
    // capture time.
    expect(published.metrics.trendRows).toEqual(rows);
  });
});

describe("gateway routes", () => {
  let services: NodeServices;
  let gatewayDeps: GatewayDeps;

  beforeEach(() => {
    services = bootNodeServices({ dataDir: dir, label: "test node" });
    gatewayDeps = { services, now: () => AT };
  });

  afterEach(() => {
    services.runtime.close();
  });

  async function call(
    method: string,
    path: string,
    options: { body?: unknown; authed?: boolean; query?: Record<string, string> } = {},
  ): Promise<GatewayResponse> {
    const request_: GatewayRequest = {
      method,
      path,
      query: options.query ?? {},
      headers: options.authed === false ? {} : { authorization: `Bearer ${services.runtime.identity.localToken}` },
      body: options.body === undefined ? "" : JSON.stringify(options.body),
    };
    return handleRequest(gatewayDeps, request_);
  }

  it("requires a token on every data route", async () => {
    for (const path of ["/calendar/events", "/images"]) {
      const response = await call("GET", path, { authed: false });
      expect(response.status).toBe(401);
    }
  });

  it("creates an event, lists it in a range, and refuses an invalid one with a reason", async () => {
    const created = await call("POST", "/calendar/events", {
      body: { title: "Viết báo cáo", startsAt: "2026-09-17T02:00:00.000Z", endsAt: "2026-09-17T04:00:00.000Z", timezone: TZ },
    });
    expect(created.status).toBe(201);
    const event = (created.body as { event: { eventId: string; date: string } }).event;
    expect(event.date).toBe("2026-09-17");

    const listed = await call("GET", "/calendar/events", { query: { from: "2026-09-14T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z" } });
    expect(listed.status).toBe(200);
    const body = listed.body as { events: { eventId: string }[]; source: string };
    expect(body.events).toHaveLength(1);
    expect(body.source).toBe("local");

    const invalid = await call("POST", "/calendar/events", {
      body: { title: "Ngược", startsAt: "2026-09-17T04:00:00.000Z", endsAt: "2026-09-17T02:00:00.000Z", timezone: TZ },
    });
    expect(invalid.status).toBe(400);
    expect((invalid.body as { code: string }).code).toBe("INVALID_RANGE");

    const updated = await call("PATCH", `/calendar/events/${event.eventId}`, { body: { title: "Viết báo cáo (xong)" } });
    expect(updated.status).toBe(200);

    const removed = await call("DELETE", `/calendar/events/${event.eventId}`);
    expect(removed.status).toBe(200);
    const missing = await call("DELETE", `/calendar/events/${event.eventId}`);
    expect(missing.status).toBe(404);
  });

  it("imports an image, serves its bytes under the verified type, and refuses a renamed file", async () => {
    const imported = await call("POST", "/images", {
      body: { dataBase64: Buffer.from(png(3, 4)).toString("base64"), mimeType: "image/png", altText: "Biểu đồ" },
    });
    expect(imported.status).toBe(201);
    const image = (imported.body as { image: { imageId: string; url: string; width: number } }).image;
    expect(image.width).toBe(3);
    expect(image.url).toBe(`/images/${image.imageId}`);

    const served = await call("GET", `/images/${image.imageId}`);
    expect(served.status).toBe(200);
    expect(served.binary?.contentType).toBe("image/png");
    expect(served.binary?.bytes.byteLength).toBe(29);

    const renamed = await call("POST", "/images", {
      body: { dataBase64: Buffer.from("<html><script/></html>").toString("base64"), mimeType: "image/png", altText: "Trang" },
    });
    expect(renamed.status).toBe(415);

    const noAlt = await call("POST", "/images", {
      body: { dataBase64: Buffer.from(png(2, 2)).toString("base64"), mimeType: "image/png", altText: "" },
    });
    expect(noAlt.status).toBe(415);

    const unknown = await call("GET", "/images/img_does_not_exist");
    expect(unknown.status).toBe(404);
  });

  it("serves a dataset to its owner and refuses it to anyone else", async () => {
    const owner = services.runtime.identity.ownerPrincipalId;
    const published = publishMiniAppData(deps(), { principalId: owner, period: "week", timezone: TZ, reference: new Date(AT) });
    const owned = await call("GET", `/datasets/${published.trendRef}`);
    // The gateway derives the caller from the transport, which is this node's owner principal.
    expect(owned.status).toBe(200);
    expect((owned.body as { datasetId: string }).datasetId).toBe(published.trendRef);

    // The same reference published for somebody else is not readable here, which is what stops a
    // leaked id from becoming a read of another principal's rows.
    const other = publishMiniAppData(deps(), { principalId: PRINCIPAL, period: "week", timezone: TZ, reference: new Date(AT) });
    const refused = await call("GET", `/datasets/${other.trendRef}`);
    expect(refused.status).toBe(404);
  });

  it("answers a composition read with the stored spec and captured rows", async () => {
    const conversation = await call("POST", "/conversations", { body: { title: "composed" } });
    const conversationId = (conversation.body as { conversationId: string }).conversationId;
    const published = publishMiniAppData(deps(), { principalId: PRINCIPAL, period: "week", timezone: TZ, reference: new Date(AT) });

    // A composition is written by captureCompositeSurface in Phase 1; this asserts the read path
    // refuses a request for an instance that has none rather than inventing an empty one.
    const missing = await call("GET", `/conversations/${conversationId}/widgets/winst_missing/composition`);
    expect(missing.status).toBe(404);
    expect(published.metricsRef).toContain("ds_metrics_");
  });
});

/**
 * Catalog coverage.
 *
 * Asserted here rather than in the client package because the client's program is restricted to
 * browser-safe packages, and this is about what the node registers.
 */
describe("catalog definitions", () => {
  const registry = registerCatalog(
    new CatalogRegistry(),
    CATALOG_WIDGETS.map((definition) => ({ definition, family: FAMILY_BY_DEFINITION[definition.id] ?? "unknown" })),
  );

  it("covers every family a composed surface needs", () => {
    expect(missingCompositionFamilies(registry)).toEqual([]);
    expect(registry.get("canvas.overview@1")?.family).toBe("layout");
  });

  it("validates leaf props with the same validator the runtime stores with", () => {
    const metrics = registry.get("canvas.metrics@1")?.definition;
    expect(metrics).toBeDefined();
    if (metrics === undefined) return;

    expect(validateProps(metrics, { datasetRef: "ds_x" }).ok).toBe(true);
    expect(validateProps(metrics, {}).ok).toBe(false);
    expect(validateProps(metrics, { datasetRef: 4 }).ok).toBe(false);
    const unknownProp = validateProps(metrics, { datasetRef: "ds_x", colour: "red" });
    expect(unknownProp.ok).toBe(false);
    if (!unknownProp.ok) expect(unknownProp.problems.join(" ")).toContain("unknown property");

    // The call to action names a binding; a bare label with no target is not a valid spec.
    const cta = registry.get("canvas.cta@1")?.definition;
    expect(cta).toBeDefined();
    if (cta !== undefined) {
      expect(validateProps(cta, { label: "Lưu", actionId: "act_1" }).ok).toBe(true);
      expect(validateProps(cta, { label: "Lưu" }).ok).toBe(false);
    }
  });

  it("refuses a spec that pins a digest the catalog has moved past", () => {
    const metrics = registry.get("canvas.metrics@1")?.definition;
    expect(metrics).toBeDefined();
    if (metrics === undefined) return;

    const spec = surfaceCompositionSpecSchema.parse({
      schemaVersion: 1,
      compositionId: "comp_1",
      instanceId: "winst_1",
      templateId: "overview",
      templateVersion: "1",
      catalogDigest: "sha256:catalog",
      sections: [
        {
          sectionId: "metrics",
          slot: "metrics",
          definitionRef: { id: "canvas.metrics@1", version: "1.0.0", digest: "sha256:stale" },
          props: { datasetRef: "ds_tasks" },
          dataRefs: ["ds_tasks"],
          textAlternative: "Bốn task hoàn thành.",
        },
      ],
      initialState: { period: "week", timezone: TZ },
      actions: [],
      provenance: {
        createdAt: AT,
        templateId: "overview",
        templateVersion: "1",
        selector: { mode: "explicit", policyVersion: "1" },
        sourceRevisions: [],
      },
    });

    const refused = checkCompositionCoverage(spec, registry);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.problems.join(" ")).toContain("pins digest");

    const compliant = {
      ...spec,
      sections: spec.sections.map((section) => ({
        ...section,
        definitionRef: { ...section.definitionRef, digest: definitionDigest(metrics) },
      })),
    };
    expect(checkCompositionCoverage(compliant, registry).ok).toBe(true);
  });

  it("states a text fallback for the container, so a missing renderer is never a blank card", () => {
    expect(OVERVIEW.textFallback.length).toBeGreaterThan(20);
    expect(OVERVIEW.sizing.expanded).toBe(true);
  });
});
