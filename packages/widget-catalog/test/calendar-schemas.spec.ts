import { describe, expect, it } from "vitest";

import {
  CALENDAR_STATE_MIGRATIONS,
  CALENDAR_STATE_VERSION,
  CALENDAR_VIEWS,
  calendarViewProblems,
  readCalendarEvents,
  stateAsCurrentVersion,
  validateProps,
  validateStateAgainstSchema,
} from "@clarkcant/contracts";
import { CALENDAR } from "@clarkcant/data-canvas";

import { fixturesFor } from "../src/fixtures.ts";

/**
 * The calendar the library shows is one the node would keep: every fixture's props pass the definition's schema, its
 * rows are all events the calendar can place, and its view is one the node would hold over those rows. The definition
 * also says its state version and the step that brings a saved month-only calendar to it.
 */

describe("calendar schemas", () => {
  it("declares its state version and the step from the month-only calendar", () => {
    expect(CALENDAR.stateVersion).toBe(CALENDAR_STATE_VERSION);
    expect(CALENDAR.stateMigrations).toEqual([...CALENDAR_STATE_MIGRATIONS]);
    const view = (CALENDAR.stateSchema?.properties as Record<string, { enum?: unknown[] }> | undefined)?.view;
    expect(view?.enum).toEqual([...CALENDAR_VIEWS]);
  });

  it("reads a calendar saved before there were views as a month view", () => {
    const migrated = stateAsCurrentVersion(CALENDAR, { stateVersion: 1, body: { selectedDate: "2026-09-08" } });
    expect(migrated).toEqual({ stateVersion: CALENDAR_STATE_VERSION, body: { selectedDate: "2026-09-08", view: "month" } });
    expect(validateStateAgainstSchema(CALENDAR.stateSchema, migrated.body)).toEqual({ ok: true });
  });

  it("refuses a view the calendar does not have, in the schema as in its own rules", () => {
    expect(validateStateAgainstSchema(CALENDAR.stateSchema, { view: "year" }).ok).toBe(false);
    expect(validateStateAgainstSchema(CALENDAR.stateSchema, { view: "week", zoom: 2 }).ok).toBe(false);
    expect(calendarViewProblems("2026-09", { view: "year" }, [])).not.toEqual([]);
    expect(validateProps(CALENDAR, { datasetRef: "ds", month: "2026-09", view: "year" }).ok).toBe(false);
  });

  it("shows a month, a week and an agenda in the library, each one the node would keep", () => {
    const fixtures = fixturesFor(CALENDAR.id);
    expect(fixtures.map((fixture) => fixture.id)).toEqual(expect.arrayContaining(["calendar.normal", "calendar.week", "calendar.agenda"]));
    for (const fixture of fixtures) {
      const props = fixture.props as Record<string, unknown>;
      expect(validateProps(CALENDAR, props).ok, fixture.id).toBe(true);
      expect(props.datasetRef, fixture.id).toBe(fixture.dataset?.datasetId);
      const read = readCalendarEvents(fixture.dataset?.rows ?? [], String(props.timezone ?? "UTC"));
      expect(read.unreadable, fixture.id).toBe(0);
      if (fixture.state !== undefined) {
        expect(validateStateAgainstSchema(CALENDAR.stateSchema, fixture.state), fixture.id).toEqual({ ok: true });
        expect(calendarViewProblems(String(props.month), fixture.state, read.events), fixture.id).toEqual([]);
      }
    }
  });
});
