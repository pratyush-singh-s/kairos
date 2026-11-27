/**
 * To-do helpers shared by the To-do page and the dashboard: grouping tasks into sections and
 * describing due dates and repeat days in words. Dates are local `YYYY-MM-DD` strings.
 */

/** The fields these helpers need; `Task` in the desktop app has more. */
export interface TaskLike {
  done: boolean;
  doneDate: string | null;
  dueDate: string | null;
  repeatDays: number;
}

/** Weekday bits, Sunday = 1 ... Saturday = 64 (matches crates/focus-store/src/tasks.rs). */
export const EVERY_DAY = 127;
export const WEEKDAYS = 0b0111110;
export const WEEKENDS = 0b1000001;

/** Monday-first order for pickers: [bit index, short name]. */
export const WEEK_ORDER: [number, string][] = [
  [1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"],
];

/** A local date string as a Date at local noon (noon keeps clock changes from shifting the day). */
export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 12);
}

export function addDays(iso: string, days: number): string {
  const d = parseIsoDate(iso);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function repeatsOn(task: Pick<TaskLike, "repeatDays">, iso: string): boolean {
  return (task.repeatDays & (1 << parseIsoDate(iso).getDay())) !== 0;
}

export interface TaskSections<T> {
  /** Open and overdue, due today, undated, repeating today, and anything ticked today. Open first. */
  today: T[];
  /** Dated after today, and repeating tasks that are not due today; soonest first. */
  upcoming: T[];
  /** One-off tasks ticked before today. */
  done: T[];
}

/**
 * Splits the full list into the page's sections, keeping the given order inside each
 * (the backend already sorts by priority). Mirrors `tasks::for_day` for "today".
 */
export function groupTasks<T extends TaskLike>(tasks: T[], today: string): TaskSections<T> {
  const sections: TaskSections<T> = { today: [], upcoming: [], done: [] };
  for (const t of tasks) {
    if (t.repeatDays > 0) {
      (repeatsOn(t, today) ? sections.today : sections.upcoming).push(t);
    } else if (t.done) {
      (t.doneDate === today ? sections.today : sections.done).push(t);
    } else if (t.dueDate === null || t.dueDate <= today) {
      sections.today.push(t);
    } else {
      sections.upcoming.push(t);
    }
  }
  // Stable sorts: ticked items sink to the bottom of today; upcoming by next date.
  sections.today.sort((a, b) => Number(a.done) - Number(b.done));
  sections.upcoming.sort((a, b) => nextDate(a, today).localeCompare(nextDate(b, today)));
  sections.done.sort((a, b) => (b.doneDate ?? "").localeCompare(a.doneDate ?? ""));
  return sections;
}

/** The next date a task is due after or on `today` (for repeating tasks, the next repeat day after today). */
export function nextDate(task: TaskLike, today: string): string {
  if (task.repeatDays > 0) {
    for (let i = 1; i <= 7; i++) {
      const d = addDays(today, i);
      if (repeatsOn(task, d)) return d;
    }
  }
  return task.dueDate ?? today;
}

/** "Every day", "Weekdays", "Weekends", or the days such as "Mon, Wed, Fri". Empty for one-off tasks. */
export function repeatLabel(repeatDays: number): string {
  if (repeatDays === 0) return "";
  if (repeatDays === EVERY_DAY) return "Every day";
  if (repeatDays === WEEKDAYS) return "Weekdays";
  if (repeatDays === WEEKENDS) return "Weekends";
  return WEEK_ORDER.filter(([bit]) => repeatDays & (1 << bit)).map(([, name]) => name).join(", ");
}

const weekdayName = new Intl.DateTimeFormat("en-GB", { weekday: "long" });
const shortDate = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });

export interface DueLabel {
  text: string;
  overdue: boolean;
}

/** "Today", "Tomorrow", "Yesterday", "Friday" (within a week), or "Sat 31 Oct". */
export function dueLabel(dueDate: string, today: string): DueLabel {
  const overdue = dueDate < today;
  if (dueDate === today) return { text: "Today", overdue };
  if (dueDate === addDays(today, 1)) return { text: "Tomorrow", overdue };
  if (dueDate === addDays(today, -1)) return { text: "Yesterday", overdue };
  const date = parseIsoDate(dueDate);
  if (!overdue && dueDate <= addDays(today, 6)) return { text: weekdayName.format(date), overdue };
  return { text: shortDate.format(date), overdue };
}
