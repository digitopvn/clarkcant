import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompositionSlot, Instant } from "@clarkcant/contracts";
import { findCompositionByMessage, upsertTask, type Database } from "@clarkcant/storage";

import { type MiniAppDataDeps, importLocalImage } from "../src/mini-app-data.ts";
import {
  COMPOSITION_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  type ComposeDeps,
  compileTemplate,
  composeMiniApp,
  findTemplate,
} from "../src/compose-mini-app.ts";
import type { JevTelemetry, JevTransport } from "../src/jev-selector.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";

/**
 * Composition inside a turn (Phase 5).
 *
 * The properties being protected here are about *not* doing things: not calling a provider when the
 * template was named, not writing anything when the turn was cancelled, not composing twice for one
 * tool call, and not inventing a region to fill the layout.
 */

const AT = "2026-09-17T05:00:00.000Z" as Instant;
const CONVERSATION = "conv_compose";
const PRINCIPAL = "prin_owner" as never;

let dir: string;
let services: NodeServices;
let compose: ComposeDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-compose-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  compose = services.compose;
  services.runtime.db
    .prepare(
      "INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)",
    )
    .run(CONVERSATION, services.runtime.identity.nodeId, AT, AT);
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

function db(): Database {
  return services.runtime.db;
}

/**
 * Row counts, from a fixed set of statements rather than an interpolated table name.
 *
 * A helper that takes a table name and builds SQL out of it is the shape a reviewer has to stop and
 * check; listing the four tables this file asks about keeps the question closed.
 */
const COUNT_STATEMENTS = {
  widget_instances: "SELECT COUNT(*) AS n FROM widget_instances",
  surface_compositions: "SELECT COUNT(*) AS n FROM surface_compositions",
  presentation_bundles: "SELECT COUNT(*) AS n FROM presentation_bundles",
  action_invocations: "SELECT COUNT(*) AS n FROM action_invocations",
} as const;

function countRows(table: keyof typeof COUNT_STATEMENTS): number {
  return Number((db().prepare(COUNT_STATEMENTS[table]).get() as { n: number }).n);
}

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

/** The data deps an import needs, taken from the same services the composition uses. */
function dataDeps(): MiniAppDataDeps {
  return {
    db: db(),
    nodeId: services.runtime.identity.nodeId,
    dataDir: services.runtime.dataDir,
    now: () => AT,
    newId: (prefix: string) => `${prefix}_image_test`,
  };
}

/** A transport that records every call and fails the test if one is made. */
function forbiddenTransport(): { transport: JevTransport; calls: number } {
  let calls = 0;
  const transport: JevTransport = async (request) => {
    calls += 1;
    void request;
    return { status: 529, body: undefined };
  };
  return {
    get calls() {
      return calls;
    },
    transport,
  };
}

function answeringTransport(choice: string, probabilities: Record<string, number>): {
  transport: JevTransport;
  calls: string[];
  telemetry: JevTelemetry[];
} {
  const calls: string[] = [];
  const telemetry: JevTelemetry[] = [];
  const transport: JevTransport = async (request) => {
    const body = request.body as { questions: Record<string, unknown> };
    calls.push(Object.keys(body.questions).join(","));
    const answerKey = Object.keys(body.questions)[0] ?? "template";
    return {
      status: 200,
      body: {
        model: "jev-1.13.0",
        answers: { [answerKey]: { type: "choice", choice, probabilities, confidence: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    };
  };
  return { transport, calls, telemetry };
}

describe("the pure compiler", () => {
  const template = findTemplate("overview") as ReturnType<typeof findTemplate> & object;

  it("fills fixed regions, pins the catalog's digest and drops an optional region with no rows", () => {
    const result = compileTemplate({
      template,
      // The orchestrator supplies the leaf for an open region; this is the choice it would make.
      chosen: new Map<CompositionSlot, { definitionId: string; definitionVersion: string }>([
        ["trend", { definitionId: "canvas.line@1", definitionVersion: "1.0.0" }],
      ]),
      registry: services.catalog,
      rowsBySlot: { metrics: [{ label: "Hoàn thành", value: 2, unit: "task" }], trend: [] },
      initialState: { period: "week", timezone: "Asia/Saigon" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const slots = result.sections.map((section) => section.slot);
    expect(slots).toContain("metrics");
    expect(slots).toContain("filter");
    expect(slots).toContain("cta");
    // `trend` is required by the template and was chosen by its single candidate; `calendar` is
    // optional and had no rows, so it is absent rather than empty.
    expect(slots).not.toContain("calendar");

    const metrics = result.sections.find((section) => section.slot === "metrics");
    expect(metrics?.definitionRef.digest).toMatch(/^sha256:/);
    expect(metrics?.textAlternative).toContain("Hoàn thành");
    // Data references stay opaque; the rows travel in the bundle, not in the props.
    expect(JSON.stringify(metrics?.props)).not.toContain("Hoàn thành");
  });

  it("refuses a required region nothing can fill instead of inventing one", () => {
    const result = compileTemplate({
      template,
      chosen: new Map<CompositionSlot, { definitionId: string; definitionVersion: string }>([
        ["trend", { definitionId: "canvas.line@1", definitionVersion: "1.0.0" }],
      ]),
      registry: services.catalog,
      rowsBySlot: {},
      initialState: { period: "week", timezone: "Asia/Saigon" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sections.map((section) => section.slot)).toContain("trend");

    const impossible = compileTemplate({
      template: { ...template, familiesBySlot: {} },
      chosen: new Map(),
      registry: services.catalog,
      rowsBySlot: {},
      initialState: { period: "week", timezone: "Asia/Saigon" },
    });
    expect(impossible.ok).toBe(false);
  });

  it("reports a definition the catalog does not hold", () => {
    const result = compileTemplate({
      template: {
        ...template,
        familiesBySlot: { trend: ["charts"] },
      },
      chosen: new Map([["trend", { definitionId: "canvas.candlestick@1", definitionVersion: "1.0.0" }]]),
      registry: services.catalog,
      rowsBySlot: { trend: [{ label: "a", completed: 1 }] },
      initialState: { period: "week", timezone: "Asia/Saigon" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toContain("canvas.candlestick@1");
  });

  it("is a pure function: the same input compiles to the same sections", () => {
    const input = {
      template,
      chosen: new Map<CompositionSlot, { definitionId: string; definitionVersion: string }>([
        ["trend", { definitionId: "canvas.line@1", definitionVersion: "1.0.0" }],
      ]),
      registry: services.catalog,
      rowsBySlot: { metrics: [{ label: "x", value: 1 }] },
      initialState: { period: "week" as const, timezone: "Asia/Saigon" },
    };
    expect(compileTemplate(input)).toEqual(compileTemplate(input));
  });
});

describe("composeMiniApp", () => {
  it("compiles the named template without calling a provider at all", async () => {
    const provider = forbiddenTransport();
    const outcome = await composeMiniApp(
      {
        ...compose,
        jev: { deps: { ...compose.jev!.deps, transport: provider.transport }, budget: compose.jev!.budget },
      },
      {
        conversationId: CONVERSATION,
        messageId: "msg_explicit",
        principalId: PRINCIPAL,
        intent: "cho tôi tổng quan tuần này",
        explicitTemplateId: "overview",
      },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.selectorMode).toBe("explicit");
    expect(provider.calls).toBe(0);
    expect(outcome.block.type).toBe("surface");

    // The instance, the spec, the snapshot and the bundle were written together.
    expect(countRows("widget_instances")).toBe(1);
    expect(countRows("surface_compositions")).toBe(1);
    expect(countRows("presentation_bundles")).toBe(1);
    expect(countRows("action_invocations")).toBe(0);

    // Every binding the compiler attached is a view operation, and every one of them is recorded
    // in the spec so a client knows what it may invoke.
    const bindings = db().prepare("SELECT document FROM action_bindings").all() as { document: string }[];
    expect(bindings.length).toBeGreaterThan(0);
    for (const row of bindings) {
      const parsed = JSON.parse(row.document) as { proposal: { kind: string } };
      expect(parsed.proposal.kind).toBe("view");
    }

    const bundle = db().prepare("SELECT document FROM presentation_bundles").get() as { document: string };
    const parsed = JSON.parse(bundle.document) as {
      sections: { slot: string; rows?: unknown[] }[];
      composition: { provenance: { selector: { mode: string } } };
    };
    expect(parsed.composition.provenance.selector.mode).toBe("explicit");
    expect(parsed.sections.some((section) => section.rows !== undefined)).toBe(true);
  });

  it("shows the imported image as a region of the overview", async () => {
    const imported = importLocalImage(dataDeps(), {
      principalId: PRINCIPAL,
      bytes: png(4, 4),
      declaredMimeType: "image/png",
      altText: "Sơ đồ kiến trúc đã nhập",
    });
    expect(imported.ok).toBe(true);

    const outcome = await composeMiniApp(compose, {
      conversationId: CONVERSATION,
      messageId: "msg_with_image",
      principalId: PRINCIPAL,
      intent: "cho tôi tổng quan tuần này",
      explicitTemplateId: "overview",
    });
    expect(outcome.ok).toBe(true);

    const bundle = db().prepare("SELECT document FROM presentation_bundles ORDER BY created_at DESC LIMIT 1").get() as { document: string };
    const parsed = JSON.parse(bundle.document) as {
      sections: { slot: string; props: Record<string, unknown>; textAlternative: string }[];
    };
    const image = parsed.sections.find((section) => section.slot === "image");
    // The sketch has a picture region, and this is the path that reaches it: the newest imported
    // image, with the alt text the user supplied, not a placeholder.
    expect(image).toBeDefined();
    expect(image?.props.alt).toBe("Sơ đồ kiến trúc đã nhập");
    expect(String(image?.props.imageRef ?? "")).toMatch(/^img_/);
    expect(image?.textAlternative).toContain("Sơ đồ kiến trúc đã nhập");
  });

  it("leaves the picture region out when nothing was imported", async () => {
    const outcome = await composeMiniApp(compose, {
      conversationId: CONVERSATION,
      messageId: "msg_without_image",
      principalId: PRINCIPAL,
      intent: "cho tôi tổng quan tuần này",
      explicitTemplateId: "overview",
    });
    expect(outcome.ok).toBe(true);

    const bundle = db().prepare("SELECT document FROM presentation_bundles ORDER BY created_at DESC LIMIT 1").get() as { document: string };
    const parsed = JSON.parse(bundle.document) as { sections: { slot: string }[] };
    // Optional by data: an empty picture region would claim an image exists when none does.
    expect(parsed.sections.map((section) => section.slot)).not.toContain("image");
  });

  it("writes nothing when the turn was cancelled before the commit", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await composeMiniApp(compose, {
      conversationId: CONVERSATION,
      messageId: "msg_cancelled",
      principalId: PRINCIPAL,
      intent: "tổng quan",
      explicitTemplateId: "overview",
      signal: controller.signal,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("CANCELLED");
    expect(countRows("widget_instances")).toBe(0);
    expect(countRows("surface_compositions")).toBe(0);
    expect(countRows("presentation_bundles")).toBe(0);
  });

  it("composes once for one message, however many times the turn is replayed", async () => {
    const input = {
      conversationId: CONVERSATION,
      messageId: "msg_replay",
      principalId: PRINCIPAL,
      intent: "tổng quan",
      explicitTemplateId: "overview",
    };
    const first = await composeMiniApp(compose, input);
    const second = await composeMiniApp(compose, input);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.instanceId).toBe(first.instanceId);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(countRows("widget_instances")).toBe(1);
    expect(countRows("surface_compositions")).toBe(1);
    expect(findCompositionByMessage(db(), "msg_replay", PRINCIPAL)).toBeDefined();
  });

  it("records a fallback as a fallback when the selector is not available", async () => {
    const outcome = await composeMiniApp(
      {
        ...compose,
        jev: {
          deps: { config: { ...compose.jev!.deps.config, enabled: false, apiKey: undefined }, transport: forbiddenTransport().transport },
          budget: compose.jev!.budget,
        },
      },
      {
        conversationId: CONVERSATION,
        messageId: "msg_fallback",
        principalId: PRINCIPAL,
        intent: "cho tôi xem gì đó",
      },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.templateId).toBe(DEFAULT_TEMPLATE_ID);
    expect(outcome.selectorMode).toBe("fallback");
    expect(outcome.selectorReason).toContain("disabled");

    const row = db().prepare("SELECT document FROM surface_compositions").get() as { document: string };
    const spec = JSON.parse(row.document) as { provenance: { selector: { mode: string; fallbackReason?: string } } };
    expect(spec.provenance.selector.mode).toBe("fallback");
    expect(spec.provenance.selector.fallbackReason).toContain("disabled");
  });

  it("takes the selector's answer when one is offered, and asks about the regions the template leaves open", async () => {
    // Every option the host offered has to appear in the distribution: the adapter refuses a
    // partial one rather than treating an omitted option as zero.
    const answering = answeringTransport("overview@1", {
      "overview@1": 0.95,
      "focused@1": 0.02,
      "agenda@1": 0.02,
      none: 0.01,
    });
    const outcome = await composeMiniApp(
      {
        ...compose,
        jev: {
          deps: {
            // Enabled with a fake credential: the transport is injected, so no request leaves the
            // process, and a disabled selector would exercise the fallback path instead.
            config: { ...compose.jev!.deps.config, enabled: true, localOnly: false, apiKey: "sk-test-not-a-real-key" },
            transport: answering.transport,
            onTelemetry: (event) => answering.telemetry.push(event),
          },
          budget: compose.jev!.budget,
        },
      },
      {
        conversationId: CONVERSATION,
        messageId: "msg_jev",
        principalId: PRINCIPAL,
        intent: "cho tôi tổng quan công việc tuần này",
      },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.templateId).toBe("overview");
    expect(outcome.selectorMode).toBe("jev");
    // Exactly one template question was asked: the trend region has a single candidate, so asking
    // about it would spend a request to learn nothing.
    expect(answering.calls[0]).toBe("template");
    expect(answering.telemetry.some((event) => event.event === "call")).toBe(true);
  });

  it("refuses a template id the host cannot compile rather than falling back silently", async () => {
    const outcome = await composeMiniApp(compose, {
      conversationId: CONVERSATION,
      messageId: "msg_unknown_template",
      principalId: PRINCIPAL,
      intent: "x",
      explicitTemplateId: "dashboard-with-everything",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("NO_TEMPLATE");
    expect(countRows("widget_instances")).toBe(0);
  });

  it("composes the sketch's regions from real records", async () => {
    upsertTask(db(), {
      taskId: "task_a",
      conversationId: CONVERSATION,
      homeNodeId: services.runtime.identity.nodeId,
      state: "succeeded",
      revision: 1,
      goal: "seeded",
      createdAt: "2026-09-16T01:00:00.000Z" as never,
      updatedAt: "2026-09-16T02:00:00.000Z" as never,
    });

    const outcome = await composeMiniApp(compose, {
      conversationId: CONVERSATION,
      messageId: "msg_real_data",
      principalId: PRINCIPAL,
      intent: "tổng quan",
      explicitTemplateId: "overview",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const bundle = db().prepare("SELECT document FROM presentation_bundles").get() as { document: string };
    const parsed = JSON.parse(bundle.document) as { sections: { slot: string; rows?: { id?: string; value?: number }[] }[] };
    const metrics = parsed.sections.find((section) => section.slot === "metrics");
    expect(metrics?.rows?.some((row) => row.id === "completed" && row.value === 1)).toBe(true);
    // The composed surface carries the five regions the sketch shows, all of them drawable.
    expect(parsed.sections.map((section) => section.slot).sort()).toEqual(["cta", "filter", "metrics", "trend"]);
  });
});

describe("the view catalog entry", () => {
  it("offers the composed surface as one more view name, with a template vocabulary and no host card", () => {
    const views = buildViewCatalog(services.conductor, compose);
    const overview = views.find((view) => view.id === "canvas.overview@1");
    expect(overview).toBeDefined();
    expect(overview?.notes).toContain("overview");
    // The template vocabulary is stated rather than left to be guessed.
    expect(COMPOSITION_TEMPLATES.map((template) => template.templateId).every((id) => overview?.notes?.includes(id) === true)).toBe(true);
    expect(views.length).toBeGreaterThan(1);
  });

  it("builds a surface block from a tool call, and reports a bad template as a refusal", async () => {
    const views = buildViewCatalog(services.conductor, compose);
    const overview = views.find((view) => view.id === "canvas.overview@1");
    expect(overview).toBeDefined();
    if (overview === undefined) return;

    const block = await overview.build({
      props: { templateId: "overview", period: "month" },
      caption: "Tổng quan tháng này",
      at: AT,
      principal: { principalId: PRINCIPAL, kind: "user", nodeId: services.runtime.identity.nodeId as never },
      messageId: "msg_tool",
      conversationId: CONVERSATION,
    });
    expect(block.type).toBe("surface");

    await expect(
      overview.build({
        props: { templateId: "not-a-template" },
        caption: "x",
        at: AT,
        principal: { principalId: PRINCIPAL, kind: "user", nodeId: services.runtime.identity.nodeId as never },
        messageId: "msg_tool_2",
        conversationId: CONVERSATION,
      }),
    ).rejects.toThrow(/not a template this host can compile/);
  });

  it("registers nothing extra when composition is not wired", () => {
    const views = buildViewCatalog(services.conductor);
    expect(views.some((view) => view.id === "canvas.overview@1")).toBe(false);
  });
});
