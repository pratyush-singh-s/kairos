import { describe, expect, it } from "vitest";
import {
  bucketBounds,
  elapsedDays,
  focusByBucket,
  focusByHour,
  heatLevel,
  periodFor,
  shiftPeriod,
  streaks,
  summarize,
  type StatSession,
} from "./stats";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const session = (start: number, minutes: number, outcome = "completed", spanMinutes = minutes): StatSession => ({
  startedAt: start,
  endedAt: start + spanMinutes * 60_000,
  actualS: minutes * 60,
  outcome,
});

describe("periods", () => {
  it("a week starts on Monday by default", () => {
    // Thursday 23 Oct 2026.
    const p = periodFor("week", new Date(2026, 9, 23));
    expect(p.buckets.map((b) => b.key)).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ]);
    expect(periodFor("week", new Date(2026, 9, 23), 0).buckets[0]!.key).toBe("2026-10-18");
  });

  it("months and years have the right buckets", () => {
    expect(periodFor("month", new Date(2026, 1, 10)).buckets).toHaveLength(28);
    const y = periodFor("year", new Date(2026, 5, 1));
    expect(y.buckets.map((b) => b.key)[11]).toBe("2026-12");
    expect(y.endMs).toBe(at(2027, 1, 1));
    expect(bucketBounds(y)).toHaveLength(13);
  });

  it("shifts back and forward", () => {
    const w = periodFor("week", new Date(2026, 9, 23));
    expect(shiftPeriod(w, -1).buckets[0]!.key).toBe("2026-10-12");
    expect(shiftPeriod(periodFor("month", new Date(2026, 0, 31)), 1).buckets[0]!.key).toBe("2026-02-01");
    expect(shiftPeriod(periodFor("year", new Date(2026, 0, 1)), -1).buckets[0]!.key).toBe("2025-01");
  });

  it("counts elapsed days up to today only", () => {
    const w = periodFor("week", new Date(2026, 9, 23));
    expect(elapsedDays(w, at(2026, 10, 23, 15))).toBe(5);
    expect(elapsedDays(w, at(2026, 11, 2))).toBe(7);
    expect(elapsedDays(w, at(2026, 10, 1))).toBe(0);
    // Started using Focus on Wednesday.
    expect(elapsedDays(w, at(2026, 10, 23, 15), at(2026, 10, 21, 9))).toBe(3);
    expect(elapsedDays(w, at(2026, 10, 23, 15), at(2026, 11, 1))).toBe(0);
  });
});

describe("totals", () => {
  const week = periodFor("week", new Date(2026, 9, 23));
  const sessions = [
    session(at(2026, 10, 19, 9), 25),
    session(at(2026, 10, 19, 10), 25),
    session(at(2026, 10, 21, 20), 10, "interrupted"),
    session(at(2026, 10, 23, 8), 50),
  ];

  it("adds focus per day by start time", () => {
    const by = focusByBucket(sessions, week.buckets);
    expect(by[0]).toEqual({ seconds: 3000, completed: 2 });
    expect(by[2]).toEqual({ seconds: 600, completed: 0 });
    expect(by[4]).toEqual({ seconds: 3000, completed: 1 });
  });

  it("summarizes the period", () => {
    const s = summarize(sessions, week, at(2026, 10, 23, 12));
    expect(s.focusSeconds).toBe(6600);
    expect([s.completed, s.stopped]).toEqual([3, 1]);
    expect(s.completionRate).toBe(0.75);
    expect(s.dailyAverage).toBe(1320);
    expect(s.averageSession).toBe(1650);
    expect(s.best).toEqual({ key: "2026-10-19", seconds: 3000 });
    expect(summarize([], week, at(2026, 10, 23)).completionRate).toBeNull();
  });
});

describe("when you focus", () => {
  it("spreads a session over the hours it covers, pauses included", () => {
    // Monday 9:30 to 10:30, 40 minutes of focus.
    const grid = focusByHour([session(at(2026, 10, 19, 9, 30), 40, "completed", 60)]);
    expect(grid[0]![9]).toBe(1200);
    expect(grid[0]![10]).toBe(1200);
    expect(grid[1]!.every((v) => v === 0)).toBe(true);
  });

  it("levels are relative to the busiest hour", () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(1, 100)).toBe(1);
    expect(heatLevel(60, 100)).toBe(3);
    expect(heatLevel(100, 100)).toBe(4);
  });
});

describe("streaks", () => {
  it("counts days in a row and keeps today open", () => {
    const starts = [at(2026, 10, 1, 9), at(2026, 10, 2, 9), at(2026, 10, 3, 9), at(2026, 10, 20, 9), at(2026, 10, 21, 9), at(2026, 10, 22, 22)];
    expect(streaks(starts, at(2026, 10, 23, 8))).toEqual({ current: 3, best: 3 });
    expect(streaks([...starts, at(2026, 10, 23, 9)], at(2026, 10, 23, 12))).toEqual({ current: 4, best: 4 });
    expect(streaks(starts, at(2026, 10, 25))).toEqual({ current: 0, best: 3 });
    expect(streaks([], at(2026, 10, 25))).toEqual({ current: 0, best: 0 });
  });
});
