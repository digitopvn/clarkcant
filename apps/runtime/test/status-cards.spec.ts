import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type Instant,
  type MessageBlock,
  MAX_DETAIL_ITEMS,
  MAX_PROGRESS_STEPS,
  SECTION_TEXT_LIMIT,
  SEMANTIC_LIMITS,
  SNAPSHOT_TEXT_LIMIT,
  AS_OF_PATTERN,
  canonicalSemanticDoc,
} from "@clarkcant/contracts";
import { captureSnapshot, getInstance } from "@clarkcant/core";
import { DETAILS, FILTER, PROGRESS, STATUS } from "@clarkcant/data-canvas";
import { appendMessage, createConversation } from "@clarkcant/storage";

import { compileLayout, composeLayout, layoutLeafWidgets } from "../src/compose-layout.ts";
import { bootNodeServices, buildTimeline, type NodeServices } from "../src/services.ts";
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
    conversationId: CONVERSATION,
  })) as Extract<MessageBlock, { type: "surface" }>;
}

function instanceRows(): number {
  return (services.runtime.db.prepare("SELECT COUNT(*) AS n FROM widget_instances").get() as { n: number }).n;
}

function snapshotRows(): number {
  return (services.runtime.db.prepare("SELECT COUNT(*) AS n FROM widget_snapshots").get() as { n: number }).n;
}

const CONVERSATION = "conv_status_cards";

/** Put a placed card in a message of the conversation, as a turn does, so the timeline reads it back. */
function keep(block: MessageBlock, messageId: string): void {
  appendMessage(
    services.runtime.db,
    {
      messageId,
      conversationId: CONVERSATION,
      role: "assistant",
      authorNodeId: services.runtime.identity.nodeId,
      delivery: "accepted",
      createdAt: AT,
      blocks: [block],
    } as never,
    ++counter,
  );
}

const AS_OF = "2026-09-30T09:00:00.000+07:00";

/** The most a details card may hold: every field at its maximum length. */
const LARGEST_DETAILS = {
  title: "t".repeat(200),
  items: Array.from({ length: MAX_DETAIL_ITEMS }, (_, index) => ({
    label: `${"k".repeat(78)}${String(index).padStart(2, "0")}`,
    value: "v".repeat(300),
  })),
  asOf: AS_OF,
};

/** The most a progress card may hold: its longest steps, each with the longest status word. */
const LARGEST_PROGRESS = {
  title: "t".repeat(200),
  label: "l".repeat(200),
  steps: Array.from({ length: MAX_PROGRESS_STEPS }, (_, index) => ({
    label: `${"s".repeat(118)}${String(index).padStart(2, "0")}`,
    status: "skipped",
    detail: "d".repeat(200),
  })),
  asOf: AS_OF,
};

const LARGEST_STATUS = { title: "t".repeat(200), label: "x".repeat(120), tone: "warning", detail: "d".repeat(500), asOf: AS_OF };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-status-cards-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  createConversation(services.runtime.db, { conversationId: CONVERSATION, homeNodeId: services.runtime.identity.nodeId, at: AT });
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
    expect(byId.get(PROGRESS.id)?.notes).toContain("Not for this node's own tasks and runs");
    expect(byId.get(STATUS.id)?.notes).toContain("Not for this node's own tasks, runs or connections");
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
    ["a value above its maximum", PROGRESS.id, { value: 130, max: 120 }, "canvas.progress@1 cannot be shown: the value 130 is above the maximum 120"],
    ["progress with nothing behind it", PROGRESS.id, { label: "Working" },
      "canvas.progress@1 cannot be shown: a progress card needs a value and a maximum, or steps; there is no progress without either",
    ],
    [
      "two current steps",
      PROGRESS.id,
      {
        steps: [
          { label: "a", status: "current" },
          { label: "b", status: "current" },
        ],
      },
      "canvas.progress@1 cannot be shown: 2 steps are current; at most one step is",
    ],
    ["a repeated label", DETAILS.id, { items: [{ label: "A", value: "1" }, { label: "A", value: "2" }] },
      "canvas.details@1 cannot be shown: labels repeat: A; each fact needs its own label",
    ],
    ["an as-of with no offset", STATUS.id, { label: "x", tone: "info", asOf: "2026-09-30T09:00:00" },
      `canvas.status@1 has props that do not fit its schema: property "asOf": Invalid string: must match pattern /${AS_OF_PATTERN}/`,
    ],
    ["an unknown tone", STATUS.id, { label: "x", tone: "red" },
      'canvas.status@1 has props that do not fit its schema: property "tone": Invalid option: expected one of "neutral"|"info"|"success"|"warning"|"danger"',
    ],
    ["a key the card does not have", STATUS.id, { label: "x", tone: "info", live: true },
      'canvas.status@1 has props that do not fit its schema: unknown property "live"',
    ],
    [
      "a line break in a label",
      STATUS.id,
      { label: "Up\nDown", tone: "info" },
      'canvas.status@1 has props that do not fit its schema: property "label": contains U+000A, a line break, and this field is one line; remove it',
    ],
    [
      "a bidi control in a fact",
      DETAILS.id,
      { items: [{ label: "Owner", value: "L\u202ean" }] },
      'canvas.details@1 has props that do not fit its schema: property "items.0.value": contains U+202E, a control that changes text direction, so the text would read differently from how it is drawn; remove it',
    ],
    ["a label of spaces", DETAILS.id, { items: [{ label: "  ", value: "1" }] },
      'canvas.details@1 has props that do not fit its schema: property "items.0.label": is empty',
    ],
  ])("refuses %s with the exact reason and leaves nothing behind", async (_name, definitionId, props, reason) => {
    const before = instanceRows();
    await expect(place(definitionId, props)).rejects.toThrow(new Error(reason));
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

describe("a conversation with the largest cards in it", () => {
  const principalId = () => services.runtime.identity.ownerPrincipalId;

  it("still opens with the largest details and progress cards placed on their own", async () => {
    const details = await place(DETAILS.id, LARGEST_DETAILS);
    const progress = await place(PROGRESS.id, LARGEST_PROGRESS);
    const status = await place(STATUS.id, LARGEST_STATUS);
    for (const block of [details, progress, status]) keep(block, block.snapshot.messageId);

    const timeline = buildTimeline(services, { conversationId: CONVERSATION, afterSequence: 0 });
    const texts = new Map(timeline.snapshots.map((snapshot) => [snapshot.snapshotId, snapshot.textAlternative]));
    const detailsText = texts.get(details.snapshot.snapshotId) ?? "";
    expect(detailsText.length).toBeLessThanOrEqual(SNAPSHOT_TEXT_LIMIT);
    expect(detailsText).toMatch(/…and \d+ more facts \(as of 2026-09-30T09:00:00\.000\+07:00\)$/u);
    expect(texts.get(progress.snapshot.snapshotId)).toBe(progress.snapshot.textAlternative);
    expect(texts.get(status.snapshot.snapshotId)).toBe(status.snapshot.textAlternative);
  });

  it("still opens with the largest cards as leaves of a layout, and with a layout of twelve of them", () => {
    const grid = composeLayout(services.compose, {
      conversationId: CONVERSATION,
      messageId: "msg_largest_grid",
      principalId: principalId(),
      intent: "",
      layout: {
        kind: "grid",
        columns: 3,
        children: [
          { kind: "widget", widget: DETAILS.id, props: LARGEST_DETAILS },
          { kind: "widget", widget: PROGRESS.id, props: LARGEST_PROGRESS },
          { kind: "widget", widget: STATUS.id, props: LARGEST_STATUS },
        ],
      },
    });
    if (!grid.ok) throw new Error(`${grid.message}: ${(grid.problems ?? []).join("; ")}`);
    keep(grid.block, "msg_largest_grid");

    const twelve = composeLayout(services.compose, {
      conversationId: CONVERSATION,
      messageId: "msg_largest_twelve",
      principalId: principalId(),
      intent: "",
      layout: { kind: "stack", children: Array.from({ length: 12 }, () => ({ kind: "widget", widget: DETAILS.id, props: LARGEST_DETAILS })) },
    });
    if (!twelve.ok) throw new Error(`${twelve.message}: ${(twelve.problems ?? []).join("; ")}`);
    keep(twelve.block, "msg_largest_twelve");

    const timeline = buildTimeline(services, { conversationId: CONVERSATION, afterSequence: 0 });
    const gridText = timeline.snapshots.find((snapshot) => snapshot.snapshotId === grid.snapshotId)?.textAlternative ?? "";
    const twelveText = timeline.snapshots.find((snapshot) => snapshot.snapshotId === twelve.snapshotId)?.textAlternative ?? "";
    expect(gridText.length).toBeLessThanOrEqual(SNAPSHOT_TEXT_LIMIT);
    // Each leaf says how many facts or steps it left out; the whole says it was shortened.
    expect(gridText).toContain("more facts");
    expect(gridText).toContain("…and 1 more step (as of");
    expect(twelveText.length).toBeLessThanOrEqual(SNAPSHOT_TEXT_LIMIT);
    expect(twelveText.endsWith("… (shortened)")).toBe(true);

    const leaves = compileLayout({
      proposal: { kind: "stack", children: [{ kind: "widget", widget: PROGRESS.id, props: LARGEST_PROGRESS }] },
      registry: services.compose.registry,
      rowsBySlot: {},
      initialState: { period: "week", timezone: "UTC" },
    });
    if (!leaves.ok) throw new Error(leaves.problems.join("; "));
    expect(leaves.sections[0]?.textAlternative.length).toBeLessThanOrEqual(SECTION_TEXT_LIMIT);
  });

  it("refuses a caption longer than a snapshot keeps, in the same turn, with nothing left behind", async () => {
    const before = { instances: instanceRows(), snapshots: snapshotRows() };
    // A card's own words replace a caption, so the caption that counts is a widget's that keeps one.
    await expect(place(FILTER.id, { period: "week", timezone: "UTC" }, "x".repeat(SNAPSHOT_TEXT_LIMIT + 1))).rejects.toThrow(
      `its caption is ${String(SNAPSHOT_TEXT_LIMIT + 1)} characters and at most ${String(SNAPSHOT_TEXT_LIMIT)} are kept`,
    );
    expect({ instances: instanceRows(), snapshots: snapshotRows() }).toEqual(before);
  });

  it("still opens when a stored snapshot cannot be read back, with that block marked unreadable and the rest intact", async () => {
    const before = await place(STATUS.id, { label: "Up", tone: "success" });
    const broken = await place(STATUS.id, { label: "Down", tone: "danger" });
    const after = await place(DETAILS.id, { items: [{ label: "Region", value: "ap-southeast-1" }] });
    for (const block of [before, broken, after]) keep(block, block.snapshot.messageId);
    // A row written before snapshots were checked on the way in: its text is longer than a reader accepts.
    const document = JSON.parse(
      (
        services.runtime.db.prepare("SELECT document FROM widget_snapshots WHERE snapshot_id = ?").get(broken.snapshot.snapshotId) as {
          document: string;
        }
      ).document,
    ) as Record<string, unknown>;
    services.runtime.db
      .prepare("UPDATE widget_snapshots SET document = ? WHERE snapshot_id = ?")
      .run(JSON.stringify({ ...document, textAlternative: "x".repeat(SNAPSHOT_TEXT_LIMIT + 1) }), broken.snapshot.snapshotId);

    const logged: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let timeline: ReturnType<typeof buildTimeline>;
    try {
      timeline = buildTimeline(services, { conversationId: CONVERSATION, afterSequence: 0 });
    } finally {
      process.stderr.write = write;
    }

    expect(timeline.messages).toHaveLength(3);
    const byId = new Map(timeline.snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
    expect(byId.get(before.snapshot.snapshotId)).toMatchObject({ textAlternative: "Up (success)" });
    expect(byId.get(after.snapshot.snapshotId)).toMatchObject({ textAlternative: "Region: ap-southeast-1" });
    expect(byId.get(broken.snapshot.snapshotId)).toEqual({
      snapshotId: broken.snapshot.snapshotId,
      messageId: broken.snapshot.messageId,
      instanceId: broken.snapshot.instanceId,
      capturedRevision: broken.snapshot.capturedRevision,
      capturedAt: broken.snapshot.capturedAt,
      stale: false,
      presentationRef: "",
      textAlternative: "",
      unreadable: true,
    });
    expect(timeline.instances.map((instance) => instance.instanceId)).toEqual(
      expect.arrayContaining([before.snapshot.instanceId, broken.snapshot.instanceId, after.snapshot.instanceId]),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`timeline: snapshot ${broken.snapshot.snapshotId} of message ${broken.snapshot.messageId} in ${CONVERSATION} could not be read`);
  });

  it("never stores a snapshot the conversation could not read back", async () => {
    const block = await place(STATUS.id, { label: "Up", tone: "info" });
    const instance = getInstance(services.conductor, block.snapshot.instanceId ?? "");
    if (instance === undefined) throw new Error("no instance");
    const before = snapshotRows();
    expect(() =>
      captureSnapshot(services.conductor, {
        messageId: "msg_too_long",
        instance,
        textAlternative: "x".repeat(SNAPSHOT_TEXT_LIMIT + 1),
        presentationRef: `catalog:${STATUS.id}`,
      }),
    ).toThrow(`catalog:${STATUS.id} cannot be kept in the conversation: textAlternative:`);
    expect(() =>
      captureSnapshot(services.conductor, { messageId: "msg_empty", instance, textAlternative: "", presentationRef: `catalog:${STATUS.id}` }),
    ).toThrow("cannot be kept in the conversation");
    expect(snapshotRows()).toBe(before);
  });
});