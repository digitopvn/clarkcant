import type { TreeNode } from "@clarkcant/contracts";

export interface VisibleTreeNode {
  node: TreeNode;
  level: number;
  position: number;
  setSize: number;
  parentId?: string;
  expanded: boolean;
}

/** The rows in keyboard order; collapsed descendants are not part of the focus sequence. */
export function visibleTreeNodes(nodes: readonly TreeNode[], expanded: ReadonlySet<string>, level = 1, parentId?: string): VisibleTreeNode[] {
  return nodes.flatMap((node, index) => {
    const isExpanded = expanded.has(node.id);
    const current: VisibleTreeNode = {
      node,
      level,
      position: index + 1,
      setSize: nodes.length,
      ...(parentId === undefined ? {} : { parentId }),
      expanded: isExpanded,
    };
    return [current, ...(isExpanded ? visibleTreeNodes(node.children ?? [], expanded, level + 1, node.id) : [])];
  });
}

export function treeFocusTarget(key: string, visible: readonly VisibleTreeNode[], currentId: string): string | undefined {
  const index = visible.findIndex((row) => row.node.id === currentId);
  switch (key) {
    case "ArrowDown": return visible[index + 1]?.node.id;
    case "ArrowUp": return visible[index - 1]?.node.id;
    case "Home": return visible[0]?.node.id;
    case "End": return visible.at(-1)?.node.id;
    default: return undefined;
  }
}

/** Search forward from focus and wrap once, matching labels with the reader's locale rules. */
export function treeTypeaheadTarget(visible: readonly VisibleTreeNode[], currentId: string, query: string, locale: string): string | undefined {
  if (query === "") return undefined;
  const index = visible.findIndex((row) => row.node.id === currentId);
  const start = Math.max(index + 1, 0);
  const ordered = [...visible.slice(start), ...visible.slice(0, start)];
  return ordered.find((row) => row.node.label.toLocaleLowerCase(locale).startsWith(query))?.node.id;
}
