import { describe, expect, it } from "vitest";

import { describeSemanticDoc, normalizeSemanticDoc, semanticDelta, uiContextNote } from "@clarkcant/contracts";
import { inspectSemanticProposal, semanticDocWithinLimits, SEMANTIC_PUBLISH_CHURN_LIMIT } from "../src/dev-semantic.ts";

describe("the semantic inspector", () => {
  it("uses the shared normalized document, delta, context note, and inspect_ui text", () => {
    const previous = normalizeSemanticDoc({
      instanceId: "dev-instance",
      definitionId: "example.notes",
      summary: "One note",
      values: { count: 1 },
      source: "frame",
      freshness: "sample",
    });
    const next = normalizeSemanticDoc({
      instanceId: "dev-instance",
      definitionId: "example.notes",
      summary: "Two notes",
      values: { count: 2 },
      source: "frame",
      freshness: "sample",
    });
    const result = inspectSemanticProposal({
      definitionId: "example.notes",
      rawProposal: { summary: "Two notes", values: { count: 2 } },
      previous: { doc: previous, revision: 1 },
      revision: 2,
      recentPublishTimes: [],
      now: 1_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inspection.doc).toEqual(next);
    expect(result.inspection.delta).toEqual(semanticDelta(previous, next));
    expect(result.inspection.contextNote).toBe(
      uiContextNote([{ doc: next, revision: 2, seen: { doc: previous, revision: 1 } }]).text,
    );
    expect(result.inspection.inspectUi).toBe(describeSemanticDoc(next).join("\n"));
  });

  it("marks clipped and dropped proposal fields and refuses malformed proposals", () => {
    const result = inspectSemanticProposal({
      definitionId: "example.notes",
      rawProposal: {
        summary: "x".repeat(400),
        values: { count: 1, "not a key": "ignored" },
        selectedIds: Array.from({ length: 24 }, (_, index) => "id-" + String(index)),
      },
      revision: 1,
      recentPublishTimes: [],
      now: 1_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inspection.clippedOrDropped).toEqual([
      "summary",
      "values.not a key (dropped)",
      "selectedIds (cleaned or clipped)",
    ]);
    expect(
      inspectSemanticProposal({
        definitionId: "example.notes",
        rawProposal: { summary: "" },
        revision: 1,
        recentPublishTimes: [],
        now: 1_000,
      }),
    ).toMatchObject({ ok: false });
  });

  it("warns when the widget publishes more than four times in one second", () => {
    let recentPublishTimes: number[] = [];
    for (let index = 0; index <= SEMANTIC_PUBLISH_CHURN_LIMIT; index += 1) {
      const result = inspectSemanticProposal({
        definitionId: "example.notes",
        rawProposal: { summary: "unchanged" },
        revision: index + 1,
        recentPublishTimes,
        now: 1_000 + index * 100,
      });
      expect(result.ok).toBe(true);
      if (result.ok) recentPublishTimes = result.recentPublishTimes;
      if (index < SEMANTIC_PUBLISH_CHURN_LIMIT) {
        expect(result.ok && result.inspection.churnWarning).toBe(false);
      } else {
        expect(result.ok && result.inspection.churnWarning).toBe(true);
      }
    }
  });

  it("rejects a semantic document that exceeds the shared limits", () => {
    const doc = normalizeSemanticDoc({
      instanceId: "dev-instance",
      definitionId: "example.notes",
      summary: "bounded",
      source: "frame",
    });
    expect(semanticDocWithinLimits(doc)).toBe(true);
    expect(semanticDocWithinLimits({ ...doc, summary: "x".repeat(301) })).toBe(false);
  });
});
