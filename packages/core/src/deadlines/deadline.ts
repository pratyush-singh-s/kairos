/**
 * Everything both themes draw for a deadline, from one pure function: its state, how much time
 * is left (the ring), the countdown words and the day-grid cells. `now` is a parameter so tests
 * can freeze time; the UI calls it again on each tick. Calendar days use this computer's time zone.
 */

import { isoDate } from "../day/localDay";
import { timeOfDay } from "../tasks/board";

export interface DeadlineLike {
  /** UTC milliseconds. */
  startAt: number;
  dueAt: number;
  completedAt: number | null;
  /** 0-based day numbers (from the start day) the user marked done. */
  markedDays: number[];
}

export type DeadlineState = "completed" | "overdue" | "today" | "urgent" | "active" | "upcoming";

export interface DayCell {
  /** 0-based from the start day; what `markedDays` stores. For week cells, the week's first day. */
  dayIndex: number;
  /** Local date YYYY-MM-DD (the first day, for week cells). */
  date: string;
  kind: "past" | "today" | "future";
  markedDone: boolean;
  isStartDay: boolean;
  isDueDay: boolean;
}

export interface DeadlineView {
  state: DeadlineState;
  /** Share of the period still left, 0–1 (1 before the start, 0 when overdue). The ring's length. */
  fraction: number;
  /** Milliseconds until due (negative when overdue). */
  remainingMs: number;
  /** "8 days left", "4 days 12 hours", "31 hours left", "42 minutes left", "37 seconds", "Overdue 2 hours". */
  countdown: string;
  /** The same, short: "8d", "4d 12h", "31h", "42m", "37s" (with a minus sign when overdue). */
  short: string;
  /** "Done", "Overdue by 2 h", "Due today 17:00", "Urgent", "In progress", "Starts 30 Oct". */
  label: string;
  /** One cell per day, or per week (`byWeek`) when the period is longer than a year (366 days). */
  cells: DayCell[];
  byWeek: boolean;
  /** How often the countdown needs redrawing. */
  refreshMs: number;
}

/** Urgent when less than this is left... */
export const URGENT_MS = 48 * 3_600_000;
/** ...or less than this share of the whole period. */
export const URGENT_FRACTION = 0.15;
const MAX_DAY_CELLS = 366;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Countdown words for a span of time, rounded down. */
export function countdownWords(ms: number): { long: string; short: string } {
  const d = Math.floor(ms / DAY);
  const h = Math.floor(ms / HOUR);
  const m = Math.floor(ms / MIN);
  if (ms >= 7 * DAY) return { long: plural(d, "day"), short: `${d}d` };
  if (ms >= 2 * DAY) return { long: `${plural(d, "day")} ${plural(h - d * 24, "hour")}`, short: `${d}d ${h - d * 24}h` };
  if (ms >= HOUR) return { long: plural(h, "hour"), short: `${h}h` };
  if (ms >= MIN) return { long: plural(m, "minute"), short: `${m}m` };
  const s = Math.max(0, Math.floor(ms / 1000));
  return { long: plural(s, "second"), short: `${s}s` };
}

const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** Local noon of the day `ms` falls on (noon keeps clock changes from shifting the day). */
function noonOf(ms: number): Date {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
}

export function computeDeadline(d: DeadlineLike, now: number): DeadlineView {
  const total = d.dueAt - d.startAt;
  const remainingMs = d.dueAt - now;
  const started = now >= d.startAt;
  const fraction = !started ? 1 : Math.min(1, Math.max(0, remainingMs / total));
  const today = isoDate(new Date(now));
  const dueDay = isoDate(new Date(d.dueAt));

  let state: DeadlineState;
  if (d.completedAt !== null) state = "completed";
  else if (now > d.dueAt) state = "overdue";
  else if (dueDay === today) state = "today";
  else if (started && (remainingMs < URGENT_MS || fraction < URGENT_FRACTION)) state = "urgent";
  else if (started) state = "active";
  else state = "upcoming";

  const words = countdownWords(Math.abs(remainingMs));
  let countdown: string;
  let short = words.short;
  let label: string;
  switch (state) {
    case "completed":
      countdown = "Done";
      label = "Done";
      break;
    case "overdue":
      countdown = `Overdue ${words.long}`;
      short = `-${words.short}`;
      label = `Overdue by ${words.short}`;
      break;
    case "upcoming": {
      const until = countdownWords(d.startAt - now);
      countdown = `Starts in ${until.long}`;
      label = `Starts ${dayMonth.format(new Date(d.startAt))}`;
      break;
    }
    default:
      countdown = remainingMs >= 2 * DAY && remainingMs < 7 * DAY ? words.long : remainingMs < MIN ? words.long : `${words.long} left`;
      label = state === "today" ? `Due today ${timeOfDay(d.dueAt)}` : state === "urgent" ? "Urgent" : "In progress";
  }

  const live = state !== "completed" && state !== "overdue";
  const refreshMs = live && remainingMs < MIN ? 1000 : live && remainingMs < HOUR ? 10_000 : 60_000;
  const { cells, byWeek } = dayCells(d, today);
  return { state, fraction, remainingMs, countdown, short, label, cells, byWeek, refreshMs };
}

function dayCells(d: DeadlineLike, today: string): { cells: DayCell[]; byWeek: boolean } {
  const first = noonOf(d.startAt);
  const last = isoDate(new Date(d.dueAt));
  const start = isoDate(first);
  const days: string[] = [];
  for (const cur = new Date(first); isoDate(cur) <= last; cur.setDate(cur.getDate() + 1)) {
    days.push(isoDate(cur));
  }
  const marked = new Set(d.markedDays);
  const kind = (from: string, to: string): DayCell["kind"] => (to < today ? "past" : from > today ? "future" : "today");
  if (days.length <= MAX_DAY_CELLS) {
    return {
      byWeek: false,
      cells: days.map((date, i) => ({
        dayIndex: i,
        date,
        kind: kind(date, date),
        markedDone: marked.has(i),
        isStartDay: date === start,
        isDueDay: date === last,
      })),
    };
  }
  const cells: DayCell[] = [];
  for (let i = 0; i < days.length; i += 7) {
    const week = days.slice(i, i + 7);
    cells.push({
      dayIndex: i,
      date: week[0]!,
      kind: kind(week[0]!, week[week.length - 1]!),
      markedDone: week.every((_, j) => marked.has(i + j)),
      isStartDay: i === 0,
      isDueDay: week.includes(last),
    });
  }
  return { byWeek: true, cells };
}
