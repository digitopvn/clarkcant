import { describe, expect, it } from "vitest";

import type { TreeNode } from "@clarkcant/contracts";
import { treeFocusTarget, treeTypeaheadTarget, visibleTreeNodes } from "../src/tree-layout.ts";

const NODES: TreeNode[] = [
  { id: "project", label: "ClarkCant", children: [{ id: "client", label: "Ứng dụng", children: [{ id: "composer", label: "Trình soạn thảo" }] }] },
  { id: "people", label: "Cộng tác viên" },
];

describe("tree keyboard order", () => {
  it("includes expanded descendants once with their set position and parent", () => {
    const visible = visibleTreeNodes(NODES, new Set(["project", "client"]));
    expect(visible.map((row) => [row.node.id, row.level, row.position, row.setSize, row.parentId])).toEqual([
      ["project", 1, 1, 2, undefined],
      ["client", 2, 1, 1, "project"],
      ["composer", 3, 1, 1, "client"],
      ["people", 1, 2, 2, undefined],
    ]);
  });

  it("moves arrows through visible rows and Home/End to their ends", () => {
    const visible = visibleTreeNodes(NODES, new Set(["project"]));
    expect(treeFocusTarget("ArrowDown", visible, "project")).toBe("client");
    expect(treeFocusTarget("ArrowUp", visible, "people")).toBe("client");
    expect(treeFocusTarget("Home", visible, "people")).toBe("project");
    expect(treeFocusTarget("End", visible, "project")).toBe("people");
    expect(treeFocusTarget("ArrowUp", visible, "project")).toBeUndefined();
    expect(treeFocusTarget("End", [], "project")).toBeUndefined();
    expect(treeFocusTarget("Enter", visible, "project")).toBeUndefined();
  });

  it("finds labels after focus, wraps once and excludes collapsed descendants", () => {
    const visible = visibleTreeNodes(NODES, new Set(["project"]));
    expect(treeTypeaheadTarget(visible, "project", "ứ", "vi")).toBe("client");
    expect(treeTypeaheadTarget(visible, "people", "cla", "en")).toBe("project");
    expect(treeTypeaheadTarget(visible, "project", "trình", "vi")).toBeUndefined();
    expect(treeTypeaheadTarget(visible, "project", "", "vi")).toBeUndefined();
  });
});
