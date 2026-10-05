import { describe, expect, it } from "vitest";

import { countsAsStep, foldWorkSteps, isWorkBlock } from "../src/work-steps.ts";

/**
 * Folding a run of working steps into one line.
 *
 * The properties that matter: the order never changes, a short run is left alone, the reply's own words are never
 * folded, and the number on the line counts things that were done rather than the notes under them.
 */

const tool = (id: string, status = "done") => ({ type: "tool-activity", toolCallId: id, status });
const thought = { type: "reasoning", content: "…" };
const check = { type: "evidence", verdict: "verified" };
const words = (content: string) => ({ type: "text", content });

function shape(blocks: Record<string, unknown>[]): string[] {
  return foldWorkSteps(blocks, isWorkBlock, countsAsStep).map((run) =>
    run.kind === "item" ? String(run.item.type) : `steps(${run.count}:${run.entries.map((entry) => entry.index).join(",")})`,
  );
}

describe("folding working steps", () => {
  it("folds a long run into one line and keeps the reply's words outside it, in order", () => {
    expect(shape([words("a"), thought, tool("1"), tool("2"), tool("3"), words("b")])).toEqual([
      "text",
      "steps(4:1,2,3,4)",
      "text",
    ]);
  });

  it("leaves a short run as it is, because folding two lines saves nothing", () => {
    expect(shape([thought, tool("1"), words("done")])).toEqual(["reasoning", "tool-activity", "text"]);
  });

  it("counts the things done, not the checks under them", () => {
    const folded = foldWorkSteps([tool("1"), check, tool("2"), check], isWorkBlock, countsAsStep);
    expect(folded).toEqual(folded.filter((run) => run.kind === "item"));
    expect(shape([tool("1"), check, tool("2"), check, tool("3")])).toEqual(["steps(3:0,1,2,3,4)"]);
  });

  it("starts a new run after the reply speaks", () => {
    expect(shape([tool("1"), tool("2"), tool("3"), words("x"), tool("4"), tool("5"), tool("6")])).toEqual([
      "steps(3:0,1,2)",
      "text",
      "steps(3:4,5,6)",
    ]);
  });

  it("lets the caller keep one step out of the fold, as the live reply does with the newest", () => {
    const live = [tool("1"), tool("2"), tool("3"), tool("4")];
    const runs = foldWorkSteps(live, (_item, index) => index !== live.length - 1);
    expect(runs.map((run) => run.kind)).toEqual(["steps", "item"]);
  });
});
