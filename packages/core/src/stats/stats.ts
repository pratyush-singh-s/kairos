/**
 * Statistics (Phase 20): periods, per-day totals, the "when you focus" grid and streaks.
 * Everything works in the computer's local time; inputs are UTC milliseconds from the database.
 */
import { isoDate } from "../day/localDay";

export type PeriodKind = "week" | "month" | "year";

export interface Bucket {
  /** YYYY-MM-DD (a day) or YYYY-MM (a month in the year view). */
  key: string;
  startMs: number;
  endMs: number;
}

export interface Period {
  kind: PeriodKind;
  startMs: number;
  endMs: number;
  buckets: Bucket[];
}

/** Mirrors `StatSession` in crates/focus-store/src/stats.rs. */
export interface StatSession {
  startedAt: number;
  endedAt: number;
  actualS: number;
  outcome: string;
  /** Timed on this PC, not synced from the phone or another PC. */
  here?: boolean;
}

/** The week (from `weekStartsOn`, 0 = Sunday), month or year that contains `anchor`. */
export function periodFor(kind: PeriodKind, anchor: Date, weekStartsOn = 1): Period {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  let first: Date;
  let count: number;
  if (kind === "week") {
    const back = (anchor.getDay() - weekStartsOn + 7) % 7;
    first = new Date(y, m, anchor.getDate() - back);
    count = 7;
  } else if (kind === "month") {
    first = new Date(y, m, 1);
    count = new Date(y, m + 1, 0).getDate();
  } else {
    first = new Date(y, 0, 1);
    count = 12;
  }
  const edge = (i: number) =>
    kind === "year" ? new Date(y, i, 1) : new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
  const buckets: Bucket[] = [];
  for (let i = 0; i < count; i++) {
    const start = edge(i);
    buckets.push({
      key: kind === "year" ? isoDate(start).slice(0, 7) : isoDate(start),
      startMs: start.getTime(),
      endMs: edge(i + 1).getTime(),
    });
  }
  return { kind, startMs: buckets[0]!.startMs, endMs: buckets[buckets.length - 1]!.endMs, buckets };
}

/** The period before (-1) or after (+1) this one. */
export function shiftPeriod(p: Period, by: number, weekStartsOn = 1): Period {
  const start = new Date(p.startMs);
  const anchor =
    p.kind === "week"
      ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7 * by)
      : p.kind === "month"
        ? new Date(start.getFullYear(), start.getMonth() + by, 1)
        : new Date(start.getFullYear() + by, 0, 1);
  return periodFor(p.kind, anchor, weekStartsOn);
}

/** The bucket edges the app needs: each bucket's start, then the last one's end. */
export function bucketBounds(p: Period): number[] {
  return [...p.buckets.map((b) => b.startMs), p.endMs];
}

export interface BucketFocus {
  seconds: number;
  completed: number;
}

/** Focus seconds and completed sessions per bucket, by when each session started. */
export function focusByBucket(sessions: StatSession[], buckets: Bucket[]): BucketFocus[] {
  const out = buckets.map(() => ({ seconds: 0, completed: 0 }));
  for (const s of sessions) {
    const i = buckets.findIndex((b) => s.startedAt >= b.startMs && s.startedAt < b.endMs);
    if (i < 0) continue;
    out[i]!.seconds += s.actualS;
    if (s.outcome === "completed") out[i]!.completed += 1;
  }
  return out;
}

export interface Summary {
  focusSeconds: number;
  completed: number;
  /** Stopped early with Stop. */
  stopped: number;
  /** Share of sessions that ran to the end, 0..1, or null with no sessions. */
  completionRate: number | null;
  /** Average focus per day, counting the days of the period up to today, from your first session on. */
  dailyAverage: number;
  /** Average length of one session in seconds, or 0. */
  averageSession: number;
  /** The bucket with the most focus, or null when there was none. */
  best: { key: string; seconds: number } | null;
}

/** `firstEverMs`: your first known session, so days before you used Focus don't lower the average. */
export function summarize(sessions: StatSession[], period: Period, now: number, firstEverMs?: number): Summary {
  const focusSeconds = sessions.reduce((n, s) => n + s.actualS, 0);
  const completed = sessions.filter((s) => s.outcome === "completed").length;
  const stopped = sessions.filter((s) => s.outcome === "interrupted").length;
  const ended = completed + stopped;
  const days = elapsedDays(period, now, firstEverMs);
  const perBucket = focusByBucket(sessions, period.buckets);
  let best: Summary["best"] = null;
  perBucket.forEach((b, i) => {
    if (b.seconds > 0 && (!best || b.seconds > best.seconds)) best = { key: period.buckets[i]!.key, seconds: b.seconds };
  });
  return {
    focusSeconds,
    completed,
    stopped,
    completionRate: ended > 0 ? completed / ended : null,
    dailyAverage: days > 0 ? Math.round(focusSeconds / days) : 0,
    averageSession: sessions.length > 0 ? Math.round(focusSeconds / sessions.length) : 0,
    best,
  };
}

/** Days of the period that have begun by `now` (all of them for a past period, none for a future one), from `fromMs` if later. */
export function elapsedDays(p: Period, now: number, fromMs?: number): number {
  const from = Math.max(p.startMs, fromMs ?? p.startMs);
  if (now < from || from >= p.endMs) return 0;
  const start = new Date(from);
  const end = new Date(Math.min(now, p.endMs - 1));
  const a = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const b = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Focus seconds by weekday (rows, starting at `weekStartsOn`) and hour (24 columns). A session's
 * focus time is spread evenly over the time from its start to its end.
 */
export function focusByHour(sessions: StatSession[], weekStartsOn = 1): number[][] {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const s of sessions) {
    const span = s.endedAt - s.startedAt;
    if (span <= 0 || s.actualS <= 0) continue;
    const rate = s.actualS / span;
    let t = s.startedAt;
    while (t < s.endedAt) {
      const d = new Date(t);
      const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
      const until = Math.min(nextHour, s.endedAt);
      const row = (d.getDay() - weekStartsOn + 7) % 7;
      grid[row]![d.getHours()]! += (until - t) * rate;
      t = until;
    }
  }
  return grid.map((r) => r.map((v) => Math.round(v)));
}

/** 0 (none) to 4 (most), relative to the busiest cell. */
export function heatLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as 1 | 2 | 3 | 4;
}

export interface Streaks {
  /** Days in a row with a completed session, up to today (today may still be empty). */
  current: number;
  best: number;
}

/** Streaks from the start times of completed sessions. */
export function streaks(focusStarts: number[], now: number): Streaks {
  const days = new Set(focusStarts.map((t) => isoDate(new Date(t))));
  const sorted = [...days].sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    run = prev !== null && nextDay(prev) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  const today = new Date(now);
  let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // Today not done yet doesn't break the streak.
  if (!days.has(isoDate(cursor))) cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1);
  let current = 0;
  while (days.has(isoDate(cursor))) {
    current++;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1);
  }
  return { current, best };
}

function nextDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return isoDate(new Date(y, m - 1, d + 1));
}
