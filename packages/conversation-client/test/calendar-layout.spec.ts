import { describe, expect, it } from "vitest";

import { calendarGridDates, readCalendarEvents } from "@clarkcant/contracts";

import { calendarWeek, eventSegment, moveDay, moveInList, nowIndex } from "../src/calendar-layout.ts";

const GRID = calendarGridDates("2026-10");

describe("calendar keyboard and layout", () => {
  it("moves a day, a week, or to the ends of the week, and never off the grid", () => {
    expect(moveDay("ArrowRight", "2026-10-07", GRID)).toBe("2026-10-08");
    expect(moveDay("ArrowLeft", "2026-10-07", GRID)).toBe("2026-10-06");
    expect(moveDay("ArrowDown", "2026-10-07", GRID)).toBe("2026-10-14");
    expect(moveDay("ArrowUp", "2026-10-07", GRID)).toBe("2026-09-30");
    expect(moveDay("Home", "2026-10-07", GRID)).toBe("2026-10-05");
    expect(moveDay("End", "2026-10-07", GRID)).toBe("2026-10-11");
    // The grid starts on Monday 2026-09-28 and ends on Sunday 2026-11-08.
    expect(GRID[0]).toBe("2026-09-28");
    expect(moveDay("ArrowLeft", "2026-09-28", GRID)).toBeUndefined();
    expect(moveDay("ArrowUp", "2026-10-01", GRID)).toBeUndefined();
    expect(moveDay("ArrowDown", GRID.at(-1) ?? "", GRID)).toBeUndefined();
    expect(moveDay("Enter", "2026-10-07", GRID)).toBeUndefined();
  });

  it("gives the week of a day and whether the grid has one before and after it", () => {
    const middle = calendarWeek(GRID, "2026-10-14");
    expect(middle.days).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(middle.previous).toBe("2026-10-07");
    expect(middle.next).toBe("2026-10-21");
    expect(calendarWeek(GRID, "2026-10-01").previous).toBeUndefined();
    expect(calendarWeek(GRID, "2026-11-05").next).toBeUndefined();
  });

  it("says which of its days an event is drawn on", () => {
    const { events } = readCalendarEvents(
      [
        { eventId: "offsite", title: "Offsite", allDay: true, startDate: "2026-10-07", endDate: "2026-10-10" },
        { eventId: "call", title: "Call", startsAt: "2026-10-05T02:00:00Z", endsAt: "2026-10-05T03:00:00Z" },
      ],
      "Asia/Ho_Chi_Minh",
    );
    const offsite = events.find((event) => event.id === "offsite");
    const call = events.find((event) => event.id === "call");
    if (offsite === undefined || call === undefined) throw new Error("events not read");
    expect(eventSegment(offsite, "2026-10-07")).toEqual({ position: "first", day: 1, days: 3 });
    expect(eventSegment(offsite, "2026-10-08")).toEqual({ position: "middle", day: 2, days: 3 });
    expect(eventSegment(offsite, "2026-10-09")).toEqual({ position: "last", day: 3, days: 3 });
    expect(eventSegment(call, "2026-10-05")).toEqual({ position: "only", day: 1, days: 1 });
  });

  it("puts now before the first timed event of the day that has not started", () => {
    const { events } = readCalendarEvents(
      [
        { eventId: "holiday", title: "Holiday", allDay: true, startDate: "2026-10-20" },
        { eventId: "early", title: "Early", startsAt: "2026-10-20T01:00:00Z", endsAt: "2026-10-20T02:00:00Z" },
        { eventId: "late", title: "Late", startsAt: "2026-10-20T05:00:00Z", endsAt: "2026-10-20T06:00:00Z" },
      ],
      "UTC",
    );
    expect(events.map((event) => event.id)).toEqual(["holiday", "early", "late"]);
    expect(nowIndex(events, "2026-10-20", new Date("2026-10-20T00:30:00Z"))).toBe(1);
    expect(nowIndex(events, "2026-10-20", new Date("2026-10-20T03:00:00Z"))).toBe(2);
    expect(nowIndex(events, "2026-10-20", new Date("2026-10-20T07:00:00Z"))).toBe(3);
  });

  it("does not put now above an event that started on an earlier day", () => {
    const { events } = readCalendarEvents(
      [{ eventId: "night", title: "Night", startsAt: "2026-10-06T22:00:00Z", endsAt: "2026-10-07T02:00:00Z" }],
      "UTC",
    );
    expect(nowIndex(events, "2026-10-07", new Date("2026-10-07T00:30:00Z"))).toBe(1);
  });

  it("moves up and down a list, and stops at its ends", () => {
    expect(moveInList("ArrowDown", 0, 3)).toBe(1);
    expect(moveInList("ArrowDown", 2, 3)).toBeUndefined();
    expect(moveInList("ArrowUp", 0, 3)).toBeUndefined();
    expect(moveInList("ArrowUp", 2, 3)).toBe(1);
    expect(moveInList("Home", 2, 3)).toBe(0);
    expect(moveInList("End", 0, 3)).toBe(2);
    expect(moveInList("ArrowLeft", 1, 3)).toBeUndefined();
  });
});
