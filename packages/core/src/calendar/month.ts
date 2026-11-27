/** Calendar-page helpers: the days of a month view and which events fall on which day. */

import { isoDate } from "../day/localDay";
import { addDays, parseIsoDate } from "../tasks/tasks";
import { timeOfDay } from "../tasks/board";

/** What the month view needs to know about an event. Times are UTC ms, dates local. */
export interface CalendarEventLike {
  allDay: boolean;
  startAt: number | null;
  endAt: number | null;
  startDate: string | null;
  /** Exclusive, as Google sends it. */
  endDate: string | null;
  summary: string;
}

/**
 * The days shown for a month: whole weeks from the one holding the 1st to the one holding the
 * last day, starting on `weekStart` (0 = Sunday, 1 = Monday, 6 = Saturday). `month` is 0-11.
 */
export function monthGrid(year: number, month: number, weekStart = 1): string[] {
  const first = isoDate(new Date(year, month, 1));
  const last = isoDate(new Date(year, month + 1, 0));
  const back = (parseIsoDate(first).getDay() - weekStart + 7) % 7;
  const days: string[] = [];
  for (let d = addDays(first, -back); days.length % 7 !== 0 || d <= last; d = addDays(d, 1)) days.push(d);
  return days;
}

/** The local days an event is on (a timed event ending at midnight is not on the next day). */
export function eventDays(e: CalendarEventLike): string[] {
  let first: string;
  let last: string;
  if (e.allDay) {
    if (!e.startDate) return [];
    first = e.startDate;
    last = e.endDate && e.endDate > first ? addDays(e.endDate, -1) : first;
  } else {
    if (e.startAt === null) return [];
    const end = e.endAt !== null && e.endAt > e.startAt ? e.endAt - 1 : e.startAt;
    first = isoDate(new Date(e.startAt));
    last = isoDate(new Date(end));
  }
  const days: string[] = [];
  // At most a year of days, so a broken event cannot hang the page.
  for (let d = first; d <= last && days.length < 366; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Events per day for the given days: all-day ones first, then by start time, then by name. */
export function eventsByDay<T extends CalendarEventLike>(events: T[], days: string[]): Map<string, T[]> {
  const map = new Map<string, T[]>(days.map((d) => [d, []]));
  for (const e of events) for (const d of eventDays(e)) map.get(d)?.push(e);
  for (const list of map.values())
    list.sort(
      (a, b) =>
        Number(b.allDay) - Number(a.allDay) ||
        (a.startAt ?? 0) - (b.startAt ?? 0) ||
        (a.startDate ?? "").localeCompare(b.startDate ?? "") ||
        a.summary.localeCompare(b.summary),
    );
  return map;
}


/** "All day", "10 AM–11:30 AM", or for an event over several days "From 10 PM" / "Until 9 AM". */
export function eventTimeLabel(e: CalendarEventLike, day: string): string {
  if (e.allDay || e.startAt === null) return "All day";
  const days = eventDays(e);
  const start = timeOfDay(e.startAt);
  const end = timeOfDay(e.endAt ?? e.startAt);
  if (days.length <= 1) return e.endAt !== null && e.endAt > e.startAt ? `${start}–${end}` : start;
  if (day === days[0]) return `From ${start}`;
  if (day === days[days.length - 1]) return `Until ${end}`;
  return "All day";
}

/** Local midnight at the start of a "YYYY-MM-DD" day, as UTC ms. */
export function dayStartMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}
