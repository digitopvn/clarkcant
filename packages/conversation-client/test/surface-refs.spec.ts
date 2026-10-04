import { describe, expect, it } from "vitest";

import { repeatsDrawnSurface } from "../src/surface-refs.ts";

const surface = (instanceId: string): Record<string, unknown> => ({
  type: "surface",
  definitionRef: { id: "canvas.line", version: "1" },
  snapshot: { instanceId, snapshotId: "snap_1", textAlternative: "Biểu đồ đường" },
});
const ref = (instanceId: string): Record<string, unknown> => ({
  type: "widget-ref",
  instanceId,
  displayMode: "inline",
  textAlternative: "Line chart over a dataset reference",
});

describe("a widget reference next to the surface that draws it", () => {
  it("is left out when a surface in the same message draws that instance", () => {
    const blocks = [{ type: "text", content: "Biểu đồ" }, surface("inst_1"), ref("inst_1")];
    expect(repeatsDrawnSurface(blocks, 2)).toBe(true);
    expect(repeatsDrawnSurface(blocks, 1)).toBe(false);
  });

  it("is drawn when no surface names its instance, since its text is then all there is", () => {
    expect(repeatsDrawnSurface([surface("inst_1"), ref("inst_2")], 1)).toBe(false);
    expect(repeatsDrawnSurface([ref("inst_1")], 0)).toBe(false);
  });
});
