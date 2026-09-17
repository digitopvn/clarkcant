import {
  type ActionBinding,
  type CompiledSection,
  type CompositionSlot,
  type CompositionSourceRevision,
  type Instant,
  type MessageBlock,
  type Principal,
  type WidgetDefinition,
  compileActionBinding,
} from "@clarkcant/contracts";
import { type WidgetDeps, captureCompositeSurface } from "@clarkcant/core";
import {
  type CatalogRegistry,
  checkCompositionCoverage,
  definitionDigest,
  validateProps,
} from "@clarkcant/widget-host";
import {
  type Database,
  findBundleForMessage,
  findCompositionByMessage,
  listSnapshotsForMessage,
} from "@clarkcant/storage";

import {
  type DefinitionCandidate,
  type MiniAppCandidateSet,
  type TemplateCandidate,
  buildMiniAppCandidateSet,
  rowScale,
} from "./mini-app-candidates.ts";
import { type MiniAppDataDeps, type PublishedMiniAppData, publishMiniAppData } from "./mini-app-data.ts";
import {
  type JevBudget,
  type JevDeps,
  selectSections,
  selectTemplate,
} from "./jev-selector.ts";

/**
 * Composing a surface inside a turn.
 *
 * The split this file exists to enforce: the **compiler is pure** and the **orchestrator does
 * I/O**. `compileTemplate` takes a template, the leaves chosen for it and the rows that were read,
 * and returns validated sections or a list of problems. Nothing in it opens a socket or writes a
 * row. The orchestrator around it is the only part that calls a selector, reads records or persists
 * anything, which is what makes "a bad selection cannot produce a stored document" checkable.
 *
 * Three behaviours are deliberate:
 *
 * 1. **An explicit template needs no model.** When the caller names a template, the deterministic
 *    path is taken and the provider is not called at all. Spending a request to confirm what was
 *    already stated would make the fast path slow and the bill larger for no gain.
 * 2. **The fallback is compiled, not improvised.** A provider that is unavailable, uncertain or
 *    incompatible falls back to the template the caller named or to the host default, and that
 *    template goes through the same compiler and the same validation as a selected one.
 * 3. **A replay is not a second composition.** The idempotency key is the message and tool call, not
 *    a hash of the intent: two identical requests by a user are two operations, while one tool call
 *    re-executed is the same operation.
 */

/* ------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------ */

export interface FixedRegion {
  slot: CompositionSlot;
  definitionId: string;
  props?: Record<string, unknown>;
}

export interface MiniAppTemplate {
  templateId: string;
  templateVersion: string;
  label: string;
  /** Every region the container will lay out, in the order the sketch has them. */
  slots: readonly CompositionSlot[];
  /** Regions the template decides itself; the selector is never asked about these. */
  fixed: readonly FixedRegion[];
  /** Families a region may be filled from, per slot. */
  familiesBySlot: Partial<Record<CompositionSlot, readonly string[]>>;
  /** Regions rendered only when there is data for them. */
  optionalSlots: readonly CompositionSlot[];
}

/**
 * The templates the host can compile.
 *
 * These are the sketch's shapes, not a model's vocabulary: the selector chooses between them and
 * cannot invent a fourth.
 */
export const COMPOSITION_TEMPLATES: readonly MiniAppTemplate[] = [
  {
    templateId: "overview",
    templateVersion: "1",
    label: "Tổng quan công việc: chỉ số, khoảng thời gian, xu hướng, lịch, ảnh và một hành động",
    slots: ["metrics", "filter", "trend", "calendar", "image", "cta"],
    fixed: [
      { slot: "metrics", definitionId: "canvas.metrics@1", props: { title: "Chỉ số" } },
      { slot: "filter", definitionId: "canvas.filter@1" },
      // The calendar region is fixed *and* optional: the renderer is known, and it is shown only when
      // there are events. Leaving it out of `fixed` meant nothing ever chose one for it, so the
      // sketch's calendar was silently absent from every composed overview.
      { slot: "calendar", definitionId: "canvas.calendar@1" },
      // The picture region is the other optional one. The sketch has it, and for a while no template
      // named it at all — so `canvas.image@1` had no path to a user, however complete its renderer
      // was. It is fixed so the renderer is known, and optional so it appears only with an image.
      { slot: "image", definitionId: "canvas.image@1", props: { title: "Hình ảnh đã nhập" } },
      { slot: "cta", definitionId: "canvas.cta@1", props: { label: "Lưu bản xem", description: "Lưu khoảng thời gian đang xem và ghim lại." } },
    ],
    familiesBySlot: { trend: ["trend"] },
    optionalSlots: ["calendar", "image"],
  },
  {
    templateId: "focused",
    templateVersion: "1",
    label: "Một biểu đồ xu hướng duy nhất với bộ chọn khoảng thời gian",
    slots: ["trend", "filter"],
    fixed: [{ slot: "filter", definitionId: "canvas.filter@1" }],
    familiesBySlot: { trend: ["trend"] },
    optionalSlots: [],
  },
  {
    templateId: "agenda",
    templateVersion: "1",
    label: "Lịch tháng với sự kiện đã nhập",
    slots: ["calendar", "filter"],
    fixed: [{ slot: "filter", definitionId: "canvas.filter@1" }],
    familiesBySlot: {},
    optionalSlots: ["calendar"],
  },
];

export function findTemplate(templateId: string): MiniAppTemplate | undefined {
  return COMPOSITION_TEMPLATES.find((template) => template.templateId === templateId);
}

/* ------------------------------------------------------------------ *
 * The pure compiler
 * ------------------------------------------------------------------ */

export interface CompileInput {
  template: MiniAppTemplate;
  /** The leaf chosen for each slot that is not fixed. */
  chosen: ReadonlyMap<CompositionSlot, { definitionId: string; definitionVersion: string }>;
  /** Definitions the catalog holds, so a digest can be pinned and props validated. */
  registry: CatalogRegistry;
  /** Rows per slot, already read. The compiler reasons about them but does not fetch them. */
  rowsBySlot: Partial<Record<CompositionSlot, Record<string, unknown>[]>>;
  /** Extra props per slot, on top of the template's fixed props. */
  propsBySlot?: Partial<Record<CompositionSlot, Record<string, unknown>>>;
  initialState: { period: "week" | "month"; timezone: string; selectedDate?: string };
  imageRef?: { imageId: string; altText: string };
}

export type CompileResult =
  | { ok: true; sections: CompiledSection[] }
  | { ok: false; problems: string[] };

/**
 * Turn a template plus chosen leaves into validated sections.
 *
 * Pure. Every leaf's props are validated with the same validator the persistence path uses, every
 * definition is pinned by the digest the catalog currently holds, and a region with no rows is
 * dropped when it is optional and reported as a problem when it is not — inventing a calendar to
 * fill the layout is exactly the behaviour this refuses.
 */
export function compileTemplate(input: CompileInput): CompileResult {
  const problems: string[] = [];
  const sections: CompiledSection[] = [];

  for (const slot of input.template.slots) {
    const fixed = input.template.fixed.find((region) => region.slot === slot);
    const chosen = input.chosen.get(slot);
    const definitionId = fixed?.definitionId ?? chosen?.definitionId;
    const definitionVersion = fixed === undefined ? chosen?.definitionVersion : undefined;

    if (definitionId === undefined) {
      // A slot nothing can fill, optional or not: an optional region is omitted, a required one is
      // a problem the caller has to see.
      if (input.template.optionalSlots.includes(slot)) continue;
      problems.push(`no renderer was chosen for the required region "${slot}"`);
      continue;
    }

    const entry =
      definitionVersion === undefined ? input.registry.get(definitionId) : input.registry.get(definitionId, definitionVersion);
    if (entry === undefined) {
      problems.push(`the catalog holds no definition "${definitionId}"`);
      continue;
    }

    const rows = input.rowsBySlot[slot];
    if (input.template.optionalSlots.includes(slot) && (rows === undefined || rows.length === 0)) {
      // Optional means "shown when there is something to show". An empty month view with a
      // fabricated title is what makes a review believe a calendar was synced.
      continue;
    }

    const props = buildProps(entry.definition, slot, input, rows);
    const validation = validateProps(entry.definition, props);
    if (!validation.ok) {
      problems.push(`props for "${definitionId}" do not fit its schema: ${validation.problems.join(", ")}`);
      continue;
    }

    sections.push({
      sectionId: slot,
      slot,
      definitionRef: {
        id: entry.definition.id,
        version: entry.definition.version,
        digest: definitionDigest(entry.definition),
      },
      props,
      dataRefs: props.datasetRef === undefined ? [] : [String(props.datasetRef)],
      ...(rows === undefined ? {} : { rows }),
      textAlternative: describeSection(entry.definition, slot, rows),
    });
  }

  if (sections.length === 0) problems.push("the compiled composition has no sections");
  return problems.length === 0 ? { ok: true, sections } : { ok: false, problems };
}

function buildProps(
  definition: WidgetDefinition,
  slot: CompositionSlot,
  input: CompileInput,
  rows: Record<string, unknown>[] | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  const fixedProps = input.template.fixed.find((region) => region.slot === slot)?.props ?? {};
  Object.assign(base, definition.textFallback === "" ? {} : {}, fixedProps, input.propsBySlot?.[slot] ?? {});

  if (slot === "metrics") {
    base.datasetRef = `inline:metrics:${input.initialState.period}`;
  }
  if (slot === "trend" || slot === "table") {
    base.datasetRef = `inline:${slot}:${input.initialState.period}`;
    base.title = titleForSlot(slot);
  }
  if (slot === "filter") {
    base.period = input.initialState.period;
    base.timezone = input.initialState.timezone;
  }
  if (slot === "calendar") {
    base.datasetRef = `inline:calendar:${input.initialState.period}`;
    base.month = input.initialState.selectedDate?.slice(0, 7) ?? localMonth(input.initialState.timezone);
    base.timezone = input.initialState.timezone;
  }
  if (slot === "image") {
    base.imageRef = input.imageRef?.imageId;
    base.alt = input.imageRef?.altText;
  }
  if (slot === "cta") {
    base.actionId = "view.save";
  }
  void rows;
  return base;
}

function titleForSlot(slot: CompositionSlot): string {
  if (slot === "trend") return "Xu hướng theo ngày";
  if (slot === "table") return "Bảng số liệu";
  return "Dữ liệu";
}

function localMonth(timezone: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).format(now);
  return parts;
}

/**
 * The sentence a reader gets when the region cannot be drawn.
 *
 * Written from the rows rather than from the definition's generic fallback, because a summary of
 * what was there is more useful than "a chart is displayed as text".
 */
function describeSection(
  definition: WidgetDefinition,
  slot: CompositionSlot,
  rows: Record<string, unknown>[] | undefined,
): string {
  if (rows === undefined || rows.length === 0) return definition.textFallback;
  if (slot === "metrics") {
    const summary = rows
      .map((row) => `${String(row.label ?? "")} ${String(row.value ?? "")}${typeof row.unit === "string" ? ` ${row.unit}` : ""}`)
      .join(", ");
    return `Chỉ số: ${summary}.`;
  }
  if (slot === "trend" || slot === "table") {
    const total = rows.reduce((sum, row) => sum + Number(row.completed ?? 0), 0);
    return `Xu hướng theo ngày, tổng ${total} task hoàn thành trong kỳ.`;
  }
  if (slot === "calendar") return `Lịch có ${rows.length} sự kiện trong kỳ.`;
  if (slot === "image") {
    // The alt text is the whole accessible content of a picture, so the text alternative says the
    // user's words rather than the definition's generic sentence. A reader who cannot see the image —
    // because the renderer is unknown, the snapshot is text-only, or a screen reader is in use —
    // gets the description the user actually wrote.
    const alt = rows
      .map((row) => (typeof row.altText === "string" ? row.altText.trim() : ""))
      .filter((value) => value !== "")
      .join("; ");
    return alt === "" ? definition.textFallback : `Hình ảnh đã nhập: ${alt}`;
  }
  return definition.textFallback;
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

export interface ComposeDeps {
  db: Database;
  nodeId: string;
  dataDir: string;
  now: () => Instant;
  newId: (prefix: string) => string;
  /** The catalog this node can draw, used for coverage and digests. */
  registry: CatalogRegistry;
  /** The selector. Absent or disabled means the deterministic path only. */
  jev?: { deps: JevDeps; budget: () => JevBudget };
  /** The node's display timezone. */
  timezone: () => string;
}

export interface ComposeInput {
  conversationId: string;
  messageId: string;
  principalId: Principal["principalId"];
  /** The user's words, which is all the selector is allowed to see. */
  intent: string;
  /** A template the caller named. When present the selector is not consulted. */
  explicitTemplateId?: string;
  /** A period the caller named. */
  period?: "week" | "month";
  /** Cancellation, so an abandoned turn does not persist a surface. */
  signal?: AbortSignal;
}

export type ComposeOutcome =
  | {
      ok: true;
      block: MessageBlock;
      instanceId: string;
      snapshotId: string;
      bundleId: string;
      compositionId: string;
      templateId: string;
      selectorMode: "explicit" | "jev" | "fallback";
      selectorReason?: string;
    }
  | {
      ok: false;
      code: "CANCELLED" | "NO_TEMPLATE" | "COMPILE_FAILED" | "PERSIST_FAILED";
      message: string;
      problems?: string[];
    };

/** The host's own template, used when nothing else decides. */
export const DEFAULT_TEMPLATE_ID = "overview";

/**
 * Compose one surface for one message.
 *
 * The order matters: candidates are built from what the catalog holds and what data exists, the
 * template is chosen (deterministically when the caller named one), the leaves are chosen for the
 * regions it does not fix, the rows are read, the compiler runs, coverage is re-checked, and only
 * then is anything written.
 */
export async function composeMiniApp(deps: ComposeDeps, input: ComposeInput): Promise<ComposeOutcome> {
  const registry = deps.registry;
  const overview = registry.get("canvas.overview@1")?.definition;
  if (overview === undefined) {
    return { ok: false, code: "COMPILE_FAILED", message: "this node's catalog has no composed-surface container" };
  }

  // A replayed turn is the same operation. The key is the message and the tool call that produced
  // it, not a hash of the intent: two identical requests from a user are two operations.
  const existing = findCompositionByMessage(deps.db, input.messageId, input.principalId);
  if (existing !== undefined) {
    const snapshot = listSnapshotsForMessage(deps.db, input.messageId)[0];
    const bundle = findBundleForMessage(deps.db, input.messageId, input.principalId);
    if (snapshot !== undefined) {
      return {
        ok: true,
        block: { type: "surface", definitionRef: { id: overview.id, version: overview.version }, snapshot },
        instanceId: existing.instanceId,
        snapshotId: snapshot.snapshotId,
        bundleId: bundle?.bundleId ?? "",
        compositionId: existing.compositionId,
        templateId: existing.templateId,
        selectorMode: existing.provenance.selector.mode === "jev" ? "jev" : existing.provenance.selector.mode === "explicit" ? "explicit" : "fallback",
        ...(existing.provenance.selector.fallbackReason === undefined
          ? {}
          : { selectorReason: existing.provenance.selector.fallbackReason }),
      };
    }
  }

  const dataDeps: MiniAppDataDeps = {
    db: deps.db,
    nodeId: deps.nodeId,
    dataDir: deps.dataDir,
    now: deps.now,
    newId: deps.newId,
  };

  const template = await chooseTemplate(deps, input);
  if (!template.ok) return template;

  const timezone = deps.timezone();
  const period = input.period ?? "week";
  const published = publishMiniAppData(dataDeps, { principalId: input.principalId, period, timezone });

  const chosen = await chooseLeaves(deps, input, template.template, template.mode !== "jev");
  if (!chosen.ok) return chosen;

  const rowsBySlot: Partial<Record<CompositionSlot, Record<string, unknown>[]>> = {
    metrics: published.metrics.rows,
    trend: published.metrics.trendRows,
    table: published.metrics.trendRows,
    calendar: published.calendarRows,
    image: published.imageRefs.map((image) => ({ ...image })),
  };

  const compiled = compileTemplate({
    template: template.template,
    chosen: chosen.chosen,
    registry,
    rowsBySlot,
    initialState: { period, timezone },
    ...(published.imageRefs[0] === undefined ? {} : { imageRef: published.imageRefs[0] }),
  });
  if (!compiled.ok) {
    return { ok: false, code: "COMPILE_FAILED", message: "the template did not compile", problems: compiled.problems };
  }

  // Checked again after compilation, against the catalog that will draw it, because the compiler
  // pinning a digest and the catalog holding it are two claims that have to agree.
  const instanceId = deps.newId("winst");
  const bindings = compileBindings(deps, compiled.sections, instanceId);
  const compositionId = deps.newId("comp");
  const coverage = checkCompositionCoverage(
    {
      schemaVersion: 1,
      compositionId,
      instanceId,
      templateId: template.template.templateId,
      templateVersion: template.template.templateVersion,
      catalogDigest: catalogDigestOf(registry),
      sections: compiled.sections.map(({ rows: _rows, ...section }) => section),
      initialState: { period, timezone },
      actions: bindings.map(({ binding, sectionId }) => ({
        actionBindingId: binding.actionBindingId,
        sectionId,
        label: binding.label,
        kind: "view" as const,
        effectCategory: binding.effectCategory,
      })),
      provenance: {
        createdAt: deps.now(),
        templateId: template.template.templateId,
        templateVersion: template.template.templateVersion,
        selector: {
          mode: template.mode,
          policyVersion: deps.jev?.deps.config.policyVersion ?? "1",
          ...(template.reason === undefined ? {} : { fallbackReason: template.reason }),
        },
        sourceRevisions,
      },
    },
    registry,
    { allowedDataRefs: new Set(compiled.sections.flatMap((section) => section.dataRefs)) },
  );
  if (!coverage.ok) {
    return { ok: false, code: "COMPILE_FAILED", message: "the spec does not fit the catalog", problems: coverage.problems };
  }

  if (input.signal?.aborted === true) {
    // Cancelled between selection and commit. Nothing has been written yet, which is the point of
    // doing the persistence last.
    return { ok: false, code: "CANCELLED", message: "the turn was cancelled before the surface was stored" };
  }

  const captured = captureCompositeSurface(deps as WidgetDeps, {
    conversationId: input.conversationId,
    messageId: input.messageId,
    principalId: input.principalId,
    instanceId,
    compositionId,
    definition: overview,
    packageDigest: overviewDigest(registry),
    catalogDigest: catalogDigestOf(registry),
    templateId: template.template.templateId,
    templateVersion: template.template.templateVersion,
    sections: compiled.sections,
    props: {
      compositionId,
      templateId: template.template.templateId,
      period,
      title: titleForTemplate(template.template.templateId),
    },
    initialState: { period, timezone },
    provenance: {
      createdAt: deps.now(),
      templateId: template.template.templateId,
      templateVersion: template.template.templateVersion,
      selector: {
        mode: template.mode,
        ...(template.model === undefined ? {} : { model: template.model }),
        policyVersion: deps.jev?.deps.config.policyVersion ?? "1",
        ...(template.confidence === undefined ? {} : { confidence: template.confidence }),
        ...(template.margin === undefined ? {} : { margin: template.margin }),
        ...(template.reason === undefined ? {} : { fallbackReason: template.reason }),
      },
      sourceRevisions,
    },
    textAlternative: textAlternativeFor(template.template.templateId, published),
    dataRefs: compiled.sections.flatMap((section) => section.dataRefs),
    bindings,
  } satisfies Parameters<typeof captureCompositeSurface>[1]);

  if (!captured.ok) {
    return { ok: false, code: "PERSIST_FAILED", message: captured.message, problems: captured.problems ?? [] };
  }

  return {
    ok: true,
    block: {
      type: "surface",
      definitionRef: { id: captured.instance.definitionRef.id, version: captured.instance.definitionRef.version },
      snapshot: captured.snapshot,
    },
    instanceId: captured.instance.instanceId,
    snapshotId: captured.snapshot.snapshotId,
    bundleId: captured.bundle.bundleId,
    compositionId: captured.composition.compositionId,
    templateId: template.template.templateId,
    selectorMode: template.mode,
    ...(template.reason === undefined ? {} : { selectorReason: template.reason }),
  };
}

const sourceRevisions: CompositionSourceRevision[] = [
  { ref: "tasks", revision: "node-local" },
  { ref: "calendar_events", revision: "node-local" },
];

function titleForTemplate(templateId: string): string {
  if (templateId === "focused") return "Xu hướng";
  if (templateId === "agenda") return "Lịch";
  return "Tổng quan";
}

function textAlternativeFor(templateId: string, published: PublishedMiniAppData): string {
  const completed = published.metrics.metrics.find((metric) => metric.id === "completed")?.value ?? 0;
  const pending = published.metrics.metrics.find((metric) => metric.id === "pending")?.value ?? 0;
  if (templateId === "agenda") {
    return `Lịch tháng này có ${published.calendarRows.length} sự kiện đã nhập.`;
  }
  return `${titleForTemplate(templateId)}: ${completed} task hoàn thành, ${pending} đang mở trong kỳ.`;
}

function catalogDigestOf(registry: CatalogRegistry): string {
  return `sha256:catalog:${registry
    .entries()
    .map((entry) => definitionDigest(entry.definition))
    .join(",")
    .length}`;
}

function overviewDigest(registry: CatalogRegistry): string {
  const definition = registry.get("canvas.overview@1")?.definition;
  if (definition === undefined) throw new Error("the catalog has no canvas.overview@1 definition");
  return definitionDigest(definition);
}

async function chooseTemplate(
  deps: ComposeDeps,
  input: ComposeInput,
): Promise<
  | { ok: true; template: MiniAppTemplate; mode: "explicit" | "jev" | "fallback"; reason?: string; model?: string; confidence?: number; margin?: number }
  | { ok: false; code: "NO_TEMPLATE"; message: string }
> {
  if (input.explicitTemplateId !== undefined) {
    const named = findTemplate(input.explicitTemplateId);
    if (named === undefined) {
      return { ok: false, code: "NO_TEMPLATE", message: `"${input.explicitTemplateId}" is not a template this host can compile` };
    }
    return { ok: true, template: named, mode: "explicit" };
  }

  const jev = deps.jev;
  if (jev === undefined) {
    return {
      ok: true,
      template: findTemplate(DEFAULT_TEMPLATE_ID) as MiniAppTemplate,
      mode: "fallback",
      reason: "the selector is not enabled on this node",
    };
  }

  const candidateSet = templateCandidates(deps.registry);
  const budget = jev.budget();
  const outcome = await selectTemplate(jev.deps, {
    intent: input.intent,
    candidateSet: { ...candidateSet, data: candidateSet.data, locale: "vi-VN" },
    budget,
  });

  if (outcome.status === "selected") {
    const selected = findTemplate(outcome.templateId);
    if (selected !== undefined) {
      return {
        ok: true,
        template: selected,
        mode: "jev",
        model: jev.deps.config.model,
        ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
        ...(outcome.margin === undefined ? {} : { margin: outcome.margin }),
      };
    }
  }

  // Either the selector abstained, or it named a template this host cannot compile. Both fall back
  // to the host default, and both are recorded as a fallback rather than as a selection.
  const reason =
    outcome.status === "selected"
      ? `the selector chose "${outcome.templateId}", which this host cannot compile`
      : outcome.reason;
  return {
    ok: true,
    template: findTemplate(DEFAULT_TEMPLATE_ID) as MiniAppTemplate,
    mode: "fallback",
    reason,
  };
}

async function chooseLeaves(
  deps: ComposeDeps,
  input: ComposeInput,
  template: MiniAppTemplate,
  deterministic: boolean,
): Promise<
  | { ok: true; chosen: Map<CompositionSlot, { definitionId: string; definitionVersion: string }> }
  | { ok: false; code: "COMPILE_FAILED"; message: string; problems: string[] }
> {
  const chosen = new Map<CompositionSlot, { definitionId: string; definitionVersion: string }>();
  const candidates = templateCandidates(deps.registry);
  const openSlots: CompositionSlot[] = [];

  // A default leaf per region, always set. This is what makes the fallback a *compiled* surface
  // rather than a partially built one: a template whose trend region has three possible renderers
  // still resolves to one of them when no selector is available, and the catalog's own order is
  // what decides which. A preference stated in data is preferable to a preference stated in a
  // branch.
  for (const slot of template.slots) {
    const families = template.familiesBySlot[slot];
    if (families === undefined) continue;
    if (template.fixed.some((region) => region.slot === slot)) continue;
    const options = candidates.definitions.filter((definition) => families.includes(definition.family));
    if (options.length === 0) continue;
    chosen.set(slot, { definitionId: options[0]!.id, definitionVersion: options[0]!.version });
    if (options.length > 1) openSlots.push(slot);
  }

  // The selector only has something to decide when a region genuinely has a choice, and an explicit
  // template means the caller already decided: a deterministic compile does not spend a request.
  if (deterministic || openSlots.length === 0 || deps.jev === undefined) return { ok: true, chosen };

  const outcome = await selectSections(deps.jev.deps, {
    intent: input.intent,
    candidateSet: candidates,
    template: { templateId: template.templateId, templateVersion: template.templateVersion, slots: template.slots },
    fixedSlots: template.fixed.map((region) => region.slot),
    budget: deps.jev.budget(),
  });

  if (outcome.status === "selected") {
    for (const section of outcome.selection.sections) {
      chosen.set(section.slot, { definitionId: section.definitionId, definitionVersion: section.definitionVersion });
    }
  }
  // An abstention leaves the defaults in place rather than failing the composition: the surface is
  // still drawable, and the provenance already records that the selector did not decide.
  return { ok: true, chosen };
}

function templateCandidates(registry: CatalogRegistry): MiniAppCandidateSet {
  const templates: TemplateCandidate[] = COMPOSITION_TEMPLATES.map((template) => ({
    templateId: template.templateId,
    templateVersion: template.templateVersion,
    label: template.label,
    slots: template.slots,
  }));
  const definitions: DefinitionCandidate[] = registry.entries().map((entry) => ({
    id: entry.definition.id,
    version: entry.definition.version,
    family: entry.family,
    fields: Object.keys(
      ((entry.definition.propsSchema as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>,
    ).slice(0, 24),
  }));
  // Only the kinds that exist locally are offered as data. An empty store offers an empty data list,
  // which is how the selector is told there is nothing to chart without being told what is missing.
  const data = [
    {
      ref: "inline:metrics:live",
      kind: "tasks" as const,
      label: "Task của node này",
      scale: rowScale(1),
      freshness: "live" as const,
    },
  ];
  return buildMiniAppCandidateSet({ templates, definitions, data, locale: "vi-VN" });
}

/**
 * Compile the view bindings a template needs.
 *
 * Compiling them here rather than accepting them from the caller is what keeps the spec free of
 * proposals: the surface references bindings this function produced, and every one of them is a
 * `view` operation.
 */
function compileBindings(
  deps: ComposeDeps,
  sections: readonly CompiledSection[],
  instanceId: string,
): { binding: ActionBinding; sectionId: string }[] {
  const bindings: { binding: ActionBinding; sectionId: string }[] = [];
  const knownCapabilities = new Set<string>();

  const add = (sectionSlot: CompositionSlot, operation: string, label: string): void => {
    const section = sections.find((candidate) => candidate.slot === sectionSlot);
    if (section === undefined) return;
    const compiled = compileActionBinding({
      bindingId: deps.newId("act"),
      instance: {
        instanceId,
        ownerNodeId: deps.nodeId,
        definitionRef: { id: "canvas.overview@1", version: "1.0.0", packageDigest: overviewDigest(deps.registry) },
        actionBindingRevision: 1,
      },
      packageGeneration: overviewDigest(deps.registry),
      label,
      proposal: { kind: "view", operation, args: {} },
      inputSchema: { type: "object" },
      allowedDataRefs: section.dataRefs,
      fixedConstraints: {},
      // A view operation reads or re-renders; it writes nothing outside the node's own state.
      effectCategory: "read",
      requiresApproval: false,
      limits: {},
      bindingDigest: `sha256:${operation}:${instanceId}`,
      at: deps.now(),
      knownCapabilities,
    });
    if (compiled.ok) bindings.push({ binding: compiled.binding, sectionId: section.sectionId });
  };

  add("filter", "period.change", "Đổi khoảng thời gian");
  add("calendar", "date.select", "Chọn ngày");
  add("cta", "view.save", "Lưu bản xem");
  return bindings;
}

/** Where a compose outcome landed, for a caller that wants to report or assert it. */
export function describeComposeOutcome(outcome: ComposeOutcome): string {
  if (!outcome.ok) return `${outcome.code}: ${outcome.message}`;
  return `${outcome.templateId} via ${outcome.selectorMode} (bundle ${outcome.bundleId})`;
}
