import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Instant, type MessageBlock, SEMANTIC_LIMITS, canonicalSemanticDoc } from "@clarkcant/contracts";
import { getInstance } from "@clarkcant/core";
import { DETAILS, PROGRESS, STATUS } from "@clarkcant/data-canvas";

import { compileLayout, layoutLeafWidgets } from "../src/compose-layout.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";
import { buildWidgetSemantic } from "../src/widget-semantic.ts";

/**
 * Status, progress and details cards, placed the way a model's `show_view` places them.
 *
 * What matters is what the node refuses and what it keeps: props that do not fit are refused before an instance exists,
 * the text a reader gets without the renderer is the card's own words, and what voice and `inspect_ui` read is built
 * from the props and never claims to be live.
 */

const AT = "2026-09-30T05:00:00.000Z" as Instant;

let dir: string;
let services: NodeServices;
let counter = 0;

function views() {
  return buildViewCatalog(services.conductor);
}

async function place(definitionId: string, props: Record<string, unknown>, caption = "") {
  const view = views().find((entry) => entry.id === definitionId);
  if (view === undefined) throw new Error(`${definitionId} is not in the catalog`);
  return (await view.build({
    props,
    caption,
    at: AT,
    principal: { principalId: services.runtime.identity.ownerPrincipalId, kind: "user", nodeId: services.runtime.identity.nodeId } as never,
    messageId: `msg_${String(++counter)}`,
    conversationId: "conv_status_cards",
  })) as Extract<MessageBlock, { type: "surface" }>;
}

function instanceRows(): number {
  return (services.runtime.db.prepare("SELECT COUNT(*) AS n FROM widget_instances").get() as { n: number }).n;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-status-cards-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
});

afterEach(() => {
  services.runtime.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("the model's vocabulary", () => {
  it("offers the three cards, each saying its props and that what it shows is not a live reading", () => {
    const byId = new Map(views().map((view) => [view.id, view]));
    for (const definition of [STATUS, PROGRESS, DETAILS]) {
      const view = byId.get(definition.id);
      expect(view?.notes).toBeTruthy();
      expect(view?.shownText).toContain("not a live reading");
    }
    expect(byId.get(STATUS.id)?.notes).toContain("neutral, info, success, warning, danger");
    expect(byId.get(PROGRESS.id)?.notes).toContain("at most one current step");
  });

  it("lets a layout place them", () => {
    expect(layoutLeafWidgets(services.compose.registry)).toEqual(expect.arrayContaining([STATUS.id, PROGRESS.id, DETAILS.id]));
  });
});

describe("placing a card", () => {
  it("keeps the card's own words as its text alternative, over a caption", async () => {
    const block = await place(
      STATUS.id,
      { title: "Build", label: "Flaky", tone: "warning", detail: "2 retries", asOf: "2026-09-30" },
      "Here is the status",
    );
    expect(block.snapshot.textAlternative).toBe("Build: Flaky (warning). 2 retries (as of 2026-09-30)");
    expect(block.snapshot.presentationRef).toBe(`catalog:${STATUS.id}`);
    expect(getInstance(services.conductor, block.snapshot.instanceId ?? "")?.props).toMatchObject({ label: "Flaky", tone: "warning" });
  });

  it("places progress as a value of a maximum and as steps, and facts as label and value pairs", async () => {
    expect((await place(PROGRESS.id, { label: "Photos", value: 42, max: 120, unit: "photos" })).snapshot.textAlternative).toBe(
      "Photos: 42 of 120 photos (35%)",
    );
    expect(
      (
        await place(PROGRESS.id, {
          steps: [
            { label: "Pack", status: "done" },
            { label: "Move", status: "current" },
          ],
        })
      ).snapshot.textAlternative,
    ).toBe("1 of 2 steps finished. Pack [done]; Move [current]");
    expect((await place(DETAILS.id, { items: [{ label: "Total", value: "1,250" }] })).snapshot.textAlternative).toBe("Total: 1,250");
  });

  it.each([
    ["a value above its maximum", PROGRESS.id, { value: 130, max: 120 }, "the value 130 is above the maximum 120"],
    ["progress with nothing behind it", PROGRESS.id, { label: "Working" }, "there is no progress without either"],
    [
      "two current steps",
      PROGRESS.id,
      {
        steps: [
          { label: "a", status: "current" },
          { label: "b", status: "current" },
        ],
      },
      "at most one step is",
    ],
    ["a repeated label", DETAILS.id, { items: [{ label: "A", value: "1" }, { label: "A", value: "2" }] }, "labels repeat"],
    ["an as-of with no offset", STATUS.id, { label: "x", tone: "info", asOf: "2026-09-30T09:00:00" }, "asOf"],
    ["an unknown tone", STATUS.id, { label: "x", tone: "red" }, "tone"],
    ["a key the card does not have", STATUS.id, { label: "x", tone: "info", live: true }, 'unknown property "live"'],
  ])("refuses %s and leaves nothing behind", async (_name, definitionId, props, reason) => {
    const before = instanceRows();
    await expect(place(definitionId, props)).rejects.toThrow(reason);
    expect(instanceRows()).toBe(before);
  });
});

describe("what a card means", () => {
  it("is read from the props, marked as unknown freshness rather than live, and bounded", async () => {
    const block = await place(PROGRESS.id, {
      title: "Move",
      steps: [
        { label: "Pack", status: "done" },
        { label: "Move", status: "current" },
        { label: "Internet", status: "failed" },
      ],
    });
    const doc = buildWidgetSemantic(services.conductor, block.snapshot.instanceId ?? "");
    expect(doc).toMatchObject({
      definitionId: PROGRESS.id,
      title: "Move",
      summary: "Progress as stated when shown: 1 of 3 steps finished; current: Move; failed: Internet",
      values: { stepsFinished: 1, stepsTotal: 3, currentStep: "Move", failedSteps: ["Internet"] },
      freshness: "unknown",
      source: "host",
      availableActions: [],
    });

    const large = await place(DETAILS.id, {
      title: "t".repeat(200),
      items: Array.from({ length: 24 }, (_, index) => ({ label: `${"k".repeat(70)}${String(index)}`, value: "v".repeat(300) })),
    });
    const bounded = buildWidgetSemantic(services.conductor, large.snapshot.instanceId ?? "");
    if (bounded === undefined) throw new Error("no document");
    expect(canonicalSemanticDoc(bounded).length).toBeLessThanOrEqual(SEMANTIC_LIMITS.bytes);
  });
});

describe("a card in a layout", () => {
  const compile = (layout: unknown) =>
    compileLayout({ proposal: layout, registry: services.compose.registry, rowsBySlot: {}, initialState: { period: "week", timezone: "UTC" } });
  const leaf = (widget: string, props: Record<string, unknown>) => ({ kind: "widget", widget, props });

  it("takes the status region with its own words as the section's text", () => {
    const result = compile({
      kind: "grid",
      columns: 3,
      children: [
        leaf(STATUS.id, { label: "Up", tone: "success" }),
        leaf(PROGRESS.id, { value: 3, max: 4 }),
        leaf(DETAILS.id, { items: [{ label: "Region", value: "ap-southeast-1" }] }),
      ],
    });
    if (!result.ok) throw new Error(result.problems.join("; "));
    expect(result.sections.map((section) => [section.sectionId, section.textAlternative])).toEqual([
      ["status-1", "Up (success)"],
      ["status-2", "3 of 4 (75%)"],
      ["status-3", "Region: ap-southeast-1"],
    ]);
  });

  it("refuses a card whose props the node would refuse on its own", () => {
    const result = compile({ kind: "stack", children: [leaf(PROGRESS.id, { value: 5, max: 4 })] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join("; ")).toContain("the value 5 is above the maximum 4");
  });
});
