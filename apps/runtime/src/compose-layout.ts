import {
  type CompiledSection,
  type CompositionSlot,
  type LayoutContainerKind,
  type LayoutNode,
  LAYOUT_CONTAINER_KINDS,
  MAX_COMPOSITION_SECTIONS,
  MAX_GRID_COLUMNS,
  MAX_LAYOUT_CHILDREN,
  MAX_LAYOUT_DEPTH,
  MAX_LAYOUT_NODES,
  checkLayout,
  describeLayout,
} from "@clarkcant/contracts";
import { primitivePropsProblems } from "@clarkcant/data-canvas";
import { type CatalogRegistry, definitionDigest, validateProps } from "@clarkcant/widget-host";

import {
  type ComposeDeps,
  type ComposeInput,
  type ComposeOutcome,
  type CompileInput,
  dataDepsOf,
  describeSection,
  findTemplate,
  leafProps,
  persistComposition,
  replayComposition,
  rowsBySlotOf,
} from "./compose-mini-app.ts";
import { validateArgs } from "./application/capability-invoke.ts";
import { publishMiniAppData } from "./mini-app-data.ts";

/**
 * Composing a surface from a layout tree a model proposed.
 *
 * A template is a recipe with fixed regions. A tree says where each region goes: a grid of three, a
 * card holding a filter above a table, two tabs. The model proposes the tree through the same
 * `show_view` it uses for everything else; the host turns each leaf into an ordinary section — the
 * widget looked up in the catalog, its props built with the host's own keys on top and validated,
 * its definition digest pinned, its rows read from the node — and stores the tree beside the sections
 * as nothing but arrangement.
 *
 * Nothing is trimmed to fit. A tree that is too deep, too large, names a widget this node does not
 * hold, or asks for a region the node has nothing to put in is refused with the reason, before
 * anything is written, so the model can say so or propose something else in the same turn.
 */

export const LAYOUT_TEMPLATE_ID = "layout";
export const LAYOUT_TEMPLATE_VERSION = "1";

/** What a model writes for one node. A leaf names a catalog widget; containers nest. */
export type ProposedLayoutNode =
  | { kind: "widget"; widget: string; props: Record<string, unknown>; label?: string }
  | { kind: "divider" }
  | { kind: LayoutContainerKind; label?: string; columns?: number; open?: boolean; children: ProposedLayoutNode[] };

/**
 * The widget families a leaf may be drawn from, and the region each one reads.
 *
 * The region is what decides where a section's rows come from, so a family is listed here only when
 * the node has a real source for it. Media other than an imported image has none yet.
 */
const SLOT_BY_FAMILY: Readonly<Record<string, CompositionSlot>> = {
  metrics: "metrics",
  filter: "filter",
  trend: "trend",
  tables: "table",
  calendar: "calendar",
  cta: "cta",
  // A search box narrows the tables of the surface it sits in, on the page; a list shows the items the model wrote.
  search: "search",
  list: "list",
};

/** The widgets a layout leaf may name, for the model's instructions and for a refusal that lists them. */
export function layoutLeafWidgets(registry: CatalogRegistry): string[] {
  return registry
    .entries()
    .filter((entry) => SLOT_BY_FAMILY[entry.family] !== undefined || entry.definition.id === "canvas.image@1")
    .map((entry) => entry.definition.id)
    .sort();
}

/* ------------------------------------------------------------------ *
 * Reading the proposal
 * ------------------------------------------------------------------ */

/**
 * Depth and node count of something that has not been read yet.
 *
 * Measured before anything else so a hostile tree costs no more to refuse than a small one: the walk
 * stops as soon as a bound is crossed.
 */
function measureProposal(value: unknown): { depth: number; nodes: number } {
  let nodes = 0;
  let depth = 0;
  const walk = (current: unknown, level: number): void => {
    nodes += 1;
    depth = Math.max(depth, level);
    if (nodes > MAX_LAYOUT_NODES || level > MAX_LAYOUT_DEPTH) return;
    if (typeof current !== "object" || current === null) return;
    const children = (current as { children?: unknown }).children;
    if (Array.isArray(children)) for (const child of children) walk(child, level + 1);
  };
  walk(value, 1);
  return { depth, nodes };
}

function readLabel(value: unknown, where: string, problems: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > 120) {
    problems.push(`${where} has a label that is not 1 to 120 characters of text`);
    return undefined;
  }
  return value.trim();
}

const NODE_KEYS: Readonly<Record<string, readonly string[]>> = {
  widget: ["kind", "widget", "props", "label"],
  divider: ["kind"],
  container: ["kind", "label", "columns", "open", "children"],
};

/** Read one proposed node, collecting every problem rather than stopping at the first. */
function readNode(value: unknown, where: string, problems: string[]): ProposedLayoutNode | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push(`${where} is not a layout node`);
    return undefined;
  }
  const node = value as Record<string, unknown>;
  const kind = node.kind;
  const isContainer = typeof kind === "string" && (LAYOUT_CONTAINER_KINDS as readonly string[]).includes(kind);
  if (kind !== "widget" && kind !== "divider" && !isContainer) {
    problems.push(
      `${where} has kind ${JSON.stringify(kind)}; a node is a widget, a divider or one of ${LAYOUT_CONTAINER_KINDS.join(", ")}`,
    );
    return undefined;
  }
  const allowed = NODE_KEYS[isContainer ? "container" : String(kind)] ?? [];
  const extra = Object.keys(node).filter((key) => !allowed.includes(key));
  // A key the node does not have is refused rather than dropped: it is the one way a layout could
  // try to carry something other than arrangement.
  if (extra.length > 0) problems.push(`${where} (${String(kind)}) has fields a ${String(kind)} does not have: ${extra.join(", ")}`);

  if (kind === "divider") return { kind: "divider" };

  const label = readLabel(node.label, where, problems);
  if (kind === "widget") {
    if (typeof node.widget !== "string" || node.widget.trim() === "") {
      problems.push(`${where} is a widget that does not name one`);
      return undefined;
    }
    if (node.props !== undefined && (typeof node.props !== "object" || node.props === null || Array.isArray(node.props))) {
      problems.push(`${where} has props that are not an object`);
      return undefined;
    }
    return {
      kind: "widget",
      widget: node.widget.trim(),
      props: (node.props ?? {}) as Record<string, unknown>,
      ...(label === undefined ? {} : { label }),
    };
  }

  const containerKind = kind as LayoutContainerKind;
  const children = node.children;
  if (!Array.isArray(children) || children.length === 0) {
    problems.push(`${where} (${containerKind}) has no children`);
    return undefined;
  }
  if (children.length > MAX_LAYOUT_CHILDREN) {
    problems.push(`${where} (${containerKind}) has ${String(children.length)} children; at most ${String(MAX_LAYOUT_CHILDREN)} are allowed`);
    return undefined;
  }
  const columns = node.columns;
  if (columns !== undefined && (typeof columns !== "number" || !Number.isInteger(columns) || columns < 1 || columns > MAX_GRID_COLUMNS)) {
    problems.push(`${where} (${containerKind}) has columns ${JSON.stringify(columns)}; a grid has 1 to ${String(MAX_GRID_COLUMNS)}`);
  }
  if (node.open !== undefined && typeof node.open !== "boolean") problems.push(`${where} (${containerKind}) has open that is not true or false`);

  const read = children.map((child, index) => readNode(child, `${where}.${String(index + 1)}`, problems));
  if (read.some((child) => child === undefined)) return undefined;
  return {
    kind: containerKind,
    ...(label === undefined ? {} : { label }),
    ...(typeof columns === "number" ? { columns } : {}),
    ...(typeof node.open === "boolean" ? { open: node.open } : {}),
    children: read as ProposedLayoutNode[],
  };
}

/* ------------------------------------------------------------------ *
 * The pure compiler
 * ------------------------------------------------------------------ */

export interface CompileLayoutInput {
  /** The tree as the model wrote it. Nothing about it is trusted. */
  proposal: unknown;
  registry: CatalogRegistry;
  rowsBySlot: Partial<Record<CompositionSlot, Record<string, unknown>[]>>;
  initialState: CompileInput["initialState"];
  imageRef?: { imageId: string; altText: string };
}

export type CompileLayoutResult =
  | { ok: true; sections: CompiledSection[]; layout: LayoutNode; textAlternative: string }
  | { ok: false; problems: string[] };

/**
 * Turn a proposed tree into validated sections and the arrangement that places them.
 *
 * Pure, like the template compiler, and held to the same checks per leaf: the widget must be in the
 * catalog, its props are built by the same function and pass the same validator, and its digest is
 * the one the catalog holds now. What the tree adds is only where each section goes.
 */
export function compileLayout(input: CompileLayoutInput): CompileLayoutResult {
  const { depth, nodes } = measureProposal(input.proposal);
  if (depth > MAX_LAYOUT_DEPTH || nodes > MAX_LAYOUT_NODES) {
    const problems: string[] = [];
    if (depth > MAX_LAYOUT_DEPTH) problems.push(`the layout is more than ${String(MAX_LAYOUT_DEPTH)} levels deep`);
    if (nodes > MAX_LAYOUT_NODES) problems.push(`the layout has more than ${String(MAX_LAYOUT_NODES)} nodes`);
    return { ok: false, problems };
  }

  const problems: string[] = [];
  const proposal = readNode(input.proposal, "layout", problems);
  if (proposal === undefined || problems.length > 0) return { ok: false, problems };

  const sections: CompiledSection[] = [];
  const countBySlot = new Map<CompositionSlot, number>();
  // The recipe's defaults for a region, so a leaf that asks for metrics without a title gets the same
  // one the overview gives it, and a save button its label and description.
  const recipe = findTemplate("overview");

  const place = (node: ProposedLayoutNode, where: string): LayoutNode | undefined => {
    if (node.kind === "divider") return { kind: "divider" };
    if (node.kind !== "widget") {
      const children = node.children.map((child, index) => place(child, `${where}.${String(index + 1)}`));
      if (children.some((child) => child === undefined)) return undefined;
      return {
        kind: node.kind,
        ...(node.label === undefined ? {} : { label: node.label }),
        ...(node.columns === undefined ? {} : { columns: node.columns }),
        ...(node.open === undefined ? {} : { open: node.open }),
        children: children as LayoutNode[],
      };
    }

    const entry = input.registry.get(node.widget);
    if (entry === undefined) {
      problems.push(`${where} names "${node.widget}", which is not a widget this node's catalog holds`);
      return undefined;
    }
    const slot = slotFor(entry.definition.id, entry.family, where, problems);
    if (slot === undefined) return undefined;
    if (slot === "image" && input.imageRef === undefined) {
      problems.push(`${where} asks for an image, and there is no imported image on this node to show`);
      return undefined;
    }

    const props = leafProps(slot, { ...(recipe?.fixed.find((region) => region.slot === slot)?.props ?? {}), ...node.props }, input);
    const validation = validateProps(entry.definition, props);
    if (!validation.ok) {
      problems.push(`${where} (${entry.definition.id}) has props that do not fit its schema: ${validation.problems.join(", ")}`);
      return undefined;
    }
    // A model wrote these props, so they are held to the whole schema — ranges, enums and item shapes — not only to
    // the structural check every stored instance passes.
    const full = validateArgs(entry.definition.propsSchema, props);
    if (!full.ok) {
      problems.push(`${where} (${entry.definition.id}) has props that do not fit its schema: ${full.message}`);
      return undefined;
    }
    const meaning = primitivePropsProblems(entry.definition.id, props);
    if (meaning.length > 0) {
      problems.push(`${where} (${entry.definition.id}) cannot be placed: ${meaning.join("; ")}`);
      return undefined;
    }
    // A leaf binds no action, so a list inside a layout offers no item button: one would press nothing.
    if (slot === "list" && props.itemActionLabel !== undefined) {
      problems.push(`${where} (${entry.definition.id}) has an item action; a list whose items act is placed with its own show_view`);
      return undefined;
    }

    const count = (countBySlot.get(slot) ?? 0) + 1;
    countBySlot.set(slot, count);
    const sectionId = `${slot}-${String(count)}`;
    const rows = input.rowsBySlot[slot];
    sections.push({
      sectionId,
      slot,
      definitionRef: { id: entry.definition.id, version: entry.definition.version, digest: definitionDigest(entry.definition) },
      props,
      dataRefs: props.datasetRef === undefined ? [] : [String(props.datasetRef)],
      ...(rows === undefined ? {} : { rows }),
      textAlternative: describeSection(entry.definition, slot, rows),
    });
    return { kind: "widget", sectionId, ...(node.label === undefined ? {} : { label: node.label }) };
  };

  const layout = place(proposal, "layout");
  if (layout === undefined || problems.length > 0) return { ok: false, problems };
  if (sections.length === 0) return { ok: false, problems: ["the layout places no widget"] };
  if (sections.length > MAX_COMPOSITION_SECTIONS) {
    return { ok: false, problems: [`the layout places ${String(sections.length)} widgets; at most ${String(MAX_COMPOSITION_SECTIONS)} are allowed`] };
  }

  const structural = checkLayout(layout, new Set(sections.map((section) => section.sectionId)));
  if (structural.length > 0) return { ok: false, problems: structural };

  const textOf = new Map(sections.map((section) => [section.sectionId, section.textAlternative]));
  return {
    ok: true,
    sections,
    layout,
    textAlternative: describeLayout(layout, (sectionId) => textOf.get(sectionId) ?? ""),
  };
}

function slotFor(definitionId: string, family: string, where: string, problems: string[]): CompositionSlot | undefined {
  const slot = SLOT_BY_FAMILY[family];
  if (slot !== undefined) return slot;
  if (definitionId === "canvas.image@1") return "image";
  if (family === "layout") {
    problems.push(`${where} names the container "${definitionId}"; nest a ${LAYOUT_CONTAINER_KINDS.join(", ")} node instead`);
  } else if (family === "action") {
    problems.push(
      `${where} names "${definitionId}"; a button is placed with its own show_view, where its action is compiled, not inside a layout`,
    );
  } else if (family === "form") {
    problems.push(`${where} names "${definitionId}"; a form is placed with its own show_view, where what it sends is bound, not inside a layout`);
  } else if (family === "choice" || family === "input") {
    problems.push(`${where} names "${definitionId}", which sends its value nowhere on its own; make it a field of a canvas.form@1`);
  } else if (family === "media") {
    problems.push(`${where} names "${definitionId}", and this node has no source for it yet; only an imported image can be placed`);
  } else {
    problems.push(`${where} names "${definitionId}", which cannot be placed in a layout`);
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

export interface ComposeLayoutInput extends ComposeInput {
  layout: unknown;
  title?: string;
}

/**
 * Compose one surface from a proposed tree.
 *
 * The same order as a template, without a selector: the tree is the choice. Rows are read once, the
 * tree compiles or is refused, and the shared tail checks coverage against the catalog and writes
 * everything in one transaction.
 */
export function composeLayout(deps: ComposeDeps, input: ComposeLayoutInput): ComposeOutcome {
  const overview = deps.registry.get("canvas.overview@1")?.definition;
  if (overview === undefined) {
    return { ok: false, code: "COMPILE_FAILED", message: "this node's catalog has no composed-surface container" };
  }
  const replayed = replayComposition(deps, input, overview);
  if (replayed !== undefined) return replayed;

  const timezone = deps.timezone();
  const period = input.period ?? "week";
  const published = publishMiniAppData(dataDepsOf(deps), { principalId: input.principalId, period, timezone });

  const compiled = compileLayout({
    proposal: input.layout,
    registry: deps.registry,
    rowsBySlot: rowsBySlotOf(published),
    initialState: { period, timezone },
    ...(published.imageRefs[0] === undefined ? {} : { imageRef: published.imageRefs[0] }),
  });
  if (!compiled.ok) {
    return { ok: false, code: "COMPILE_FAILED", message: "the layout did not compile", problems: compiled.problems };
  }

  return persistComposition(deps, input, overview, {
    templateId: LAYOUT_TEMPLATE_ID,
    templateVersion: LAYOUT_TEMPLATE_VERSION,
    sections: compiled.sections,
    layout: compiled.layout,
    period,
    timezone,
    selector: { mode: "explicit" },
    title: input.title === undefined || input.title.trim() === "" ? "Bảng điều khiển" : input.title.trim().slice(0, 200),
    textAlternative: compiled.textAlternative,
  });
}
