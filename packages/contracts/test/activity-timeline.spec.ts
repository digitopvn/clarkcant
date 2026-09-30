import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MAX_TIMELINE_ENTRIES,
  MULTI_LINE_PATTERN,
  SEMANTIC_LIMITS,
  groupTimelineByDay,
  normalizeSemanticDoc,
  readTimeline,
  readTimelineAt,
  readTimelineSelection,
  timelineHiddenCount,
  timelinePage,
  timelinePageCount,
  timelinePageOf,
  timelineProblems,
  timelineRange,
  timelineSelectionProblems,
  timelineSemantic,
  timelineText,
  timelineToneCounts,
} from "../src/index.ts";

/**
 * The activity timeline: entries the model states, refused with a reason when they cannot be read, each on the day it
 * is on in the timeline's timezone, and a selection the node checks against the entries it holds.
 */

const SAIGON = "Asia/Saigon";

const ENTRIES = [
  { id: "build", at: "2026-09-30T09:15:00+07:00", title: "Build passed", tone: "success", actor: "CI" },
  { id: "deploy", at: "2026-09-30T23:30:00+07:00", title: "Deploy started", tone: "info" },
  // 17:30 UTC on the 29th is 00:30 on the 30th in Saigon.
  { id: "alert", at: "2026-09-29T17:30:00Z", title: "Disk alert", tone: "warning", description: "Disk at 91%.\nCleanup queued." },
  { id: "freeze", at: "2026-09-30", title: "Release freeze" },
  { id: "kickoff", at: "2026-09-28T02:00:00Z", title: "Kickoff", tone: "neutral" },
];

function timeline(extra: Record<string, unknown> = {}) {
  const read = readTimeline({ entries: ENTRIES, timezone: SAIGON, ...extra });
  if (read === undefined) throw new Error("the sample timeline does not read");
  return read;
}

describe("refusing a timeline with the reason", () => {
  it("accepts the sample", () => {
    expect(timelineProblems({ entries: ENTRIES, timezone: SAIGON, title: "Release" })).toEqual([]);
    expect(timelineProblems({ entries: [] })).toEqual([]);
  });

  it("refuses a missing, offset-less or impossible time, and names the entry", () => {
    expect(timelineProblems({ entries: [{ id: "a", title: "A" }] }).join(" ")).toMatch(/"entries\.0\.at"/u);
    expect(timelineProblems({ entries: [{ id: "a", title: "A", at: "2026-09-30T09:15:00" }] }).join(" ")).toMatch(/offset/u);
    expect(timelineProblems({ entries: [{ id: "a", title: "A", at: "Sep 30 2026" }] }).join(" ")).toMatch(/"entries\.0\.at"/u);
    expect(timelineProblems({ entries: [{ id: "a", title: "A", at: "2026-02-30" }] })).toEqual(['not a real date or time: "entries.0.at" (2026-02-30)']);
    expect(timelineProblems({ entries: [{ id: "a", title: "A", at: "2026-09-30T24:00Z" }] }).join(" ")).toMatch(/not a real date or time/u);
    expect(timelineProblems({ entries: [{ id: "a", title: "A", at: "2026-09-30T09:00+24:00" }] }).join(" ")).toMatch(/not a real date or time/u);
  });

  it("refuses ids that repeat, an unknown tone and order, and an unknown timezone", () => {
    const twice = [ENTRIES[0], { ...ENTRIES[1], id: "build" }];
    expect(timelineProblems({ entries: twice })).toEqual(['ids repeat: "build"; each entry needs its own id']);
    expect(timelineProblems({ entries: [{ ...ENTRIES[0], tone: "critical" }] }).join(" ")).toMatch(/"entries\.0\.tone": is not one of neutral/u);
    expect(timelineProblems({ entries: [], order: "random" }).join(" ")).toMatch(/"order"/u);
    expect(timelineProblems({ entries: [], timezone: "Mars/Olympus" })).toEqual(['"timezone": Mars/Olympus is not a timezone this node knows']);
    expect(timelineProblems({ entries: [], timezone: "UTC+7" }).join(" ")).toMatch(/"timezone"/u);
  });

  it("refuses an entry set or a text that is too long, and a page size out of range", () => {
    const many = Array.from({ length: MAX_TIMELINE_ENTRIES + 1 }, (_, index) => ({ id: `e${String(index)}`, at: "2026-09-30", title: "E" }));
    expect(timelineProblems({ entries: many }).join(" ")).toMatch(/more than 200 entries/u);
    expect(timelineProblems({ entries: many.slice(0, MAX_TIMELINE_ENTRIES) })).toEqual([]);
    expect(timelineProblems({ entries: [{ ...ENTRIES[0], title: "x".repeat(201) }] }).join(" ")).toMatch(/longer than 200/u);
    expect(timelineProblems({ entries: [{ ...ENTRIES[0], description: "x".repeat(1001) }] }).join(" ")).toMatch(/longer than 1000/u);
    expect(timelineProblems({ entries: [{ ...ENTRIES[0], actor: "x".repeat(81) }] }).join(" ")).toMatch(/longer than 80/u);
    expect(timelineProblems({ entries: [{ ...ENTRIES[0], id: "x".repeat(121) }] }).join(" ")).toMatch(/longer than 120/u);
    expect(timelineProblems({ entries: [], pageSize: 4 }).join(" ")).toMatch(/below 5/u);
    expect(timelineProblems({ entries: [], pageSize: 51 }).join(" ")).toMatch(/above 50/u);
    expect(timelineProblems({ entries: [], pageSize: 7.5 }).join(" ")).toMatch(/whole number/u);
  });

  it("refuses hidden characters with the code point, and lets a description hold lines", () => {
    expect(timelineProblems({ entries: [{ ...ENTRIES[0], title: "Build‮passed" }] }).join(" ")).toMatch(/U\+202E/u);
    expect(timelineProblems({ entries: [{ ...ENTRIES[0], id: "b​x" }] }).join(" ")).toMatch(/U\+200B/u);
    expect(timelineProblems({ entries: [{ ...ENTRIES[0], actor: "C\nI" }] }).join(" ")).toMatch(/U\+000A/u);
    expect(timelineProblems({ entries: [{ ...ENTRIES[0], description: "one\ntwo\tthree" }] })).toEqual([]);
    expect(timelineProblems({ entries: [{ ...ENTRIES[0], description: "one\r\ntwo" }] }).join(" ")).toMatch(/U\+000D/u);
    expect(timelineProblems({ entries: [{ ...ENTRIES[0], description: "a⁦b" }] }).join(" ")).toMatch(/U\+2066/u);
  });

  it("refuses an empty title, an id of spaces, a field it does not know and props that are not an object", () => {
    expect(timelineProblems({ entries: [{ ...ENTRIES[0], title: "   " }] }).join(" ")).toMatch(/"entries\.0\.title": is empty/u);
    expect(timelineProblems({ entries: [{ ...ENTRIES[0], id: "  " }] }).join(" ")).toMatch(/is only spaces/u);
    expect(timelineProblems({ entries: [{ ...ENTRIES[0], url: "https://x" }] }).join(" ")).toMatch(/url/u);
    expect(timelineProblems({ entries: [], live: true }).join(" ")).toMatch(/live/u);
    expect(timelineProblems(null)).not.toEqual([]);
    expect(timelineProblems({})).not.toEqual([]);
  });

  it("gives a multi-line JSON pattern that agrees with the multi-line rule", () => {
    const pattern = new RegExp(MULTI_LINE_PATTERN);
    for (const text of ["one\ntwo", "tab\there", "Tiếng Việt 👍🏽", ""]) expect(pattern.test(text), text).toBe(true);
    for (const text of ["a\rb", "a b", "a‮b", "a​b", "a\u0000b", "a\u{E0041}b"]) expect(pattern.test(text), text).toBe(false);
  });
});

describe("reading times", () => {
  it("reads an instant with any offset and a date, and nothing else", () => {
    expect(readTimelineAt("2026-09-30T09:15:00+07:00")).toEqual({ allDay: false, ms: Date.parse("2026-09-30T02:15:00Z") });
    expect(readTimelineAt("2026-09-30T02:15Z")).toEqual({ allDay: false, ms: Date.parse("2026-09-30T02:15:00Z") });
    expect(readTimelineAt("2026-09-30T02:15:00.123456789Z")).toEqual({ allDay: false, ms: Date.parse("2026-09-30T02:15:00.123Z") });
    expect(readTimelineAt("2026-09-30T02:15:00.5-03:30")).toEqual({ allDay: false, ms: Date.parse("2026-09-30T05:45:00.500Z") });
    expect(readTimelineAt("2026-09-30")).toEqual({ allDay: true, date: "2026-09-30" });
    for (const bad of ["2026-09-30T02:15", "2026-9-30", "2026-09-30t02:15z", "2026-09-30 02:15Z", "2026-09-30T02:60Z", "2026-09-30T02:15:60Z", 20260930]) {
      expect(readTimelineAt(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("grouping by day", () => {
  it("puts each entry on its day in the timeline's timezone, newest first, all-day entries heading their day", () => {
    const read = timeline();
    expect(read.entries.map((entry) => [entry.id, entry.day, entry.time])).toEqual([
      ["freeze", "2026-09-30", undefined],
      ["deploy", "2026-09-30", "23:30"],
      ["build", "2026-09-30", "09:15"],
      ["alert", "2026-09-30", "00:30"],
      ["kickoff", "2026-09-28", "09:00"],
    ]);
    expect(groupTimelineByDay(read.entries).map((day) => [day.day, day.entries.length])).toEqual([
      ["2026-09-30", 4],
      ["2026-09-28", 1],
    ]);
  });

  it("reads the same entries on other days in another timezone, and oldest first when asked", () => {
    const utc = timeline({ timezone: "UTC", order: "oldest" });
    expect(utc.entries.map((entry) => [entry.id, entry.day, entry.time])).toEqual([
      ["kickoff", "2026-09-28", "02:00"],
      ["alert", "2026-09-29", "17:30"],
      ["freeze", "2026-09-30", undefined],
      ["build", "2026-09-30", "02:15"],
      ["deploy", "2026-09-30", "16:30"],
    ]);
  });

  it("keeps an all-day entry on its date wherever it is read", () => {
    for (const timeZone of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"]) {
      expect(timeline({ timezone: timeZone }).entries.find((entry) => entry.id === "freeze")?.day, timeZone).toBe("2026-09-30");
    }
  });

  it("follows daylight saving time: the hour that repeats and the hour that is skipped", () => {
    const newYork = readTimeline({
      timezone: "America/New_York",
      order: "oldest",
      entries: [
        // 2026-03-08: clocks go from 02:00 to 03:00. 06:59Z is 01:59 EST; 07:00Z is 03:00 EDT.
        { id: "before-spring", at: "2026-03-08T06:59:00Z", title: "A" },
        { id: "after-spring", at: "2026-03-08T07:00:00Z", title: "B" },
        // 2026-11-01: 01:00–02:00 happens twice. 05:30Z is 01:30 EDT; 06:30Z is 01:30 EST.
        { id: "first-0130", at: "2026-11-01T05:30:00Z", title: "C" },
        { id: "second-0130", at: "2026-11-01T06:30:00Z", title: "D" },
        // 04:30Z on 1 November is still 00:30 on 1 November (EDT), and 03:30Z is 23:30 on 31 October.
        { id: "late-october", at: "2026-11-01T03:30:00Z", title: "E" },
      ],
    });
    expect(newYork?.entries.map((entry) => [entry.id, entry.day, entry.time])).toEqual([
      ["before-spring", "2026-03-08", "01:59"],
      ["after-spring", "2026-03-08", "03:00"],
      ["late-october", "2026-10-31", "23:30"],
      // The same wall-clock time twice, kept in the order it happened.
      ["first-0130", "2026-11-01", "01:30"],
      ["second-0130", "2026-11-01", "01:30"],
    ]);
  });

  it("keeps the model's order for entries at the same instant", () => {
    const same = readTimeline({
      entries: [
        { id: "one", at: "2026-09-30T02:00:00Z", title: "One" },
        { id: "two", at: "2026-09-30T09:00:00+07:00", title: "Two" },
        { id: "three", at: "2026-09-30T02:00Z", title: "Three" },
      ],
    });
    expect(same?.entries.map((entry) => entry.id)).toEqual(["one", "two", "three"]);
    expect(readTimeline({ order: "oldest", entries: [{ id: "b", at: "2026-09-30T02:00Z", title: "B" }, { id: "a", at: "2026-09-30T02:00Z", title: "A" }] })?.entries.map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("groups by the same days whatever timezone the reading process is in", () => {
    const module = fileURLToPath(new URL("../src/activity-timeline.ts", import.meta.url));
    const props = { entries: ENTRIES, timezone: SAIGON };
    const script =
      `const { readTimeline } = await import(${JSON.stringify(`file:///${module.replaceAll("\\", "/").replace(/^\//, "")}`)});` +
      `const read = readTimeline(${JSON.stringify(props)});` +
      `process.stdout.write(JSON.stringify({ offset: new Date(2026, 8, 30, 12).getTimezoneOffset(), ` +
      `entries: read.entries.map((e) => [e.id, e.day, e.time ?? null]) }));`;
    const readIn = (zone: string): { offset: number; entries: unknown[] } =>
      JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ: zone }, encoding: "utf8" }),
      ) as { offset: number; entries: unknown[] };
    const node = readIn("Pacific/Kiritimati");
    const page = readIn("America/Los_Angeles");
    expect(node.offset).not.toBe(page.offset);
    expect(node.entries).toEqual(page.entries);
    expect(node.entries).toEqual(timeline().entries.map((e) => [e.id, e.day, e.time ?? null]));
  });

  it("reads in the timezone it is given when the props name none, and in UTC when that one is unknown", () => {
    expect(readTimeline({ entries: ENTRIES }, { timeZone: SAIGON })?.timeZone).toBe(SAIGON);
    expect(readTimeline({ entries: ENTRIES })?.timeZone).toBe("UTC");
    expect(readTimeline({ entries: ENTRIES, timezone: "Mars/Olympus" })?.timeZone).toBe("UTC");
  });
});

describe("pages", () => {
  const long = readTimeline({
    pageSize: 5,
    order: "oldest",
    timezone: "UTC",
    entries: Array.from({ length: 12 }, (_, index) => ({ id: `e${String(index)}`, at: `2026-09-${String(10 + Math.floor(index / 3))}`, title: `E${String(index)}` })),
  });
  if (long === undefined) throw new Error("the long timeline does not read");

  it("pages the entries and groups each page by day", () => {
    expect(timelinePageCount(long)).toBe(3);
    expect(timelinePage(long, 0).map((day) => [day.day, day.entries.map((entry) => entry.id)])).toEqual([
      ["2026-09-10", ["e0", "e1", "e2"]],
      ["2026-09-11", ["e3", "e4"]],
    ]);
    expect(timelinePage(long, 2).flatMap((day) => day.entries.map((entry) => entry.id))).toEqual(["e10", "e11"]);
    expect(timelinePage(long, 9).flatMap((day) => day.entries.map((entry) => entry.id))).toEqual(["e10", "e11"]);
    expect(timelinePage(long, -1).flatMap((day) => day.entries.map((entry) => entry.id))).toHaveLength(5);
  });

  it("opens on the page that holds the selected entry", () => {
    expect(timelinePageOf(long, "e7")).toBe(1);
    expect(timelinePageOf(long, "gone")).toBe(0);
    expect(timelinePageOf(long, undefined)).toBe(0);
    expect(timelinePageCount({ entries: [], pageSize: 10 })).toBe(1);
  });
});

describe("the selection", () => {
  const read = timeline();

  it("accepts an entry the timeline holds, and an empty id that clears it", () => {
    expect(timelineSelectionProblems(read, { selectedId: "deploy" })).toEqual([]);
    expect(timelineSelectionProblems(read, { selectedId: "" })).toEqual([]);
  });

  it("refuses an entry that is not there, another key and another shape", () => {
    expect(timelineSelectionProblems(read, { selectedId: "gone" })).toEqual(['"gone" is not an entry on this timeline now']);
    expect(timelineSelectionProblems(read, { selectedId: "deploy", page: 2 })).toEqual(["a timeline selection carries only selectedId, not page"]);
    expect(timelineSelectionProblems(read, { selectedId: 3 })).toHaveLength(1);
    expect(timelineSelectionProblems(read, {})).toHaveLength(1);
    expect(timelineSelectionProblems(read, "deploy")).toHaveLength(1);
    expect(timelineSelectionProblems(read, { selectedId: "x".repeat(500) })[0]?.length).toBeLessThan(120);
  });

  it("reads a stored selection leniently, dropping an entry that is gone", () => {
    expect(readTimelineSelection({ selectedId: "deploy" }, read)).toEqual({ selectedId: "deploy" });
    expect(readTimelineSelection({ selectedId: "gone" }, read)).toEqual({});
    expect(readTimelineSelection({ selectedId: "gone" })).toEqual({ selectedId: "gone" });
    expect(readTimelineSelection(undefined, read)).toEqual({});
  });
});

describe("what the timeline says", () => {
  const read = timeline({ title: "Release", truncated: true });

  it("counts the tones and the days it covers", () => {
    expect(timelineToneCounts(read)).toEqual({ neutral: 2, info: 1, success: 1, warning: 1, danger: 0 });
    expect(timelineRange(read)).toEqual({ from: "2026-09-28", to: "2026-09-30" });
    expect(timelineRange({ entries: [] })).toBeUndefined();
  });

  it("is a dated list as text, saying entries were left out, clipped when it is long", () => {
    const text = timelineText(read);
    expect(text).toContain("Release: Activity timeline (Asia/Saigon, newest first): 5 entries. More entries were left out.");
    expect(text).toContain("2026-09-30: all day Release freeze; 23:30 Deploy started [info]; 09:15 Build passed [success] by CI");
    expect(text).toContain("2026-09-28: 09:00 Kickoff");
    expect(timelineText(read, 80).length).toBeLessThanOrEqual(80);
    expect(timelineText(read, 80).endsWith("… (shortened)")).toBe(true);
    expect(timelineText(timeline({ entries: [] }))).toBe("Activity timeline (Asia/Saigon, newest first): no entries.");
  });

  it("gives a semantic document with the count, range, tones and selected entry, within the limits", () => {
    const semantic = timelineSemantic(read, { selectedId: "build" });
    expect(semantic).toMatchObject({
      title: "Release",
      selectedIds: ["build"],
      values: {
        entries: 5,
        from: "2026-09-28",
        to: "2026-09-30",
        timezone: SAIGON,
        truncated: true,
        toneSuccess: 1,
        toneDanger: 0,
        selectedEntry: "Build passed",
        selectedAt: "2026-09-30 at 09:15",
      },
    });
    expect(semantic.summary).toBe(
      "Activity timeline (Asia/Saigon): 5 entries from 2026-09-28 to 2026-09-30, 2 neutral, 1 info, 1 success, 1 warning; more entries were left out; selected: Build passed, 2026-09-30 at 09:15",
    );
    expect(Object.keys(semantic.values).length).toBeLessThanOrEqual(SEMANTIC_LIMITS.values);
    const doc = normalizeSemanticDoc({ instanceId: "i", definitionId: "canvas.timeline@1", ...semantic, availableActions: [], freshness: "unknown" });
    expect(doc.values).toEqual(semantic.values);
    expect(doc.summary).toBe(semantic.summary.slice(0, SEMANTIC_LIMITS.summary));
    expect(timelineSemantic(read, { selectedId: "gone" }).selectedIds).toEqual([]);
  });
});

describe("the page's reading", () => {
  it("keeps a hidden character for the page to mark, and counts it, while the node refuses it", () => {
    const props = { entries: [{ id: "x", at: "2026-09-30", title: "Build‮passed", description: "a​b" }] };
    expect(readTimeline(props)).toBeUndefined();
    const kept = readTimeline(props, { keepHidden: true });
    expect(kept?.entries[0]?.title).toBe("Build‮passed");
    expect(kept === undefined ? -1 : timelineHiddenCount(kept)).toBe(2);
    expect(timelineHiddenCount(timeline())).toBe(0);
  });

  it("still refuses what is not a timeline, even when keeping hidden characters", () => {
    expect(readTimeline({ entries: [ENTRIES[0], ENTRIES[0]] }, { keepHidden: true })).toBeUndefined();
    expect(readTimeline({ entries: [{ id: "a", at: "2026-02-30", title: "A" }] }, { keepHidden: true })).toBeUndefined();
  });
});
