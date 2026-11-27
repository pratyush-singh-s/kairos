/**
 * Local-calendar helpers. They use the computer's time zone, so "today" means the user's today.
 */

export interface LocalDay {
  /** Local midnight at the start of the day, as UTC milliseconds. */
  startMs: number;
  /** Local midnight at the start of the next day (exclusive). Usually 24 h later; 23 or 25 h on clock-change days. */
  endMs: number;
  /** Local date as YYYY-MM-DD. */
  isoDate: string;
}

export function localDay(at: Date): LocalDay {
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const end = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);
  return { startMs: start.getTime(), endMs: end.getTime(), isoDate: isoDate(start) };
}

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** "Good morning" 05:00-11:59, "Good afternoon" 12:00-16:59, "Good evening" otherwise. */
export function greeting(at: Date): string {
  const h = at.getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 17) return "Good afternoon";
  return "Good evening";
}
