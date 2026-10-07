import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Instant, type MessageBlock, type WidgetDefinition, CALENDAR_STATE_VERSION, MAX_CALENDAR_EVENTS, SEMANTIC_LIMITS, canonicalSemanticDoc } from "@clarkcant/contracts";
import { getActionBinding, getInstance, liveStateOf, placeInstance } from "@clarkcant/core";
import { CALENDAR } from "@clarkcant/data-canvas";
import { appendMessage, upsertDataset } from "@clarkcant/storage";
import { definitionDigest } from "@clarkcant/widget-host";

import { invokeWidgetAction } from "../src/application/widget-actions.ts";
import { bootNodeServices, buildTimeline, type NodeServices } from "../src/services.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";
import { buildWidgetSemantic } from "../src/widget-semantic.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

/**
 * The calendar's month, week and agenda views, placed the way a model's `show_view` places them and used the way a
 * person uses them.
 *
 * What a person changes — the view, the day and the event selected — is state the node checks against the calendar and
 * the rows it holds now, and is what voice and `inspect_ui` read. A calendar saved before it had views is read as the
 * month view it was, and the next write stores it in the current shape.
 */

const AT = "2026-09-30T05:00:00.000Z" as Instant;
const CONVERSATION = "conv_calendar_views";
const ZONE = "Asia/Ho_Chi_Minh";

const ROWS = [
  // 09:00–10:00 on the 5th in Ho Chi Minh City.
  { eventId: "standup", title: "Standup", startsAt: "2026-10-05T02:00:00Z", endsAt: "2026-10-05T03:00:00Z" },
  // 22:00 on the 6th to 02:00 on the 7th there: on both days.
  { eventId: "deploy", title: "Deploy", startsAt: "2026-10-06T15:00:00Z", endsAt: "2026-10-06T19:00:00Z" },
  // The 7th, 8th and 9th: the end is the day after the last day.
  { eventId: "offsite", title: "Offsite", allDay: true, startDate: "2026-10-07", endDate: "2026-10-10" },
  // Written in Berlin, shown in Ho Chi Minh City.
  { eventId: "berlin", title: "Berlin sync", startsAt: "2026-10-08T08:00:00Z", endsAt: "2026-10-08T09:00:00Z", timezone: "Europe/Berlin" },
];

const PROPS = { title: "Team", datasetRef: "ds_calendar", month: "2026-10", timezone: ZONE };

/** The keys events are selected by: the row's id and when it starts. */
const DEPLOY = "deploy@2026-10-06T15:00:00.000Z";
const BERLIN = "berlin@2026-10-08T08:00:00.000Z";
const OFFSITE = "offsite@2026-10-07";

let dir: string;
let services: NodeServices;
let counter = 0;

function owner(): string {
  return services.runtime.identity.ownerPrincipalId;
}

function dataset(datasetId: string, rows: unknown[], ownerPrincipalId: string = owner()): void {
  upsertDataset(services.runtime.db, {
    datasetId,
    originNodeId: services.runtime.identity.nodeId,
    rowCount: rows.length,
    freshness: "live",
    updatedAt: AT,
    document: { rows },
    ownerPrincipalId,
  });
}

function instanceRows(): number {
  return (services.runtime.db.prepare("SELECT COUNT(*) AS n FROM widget_instances").get() as { n: number }).n;
}

function stateVersionOf(instanceId: string): number | undefined {
  const row = services.runtime.db.prepare("SELECT state_version FROM widget_state WHERE instance_id = ?").get(instanceId) as
    | { state_version: number }
    | undefined;
  return row === undefined ? undefined : Number(row.state_version);
}

async function place(props: Record<string, unknown>): Promise<string> {
  const view = buildViewCatalog(services.conductor).find((entry) => entry.id === CALENDAR.id);
  if (view === undefined) throw new Error("the calendar is not in the catalog");
  const messageId = `msg_${String(++counter)}`;
  const block = (await view.build({
    props,
    caption: "Here is the calendar",
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

async function setView(instanceId: string, input: Record<string, unknown>, principalId = owner()) {
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

function carriedState(instanceId: string): unknown {
  const timeline = buildTimeline(services, { conversationId: CONVERSATION });
  return (timeline.instances.find((instance) => instance.instanceId === instanceId) as { state?: unknown } | undefined)?.state;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-calendar-views-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)")
    .run(CONVERSATION, services.runtime.identity.nodeId, AT, AT);
  dataset("ds_calendar", ROWS);
});

afterEach(async () => {
  services.runtime.db.close();
  await removeTestDirectory(dir);
});

describe("the model's vocabulary", () => {
  it("offers the calendar with the row shapes it reads and the views it opens in", () => {
    const view = buildViewCatalog(services.conductor).find((entry) => entry.id === CALENDAR.id);
    expect(view?.notes).toContain("{title, allDay:true, startDate, endDate} with endDate the day after the last day");
    expect(view?.notes).toContain("month, week, agenda");
    expect(view?.notes).toContain(`first ${String(MAX_CALENDAR_EVENTS)} rows`);
    expect(view?.notes).toContain("it does not add or change them");
  });
});

describe("placing a calendar", () => {
  it("keeps each event and when it is in the calendar's timezone as its text alternative, and binds one view action", async () => {
    const instanceId = await place(PROPS);
    const instance = getInstance(services.conductor, instanceId);
    expect(instance?.actionBindingIds).toHaveLength(1);
    const binding = getActionBinding(services.conductor, instance?.actionBindingIds[0] ?? "");
    expect(binding).toMatchObject({ proposal: { kind: "view", operation: "calendar.view" }, effectCategory: "read", requiresApproval: false });

    const timeline = buildTimeline(services, { conversationId: CONVERSATION });
    const text = timeline.snapshots[0]?.textAlternative ?? "";
    expect(text).toContain("Team: Calendar for 2026-10 (Asia/Ho_Chi_Minh): 4 event(s).");
    expect(text).toContain("Offsite (all day, 2026-10-07 to 2026-10-09)");
    expect(text).toContain("Deploy (2026-10-06 at 22:00 to 2026-10-07 at 02:00)");
    expect(text).toContain("Berlin sync (2026-10-08 at 15:00–16:00)");
  });

  it.each([
    ["a month that is not one", { ...PROPS, month: "2026-13" }, 'canvas.calendar@1 cannot be shown: props.month "2026-13" is not a month in YYYY-MM form'],
    ["a timezone this node does not know", { ...PROPS, timezone: "Mars/Olympus" }, 'canvas.calendar@1 cannot be shown: props.timezone "Mars/Olympus" is not a timezone this node knows'],
    ["a dataset that is not there", { ...PROPS, datasetRef: "ds_missing" }, 'canvas.calendar@1 cannot be shown: dataset "ds_missing" is not on this node, or is not yours to read'],
  ])("refuses %s with the reason and leaves nothing behind", async (_name, props, reason) => {
    const before = instanceRows();
    await expect(place(props)).rejects.toThrow(new Error(reason));
    expect(instanceRows()).toBe(before);
  });

  it("refuses a view the calendar does not have", async () => {
    await expect(place({ ...PROPS, view: "year" })).rejects.toThrow("canvas.calendar@1 has props that do not fit its schema");
  });

  it("does not read another principal's events", async () => {
    dataset("ds_theirs", ROWS, "prin_someone_else");
    await expect(place({ ...PROPS, datasetRef: "ds_theirs" })).rejects.toThrow("is not yours to read");
  });

  it("opens in the view it was placed with", async () => {
    const instanceId = await place({ ...PROPS, view: "agenda" });
    expect(buildWidgetSemantic(services.conductor, instanceId)?.values.view).toBe("agenda");
  });
});

describe("a person's view of a calendar", () => {
  it("switches view and selects a day and an event, and the state and meaning say so", async () => {
    const instanceId = await place(PROPS);
    const outcome = await setView(instanceId, { view: "week", selectedDate: "2026-10-07", selectedEventId: DEPLOY });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.body.state).toEqual({ view: "week", selectedDate: "2026-10-07", selectedEventId: DEPLOY });
    expect(stateVersionOf(instanceId)).toBe(CALENDAR_STATE_VERSION);

    const doc = buildWidgetSemantic(services.conductor, instanceId);
    expect(doc).toMatchObject({
      definitionId: CALENDAR.id,
      title: "Team",
      freshness: "live",
      selectedIds: [DEPLOY],
      values: {
        view: "week",
        month: "2026-10",
        timezone: ZONE,
        selectedDate: "2026-10-07",
        events: 4,
        // The deploy that started the evening before is on this day too.
        selectedDayEvents: ["Offsite", "Deploy"],
        selectedEvent: "Deploy (2026-10-06 at 22:00 to 2026-10-07 at 02:00)",
      },
    });
    if (doc === undefined) throw new Error("no document");
    expect(canonicalSemanticDoc(doc).length).toBeLessThanOrEqual(SEMANTIC_LIMITS.bytes);

    // The timeline carries the state, so a reload opens the calendar the way the person left it.
    expect(carriedState(instanceId)).toEqual({ view: "week", selectedDate: "2026-10-07", selectedEventId: DEPLOY });
  });

  it("names the timezone an event was written in when it is not the calendar's", async () => {
    const instanceId = await place(PROPS);
    expect((await setView(instanceId, { view: "agenda", selectedDate: "2026-10-08", selectedEventId: BERLIN })).ok).toBe(true);
    expect(buildWidgetSemantic(services.conductor, instanceId)?.values).toMatchObject({
      selectedEvent: "Berlin sync (2026-10-08 at 15:00–16:00)",
      selectedEventTimezone: "Europe/Berlin",
    });
  });

  it("replaces the whole view, so clearing the event removes it", async () => {
    const instanceId = await place(PROPS);
    expect((await setView(instanceId, { view: "month", selectedDate: "2026-10-08", selectedEventId: OFFSITE })).ok).toBe(true);
    expect((await setView(instanceId, { view: "month", selectedDate: "2026-10-08" })).ok).toBe(true);
    expect(liveStateOf(services.conductor, instanceId)?.body).toEqual({ view: "month", selectedDate: "2026-10-08" });
    expect(buildWidgetSemantic(services.conductor, instanceId)?.selectedIds).toEqual([]);
  });

  it.each([
    ["a view the calendar does not have", { view: "year" }, "the view is one of month, week, agenda"],
    ["a day off the calendar", { view: "month", selectedDate: "2026-12-01" }, "2026-12-01 is not on this calendar, which shows 2026-09-28 to 2026-11-08"],
    ["a day that is not a date", { view: "month", selectedDate: "2026-10-32" }, "the selected day is a date in YYYY-MM-DD form"],
    ["an event on another day", { view: "week", selectedDate: "2026-10-05", selectedEventId: DEPLOY }, '"Deploy" is not on 2026-10-05'],
    ["an event that is not there", { view: "week", selectedEventId: "nope" }, '"nope" is not an event on this calendar now'],
    ["a key a view does not carry", { view: "week", zoom: 2 }, "a calendar view carries view, selectedDate and selectedEventId, not zoom"],
  ])("refuses %s with the reason and changes nothing", async (_name, input, reason) => {
    const instanceId = await place(PROPS);
    const before = getInstance(services.conductor, instanceId)?.revision;
    const outcome = await setView(instanceId, input);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("INVALID_INPUT");
    expect(outcome.message).toBe(`the calendar view was refused: ${reason}`);
    expect(getInstance(services.conductor, instanceId)?.revision).toBe(before);
    expect(liveStateOf(services.conductor, instanceId)).toBeUndefined();
  });

  it("refuses a view set by someone who does not own the calendar", async () => {
    const instanceId = await place(PROPS);
    const outcome = await setView(instanceId, { view: "week" }, "prin_someone_else");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("NOT_AUTHORIZED");
  });

  it("checks an event against the rows the node holds now, and drops a kept selection whose event is gone", async () => {
    const instanceId = await place(PROPS);
    expect((await setView(instanceId, { view: "week", selectedDate: "2026-10-06", selectedEventId: DEPLOY })).ok).toBe(true);

    dataset("ds_calendar", ROWS.filter((row) => row.eventId !== "deploy"));
    const doc = buildWidgetSemantic(services.conductor, instanceId);
    expect(doc?.selectedIds).toEqual([]);
    expect(doc?.values.selectedEvent).toBeUndefined();
    expect(doc?.values.selectedDayEvents).toEqual([]);
    const outcome = await setView(instanceId, { view: "week", selectedDate: "2026-10-06", selectedEventId: DEPLOY });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toBe(`the calendar view was refused: "${DEPLOY}" is not an event on this calendar now`);
  });

  it("says a calendar whose dataset is gone has no events available, rather than none", async () => {
    const instanceId = await place(PROPS);
    services.runtime.db.prepare("DELETE FROM datasets WHERE dataset_id = 'ds_calendar'").run();
    const doc = buildWidgetSemantic(services.conductor, instanceId);
    expect(doc?.summary).toContain("its events are not available on this node");
    expect(doc?.freshness).toBe("unknown");
  });
});

describe("a calendar state saved in the first shape", () => {
  it("reads as the month view it was, and the next change stores it in the current shape", async () => {
    const instanceId = await place(PROPS);
    // The only state the first calendar kept: a selected day, at state version 1.
    services.runtime.db
      .prepare(
        `INSERT INTO widget_state (instance_id, state_version, state_revision, document, draft, draft_revision, draft_saved_at, updated_at)
         VALUES (?, 1, 1, ?, NULL, NULL, NULL, ?)`,
      )
      .run(instanceId, JSON.stringify({ selectedDate: "2026-10-07" }), AT);

    expect(carriedState(instanceId)).toEqual({ selectedDate: "2026-10-07", view: "month" });
    expect(buildWidgetSemantic(services.conductor, instanceId)?.values).toMatchObject({ view: "month", selectedDate: "2026-10-07" });
    // Read in the current shape without being rewritten: the row stays as it was until something writes the state.
    expect(stateVersionOf(instanceId)).toBe(1);

    expect((await setView(instanceId, { view: "agenda", selectedDate: "2026-10-07" })).ok).toBe(true);
    expect(stateVersionOf(instanceId)).toBe(CALENDAR_STATE_VERSION);
    expect(liveStateOf(services.conductor, instanceId)?.body).toEqual({ view: "agenda", selectedDate: "2026-10-07" });
  });
});

describe("a calendar placed before it had views", () => {
  // The calendar as it was before it had views: no view prop or operation, state version 1, and placed through the
  // generic path, which gave it no binding at all.
  const { stateMigrations: _steps, ...current } = CALENDAR;
  const LEGACY: WidgetDefinition = {
    ...current,
    version: "1.0.0",
    propsSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        datasetRef: { type: "string", minLength: 1, maxLength: 200 },
        month: { type: "string", maxLength: 10 },
        timezone: { type: "string", maxLength: 60 },
        title: { type: "string", maxLength: 200 },
      },
      required: ["datasetRef", "month"],
    },
    eventSchemas: { "date.select": { type: "object" } },
    stateSchema: { type: "object", properties: { selectedDate: { type: "string" } } },
    stateVersion: 1,
    semanticDescription: "A month view of local calendar events, with event details for the selected day",
  };

  function placeLegacy(): string {
    const messageId = `msg_${String(++counter)}`;
    const { snapshot } = placeInstance(services.conductor, {
      definition: LEGACY,
      packageDigest: definitionDigest(LEGACY),
      ownerPrincipalId: owner(),
      props: PROPS,
      messageId,
      textAlternative: "Here is the calendar",
      presentationRef: `catalog:${CALENDAR.id}`,
    });
    const block = { type: "surface", definitionRef: { id: CALENDAR.id, version: LEGACY.version }, snapshot };
    appendMessage(
      services.runtime.db,
      { messageId, conversationId: CONVERSATION, role: "assistant", authorNodeId: services.runtime.identity.nodeId, delivery: "accepted", createdAt: AT, blocks: [block] } as never,
      counter,
    );
    return snapshot.instanceId ?? "";
  }

  it("is given the view binding a new calendar has, once, when the node next reads it", () => {
    const instanceId = placeLegacy();
    expect(getInstance(services.conductor, instanceId)?.actionBindingIds).toEqual([]);

    const timeline = buildTimeline(services, { conversationId: CONVERSATION });
    const carried = timeline.instances.find((instance) => instance.instanceId === instanceId);
    expect(carried?.actions).toEqual([expect.objectContaining({ label: "Calendar view", available: true })]);
    const bindingIds = getInstance(services.conductor, instanceId)?.actionBindingIds ?? [];
    expect(bindingIds).toHaveLength(1);
    expect(getActionBinding(services.conductor, bindingIds[0] ?? "")).toMatchObject({
      instanceId,
      proposal: { kind: "view", operation: "calendar.view" },
      effectCategory: "read",
      requiresApproval: false,
      packageGeneration: definitionDigest(LEGACY),
    });

    // Read again, by this page or another, it keeps the one binding.
    buildTimeline(services, { conversationId: CONVERSATION });
    expect(getInstance(services.conductor, instanceId)?.actionBindingIds).toEqual(bindingIds);
  });

  it("keeps the view a person picks across a reload, and describes the view it keeps", async () => {
    const instanceId = placeLegacy();
    // Nothing picked yet: the month it was placed as, which is what it says.
    expect(buildWidgetSemantic(services.conductor, instanceId)?.values.view).toBe("month");
    // The page reads the timeline, and sends the view through the binding it finds there.
    buildTimeline(services, { conversationId: CONVERSATION });
    expect((await setView(instanceId, { view: "week", selectedDate: "2026-10-07", selectedEventId: DEPLOY })).ok).toBe(true);

    // A reload reads the timeline again, and the calendar opens where the person left it.
    expect(carriedState(instanceId)).toEqual({ view: "week", selectedDate: "2026-10-07", selectedEventId: DEPLOY });
    expect(stateVersionOf(instanceId)).toBe(CALENDAR_STATE_VERSION);
    const doc = buildWidgetSemantic(services.conductor, instanceId);
    expect(doc?.values).toMatchObject({ view: "week", selectedDate: "2026-10-07" });
    expect(doc?.summary).toContain("week view");
    expect(doc?.selectedIds).toEqual([DEPLOY]);
  });
});