import { z } from "zod";

/**
 * The layout tree of a composed surface.
 *
 * A template places its regions in fixed slots. A layout tree places them wherever the tree says: a
 * grid of three, a card holding a filter above a table, two tabs. The tree is only arrangement. Its
 * leaves point at the composition's sections by id, and a section is still an ordinary catalog widget
 * whose props were validated and whose definition digest was pinned when it was compiled. So a tree
 * adds no way to run anything: it has no widget ids, no props and no data of its own, only kinds,
 * labels and the ids of sections that already passed every check a section passes.
 *
 * It is bounded in the three directions a model could push it, and a tree over any bound is refused
 * with the bound it crossed rather than cut down to fit: a layout that silently lost a branch would
 * show the person something other than what was asked for, and nothing would say so.
 */

/** Containers a tree may use. `widget` and `divider` are the two leaf kinds. */
export const LAYOUT_CONTAINER_KINDS = ["stack", "row", "grid", "card", "tabs", "split", "collapsible"] as const;
export type LayoutContainerKind = (typeof LAYOUT_CONTAINER_KINDS)[number];

/** Levels below the root. The root is depth 1, so `grid > card > widget` is depth 3. */
export const MAX_LAYOUT_DEPTH = 5;
/** Every node counts, containers, widgets and dividers alike. */
export const MAX_LAYOUT_NODES = 40;
export const MAX_LAYOUT_CHILDREN = 12;
export const MAX_GRID_COLUMNS = 4;
export const MAX_TABS = 8;

export interface LayoutWidgetNode {
  kind: "widget";
  sectionId: string;
  /** Needed when the widget is a tab or a collapsible's only child; otherwise optional. */
  label?: string | undefined;
}

export interface LayoutDividerNode {
  kind: "divider";
}

export interface LayoutContainerNode {
  kind: LayoutContainerKind;
  label?: string | undefined;
  /** `grid` only: how many columns it has at full width. It becomes one column when there is no room. */
  columns?: number | undefined;
  /** `collapsible` only: whether it starts open. */
  open?: boolean | undefined;
  children: LayoutNode[];
}

export type LayoutNode = LayoutWidgetNode | LayoutDividerNode | LayoutContainerNode;

const labelSchema = z.string().trim().min(1).max(120);
const sectionIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "section ids are lowercase identifiers");

/**
 * The shape of a stored tree.
 *
 * Strict at every level: a node with a field that is not here is refused, because the fields that are
 * not here are the ones that would let a layout carry something other than arrangement.
 */
export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.strictObject({ kind: z.literal("widget"), sectionId: sectionIdSchema, label: labelSchema.optional() }),
    z.strictObject({ kind: z.literal("divider") }),
    z.strictObject({
      kind: z.enum(LAYOUT_CONTAINER_KINDS),
      label: labelSchema.optional(),
      columns: z.int().min(1).max(MAX_GRID_COLUMNS).optional(),
      open: z.boolean().optional(),
      children: z.array(layoutNodeSchema).min(1).max(MAX_LAYOUT_CHILDREN),
    }),
  ]),
);

export function isLayoutContainer(node: LayoutNode): node is LayoutContainerNode {
  return node.kind !== "widget" && node.kind !== "divider";
}

/** Depth and node count, measured without trusting the tree to be small. */
export function measureLayout(node: LayoutNode): { depth: number; nodes: number } {
  let nodes = 0;
  let depth = 0;
  const walk = (current: LayoutNode, level: number): void => {
    nodes += 1;
    depth = Math.max(depth, level);
    // Stop descending once a bound is already crossed: the answer is "too big" either way, and a
    // hostile tree should not cost more to refuse than to accept.
    if (nodes > MAX_LAYOUT_NODES || level > MAX_LAYOUT_DEPTH) return;
    if (isLayoutContainer(current)) for (const child of current.children) walk(child, level + 1);
  };
  walk(node, 1);
  return { depth, nodes };
}

/** The section ids a tree places, in reading order. */
export function layoutSectionIds(node: LayoutNode): string[] {
  if (node.kind === "widget") return [node.sectionId];
  if (node.kind === "divider") return [];
  return node.children.flatMap(layoutSectionIds);
}

/**
 * Rules a schema cannot express.
 *
 * Every section is placed exactly once, so no region is drawn twice or silently dropped; a tab and a
 * collapsible have a label a person can read and a screen reader can announce; a split has exactly two
 * sides; `columns` belongs to a grid and `open` to a collapsible.
 */
export function checkLayout(node: LayoutNode, sectionIds: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const { depth, nodes } = measureLayout(node);
  if (depth > MAX_LAYOUT_DEPTH) problems.push(`the layout is ${String(depth)} levels deep; at most ${String(MAX_LAYOUT_DEPTH)} are allowed`);
  if (nodes > MAX_LAYOUT_NODES) problems.push(`the layout has more than ${String(MAX_LAYOUT_NODES)} nodes`);
  if (problems.length > 0) return problems;

  const placed = new Map<string, number>();
  const visit = (current: LayoutNode, path: string): void => {
    if (current.kind === "divider") return;
    if (current.kind === "widget") {
      placed.set(current.sectionId, (placed.get(current.sectionId) ?? 0) + 1);
      if (!sectionIds.has(current.sectionId)) problems.push(`${path} places section "${current.sectionId}", which the composition does not have`);
      return;
    }
    const where = `${path} (${current.kind})`;
    if (current.columns !== undefined && current.kind !== "grid") problems.push(`${where} sets columns, which only a grid has`);
    if (current.open !== undefined && current.kind !== "collapsible") problems.push(`${where} sets open, which only a collapsible has`);
    if (current.kind === "collapsible" && current.label === undefined) problems.push(`${where} needs a label to show when it is closed`);
    if (current.kind === "split" && current.children.length !== 2) problems.push(`${where} has ${String(current.children.length)} sides; a split has two`);
    if (current.kind === "tabs") {
      if (current.children.length < 2 || current.children.length > MAX_TABS) {
        problems.push(`${where} has ${String(current.children.length)} tabs; between 2 and ${String(MAX_TABS)} are allowed`);
      }
      current.children.forEach((child, index) => {
        if (child.kind === "divider" || child.label === undefined) problems.push(`${where} tab ${String(index + 1)} needs a label`);
      });
    }
    current.children.forEach((child, index) => visit(child, `${path}.${String(index + 1)}`));
  };
  visit(node, "layout");

  for (const [sectionId, count] of placed) {
    if (count > 1) problems.push(`section "${sectionId}" is placed ${String(count)} times; a section is placed once`);
  }
  for (const sectionId of sectionIds) {
    if (!placed.has(sectionId)) problems.push(`section "${sectionId}" is not placed anywhere in the layout`);
  }
  return problems;
}

/**
 * The tree read as text, for a reader who cannot see it.
 *
 * Every node has one: a container is its label followed by its children, a widget is its section's own
 * text alternative, and a divider is a paragraph break. It is what a snapshot keeps as its text, and what
 * a client that does not know a container kind falls back to.
 */
export function describeLayout(node: LayoutNode, textOf: (sectionId: string) => string): string {
  if (node.kind === "divider") return "";
  if (node.kind === "widget") return node.label === undefined ? textOf(node.sectionId) : `${node.label}: ${textOf(node.sectionId)}`;
  const inner = node.children
    .map((child) => describeLayout(child, textOf))
    .filter((text) => text !== "")
    .join(" ");
  return node.label === undefined ? inner : `${node.label}: ${inner}`;
}
