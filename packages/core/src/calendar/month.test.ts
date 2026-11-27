import { describe, expect, it } from "vitest";
import { dayStartMs, eventDays, eventTimeLabel, eventsByDay, monthGrid, type CalendarEventLike } from "./month";

const allDay = (summary: string, startDate: string, endDate: string): CalendarEventLike => ({
  summary,
  allDay: true,
  startAt: null,
  endAt: null,
  startDate,
  endDate,
});
const timed = (summary: string, start: Date, end: Date): CalendarEventLike => ({
  summary,
  allDay: false,
  startAt: start.getTime(),
  endAt: end.getTime(),
  startDate: null,
  endDate: null,
});

describe("monthGrid", () => {
  it("covers the month in whole weeks from the chosen first day", () => {
    // October 2026 starts on a Thursday and ends on a Saturday.
    const monday = monthGrid(2026, 9, 1);
    expect(monday[0]).toBe("2026-09-28");
    expect(monday.at(-1)).toBe("2026-11-01");
    expect(monday.length).toBe(35);
    const sunday = monthGrid(2026, 9, 0);
    expect(sunday[0]).toBe("2026-09-27");
    expect(sunday.at(-1)).toBe("2026-10-31");
    // February 2026 starts on a Sunday: with Sunday first it is exactly 4 weeks.
    expect(monthGrid(2026, 1, 0).length).toBe(28);
  });
});

describe("eventDays", () => {
  it("uses Google's exclusive end date for all-day events", () => {
    expect(eventDays(allDay("Diwali", "2026-11-08", "2026-11-09"))).toEqual(["2026-11-08"]);
    expect(eventDays(allDay("Trip", "2026-11-08", "2026-11-11"))).toEqual(["2026-11-08", "2026-11-09", "2026-11-10"]);
  });

  it("puts a timed event on each local day it touches, not the day it ends at midnight", () => {
    expect(eventDays(timed("Call", new Date(2026, 9, 23, 10), new Date(2026, 9, 23, 11)))).toEqual(["2026-10-23"]);
    expect(eventDays(timed("Late", new Date(2026, 9, 23, 22), new Date(2026, 9, 24, 0)))).toEqual(["2026-10-23"]);
    expect(eventDays(timed("Night", new Date(2026, 9, 23, 22), new Date(2026, 9, 24, 2)))).toEqual(["2026-10-23", "2026-10-24"]);
  });
});

describe("eventsByDay and labels", () => {
  it("lists all-day events first, then by time", () => {
    const call = timed("Call", new Date(2026, 9, 23, 10), new Date(2026, 9, 23, 11, 30));
    const early = timed("Gym", new Date(2026, 9, 23, 7), new Date(2026, 9, 23, 8));
    const hol = allDay("Holiday", "2026-10-23", "2026-10-24");
    const map = eventsByDay([call, early, hol], ["2026-10-23", "2026-10-24"]);
    expect(map.get("2026-10-23")!.map((e) => e.summary)).toEqual(["Holiday", "Gym", "Call"]);
    expect(map.get("2026-10-24")).toEqual([]);
    expect(eventTimeLabel(call, "2026-10-23")).toBe("10 AM–11:30 AM");
    expect(eventTimeLabel(hol, "2026-10-23")).toBe("All day");
    const night = timed("Night", new Date(2026, 9, 23, 22), new Date(2026, 9, 24, 2));
    expect(eventTimeLabel(night, "2026-10-23")).toBe("From 10 PM");
    expect(eventTimeLabel(night, "2026-10-24")).toBe("Until 2 AM");
  });
});

describe("dayStartMs", () => {
  it("is local midnight", () => {
    expect(dayStartMs("2026-10-23")).toBe(new Date(2026, 9, 23).getTime());
  });
});
