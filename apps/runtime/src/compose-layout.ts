import {
  type CompiledSection,
  type CompositionGraph,
  type CompositionSlot,
  type LayoutContainerKind,
  type LayoutNode,
  LAYOUT_CONTAINER_KINDS,
  MAX_COMPOSITION_SECTIONS,
  MAX_GRID_COLUMNS,
  MAX_LAYOUT_CHILDREN,
  MAX_LAYOUT_DEPTH,
  MAX_LAYOUT_NODES,
  MAX_GRAPH_FEEDS,
  MAX_GRAPH_RULES,
  SECTION_TEXT_LIMIT,
  SNAPSHOT_TEXT_LIMIT,
  checkCompositionGraph,
  checkLayout,
  clipWithMarker,
  describeLayout,
  readStatusCard,
  readTimeline,
  statusCardText,
  timelineText,
} from "@clarkcant/contracts";
import { STATUS_CARD_KIND, primitivePropsProblems } from "@clarkcant/data-canvas";
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
  | { kind: "widget"; widget: string; props: Record<string, unknown>; label?: string; on?: unknown[]; feed?: unknown[] }
  | { kind: "divider" }
  | { kind: LayoutContainerKind; label?: string; columns?: number; open?: boolean; children: ProposedLayoutNode[] };

/**
 * The widget families a leaf may be drawn from, and the region each one reads.
 *
 * The region is what decides where a section's rows come from, so a family is listed here only when
 * the node has a real source for it. Media is not a family here: of its widgets, only an imported image and a gallery or
 * carousel of the person's imported pictures have one (see `slotFor`); a video or a YouTube embed has none yet.
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
  // A status, progress or details card shows what the model wrote in its props; it reads nothing from the node.
  status: "status",
  // So does a timeline: its entries are its props.
  timeline: "timeline",
};

/** The media widgets the node has a source for: the newest imported image, or the person's imported pictures as a set. */
const PICTURE_SLOT_BY_DEFINITION: Readonly<Record<string, CompositionSlot>> = {
  "canvas.image@1": "image",
  "canvas.gallery@1": "pictures",
  "canvas.carousel@1": "pictures",
};

/** How many pictures a gallery or carousel holds, from its own props schema, so a set is cut to fit rather than refused. */
function pictureLimit(definition: { propsSchema?: unknown }): number {
  const schema = definition.propsSchema as { properties?: { imageRefs?: { maxItems?: unknown } } } | undefined;
  const max = schema?.properties?.imageRefs?.maxItems;
  return typeof max === "number" && Number.isInteger(max) && max > 0 ? max : 1;
}

/** The widgets a layout leaf may name, for the model's instructions and for a refusal that lists them. */
export function layoutLeafWidgets(registry: CatalogRegistry): string[] {
  return registry
    .entries()
    .filter(
      (entry) =>
        SLOT_BY_FAMILY[entry.family] !== undefined ||
        entry.family === "choice" ||
        entry.family === "input" ||
        PICTURE_SLOT_BY_DEFINITION[entry.definition.id] !== undefined,
    )
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

/**
 * A leaf's `on` or `feed`: a short list of objects. Only the envelope is read here; what each entry may say is the
 * graph's to check, once the leaf has a section id to attach it to.
 */
function readWiring(value: unknown, name: "on" | "feed", max: number, where: string, problems: string[]): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    problems.push(`${where} has ${name} that is not a list of 1 to ${String(max)} entries`);
    return undefined;
  }
  if (value.some((entry) => typeof entry !== "object" || entry === null || Array.isArray(entry))) {
    problems.push(`${where} has ${name} entries that are not objects`);
    return undefined;
  }
  return value;
}

const NODE_KEYS: Readonly<Record<string, readonly string[]>> = {
  widget: ["kind", "widget", "props", "label", "on", "feed"],
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
    const on = readWiring(node.on, "on", MAX_GRAPH_RULES, where, problems);
    const feed = readWiring(node.feed, "feed", MAX_GRAPH_FEEDS, where, problems);
    return {
      kind: "widget",
      widget: node.widget.trim(),
      props: (node.props ?? {}) as Record<string, unknown>,
      ...(label === undefined ? {} : { label }),
      ...(on === undefined ? {} : { on }),
      ...(feed === undefined ? {} : { feed }),
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
  /** The person's imported pictures, newest first, for a gallery or carousel leaf. */
  pictureRefs?: { imageId: string; altText: string }[];
  /** The state the model declared for the surface, as it wrote it: `{ key: { type, initial } }`. Checked with the graph. */
  state?: unknown;
}

export type CompileLayoutResult =
  | { ok: true; sections: CompiledSection[]; layout: LayoutNode; textAlternative: string; graph?: CompositionGraph }
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
  // What each leaf wired, with the section id the host gave it attached; the leaf never names one itself.
  const on: unknown[] = [];
  const feed: unknown[] = [];
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
    const slot = slotFor(entry.definition.id, entry.family, node.on !== undefined, where, problems);
    if (slot === undefined) return undefined;
    if (slot === "image" && input.imageRef === undefined) {
      problems.push(`${where} asks for an image, and there is no imported image on this node to show`);
      return undefined;
    }
    if (slot === "pictures" && (input.pictureRefs ?? []).length === 0) {
      problems.push(`${where} asks for pictures, and there is no imported image on this node to show`);
      return undefined;
    }

    // A set is cut once, to what this widget holds, so its props, its stored rows and its text all name the same pictures.
    const limit = slot === "pictures" ? pictureLimit(entry.definition) : undefined;
    const props = leafProps(slot, { ...(recipe?.fixed.find((region) => region.slot === slot)?.props ?? {}), ...node.props }, {
      ...input,
      ...(limit === undefined ? {} : { pictureRefs: (input.pictureRefs ?? []).slice(0, limit) }),
    });
    // Held to the whole schema — ranges, enums and item shapes — the same check every stored instance passes.
    const validation = validateProps(entry.definition, props);
    if (!validation.ok) {
      problems.push(`${where} (${entry.definition.id}) has props that do not fit its schema: ${validation.problems.join(", ")}`);
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
    for (const rule of node.on ?? []) on.push({ ...(rule as Record<string, unknown>), sectionId });
    for (const entry of node.feed ?? []) feed.push({ ...(entry as Record<string, unknown>), sectionId });
    const rows = limit === undefined ? input.rowsBySlot[slot] : input.rowsBySlot[slot]?.slice(0, limit);
    sections.push({
      sectionId,
      slot,
      definitionRef: { id: entry.definition.id, version: entry.definition.version, digest: definitionDigest(entry.definition) },
      props,
      dataRefs: props.datasetRef === undefined ? [] : [String(props.datasetRef)],
      ...(rows === undefined ? {} : { rows }),
      textAlternative: sectionText(entry.definition, slot, props, rows),
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

  const graph = graphOf(input.state, on, feed, sections);
  if (!graph.ok) return { ok: false, problems: graph.problems };

  const textOf = new Map(sections.map((section) => [section.sectionId, section.textAlternative]));
  return {
    ok: true,
    sections,
    layout,
    // Twelve sections of up to 2000 characters each can say more than a snapshot keeps; past that the text says so.
    textAlternative: clipWithMarker(describeLayout(layout, (sectionId) => textOf.get(sectionId) ?? ""), SNAPSHOT_TEXT_LIMIT),
    ...(graph.graph === undefined ? {} : { graph: graph.graph }),
  };
}

/**
 * The graph a tree declares, or the one a search box implies.
 *
 * A tree that declares state or wires a leaf gets exactly what it declared, checked whole. A tree that declares nothing
 * and holds a search box gets the graph that box has always had: it writes the query, every table reads it. With a
 * declared graph a search box that writes nothing is refused rather than left as a box that silently does nothing.
 */
function graphOf(
  state: unknown,
  on: unknown[],
  feed: unknown[],
  sections: readonly CompiledSection[],
): { ok: true; graph?: CompositionGraph } | { ok: false; problems: string[] } {
  const leaves = sections.map((section) => ({ sectionId: section.sectionId, definitionId: section.definitionRef.id, props: section.props }));
  // Nothing declared: a search box narrows its tables on the page only, by the graph `implicitSearchGraph` gives the
  // page, and the node stores no graph and binds no event for it.
  if (state === undefined && on.length === 0 && feed.length === 0) return { ok: true };
  const graph = { state: state ?? {}, on, feed };
  const problems = checkCompositionGraph(graph, leaves);
  const wired = new Set(on.map((rule) => (rule as { sectionId: string }).sectionId));
  for (const section of sections) {
    if (section.slot === "search" && !wired.has(section.sectionId)) {
      problems.push(`${section.sectionId} is a search box that writes no state; give it an "on" rule for "query.change"`);
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, graph: graph as CompositionGraph };
}

/** A leaf's text alternative: a status card or a timeline says what its props say, any other region what its rows hold. */
function sectionText(
  definition: Parameters<typeof describeSection>[0],
  slot: CompositionSlot,
  props: Record<string, unknown>,
  rows: Record<string, unknown>[] | undefined,
): string {
  if (slot === "timeline") {
    const timeline = readTimeline(props);
    if (timeline !== undefined) return timelineText(timeline, SECTION_TEXT_LIMIT);
  }
  const kind = STATUS_CARD_KIND[definition.id];
  const card = kind === undefined ? undefined : readStatusCard(kind, props);
  return card === undefined ? describeSection(definition, slot, rows) : statusCardText(card, SECTION_TEXT_LIMIT);
}

function slotFor(definitionId: string, family: string, wired: boolean, where: string, problems: string[]): CompositionSlot | undefined {
  const slot = SLOT_BY_FAMILY[family];
  if (slot !== undefined) return slot;
  // A choice or an input placed on its own acts only through the surface's state, so it is placed only when it writes some.
  if ((family === "choice" || family === "input") && wired) return family;
  const picture = PICTURE_SLOT_BY_DEFINITION[definitionId];
  if (picture !== undefined) return picture;
  if (family === "layout") {
    problems.push(`${where} names the container "${definitionId}"; nest a ${LAYOUT_CONTAINER_KINDS.join(", ")} node instead`);
  } else if (family === "action") {
    problems.push(
      `${where} names "${definitionId}"; a button is placed with its own show_view, where its action is compiled, not inside a layout`,
    );
  } else if (family === "form") {
    problems.push(`${where} names "${definitionId}"; a form is placed with its own show_view, where what it sends is bound, not inside a layout`);
  } else if (family === "choice" || family === "input") {
    problems.push(
      `${where} names "${definitionId}", which sends its value nowhere on its own; give it an "on" rule that writes the surface's state, or make it a field of a canvas.form@1`,
    );
  } else if (definitionId === "canvas.audio@1" || definitionId === "canvas.document@1") {
    problems.push(
      `${where} names "${definitionId}"; it is placed with its own show_view, where the node checks its source under the media content policy, not inside a layout`,
    );
  } else if (family === "media") {
    problems.push(
      `${where} names "${definitionId}", and this node has no source for it yet; only an imported image, or a gallery or carousel of imported pictures, can be placed`,
    );
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
  /** The surface state the model declared, unread until the graph is checked. */
  state?: unknown;
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
    pictureRefs: published.pictureRefs,
    ...(input.state === undefined ? {} : { state: input.state }),
  });
  if (!compiled.ok) {
    return { ok: false, code: "COMPILE_FAILED", message: "the layout did not compile", problems: compiled.problems };
  }

  return persistComposition(deps, input, overview, {
    templateId: LAYOUT_TEMPLATE_ID,
    templateVersion: LAYOUT_TEMPLATE_VERSION,
    sections: compiled.sections,
    layout: compiled.layout,
    ...(compiled.graph === undefined ? {} : { graph: compiled.graph }),
    period,
    timezone,
    selector: { mode: "explicit" },
    title: input.title === undefined || input.title.trim() === "" ? "Bảng điều khiển" : input.title.trim().slice(0, 200),
    textAlternative: compiled.textAlternative,
  });
}
