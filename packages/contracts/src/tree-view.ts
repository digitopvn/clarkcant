import { z } from "zod";

import { cardSchemaProblems, clipWithMarker, hiddenCharacterProblem, oneLineText } from "./text-rules.ts";
import { SEMANTIC_LIMITS, type SemanticValue } from "./widget-semantic.ts";
import { SNAPSHOT_TEXT_LIMIT } from "./widgets.ts";

export const TREE_ID = "canvas.tree@1";
export const TREE_SELECT_OPERATION = "tree.select";
export const TREE_TOGGLE_OPERATION = "tree.toggle";

export const MAX_TREE_NODES = 200;
export const MAX_TREE_DEPTH = 12;
export const MAX_TREE_ID = 120;
export const MAX_TREE_LABEL = 200;
export const MAX_TREE_SECONDARY = 300;
export const TREE_ICONS = ["branch", "document", "folder", "group", "person", "project", "task"] as const;
export type TreeIcon = (typeof TREE_ICONS)[number];

function idSchema() {
  return z.string().min(1, "is empty").max(MAX_TREE_ID, `is longer than ${String(MAX_TREE_ID)} characters`).superRefine((value, ctx) => {
    const problem = hiddenCharacterProblem(value);
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
    else if (value.trim() === "") ctx.addIssue({ code: "custom", message: "is only spaces" });
  });
}

const nodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.strictObject({
    id: idSchema(),
    label: oneLineText(MAX_TREE_LABEL, true),
    secondary: oneLineText(MAX_TREE_SECONDARY, false).optional(),
    icon: z.enum(TREE_ICONS).optional(),
    children: z.array(nodeSchema).max(MAX_TREE_NODES).optional(),
  }),
);

const treeSchema = z.strictObject({
  title: oneLineText(MAX_TREE_LABEL, false).optional(),
  nodes: z.array(nodeSchema).max(MAX_TREE_NODES),
  initiallyExpanded: z.array(idSchema()).max(MAX_TREE_NODES).optional(),
});

export interface TreeNode {
  id: string;
  label: string;
  secondary?: string | undefined;
  icon?: TreeIcon | undefined;
  children?: TreeNode[] | undefined;
}

export interface TreeView {
  title?: string | undefined;
  nodes: TreeNode[];
  initiallyExpanded: string[];
  nodeCount: number;
  depth: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check depth, total nodes and object cycles before recursive schema parsing. */
function boundedShapeProblems(value: unknown): string[] {
  if (!record(value) || !Array.isArray(value.nodes)) return [];
  const problems: string[] = [];
  const active = new WeakSet<object>();
  let count = 0;
  let deepest = 0;
  const visit = (nodes: unknown[], depth: number): void => {
    deepest = Math.max(deepest, depth);
    if (depth > MAX_TREE_DEPTH && !problems.some((problem) => problem.includes("depth"))) {
      problems.push(`tree depth is greater than ${String(MAX_TREE_DEPTH)}`);
      return;
    }
    for (const candidate of nodes) {
      if (record(candidate)) {
        if (active.has(candidate)) {
          if (!problems.some((problem) => problem.includes("cycle"))) problems.push("tree contains a cycle");
          continue;
        }
        count += 1;
        if (count > MAX_TREE_NODES) {
          if (!problems.some((problem) => problem.includes("node count"))) problems.push(`tree has more than ${String(MAX_TREE_NODES)} nodes`);
          return;
        }
        active.add(candidate);
        if (Array.isArray(candidate.children)) visit(candidate.children, depth + 1);
        active.delete(candidate);
      } else {
        count += 1;
        if (count > MAX_TREE_NODES) {
          if (!problems.some((problem) => problem.includes("node count"))) problems.push(`tree has more than ${String(MAX_TREE_NODES)} nodes`);
          return;
        }
      }
      if (problems.length > 0 && (problems.some((problem) => problem.includes("cycle")) || count > MAX_TREE_NODES)) return;
    }
  };
  visit(value.nodes, 1);
  return problems;
}

function flatten(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

/** Placement problems shared by the model schema's semantic validation and the runtime's exact refusal reason. */
export function treeProblems(input: unknown): string[] {
  const bounded = boundedShapeProblems(input);
  if (bounded.length > 0) return bounded;
  const parsed = treeSchema.safeParse(input);
  if (!parsed.success) return cardSchemaProblems(parsed.error.issues);
  const nodes = flatten(parsed.data.nodes);
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) repeated.add(node.id);
    seen.add(node.id);
  }
  const problems: string[] = [];
  if (repeated.size > 0) problems.push(`node ids repeat: ${[...repeated].slice(0, 5).join(", ")}; each node needs its own id`);
  const expanded = parsed.data.initiallyExpanded ?? [];
  const repeatedExpanded = expanded.filter((id, index) => expanded.indexOf(id) !== index);
  if (repeatedExpanded.length > 0) problems.push(`initiallyExpanded repeats ${[...new Set(repeatedExpanded)].slice(0, 5).join(", ")}`);
  const ids = new Set(nodes.map((node) => node.id));
  const unknownExpanded = [...new Set(expanded.filter((id) => !ids.has(id)))];
  if (unknownExpanded.length > 0) problems.push(`initiallyExpanded names missing nodes: ${unknownExpanded.slice(0, 5).join(", ")}`);
  const branches = new Set(nodes.filter((node) => (node.children?.length ?? 0) > 0).map((node) => node.id));
  const expandedLeaves = [...new Set(expanded.filter((id) => ids.has(id) && !branches.has(id)))];
  if (expandedLeaves.length > 0) problems.push(`initiallyExpanded names leaf nodes: ${expandedLeaves.slice(0, 5).join(", ")}`);
  return problems;
}

/** Parse a tree only after applying the same bounds the placement path uses. */
export function readTree(input: unknown): TreeView | undefined {
  if (treeProblems(input).length > 0) return undefined;
  const parsed = treeSchema.safeParse(input);
  if (!parsed.success) return undefined;
  let depth = 0;
  const countDepth = (nodes: readonly TreeNode[], level: number): void => {
    depth = Math.max(depth, level);
    for (const node of nodes) if ((node.children?.length ?? 0) > 0) countDepth(node.children ?? [], level + 1);
  };
  countDepth(parsed.data.nodes, 1);
  return {
    ...(parsed.data.title === undefined || parsed.data.title === "" ? {} : { title: parsed.data.title }),
    nodes: parsed.data.nodes,
    initiallyExpanded: parsed.data.initiallyExpanded ?? [],
    nodeCount: flatten(parsed.data.nodes).length,
    depth: parsed.data.nodes.length === 0 ? 0 : depth,
  };
}

export interface TreeState {
  selectedId?: string;
  expandedIds: string[];
}

/** Ignore saved ids that no longer exist after props change; keep the current tree bounded. */
export function readTreeState(state: unknown, tree: Pick<TreeView, "nodes" | "initiallyExpanded">): TreeState {
  const branches = new Set(flatten(tree.nodes).filter((node) => (node.children?.length ?? 0) > 0).map((node) => node.id));
  const value = record(state) ? state : {};
  const ids = new Set(flatten(tree.nodes).map((node) => node.id));
  const selectedId = typeof value.selectedId === "string" && ids.has(value.selectedId) ? value.selectedId : undefined;
  const source = Array.isArray(value.expandedIds) ? value.expandedIds : tree.initiallyExpanded;
  const expandedIds = [...new Set(source.filter((id): id is string => typeof id === "string" && branches.has(id)))].slice(0, MAX_TREE_NODES);
  return { ...(selectedId === undefined ? {} : { selectedId }), expandedIds };
}

/** State the host accepts from a page action. Stale identifiers are refused here and ignored only when reading old state. */
export function treeStateProblems(tree: Pick<TreeView, "nodes">, input: unknown): string[] {
  if (!record(input)) return ["tree state is an object with selectedId and expandedIds"];
  const extra = Object.keys(input).filter((key) => key !== "selectedId" && key !== "expandedIds");
  if (extra.length > 0) return [`tree state carries only selectedId and expandedIds, not ${extra.slice(0, 5).join(", ")}`];
  const branches = new Set(flatten(tree.nodes).filter((node) => (node.children?.length ?? 0) > 0).map((node) => node.id));
  const ids = new Set(flatten(tree.nodes).map((node) => node.id));
  const selected = input.selectedId;
  if (selected !== undefined && (typeof selected !== "string" || (selected !== "" && !ids.has(selected)))) return ["selectedId must name a node on this tree or be empty to clear selection"];
  const expanded = input.expandedIds;
  if (expanded !== undefined) {
    if (!Array.isArray(expanded) || expanded.length > MAX_TREE_NODES || expanded.some((id) => typeof id !== "string" || !branches.has(id))) {
      return ["expandedIds must name at most 200 expandable branches on this tree"];
    }
    if (new Set(expanded).size !== expanded.length) return ["expandedIds must not repeat a node"];
  }
  return [];
}

export function treeText(tree: TreeView, limit: number = SNAPSHOT_TEXT_LIMIT): string {
  const lines: string[] = [];
  const visit = (nodes: readonly TreeNode[], depth: number): void => {
    for (const node of nodes) {
      lines.push(`${"  ".repeat(depth)}- ${node.label}${node.secondary === undefined ? "" : ` — ${node.secondary}`}`);
      visit(node.children ?? [], depth + 1);
    }
  };
  visit(tree.nodes, 0);
  const body = lines.length === 0 ? "no nodes" : lines.join("\n");
  return clipWithMarker(`${tree.title === undefined ? "Hierarchy" : tree.title}:\n${body}`, limit);
}

export function treeSemantic(tree: TreeView, state: TreeState): {
  title?: string;
  summary: string;
  values: Record<string, SemanticValue>;
  selectedIds: string[];
} {
  const nodes = flatten(tree.nodes);
  const selected = nodes.find((node) => node.id === state.selectedId);
  const pathFor = (target: string | undefined, source: readonly TreeNode[], path: readonly string[] = []): string[] | undefined => {
    for (const node of source) {
      const next = [...path, node.label];
      if (node.id === target) return next;
      const child = pathFor(target, node.children ?? [], next);
      if (child !== undefined) return child;
    }
    return undefined;
  };
  const selectedPath = pathFor(selected?.id, tree.nodes);
  const summary = `Hierarchy: ${String(tree.nodeCount)} nodes across ${String(tree.depth)} level${tree.depth === 1 ? "" : "s"}; ${String(state.expandedIds.length)} expanded${selectedPath === undefined ? "" : `; selected ${selectedPath.join(" / ")}`}`;
  const values: Record<string, SemanticValue> = {
    nodeCount: tree.nodeCount,
    depth: tree.depth,
    expandedNodes: state.expandedIds.length,
    ...(selected === undefined ? {} : { selectedLabel: selected.label, selectedPath: (selectedPath ?? []).join(" / ") }),
  };
  return {
    ...(tree.title === undefined ? {} : { title: tree.title }),
    summary,
    values: Object.fromEntries(Object.entries(values).slice(0, SEMANTIC_LIMITS.values)),
    selectedIds: selected === undefined ? [] : [selected.id],
  };
}
