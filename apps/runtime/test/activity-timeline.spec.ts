import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type Instant,
  type MessageBlock,
  MAX_TIMELINE_ACTOR,
  MAX_TIMELINE_DESCRIPTION,
  MAX_TIMELINE_ENTRIES,
  MAX_TIMELINE_TITLE,
  SECTION_TEXT_LIMIT,
  SEMANTIC_LIMITS,
  SNAPSHOT_TEXT_LIMIT,
  canonicalSemanticDoc,
} from "@clarkcant/contracts";
import { getActionBinding, getInstance, liveStateOf } from "@clarkcant/core";
import { TIMELINE } from "@clarkcant/data-canvas";
import { appendMessage } from "@clarkcant/storage";

import { invokeWidgetAction } from "../src/application/widget-actions.ts";
import { compileLayout, layoutLeafWidgets } from "../src/compose-layout.ts";
import { bootNodeServices, buildTimeline, type NodeServices } from "../src/services.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";
import { buildWidgetSemantic } from "../src/widget-semantic.ts";

/**
 * The activity timeline, placed the way a model's `show_view` places it and used the way a person uses it.
 *
 * What matters is what the node refuses and what it keeps: props that break a timeline rule are refused before an
 * instance exists; the timezone a timeline groups its days in is written down when it is placed, so the node and the
 * page read the same days; a selection is state the node checks against the entries, refused and left as it was when it
 * names none of them; and what voice and `inspect_ui` read is built from the props and that state.
 */

const AT = "2026-09-30T05:00:00.000Z" as Instant;
const CONVERSATION = "conv_activity_timeline";

const ENTRIES = [
  { id: "freeze", at: "2026-09-30", title: "Release freeze", tone: "info" },
  // 23:30 on the 30th in Saigon: the 30th there, still the 30th in UTC.
  { id: "deploy", at: "2026-09-30T23:30:00+07:00", title: "Deploy started", tone: "info", actor: "Lan" },
  // 02:15 on 1 October in Saigon is 19:15 on 30 September in UTC.
  { id: "late", at: "2026-09-30T19:15:00Z", title: "Late alert", tone: "warning" },
  { id: "tests", at: "2026-09-30T09:15:00+07:00", title: "Tests passed", tone: "success", actor: "CI", description: "All 1,745 tests." },
  { id: "migration", at: "2026-09-29T16:00:00+07:00", title: "Migration failed", tone: "danger" },
];
const PROPS = { title: "Release", entries: ENTRIES, timezone: "Asia/Saigon" };

let dir: string;
let services: NodeServices;
let counter = 0;

function owner(): string {
  return services.runtime.identity.ownerPrincipalId;
}

function instanceRows(): number {
  return (services.runtime.db.prepare("SELECT COUNT(*) AS n FROM widget_instances").get() as { n: number }).n;
}

async function place(props: Record<string, unknown>, timezone?: () => string): Promise<string> {
  const compose = timezone === undefined ? undefined : { ...services.compose, timezone };
  const view = buildViewCatalog(services.conductor, compose).find((entry) => entry.id === TIMELINE.id);
  if (view === undefined) throw new Error("the timeline is not in the catalog");
  const messageId = `msg_${String(++counter)}`;
  const block = (await view.build({
    props,
    caption: "Here is what happened",
    at: AT,
    principal: { principalId: owner(), kind: "user", nodeId: services.runtime.identity.nodeId } as never,
    messageId,
    conversationId: CONVERSATION,
  })) as Extract<MessageBlock, { type: "surface" }>;
  appendMessage(
    services.runtime.db,
    { messageId, conversationId: CONVERSATION, role: "assistant", authorNodeId: services.runtime.identity.nodeId, delivery: "accepted", createdAt: AT, blocks: [block] } as never,
    counter,
  );
  return block.snapshot.instanceId ?? "";
}

async function select(instanceId: string, input: Record<string, unknown>, principalId = owner()) {
  const instance = getInstance(services.conductor, instanceId);
  const bindingId = instance?.actionBindingIds[0] ?? "";
  const binding = getActionBinding(services.conductor, bindingId);
  return invokeWidgetAction(
    services,
    {
      conversationId: CONVERSATION,
      principalId: principalId as never,
      instanceId,
      actionBindingId: bindingId,
      expectedRevision: instance?.revision ?? 0,
      expectedBindingDigest: binding?.bindingDigest ?? "",
      input,
      invocationId: `inv_${String(++counter)}`,
    },
    "click",
  );
}

function carried(instanceId: string) {
  const timeline = buildTimeline(services, { conversationId: CONVERSATION, afterSequence: 0 });
  return timeline.instances.find((instance) => instance.instanceId === instanceId) as { state?: unknown; props?: Record<string, unknown> } | undefined;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-activity-timeline-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)")
    .run(CONVERSATION, services.runtime.identity.nodeId, AT, AT);
});

afterEach(() => {
  services.runtime.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("the model's vocabulary", () => {
  it("offers the timeline with its entry shape, its bounds and what a time may be", () => {
    const view = buildViewCatalog(services.conductor).find((entry) => entry.id === TIMELINE.id);
    expect(view?.notes).toContain(`at most ${String(MAX_TIMELINE_ENTRIES)} entries`);
    expect(view?.notes).toContain("an ISO 8601 instant with an offset");
    expect(view?.notes).toContain("or a date (2026-09-30)");
    expect(view?.notes).toContain("neutral, info, success, warning, danger");
    expect(view?.notes).toContain("props.truncated: true when you left entries out");
    expect(view?.notes).toContain("no HTML, links or hidden characters");
  });

  it("lets a layout place it, and names the event it emits", () => {
    expect(layoutLeafWidgets(services.compose.registry)).toContain(TIMELINE.id);
    const overview = buildViewCatalog(services.conductor, services.compose).find((entry) => entry.id === "canvas.overview@1");
    expect(overview?.notes).toContain("canvas.timeline@1 timeline.select {selectedId}");
  });
});

describe("placing a timeline", () => {
  it("keeps its days and entries in its timezone as its text alternative, and binds one view action", async () => {
    const instanceId = await place(PROPS);
    const instance = getInstance(services.conductor, instanceId);
    expect(instance?.actionBindingIds).toHaveLength(1);
    const binding = getActionBinding(services.conductor, instance?.actionBindingIds[0] ?? "");
    expect(binding).toMatchObject({
      label: "Timeline selection",
      proposal: { kind: "view", operation: "timeline.select" },
      effectCategory: "read",
      requiresApproval: false,
      allowedDataRefs: [],
    });

    const text = buildTimeline(services, { conversationId: CONVERSATION, afterSequence: 0 }).snapshots[0]?.textAlternative ?? "";
    expect(text).toBe(
      "Release: Activity timeline (Asia/Saigon, newest first): 5 entries. " +
        "2026-10-01: 02:15 Late alert [warning]. " +
        "2026-09-30: all day Release freeze [info]; 23:30 Deploy started [info] by Lan; 09:15 Tests passed [success] by CI. " +
        "2026-09-29: 16:00 Migration failed [danger].",
    );
  });

  it("writes down the node's timezone when the props name none, so the node and the page read the same days", async () => {
    const { timezone: _zone, ...unzoned } = PROPS;
    const saigon = await place(unzoned, () => "Asia/Saigon");
    expect(getInstance(services.conductor, saigon)?.props.timezone).toBe("Asia/Saigon");
    expect(carried(saigon)?.props?.timezone).toBe("Asia/Saigon");
    expect(buildWidgetSemantic(services.conductor, saigon)?.values).toMatchObject({ timezone: "Asia/Saigon", from: "2026-09-29", to: "2026-10-01" });

    // A zone the timeline could not name is not guessed at: the timeline is placed in UTC, and says so.
    const unknown = await place(unzoned, () => "Not a zone");
    expect(getInstance(services.conductor, unknown)?.props.timezone).toBe("UTC");
    expect(buildWidgetSemantic(services.conductor, unknown)?.values).toMatchObject({ timezone: "UTC", from: "2026-09-29", to: "2026-09-30" });

    // A timezone the model named is kept as it named it.
    const named = await place({ ...PROPS, timezone: "America/New_York" }, () => "Asia/Saigon");
    expect(getInstance(services.conductor, named)?.props.timezone).toBe("America/New_York");
  });

  it.each([
    ["a time with no offset", { entries: [{ ...ENTRIES[1], at: "2026-09-30T23:30:00" }] }, "has props that do not fit its schema"],
    ["a time that is not a time", { entries: [{ ...ENTRIES[1], at: "yesterday" }] }, "has props that do not fit its schema"],
    ["a time with no entry", { entries: [{ id: "a", title: "A" }] }, "has props that do not fit its schema"],
    ["a date that does not exist", { entries: [{ ...ENTRIES[0], at: "2026-02-30" }] }, 'cannot be shown: not a real date or time: "entries.0.at" (2026-02-30)'],
    ["an hour past 23", { entries: [{ ...ENTRIES[1], at: "2026-09-30T24:00:00Z" }] }, 'cannot be shown: not a real date or time: "entries.0.at"'],
    ["an id used twice", { entries: [ENTRIES[0], { ...ENTRIES[1], id: "freeze" }] }, 'cannot be shown: ids repeat: "freeze"; each entry needs its own id'],
    ["a tone the timeline does not have", { entries: [{ ...ENTRIES[0], tone: "critical" }] }, "has props that do not fit its schema"],
    ["too many entries", { entries: Array.from({ length: MAX_TIMELINE_ENTRIES + 1 }, (_, index) => ({ ...ENTRIES[0], id: `e${String(index)}` })) }, "has props that do not fit its schema"],
    ["a title that is too long", { entries: [{ ...ENTRIES[0], title: "x".repeat(MAX_TIMELINE_TITLE + 1) }] }, "has props that do not fit its schema"],
    ["a description that is too long", { entries: [{ ...ENTRIES[0], description: "x".repeat(MAX_TIMELINE_DESCRIPTION + 1) }] }, "has props that do not fit its schema"],
    ["a bidi control in a title", { entries: [{ ...ENTRIES[0], title: "Deploy ‮yaled" }] }, "has props that do not fit its schema"],
    ["an invisible character in an id", { entries: [{ ...ENTRIES[0], id: "free​ze" }] }, "has props that do not fit its schema"],
    ["a link carried as an extra key", { entries: [{ ...ENTRIES[0], href: "https://example.com" }] }, "has props that do not fit its schema"],
    ["a timezone this node does not know", { ...PROPS, timezone: "Mars/Olympus" }, 'cannot be shown: "timezone": Mars/Olympus is not a timezone this node knows'],
  ])("refuses %s with the reason and leaves nothing behind", async (_name, props, reason) => {
    const before = instanceRows();
    await expect(place(props as Record<string, unknown>)).rejects.toThrow(`${TIMELINE.id} ${reason}`);
    expect(instanceRows()).toBe(before);
  });

  it("names the hidden character it refuses", async () => {
    await expect(place({ entries: [{ ...ENTRIES[0], title: "Deploy ‮yaled" }] })).rejects.toThrow("U+202E");
  });

  it("keeps a conversation readable with the largest timeline in it", async () => {
    const entries = Array.from({ length: MAX_TIMELINE_ENTRIES }, (_, index) => ({
      id: `entry-${String(index).padStart(3, "0")}-${"i".repeat(100)}`,
      at: `2026-09-${String(1 + (index % 30)).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00+07:00`,
      title: `Ghi chú ${String(index)} ${"đ".repeat(MAX_TIMELINE_TITLE - 20)}`,
      description: "mô tả ".repeat(MAX_TIMELINE_DESCRIPTION / 6).slice(0, MAX_TIMELINE_DESCRIPTION),
      actor: "a".repeat(MAX_TIMELINE_ACTOR),
      tone: (["neutral", "info", "success", "warning", "danger"] as const)[index % 5],
    }));
    const instanceId = await place({ title: "t".repeat(MAX_TIMELINE_TITLE), entries, truncated: true, timezone: "Asia/Saigon" });
    const timeline = buildTimeline(services, { conversationId: CONVERSATION, afterSequence: 0 });
    const snapshot = timeline.snapshots[0];
    expect(snapshot?.unreadable).not.toBe(true);
    expect(snapshot?.textAlternative.length).toBeLessThanOrEqual(SNAPSHOT_TEXT_LIMIT);
    expect(snapshot?.textAlternative.endsWith("… (shortened)")).toBe(true);

    expect((await select(instanceId, { selectedId: entries[199]?.id ?? "" })).ok).toBe(true);
    const doc = buildWidgetSemantic(services.conductor, instanceId);
    if (doc === undefined) throw new Error("no document");
    expect(canonicalSemanticDoc(doc).length).toBeLessThanOrEqual(SEMANTIC_LIMITS.bytes);
    expect(doc.summary.length).toBeLessThanOrEqual(SEMANTIC_LIMITS.summary);
    expect(doc.values).toMatchObject({ entries: 200, truncated: true, toneNeutral: 40, toneDanger: 40 });
  });
});

describe("a person's selection on a timeline", () => {
  it("selects an entry, and the state, a reload and the meaning say so", async () => {
    const instanceId = await place(PROPS);
    const outcome = await select(instanceId, { selectedId: "deploy" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.body.state).toEqual({ selectedId: "deploy" });

    // The timeline the page reads carries the selection, so a reload opens the timeline the way the person left it.
    expect(carried(instanceId)?.state).toEqual({ selectedId: "deploy" });

    const doc = buildWidgetSemantic(services.conductor, instanceId);
    expect(doc).toMatchObject({
      definitionId: TIMELINE.id,
      title: "Release",
      freshness: "unknown",
      selectedIds: ["deploy"],
      values: {
        entries: 5,
        order: "newest",
        timezone: "Asia/Saigon",
        truncated: false,
        from: "2026-09-29",
        to: "2026-10-01",
        toneNeutral: 0,
        toneInfo: 2,
        toneSuccess: 1,
        toneWarning: 1,
        toneDanger: 1,
        selectedEntry: "Deploy started",
        selectedAt: "2026-09-30 at 23:30",
        selectedTone: "info",
      },
    });
    expect(doc?.summary).toBe(
      "Activity timeline (Asia/Saigon): 5 entries from 2026-09-29 to 2026-10-01, 2 info, 1 success, 1 warning, 1 danger; " +
        "selected: Deploy started, 2026-09-30 at 23:30",
    );
    if (doc === undefined) throw new Error("no document");
    expect(canonicalSemanticDoc(doc).length).toBeLessThanOrEqual(SEMANTIC_LIMITS.bytes);
  });

  it("clears the selection with an empty id", async () => {
    const instanceId = await place(PROPS);
    expect((await select(instanceId, { selectedId: "tests" })).ok).toBe(true);
    expect((await select(instanceId, { selectedId: "" })).ok).toBe(true);
    expect(liveStateOf(services.conductor, instanceId)?.body).toEqual({});
    expect(buildWidgetSemantic(services.conductor, instanceId)?.selectedIds).toEqual([]);
  });

  it.each([
    ["an entry that is not on the timeline", { selectedId: "nope" }, '"nope" is not an entry on this timeline now'],
    ["an id that is not text", { selectedId: 3 }, "selectedId names an entry by its id, or is empty to clear the selection"],
    ["a key a selection does not carry", { selectedId: "deploy", scroll: 2 }, "a timeline selection carries only selectedId, not scroll"],
    ["no id at all", {}, "selectedId names an entry by its id, or is empty to clear the selection"],
  ])("refuses %s with the reason and keeps the selection it holds", async (_name, input, reason) => {
    const instanceId = await place(PROPS);
    expect((await select(instanceId, { selectedId: "tests" })).ok).toBe(true);
    const before = getInstance(services.conductor, instanceId)?.revision;
    const outcome = await select(instanceId, input);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("INVALID_INPUT");
    expect(outcome.message).toBe(`the timeline selection was refused: ${reason}`);
    expect(getInstance(services.conductor, instanceId)?.revision).toBe(before);
    expect(liveStateOf(services.conductor, instanceId)?.body).toEqual({ selectedId: "tests" });
  });

  it("refuses a selection made by someone who does not own the timeline", async () => {
    const instanceId = await place(PROPS);
    const outcome = await select(instanceId, { selectedId: "deploy" }, "prin_someone_else");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("NOT_AUTHORIZED");
  });
});

describe("a timeline in a layout", () => {
  const compile = (layout: unknown, state?: unknown) =>
    compileLayout({
      proposal: layout,
      registry: services.compose.registry,
      rowsBySlot: {},
      initialState: { period: "week", timezone: "Asia/Saigon" },
      ...(state === undefined ? {} : { state }),
    });
  const { timezone: _zone, ...unzoned } = PROPS;

  it("takes the timeline region with its own words as the section's text, in the surface's timezone", () => {
    const result = compile({ kind: "stack", children: [{ kind: "widget", widget: TIMELINE.id, props: unzoned }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    const [section] = result.sections;
    expect(section).toMatchObject({ sectionId: "timeline-1", slot: "timeline", dataRefs: [] });
    expect(section?.props.timezone).toBe("Asia/Saigon");
    expect(section?.textAlternative.length).toBeLessThanOrEqual(SECTION_TEXT_LIMIT);
    expect(section?.textAlternative.startsWith("Release: Activity timeline (Asia/Saigon, newest first): 5 entries.")).toBe(true);
  });

  const wired = (event: string) => ({
    kind: "stack",
    children: [
      {
        kind: "widget",
        widget: TIMELINE.id,
        props: PROPS,
        on: [{ event, steps: [{ op: "select-field", key: "picked", field: "selectedId" }] }],
      },
    ],
  });

  it("wires its selection into the surface's state", () => {
    const result = compile(wired("timeline.select"), { picked: { type: "string", initial: "" } });
    if (!result.ok) throw new Error(result.problems.join("; "));
    expect(result.graph?.on).toEqual([
      expect.objectContaining({ sectionId: "timeline-1", event: "timeline.select" }),
    ]);
  });

  it("refuses a rule for an event a timeline does not emit", () => {
    const result = compile(wired("row.select"), { picked: { type: "string", initial: "" } });
    expect(result.ok).toBe(false);
  });

  it("refuses a timeline whose props the node would refuse on its own", () => {
    const result = compile({ kind: "stack", children: [{ kind: "widget", widget: TIMELINE.id, props: { entries: [ENTRIES[0], ENTRIES[0]] } }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join("; ")).toContain("ids repeat");
  });
});
