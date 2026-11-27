/** Week-board helpers for the To-do page: which days to show and which cards go in each. */

import { addDays, parseIsoDate, repeatsOn, type TaskLike } from "./tasks";

export interface BoardTaskLike extends TaskLike {
  startTime: string | null;
  durationMin: number | null;
}

/** The 7 dates of the week holding `iso`, starting on `weekStart` (0 = Sunday, 1 = Monday). */
export function weekOf(iso: string, weekStart = 1): string[] {
  const back = (parseIsoDate(iso).getDay() - weekStart + 7) % 7;
  const first = addDays(iso, -back);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/**
 * Cards for one day column: one-off tasks due that day, repeating tasks on their weekdays.
 * Open tasks from earlier days roll over into today's column (marked overdue) instead of staying
 * on their old day. Timed cards first by time, then the rest.
 */
export function tasksForDay<T extends BoardTaskLike>(tasks: T[], day: string, today: string): T[] {
  const list = tasks.filter((t) => {
    if (t.repeatDays > 0) return repeatsOn(t, day);
    const rolledOver = !t.done && t.dueDate !== null && t.dueDate < today;
    if (rolledOver) return day === today;
    return t.dueDate === day;
  });
  return list.sort((a, b) => (a.startTime ?? "99") .localeCompare(b.startTime ?? "99"));
}

/** Is a repeating task ticked on this particular day? (Only the last tick is known.) */
export function doneOn(t: TaskLike, day: string): boolean {
  return t.repeatDays > 0 ? t.doneDate === day : t.done;
}

/** Undated one-off tasks: the "No date" list under the board. Open ones first. */
export function undatedTasks<T extends TaskLike>(tasks: T[]): T[] {
  return tasks.filter((t) => t.repeatDays === 0 && t.dueDate === null).sort((a, b) => Number(a.done) - Number(b.done));
}

/** Planned length as on the cards: 30 → "0:30h", 90 → "1:30h". */
export function formatLength(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}h`;
}

/** A column's total, as in its header: 450 → "7h 30m", 60 → "1h", 0 → "". */
export function formatTotal(min: number): string {
  if (min <= 0) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

/** Minutes between two "HH:MM" times; an end at or before the start is on the next day (23:00 → 00:30 = 90). */
export function minutesBetween(start: string, end: string): number {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const diff = toMin(end) - toMin(start);
  return diff > 0 ? diff : diff + 1440;
}

/** "13:00" → "1 PM", "09:30" → "9:30 AM", "00:00" → "12 AM". */
export function formatClock(time: string): string {
  const h = Number(time.slice(0, 2));
  const m = time.slice(3, 5);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m === "00" ? "" : `:${m}`} ${h < 12 ? "AM" : "PM"}`;
}

/** A moment as a time of day in the same style as task times: "9:30 AM", "1 PM". */
export function timeOfDay(at: number | Date): string {
  const d = new Date(at);
  return formatClock(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
}

/** A task's time on its card: "3 PM", or "3 PM – 4:30 PM". */
export function formatTimeRange(start: string, end: string | null): string {
  return end ? `${formatClock(start)} – ${formatClock(end)}` : formatClock(start);
}

/** A likely AM/PM slip in a task's times, with the times that fix it. */
export interface TimeHint {
  message: string;
  fix: { startTime: string; endTime: string | null };
}

/** "15:00" + 12 hours → "03:00". */
function flipHalf(time: string): string {
  return `${String((Number(time.slice(0, 2)) + 12) % 24).padStart(2, "0")}${time.slice(2)}`;
}

/**
 * Spot times that are probably on the wrong side of noon: a start at night (12 AM to 5:59 AM),
 * or a range longer than 12 hours (10 AM – 11 PM). Only a hint; such times are still allowed.
 */
export function timeHint(start: string, end: string | null): TimeHint | null {
  if (!start) return null;
  const h = Number(start.slice(0, 2));
  if (h < 6) {
    const startTime = flipHalf(start);
    const endTime = end && minutesBetween(startTime, end) > 720 ? flipHalf(end) : end;
    const what = h === 0 ? `${formatClock(start)} is midnight` : `${formatClock(start)} is at night`;
    return { message: `${what}. Did you mean ${formatClock(startTime)}?`, fix: { startTime, endTime } };
  }
  if (end && end !== start && minutesBetween(start, end) > 720) {
    const endTime = flipHalf(end);
    return {
      message: `${formatTimeRange(start, end)} is ${formatTotal(minutesBetween(start, end))} long. Did you mean ${formatClock(start)} – ${formatClock(endTime)}?`,
      fix: { startTime: start, endTime },
    };
  }
  return null;
}

export interface PlanTaskLike extends BoardTaskLike {
  planDay: number | null;
}

/** A plan step's place in time: its day has passed, is today, or is still to come (null = plan not dated). */
export type PlanDayKind = "past" | "today" | "future";

/** The date of a plan's day (1 = the start date), or null when the plan has no start date. */
export function planDayDate(startDate: string | null, day: number): string | null {
  return startDate ? addDays(startDate, day - 1) : null;
}

export function planDayKind(startDate: string | null, day: number, today: string): PlanDayKind | null {
  const date = planDayDate(startDate, day);
  if (date === null) return null;
  return date < today ? "past" : date === today ? "today" : "future";
}

/** Steps on one day of a plan (null = "No day yet"): timed ones first by time, then in order. */
export function planDayTasks<T extends PlanTaskLike>(tasks: T[], day: number | null): T[] {
  return tasks
    .filter((t) => t.planDay === day)
    .sort((a, b) => (a.startTime ?? "99").localeCompare(b.startTime ?? "99"));
}
