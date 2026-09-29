import { describe, expect, it } from "vitest";

import {
  MAX_DETAIL_ITEMS,
  MAX_PROGRESS_STEPS,
  SEMANTIC_LIMITS,
  canonicalSemanticDoc,
  normalizeSemanticDoc,
  progressPercent,
  readStatusCard,
  statusCardProblems,
  statusCardSemantic,
  statusCardText,
  stepCounts,
} from "../src/index.ts";

/**
 * A status, the progress of one thing, a few labelled facts: what the node refuses, and what a card that passes says.
 *
 * The node and the page read the same props with these functions, so what is refused here is exactly what the page
 * would never draw.
 */

const STEPS = [
  { label: "Pack", status: "done" },
  { label: "Move", status: "current" },
  { label: "Paint", status: "skipped" },
  { label: "Internet", status: "failed" },
  { label: "Party", status: "pending" },
];

describe("status cards: what is refused", () => {
  it("accepts a status, a value of a maximum, steps and facts", () => {
    expect(statusCardProblems("status", { label: "Backup done", tone: "success" })).toEqual([]);
    expect(statusCardProblems("progress", { value: 3, max: 5, unit: "files" })).toEqual([]);
    expect(statusCardProblems("progress", { steps: STEPS })).toEqual([]);
    expect(statusCardProblems("details", { items: [{ label: "Owner", value: "Lan" }] })).toEqual([]);
  });

  it("refuses a tone, a step status or a key it does not know", () => {
    expect(statusCardProblems("status", { label: "x", tone: "red" })).not.toEqual([]);
    expect(statusCardProblems("status", { label: "x", tone: "info", live: true })).not.toEqual([]);
    expect(statusCardProblems("progress", { steps: [{ label: "x", status: "running" }] })).not.toEqual([]);
    expect(statusCardProblems("details", { items: [{ label: "x", value: "y", tone: "ok" }] })).not.toEqual([]);
  });

  it("has no progress without a value and a maximum or steps, so nothing spins with nothing behind it", () => {
    expect(statusCardProblems("progress", { label: "Importing" })).toEqual([
      "a progress card needs a value and a maximum, or steps; there is no progress without either",
    ]);
    expect(statusCardProblems("progress", { value: 3 })).toContain("a value and a maximum go together");
    expect(statusCardProblems("progress", { max: 3 })).toContain("a value and a maximum go together");
  });

  it("refuses a value above its maximum, a maximum of zero and a negative value", () => {
    expect(statusCardProblems("progress", { value: 130, max: 120 })).toEqual(["the value 130 is above the maximum 120"]);
    expect(statusCardProblems("progress", { value: 0, max: 0 })).not.toEqual([]);
    expect(statusCardProblems("progress", { value: -1, max: 3 })).not.toEqual([]);
  });

  it("refuses a value and steps together, a unit on steps, and two current steps", () => {
    expect(statusCardProblems("progress", { value: 1, max: 2, steps: STEPS })).toContain(
      "a progress card shows either a value of a maximum or a list of steps, not both",
    );
    expect(statusCardProblems("progress", { unit: "%", steps: STEPS })).toContain("a unit goes with a value, not with steps");
    expect(
      statusCardProblems("progress", {
        steps: [
          { label: "a", status: "current" },
          { label: "b", status: "current" },
        ],
      }),
    ).toEqual(["2 steps are current; at most one step is"]);
  });

  it("bounds steps and facts, and refuses an empty list", () => {
    const step = { label: "s", status: "pending" };
    expect(statusCardProblems("progress", { steps: Array.from({ length: MAX_PROGRESS_STEPS }, () => step) })).toEqual([]);
    expect(statusCardProblems("progress", { steps: Array.from({ length: MAX_PROGRESS_STEPS + 1 }, () => step) })).not.toEqual([]);
    expect(statusCardProblems("progress", { steps: [] })).not.toEqual([]);
    const items = Array.from({ length: MAX_DETAIL_ITEMS + 1 }, (_, index) => ({ label: `k${String(index)}`, value: "v" }));
    expect(statusCardProblems("details", { items: items.slice(0, MAX_DETAIL_ITEMS) })).toEqual([]);
    expect(statusCardProblems("details", { items })).not.toEqual([]);
    expect(statusCardProblems("details", { items: [] })).not.toEqual([]);
  });

  it("refuses a fact label twice, since a reader could not tell the two apart", () => {
    expect(
      statusCardProblems("details", {
        items: [
          { label: "Owner", value: "Lan" },
          { label: "Owner", value: "Minh" },
        ],
      }),
    ).toEqual(["labels repeat: Owner; each fact needs its own label"]);
  });

  it("takes an as-of day or an instant with its offset, and refuses one that is ambiguous or not real", () => {
    const at = (asOf: string) => statusCardProblems("status", { label: "x", tone: "info", asOf });
    expect(at("2026-09-30")).toEqual([]);
    expect(at("2026-09-30T09:00:00+07:00")).toEqual([]);
    expect(at("2026-09-30T02:00Z")).toEqual([]);
    expect(at("2026-09-30T09:00:00")).not.toEqual([]);
    expect(at("yesterday")).not.toEqual([]);
    expect(at("2026-02-30")).toEqual(['"asOf" is not a real date or time: 2026-02-30']);
  });

  it("reads nothing the node would refuse", () => {
    expect(readStatusCard("progress", { value: 130, max: 120 })).toBeUndefined();
    expect(readStatusCard("status", "not props")).toBeUndefined();
    expect(readStatusCard("status", { label: "ok", tone: "success" })).toEqual({ kind: "status", card: { label: "ok", tone: "success" } });
  });
});

describe("status cards: what a card says", () => {
  it("rounds a percentage and counts finished steps", () => {
    expect(progressPercent({ value: 42, max: 120 })).toBe(35);
    expect(progressPercent({ steps: [{ label: "a", status: "done" }] })).toBeUndefined();
    expect(stepCounts(STEPS as never)).toEqual({ finished: 2, total: 5, failed: 1, current: { label: "Move", status: "current" } });
  });

  it("writes a text alternative from the props, with the tone and the as-of in words", () => {
    const text = (kind: "status" | "progress" | "details", props: Record<string, unknown>) => {
      const content = readStatusCard(kind, props);
      if (content === undefined) throw new Error("unreadable");
      return statusCardText(content);
    };
    expect(text("status", { title: "Build", label: "Flaky", tone: "warning", detail: "2 retries", asOf: "2026-09-30" })).toBe(
      "Build: Flaky (warning). 2 retries (as of 2026-09-30)",
    );
    expect(text("progress", { label: "Photos", value: 42, max: 120, unit: "photos" })).toBe("Photos: 42 of 120 photos (35%)");
    expect(text("progress", { steps: STEPS })).toBe(
      "2 of 5 steps finished. Pack [done]; Move [current]; Paint [skipped]; Internet [failed]; Party [pending]",
    );
    expect(text("details", { title: "Order", items: [{ label: "Total", value: "1,250" }] })).toBe("Order: Total: 1,250");
  });

  it("says in its semantic summary that the card is what was stated when shown", () => {
    const content = readStatusCard("status", { label: "Down", tone: "danger", detail: "503" });
    if (content === undefined) throw new Error("unreadable");
    expect(statusCardSemantic(content)).toEqual({
      summary: "Status as stated when shown: Down (danger)",
      values: { label: "Down", tone: "danger", detail: "503" },
    });
    const steps = readStatusCard("progress", { title: "Move", steps: STEPS });
    if (steps === undefined) throw new Error("unreadable");
    expect(statusCardSemantic(steps)).toMatchObject({
      title: "Move",
      summary: "Progress as stated when shown: 2 of 5 steps finished; current: Move; failed: Internet",
      values: { stepsFinished: 2, stepsTotal: 5, currentStep: "Move", failedSteps: ["Internet"] },
    });
  });

  it("stays inside the semantic bounds at the largest card the schema allows", () => {
    const items = Array.from({ length: MAX_DETAIL_ITEMS }, (_, index) => ({ label: `${"k".repeat(70)}${String(index)}`, value: "v".repeat(300) }));
    const content = readStatusCard("details", { title: "t".repeat(200), items, asOf: "2026-09-30" });
    if (content === undefined) throw new Error("unreadable");
    const doc = normalizeSemanticDoc({ instanceId: "i", definitionId: "canvas.details@1", ...statusCardSemantic(content) });
    expect(canonicalSemanticDoc(doc).length).toBeLessThanOrEqual(SEMANTIC_LIMITS.bytes);
    expect((doc.values.items as string[]).length).toBeLessThanOrEqual(SEMANTIC_LIMITS.list);
  });
});
