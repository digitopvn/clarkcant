import { describe, expect, it } from "vitest";

import {
  readTimeline,
  readTimelineSelection,
  timelineProblems,
  timelineSchemaProblems,
  timelineSelectionProblems,
  validateProps,
  validateStateAgainstSchema,
} from "@clarkcant/contracts";
import { TIMELINE } from "@clarkcant/data-canvas";

import { fixturesFor } from "../src/fixtures.ts";

/**
 * The timeline's JSON Schema, which the model reads, and the timeline's own schema, which the node places by, accept and
 * refuse the same props; what only the timeline's rules can say (a date that does not exist, an id used twice) is
 * refused on top; and every library fixture is one the node would place, with a selection the node would keep.
 */

const ENTRY = { id: "a", at: "2026-09-30T09:15:00+07:00", title: "Build passed" };

const BAD: Record<string, unknown>[] = [
  {},
  { entries: "none" },
  { entries: [{ at: ENTRY.at, title: "x" }] },
  { entries: [{ id: "a", title: "x" }] },
  { entries: [{ id: "a", at: ENTRY.at }] },
  { entries: [{ ...ENTRY, id: "" }] },
  { entries: [{ ...ENTRY, id: "   " }] },
  { entries: [{ ...ENTRY, id: "a​b" }] },
  { entries: [{ ...ENTRY, id: "x".repeat(121) }] },
  { entries: [{ ...ENTRY, at: "2026-09-30T09:15:00" }] },
  { entries: [{ ...ENTRY, at: "2026-09-30 09:15Z" }] },
  { entries: [{ ...ENTRY, at: "30/09/2026" }] },
  { entries: [{ ...ENTRY, at: 1759198500000 }] },
  { entries: [{ ...ENTRY, title: "" }] },
  { entries: [{ ...ENTRY, title: " " }] },
  { entries: [{ ...ENTRY, title: "Up\nDown" }] },
  { entries: [{ ...ENTRY, title: "a‮b" }] },
  { entries: [{ ...ENTRY, title: "x".repeat(201) }] },
  { entries: [{ ...ENTRY, description: "x".repeat(1001) }] },
  { entries: [{ ...ENTRY, description: "a\rb" }] },
  { entries: [{ ...ENTRY, description: "a b" }] },
  { entries: [{ ...ENTRY, actor: "x".repeat(81) }] },
  { entries: [{ ...ENTRY, actor: "C\tI" }] },
  { entries: [{ ...ENTRY, tone: "critical" }] },
  { entries: [{ ...ENTRY, href: "https://example.com" }] },
  { entries: Array.from({ length: 201 }, (_, index) => ({ ...ENTRY, id: `e${String(index)}` })) },
  { entries: [], order: "random" },
  { entries: [], pageSize: 4 },
  { entries: [], pageSize: 51 },
  { entries: [], pageSize: 10.5 },
  { entries: [], timezone: "" },
  { entries: [], timezone: "Asia Saigon" },
  { entries: [], timezone: `A${"x".repeat(60)}` },
  { entries: [], truncated: "yes" },
  { entries: [], title: "x".repeat(201) },
  { entries: [], live: true },
];

const GOOD: Record<string, unknown>[] = [
  { entries: [] },
  { entries: [ENTRY], title: " ", order: "oldest", pageSize: 5, timezone: "America/Argentina/Buenos_Aires", truncated: false },
  { entries: [{ ...ENTRY, id: " spaced id ", description: "one\ntwo\tthree", actor: "CI", tone: "danger" }], pageSize: 50 },
  { entries: [{ ...ENTRY, at: "2026-09-30" }, { ...ENTRY, id: "b", at: "2026-09-30T02:15:00.123456789Z" }], timezone: "Etc/GMT-7" },
  { entries: Array.from({ length: 200 }, (_, index) => ({ ...ENTRY, id: `e${String(index)}` })) },
];

/** Props the schema accepts and only the timeline's own rules refuse. */
const MEANING_ONLY: Record<string, unknown>[] = [
  { entries: [ENTRY, ENTRY] },
  { entries: [{ ...ENTRY, at: "2026-02-30" }] },
  { entries: [{ ...ENTRY, at: "2026-09-30T24:00Z" }] },
  { entries: [{ ...ENTRY, at: "2026-09-30T09:15+25:00" }] },
  { entries: [], timezone: "Mars/Olympus" },
];

describe("the timeline's schema", () => {
  it("the JSON Schema and the timeline's own schema accept and refuse the same props", () => {
    const cases = [...fixturesFor(TIMELINE.id).map((fixture) => fixture.props as Record<string, unknown>), ...GOOD, ...BAD, ...MEANING_ONLY];
    for (const props of cases) {
      const json = validateProps(TIMELINE, props).ok;
      const own = timelineSchemaProblems(props).length === 0;
      expect({ props, json }).toEqual({ props, json: own });
    }
    for (const props of BAD) expect(validateProps(TIMELINE, props).ok, JSON.stringify(props).slice(0, 200)).toBe(false);
    for (const props of GOOD) expect(timelineProblems(props), JSON.stringify(props).slice(0, 200)).toEqual([]);
  });

  it("refuses on top what only the timeline's rules can say", () => {
    for (const props of MEANING_ONLY) {
      expect(validateProps(TIMELINE, props).ok, JSON.stringify(props)).toBe(true);
      expect(timelineProblems(props).length, JSON.stringify(props)).toBeGreaterThan(0);
    }
  });

  it("every library fixture is one the node would place, with a selection it would keep", () => {
    const fixtures = fixturesFor(TIMELINE.id);
    expect(fixtures.some((fixture) => fixture.id.endsWith(".normal"))).toBe(true);
    for (const fixture of fixtures) {
      expect(timelineProblems(fixture.props), fixture.id).toEqual([]);
      const timeline = readTimeline(fixture.props);
      if (timeline === undefined) throw new Error(`${fixture.id} does not describe a timeline`);
      if (fixture.state !== undefined) {
        expect(validateStateAgainstSchema(TIMELINE.stateSchema, fixture.state).ok, fixture.id).toBe(true);
        expect(timelineSelectionProblems(timeline, fixture.state), fixture.id).toEqual([]);
        expect(readTimelineSelection(fixture.state, timeline), fixture.id).toEqual(fixture.state);
      }
    }
  });

  it("shows every tone, an all-day entry, a long description, a second page, a truncated list and an empty one", () => {
    const [normal, oldest] = [fixturesFor(TIMELINE.id)[0], fixturesFor(TIMELINE.id)[1]];
    const timeline = normal === undefined ? undefined : readTimeline(normal.props);
    expect(new Set(timeline?.entries.map((entry) => entry.tone))).toEqual(new Set(["neutral", "info", "success", "warning", "danger"]));
    expect(timeline?.entries.some((entry) => entry.allDay)).toBe(true);
    expect(timeline?.entries.some((entry) => (entry.description?.length ?? 0) > 160)).toBe(true);
    const paged = oldest === undefined ? undefined : readTimeline(oldest.props);
    expect(paged === undefined ? 0 : Math.ceil(paged.entries.length / paged.pageSize)).toBeGreaterThan(1);
    expect(fixturesFor(TIMELINE.id).some((fixture) => fixture.props.truncated === true)).toBe(true);
    expect(fixturesFor(TIMELINE.id).some((fixture) => Array.isArray(fixture.props.entries) && fixture.props.entries.length === 0)).toBe(true);
  });
});
