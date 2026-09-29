import { describe, expect, it } from "vitest";

import {
  CALENDAR_STATE_MIGRATIONS,
  CALENDAR_STATE_VERSION,
  MAX_CALENDAR_EVENTS,
  addDaysIso,
  applyStateMigrationOps,
  calendarFocusDate,
  calendarGridDates,
  calendarSemantic,
  calendarText,
  calendarViewProblems,
  eventWhenText,
  eventsOnDay,
  isIsoDate,
  normalizeSemanticDoc,
  readCalendarEvents,
  readCalendarState,
  stateMigrationGaps,
  weekDates,
} from "../src/index.ts";

/**
 * The calendar's views: every event is on each day it covers in the calendar's timezone, an all-day event keeps its
 * dates wherever it is seen, and what a person selects is a view the node checks against the events it holds.
 */

const HCM = "Asia/Ho_Chi_Minh";

const ROWS = [
  // 09:00–10:00 in Ho Chi Minh City on 5 October.
  { eventId: "standup", title: "Họp đầu tuần", startsAt: "2026-10-05T02:00:00Z", endsAt: "2026-10-05T03:00:00Z", timezone: HCM },
  // 22:00 on the 6th to 02:00 on the 7th in Ho Chi Minh City: on both days there.
  { eventId: "deploy", title: "Triển khai đêm", startsAt: "2026-10-06T15:00:00Z", endsAt: "2026-10-06T19:00:00Z", timezone: HCM },
  // All day, 7 to 9 October: the end date is the day after the last.
  { eventId: "offsite", title: "Hội thảo", allDay: true, startDate: "2026-10-07", endDate: "2026-10-10" },
  // Ends exactly at midnight: not on the day that midnight begins.
  { eventId: "review", title: "Rà soát", startsAt: "2026-10-12T15:00:00Z", endsAt: "2026-10-12T17:00:00Z", timezone: HCM },
];

describe("reading calendar events", () => {
  it("places a timed event on every day it runs in the calendar's timezone, and not on the day a midnight end begins", () => {
    const { events, unreadable } = readCalendarEvents(ROWS, HCM);
    expect(unreadable).toBe(0);
    const deploy = events.find((event) => event.id === "deploy");
    expect([deploy?.startDate, deploy?.lastDate]).toEqual(["2026-10-06", "2026-10-07"]);
    const review = events.find((event) => event.id === "review");
    expect([review?.startDate, review?.lastDate]).toEqual(["2026-10-12", "2026-10-12"]);
    expect(eventsOnDay(events, "2026-10-07").map((event) => event.id)).toEqual(["offsite", "deploy"]);
    expect(eventsOnDay(events, "2026-10-13")).toEqual([]);
  });

  it("reads the same instants onto other days in another timezone", () => {
    const { events } = readCalendarEvents(ROWS, "America/Los_Angeles");
    const deploy = events.find((event) => event.id === "deploy");
    // 08:00–12:00 on the 6th in Los Angeles.
    expect([deploy?.startDate, deploy?.lastDate]).toEqual(["2026-10-06", "2026-10-06"]);
    const standup = events.find((event) => event.id === "standup");
    // 19:00 on the 4th in Los Angeles.
    expect(standup?.startDate).toBe("2026-10-04");
  });

  it("keeps an all-day event on its own dates in every timezone", () => {
    for (const zone of [HCM, "America/Los_Angeles", "Pacific/Kiritimati", "UTC"]) {
      const offsite = readCalendarEvents(ROWS, zone).events.find((event) => event.id === "offsite");
      expect([offsite?.allDay, offsite?.startDate, offsite?.lastDate]).toEqual([true, "2026-10-07", "2026-10-09"]);
    }
  });

  it("reads a single-day all-day row from its date, and a dated row with no time on that date", () => {
    const { events } = readCalendarEvents(
      [
        { title: "Nghỉ lễ", allDay: true, date: "2026-10-20" },
        { title: "Hạn nộp", date: "2026-10-21", allDay: false },
      ],
      HCM,
    );
    expect(events.map((event) => [event.title, event.allDay, event.startDate, event.lastDate])).toEqual([
      ["Nghỉ lễ", true, "2026-10-20", "2026-10-20"],
      ["Hạn nộp", false, "2026-10-21", "2026-10-21"],
    ]);
  });

  it("counts rows it cannot place instead of guessing a day for them", () => {
    const { events, unreadable } = readCalendarEvents(
      [
        "not a row",
        { title: "", date: "2026-10-01" },
        { title: "No date" },
        { title: "Backwards", startsAt: "2026-10-02T10:00:00Z", endsAt: "2026-10-02T09:00:00Z" },
        { title: "Empty all-day", allDay: true, startDate: "2026-10-03", endDate: "2026-10-03" },
        { title: "Not a date", allDay: true, date: "2026-02-30" },
        { title: "Fine", date: "2026-10-04" },
      ],
      HCM,
    );
    expect(unreadable).toBe(6);
    expect(events.map((event) => event.title)).toEqual(["Fine"]);
  });

  it("reads at most the first rows and says how many there were", () => {
    const rows = Array.from({ length: MAX_CALENDAR_EVENTS + 3 }, (_, index) => ({ title: `E${String(index)}`, date: "2026-10-01" }));
    const read = readCalendarEvents(rows, HCM);
    expect(read.events).toHaveLength(MAX_CALENDAR_EVENTS);
    expect(read.total).toBe(MAX_CALENDAR_EVENTS + 3);
  });

  it("says when an event is in the calendar's timezone", () => {
    const { events } = readCalendarEvents(ROWS, HCM);
    const text = (id: string): string => {
      const event = events.find((candidate) => candidate.id === id);
      if (event === undefined) throw new Error(id);
      return eventWhenText(event, HCM);
    };
    expect(text("standup")).toBe("2026-10-05 at 09:00–10:00");
    expect(text("deploy")).toBe("2026-10-06 at 22:00 to 2026-10-07 at 02:00");
    expect(text("offsite")).toBe("all day, 2026-10-07 to 2026-10-09");
  });
});

describe("calendar dates", () => {
  it("checks real dates and does calendar arithmetic across month and year ends", () => {
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-10-5")).toBe(false);
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekDates("2026-10-07")).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
    expect(weekDates("2026-10-11")[0]).toBe("2026-10-05");
  });

  it("focuses the selected day, else today on the calendar, else the first of the month", () => {
    expect(calendarFocusDate("2026-10", "2026-10-15", "2026-10-02")).toBe("2026-10-15");
    expect(calendarFocusDate("2026-10", undefined, "2026-10-02")).toBe("2026-10-02");
    expect(calendarFocusDate("2026-10", undefined, "2026-11-20")).toBe("2026-10-01");
    expect(calendarFocusDate("2026-10", "2027-01-01", undefined)).toBe("2026-10-01");
  });
});

describe("the calendar view", () => {
  const { events } = readCalendarEvents(ROWS, HCM);

  it("accepts a view the calendar can show", () => {
    expect(calendarViewProblems("2026-10", { view: "week" }, events)).toEqual([]);
    expect(calendarViewProblems("2026-10", { view: "agenda", selectedDate: "2026-10-07", selectedEventId: "deploy" }, events)).toEqual([]);
    // A leading day of the next month is on the month grid, so it can be selected.
    expect(calendarViewProblems("2026-10", { view: "month", selectedDate: "2026-11-01" }, events)).toEqual([]);
  });

  it("refuses a view it cannot show, with the reason", () => {
    expect(calendarViewProblems("2026-10", { view: "year" }, events)).toEqual(["the view is one of month, week, agenda"]);
    expect(calendarViewProblems("2026-10", { selectedDate: "2026-10-01" }, events)).toEqual(["the view is one of month, week, agenda"]);
    expect(calendarViewProblems("2026-10", { view: "month", selectedDate: "2026-12-01" }, events)[0]).toContain("is not on this calendar");
    expect(calendarViewProblems("2026-10", { view: "month", selectedDate: "5/10/2026" }, events)).toEqual([
      "the selected day is a date in YYYY-MM-DD form",
    ]);
    expect(calendarViewProblems("2026-10", { view: "month", selectedEventId: "gone" }, events)).toEqual([
      '"gone" is not an event on this calendar now',
    ]);
    expect(calendarViewProblems("2026-10", { view: "month", selectedDate: "2026-10-05", selectedEventId: "deploy" }, events)).toEqual([
      '"Triển khai đêm" is not on 2026-10-05',
    ]);
    expect(calendarViewProblems("2026-10", { view: "month", zoom: 2 }, events)[0]).toContain("not zoom");
    expect(calendarViewProblems("2026-10", "week", events)[0]).toContain("is an object");
  });

  it("reads a stored view leniently, and a state with no view as the view the calendar was placed with", () => {
    expect(readCalendarState({ selectedDate: "2026-10-05" }, "2026-10", undefined)).toEqual({ view: "month", selectedDate: "2026-10-05" });
    expect(readCalendarState(undefined, "2026-10", "agenda")).toEqual({ view: "agenda" });
    expect(readCalendarState({ view: "week" }, "2026-10", "agenda")).toEqual({ view: "week" });
    expect(readCalendarState({ view: "year", selectedDate: "2027-01-01", selectedEventId: "gone" }, "2026-10", undefined, events)).toEqual({
      view: "month",
    });
    expect(readCalendarState({ view: "week", selectedDate: "2026-10-07", selectedEventId: "deploy" }, "2026-10", undefined, events)).toEqual({
      view: "week",
      selectedDate: "2026-10-07",
      selectedEventId: "deploy",
    });
  });

  it("carries a first-version state to the current one as a month view, without touching a view already set", () => {
    const definition = { stateVersion: CALENDAR_STATE_VERSION, stateMigrations: [...CALENDAR_STATE_MIGRATIONS] };
    expect(stateMigrationGaps(definition)).toEqual([]);
    const step = CALENDAR_STATE_MIGRATIONS[0];
    if (step === undefined) throw new Error("no migration step");
    expect(applyStateMigrationOps({ selectedDate: "2026-10-05" }, step.ops)).toEqual({ selectedDate: "2026-10-05", view: "month" });
    expect(applyStateMigrationOps({ view: "week" }, step.ops)).toEqual({ view: "week" });
  });
});

describe("what the calendar says", () => {
  const subject = { month: "2026-10", timeZone: HCM, title: "Lịch nhóm" };

  it("writes a text alternative with each event of the month and when it is", () => {
    const text = calendarText(subject, readCalendarEvents(ROWS, HCM));
    expect(text).toContain("Lịch nhóm: Calendar for 2026-10 (Asia/Ho_Chi_Minh): 4 event(s).");
    expect(text).toContain("Triển khai đêm (2026-10-06 at 22:00 to 2026-10-07 at 02:00)");
    expect(calendarText(subject, readCalendarEvents([], HCM))).toBe("Lịch nhóm: Calendar for 2026-10 (Asia/Ho_Chi_Minh): no events.");
  });

  it("gives the view, the selected day and the selected event as semantic state", () => {
    const read = readCalendarEvents(ROWS, HCM);
    const semantic = calendarSemantic(subject, read, { view: "week", selectedDate: "2026-10-07", selectedEventId: "deploy" });
    expect(semantic.values).toMatchObject({
      view: "week",
      month: "2026-10",
      timezone: HCM,
      selectedDate: "2026-10-07",
      events: 4,
      selectedDayEvents: ["Hội thảo", "Triển khai đêm"],
      selectedEvent: "Triển khai đêm (2026-10-06 at 22:00 to 2026-10-07 at 02:00)",
    });
    expect(semantic.selectedIds).toEqual(["deploy"]);
    const doc = normalizeSemanticDoc({ instanceId: "w", definitionId: "canvas.calendar@1", ...semantic });
    expect(doc.values.view).toBe("week");
    expect(doc.selectedIds).toEqual(["deploy"]);
  });

  it("says when the events are not on the node, instead of describing none", () => {
    const semantic = calendarSemantic(subject, undefined, { view: "agenda" });
    expect(semantic.summary).toContain("not available on this node");
    expect(semantic.values.events).toBeUndefined();
  });

  it("names the month grid it selects from", () => {
    const grid = calendarGridDates("2026-10");
    expect(grid).toHaveLength(42);
    expect([grid[0], grid.at(-1)]).toEqual(["2026-09-28", "2026-11-08"]);
  });
});
