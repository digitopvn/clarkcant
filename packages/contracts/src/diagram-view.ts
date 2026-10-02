import { z } from "zod";

import { cardSchemaProblems, clipWithMarker, oneLineText } from "./text-rules.ts";
import { SEMANTIC_LIMITS, type SemanticValue } from "./widget-semantic.ts";
import { SNAPSHOT_TEXT_LIMIT } from "./widgets.ts";

/**
 * A bounded diagram the host draws from a node-and-edge model.
 *
 * The model is the only thing a diagram is drawn from: a node is an id, a one-line label, a shape from a closed set and an
 * optional group; an edge is two node ids, an optional one-line label and a direction. No HTML, SVG, link, callback or
 * style travels in it, so drawing it runs no script and fetches nothing. A Mermaid flowchart is accepted only as input:
 * the host parses a subset of it into this same model (`diagram-mermaid.ts`) and stores the model, never the source.
 */

export const DIAGRAM_ID = "canvas.diagram@1";
export const DIAGRAM_SELECT_OPERATION = "diagram.select";

export const MAX_DIAGRAM_NODES = 60;
export const MAX_DIAGRAM_EDGES = 120;
export const MAX_DIAGRAM_ID = 64;
export const MAX_DIAGRAM_LABEL = 80;
export const MAX_DIAGRAM_EDGE_LABEL = 40;
export const MAX_DIAGRAM_GROUP = 40;
export const MAX_DIAGRAM_TITLE = 200;

export const DIAGRAM_SHAPES = ["box", "round", "diamond", "circle"] as const;
export type DiagramShape = (typeof DIAGRAM_SHAPES)[number];
export const DIAGRAM_LAYOUTS = ["layered", "tree"] as const;
export type DiagramLayoutKind = (typeof DIAGRAM_LAYOUTS)[number];
/** Top to bottom, or left to right. A layout reads its layers along this axis. */
export const DIAGRAM_DIRECTIONS = ["TB", "LR"] as const;
export type DiagramDirection = (typeof DIAGRAM_DIRECTIONS)[number];
/** An edge points from `from` to `to`, both ways, or neither way. */
export const DIAGRAM_EDGE_DIRECTIONS = ["forward", "both", "none"] as const;
export type DiagramEdgeDirection = (typeof DIAGRAM_EDGE_DIRECTIONS)[number];

/** Letters, digits, `_` and `-`, starting with a letter, digit or `_`: an id is a name, never text a reader sees. */
export const DIAGRAM_ID_PATTERN = "^[A-Za-z0-9_][A-Za-z0-9_-]*$";
const ID_RE = new RegExp(DIAGRAM_ID_PATTERN, "u");

function idSchema() {
  return z
    .string()
    .min(1, "is empty")
    .max(MAX_DIAGRAM_ID, `is longer than ${String(MAX_DIAGRAM_ID)} characters`)
    .regex(ID_RE, "is not an id: use letters, digits, _ and -");
}

const nodeSchema = z.strictObject({
  id: idSchema(),
  label: oneLineText(MAX_DIAGRAM_LABEL, true),
  shape: z.enum(DIAGRAM_SHAPES).optional(),
  group: oneLineText(MAX_DIAGRAM_GROUP, false).optional(),
});

const edgeSchema = z.strictObject({
  from: idSchema(),
  to: idSchema(),
  label: oneLineText(MAX_DIAGRAM_EDGE_LABEL, false).optional(),
  direction: z.enum(DIAGRAM_EDGE_DIRECTIONS).optional(),
});

const diagramSchema = z.strictObject({
  title: oneLineText(MAX_DIAGRAM_TITLE, false).optional(),
  layout: z.enum(DIAGRAM_LAYOUTS).optional(),
  direction: z.enum(DIAGRAM_DIRECTIONS).optional(),
  nodes: z.array(nodeSchema).max(MAX_DIAGRAM_NODES),
  edges: z.array(edgeSchema).max(MAX_DIAGRAM_EDGES).optional(),
});

export interface DiagramNode {
  id: string;
  label: string;
  shape: DiagramShape;
  group?: string;
  /** Position in the props, which every tie in the layout and the text falls back to. */
  index: number;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  direction: DiagramEdgeDirection;
  index: number;
}

export interface Diagram {
  title?: string;
  layout: DiagramLayoutKind;
  direction: DiagramDirection;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Counts measured before the schema reads anything, so an oversized graph costs no more to refuse than a small one. */
function sizeProblems(input: unknown): string[] {
  if (!record(input)) return [];
  const problems: string[] = [];
  if (Array.isArray(input.nodes) && input.nodes.length > MAX_DIAGRAM_NODES) {
    problems.push(`the diagram has ${String(input.nodes.length)} nodes; at most ${String(MAX_DIAGRAM_NODES)} are drawn`);
  }
  if (Array.isArray(input.edges) && input.edges.length > MAX_DIAGRAM_EDGES) {
    problems.push(`the diagram has ${String(input.edges.length)} edges; at most ${String(MAX_DIAGRAM_EDGES)} are drawn`);
  }
  return problems;
}

/** Whether the edges, read from parent to child, make a forest: one parent at most, and no way back to a node. */
function forestProblems(nodes: readonly { id: string }[], edges: readonly { from: string; to: string }[]): string[] {
  const parent = new Map<string, string>();
  const twoParents = new Set<string>();
  for (const edge of edges) {
    if (parent.has(edge.to)) twoParents.add(edge.to);
    else parent.set(edge.to, edge.from);
  }
  if (twoParents.size > 0) {
    return [`a tree layout gives each node one parent, and ${[...twoParents].slice(0, 5).join(", ")} has more than one; use the layered layout`];
  }
  for (const node of nodes) {
    // Walking up from each node meets the node again only on a cycle; the walk is at most as long as the node list.
    let at = parent.get(node.id);
    for (let steps = 0; at !== undefined && steps <= nodes.length; steps += 1) {
      if (at === node.id) return [`a tree layout cannot hold the cycle through ${node.id}; use the layered layout`];
      at = parent.get(at);
    }
  }
  return [];
}

/**
 * Why these props cannot be drawn, or nothing.
 *
 * Shared by the node's refusal and the page's reading, so a diagram the node stored is one the page can draw. Beyond the
 * schema it refuses repeated node ids, an edge naming a node that is not there, an edge from a node to itself, the same
 * edge twice, and, for the tree layout, a node with two parents or a cycle.
 */
export function diagramProblems(input: unknown): string[] {
  const sized = sizeProblems(input);
  if (sized.length > 0) return sized;
  const parsed = diagramSchema.safeParse(input);
  if (!parsed.success) return cardSchemaProblems(parsed.error.issues);
  const nodes = parsed.data.nodes;
  const edges = parsed.data.edges ?? [];
  const problems: string[] = [];
  const ids = new Set<string>();
  const repeated = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) repeated.add(node.id);
    ids.add(node.id);
  }
  if (repeated.size > 0) problems.push(`node ids repeat: ${[...repeated].slice(0, 5).join(", ")}; each node needs its own id`);
  const missing: string[] = [];
  const loops: string[] = [];
  const seen = new Set<string>();
  const twice: string[] = [];
  edges.forEach((edge, index) => {
    for (const end of [edge.from, edge.to]) {
      if (!ids.has(end)) missing.push(`edge ${String(index + 1)} names "${end}", which is not a node`);
    }
    if (edge.from === edge.to) loops.push(edge.from);
    const key = `${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) twice.push(`${edge.from} → ${edge.to}`);
    seen.add(key);
  });
  if (missing.length > 0) problems.push(...missing.slice(0, 5));
  if (loops.length > 0) problems.push(`an edge cannot go from a node to itself: ${[...new Set(loops)].slice(0, 5).join(", ")}`);
  if (twice.length > 0) problems.push(`edges repeat: ${[...new Set(twice)].slice(0, 5).join(", ")}`);
  if (problems.length === 0 && parsed.data.layout === "tree") problems.push(...forestProblems(nodes, edges));
  return problems;
}

/** The diagram these props describe, or `undefined` when `diagramProblems` refuses them. */
export function readDiagram(input: unknown): Diagram | undefined {
  if (diagramProblems(input).length > 0) return undefined;
  const parsed = diagramSchema.safeParse(input);
  if (!parsed.success) return undefined;
  return {
    ...(parsed.data.title === undefined || parsed.data.title === "" ? {} : { title: parsed.data.title }),
    layout: parsed.data.layout ?? "layered",
    direction: parsed.data.direction ?? "TB",
    nodes: parsed.data.nodes.map((node, index) => ({
      id: node.id,
      label: node.label,
      shape: node.shape ?? "box",
      ...(node.group === undefined || node.group === "" ? {} : { group: node.group }),
      index,
    })),
    edges: (parsed.data.edges ?? []).map((edge, index) => ({
      from: edge.from,
      to: edge.to,
      ...(edge.label === undefined || edge.label === "" ? {} : { label: edge.label }),
      direction: edge.direction ?? "forward",
      index,
    })),
  };
}

/** The nodes one node is joined to, each named once in the order its edges were given. */
export interface DiagramNeighbours {
  /** Nodes an edge leads to from this one. */
  next: DiagramNode[];
  /** Nodes whose edge leads to this one. */
  previous: DiagramNode[];
  /** Nodes joined by an edge with no direction. */
  linked: DiagramNode[];
  /** Every edge touching this node, by index. */
  edges: number[];
  /**
   * The same neighbours as words: each label followed by the labels of the edges joining it, as in "Retry (no)", so a
   * reader who cannot see the drawing hears which branch leads where.
   */
  named: { next: string[]; previous: string[]; linked: string[] };
}

export function diagramNeighbours(diagram: Diagram, id: string): DiagramNeighbours {
  const byId = new Map(diagram.nodes.map((node) => [node.id, node]));
  const sides = { next: new Map<string, Set<string>>(), previous: new Map<string, Set<string>>(), linked: new Map<string, Set<string>>() };
  const edges: number[] = [];
  const add = (side: keyof typeof sides, other: string, label: string | undefined): void => {
    const labels = sides[side].get(other) ?? new Set<string>();
    if (label !== undefined) labels.add(label);
    sides[side].set(other, labels);
  };
  for (const edge of diagram.edges) {
    if (edge.from !== id && edge.to !== id) continue;
    edges.push(edge.index);
    const other = edge.from === id ? edge.to : edge.from;
    if (!byId.has(other)) continue;
    if (edge.direction === "none") add("linked", other, edge.label);
    else if (edge.direction === "both") {
      add("next", other, edge.label);
      add("previous", other, edge.label);
    } else add(edge.from === id ? "next" : "previous", other, edge.label);
  }
  const nodes = (side: keyof typeof sides): DiagramNode[] => [...sides[side].keys()].flatMap((other) => byId.get(other) ?? []);
  const named = (side: keyof typeof sides): string[] =>
    [...sides[side].entries()].map(([other, labels]) => `${byId.get(other)?.label ?? other}${labels.size === 0 ? "" : ` (${[...labels].join(", ")})`}`);
  return {
    next: nodes("next"),
    previous: nodes("previous"),
    linked: nodes("linked"),
    edges,
    named: { next: named("next"), previous: named("previous"), linked: named("linked") },
  };
}

export interface DiagramState {
  selectedId?: string;
}

/** The selection a widget holds, ignoring one that names a node the props no longer have. */
export function readDiagramState(state: unknown, diagram: Pick<Diagram, "nodes">): DiagramState {
  const value = record(state) ? state : {};
  const selectedId = value.selectedId;
  return typeof selectedId === "string" && diagram.nodes.some((node) => node.id === selectedId) ? { selectedId } : {};
}

/** What a `diagram.select` may carry: a node on this diagram, or `""` to clear. Refused here, ignored only on reading. */
export function diagramSelectionProblems(diagram: Pick<Diagram, "nodes">, input: unknown): string[] {
  if (!record(input)) return ["a diagram selection is an object with selectedId"];
  const extra = Object.keys(input).filter((key) => key !== "selectedId");
  if (extra.length > 0) return [`a diagram selection carries only selectedId, not ${extra.slice(0, 5).join(", ")}`];
  const selected = input.selectedId;
  if (typeof selected !== "string") return ["selectedId names a node on this diagram, or is empty to clear the selection"];
  if (selected !== "" && !diagram.nodes.some((node) => node.id === selected)) return [`selectedId "${selected.slice(0, MAX_DIAGRAM_ID)}" is not a node on this diagram`];
  return [];
}

const ARROW: Record<DiagramEdgeDirection, string> = { forward: "→", both: "↔", none: "—" };

/** One node of the adjacency list, as the text alternative and the list under the drawing both write it: "Label [group]: → Next (label)". */
export function diagramTextLine(diagram: Pick<Diagram, "nodes" | "edges">, node: DiagramNode): string {
  const name = `${node.label}${node.group === undefined ? "" : ` [${node.group}]`}`;
  const out = diagram.edges
    .filter((edge) => edge.from === node.id)
    .map((edge) => `${ARROW[edge.direction]} ${diagram.nodes.find((other) => other.id === edge.to)?.label ?? edge.to}${edge.label === undefined ? "" : ` (${edge.label})`}`);
  return out.length === 0 ? name : `${name}: ${out.join(", ")}`;
}

/**
 * The diagram as an adjacency list: each node with the edges it starts, then the nodes nothing starts from.
 *
 * What a reader gets when the drawing is unavailable and what the transcript keeps, so it names every node and every
 * edge once, by label, in the order the props gave them.
 */
export function diagramText(diagram: Diagram, limit: number = SNAPSHOT_TEXT_LIMIT): string {
  const lines = diagram.nodes.map((node) => `- ${diagramTextLine(diagram, node)}`);
  const head = `${diagram.title ?? "Diagram"}: ${String(diagram.nodes.length)} node${diagram.nodes.length === 1 ? "" : "s"}, ${String(diagram.edges.length)} edge${diagram.edges.length === 1 ? "" : "s"}`;
  return clipWithMarker(lines.length === 0 ? `${head}\nno nodes` : `${head}\n${lines.join("\n")}`, limit);
}

function labels(names: readonly string[]): string[] {
  return names.slice(0, SEMANTIC_LIMITS.list).map((name) => clipWithMarker(name, SEMANTIC_LIMITS.listEntry, "…"));
}

/** What voice and the next turn read: the counts, how it is laid out, and the selected node with its neighbours. */
export function diagramSemantic(diagram: Diagram, state: DiagramState): {
  title?: string;
  summary: string;
  values: Record<string, SemanticValue>;
  selectedIds: string[];
} {
  const selected = diagram.nodes.find((node) => node.id === state.selectedId);
  const neighbours = selected === undefined ? undefined : diagramNeighbours(diagram, selected.id);
  const arrangement = `${diagram.layout} ${diagram.direction === "LR" ? "left to right" : "top to bottom"}`;
  const head = `Diagram: ${String(diagram.nodes.length)} nodes, ${String(diagram.edges.length)} edges, ${arrangement}`;
  const selection =
    selected === undefined || neighbours === undefined
      ? ""
      : `; selected ${selected.label} (${String(neighbours.previous.length)} in, ${String(neighbours.next.length)} out, ${String(neighbours.linked.length)} linked)`;
  const values: Record<string, SemanticValue> = {
    nodeCount: diagram.nodes.length,
    edgeCount: diagram.edges.length,
    layout: diagram.layout,
    direction: diagram.direction,
    ...(selected === undefined || neighbours === undefined
      ? {}
      : {
          selectedLabel: selected.label,
          ...(selected.group === undefined ? {} : { selectedGroup: selected.group }),
          previous: labels(neighbours.named.previous),
          next: labels(neighbours.named.next),
          linked: labels(neighbours.named.linked),
        }),
  };
  return {
    ...(diagram.title === undefined ? {} : { title: diagram.title }),
    summary: clipWithMarker(`${head}${selection}`, SEMANTIC_LIMITS.summary, "…"),
    values: Object.fromEntries(Object.entries(values).slice(0, SEMANTIC_LIMITS.values)),
    selectedIds: selected === undefined ? [] : [selected.id],
  };
}
