import { describe, expect, it } from "vitest";
import { computeDeadline, countdownWords, type DeadlineLike } from "./deadline";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const make = (start: number, due: number, over: Partial<DeadlineLike> = {}): DeadlineLike => ({
  startAt: start,
  dueAt: due,
  completedAt: null,
  markedDays: [],
  ...over,
});

// The design's example: start 22 Oct 18:00, due 2 Nov 23:59.
const START = at(2026, 10, 22, 18);
const DUE = at(2026, 11, 2, 23, 59);

describe("computeDeadline", () => {
  it("matches the worked example: 12 day cells and the ring at 176°", () => {
    const v = computeDeadline(make(START, DUE, { markedDays: [0, 3] }), at(2026, 10, 28, 12));
    expect(v.state).toBe("active");
    expect(Math.round(v.fraction * 360)).toBe(176);
    expect(v.cells).toHaveLength(12);
    expect(v.cells[0]).toMatchObject({ date: "2026-10-22", kind: "past", markedDone: true, isStartDay: true });
    expect(v.cells[6]).toMatchObject({ date: "2026-10-28", kind: "today", markedDone: false });
    expect(v.cells[11]).toMatchObject({ date: "2026-11-02", kind: "future", isDueDay: true });
    expect(v.countdown).toBe("5 days 11 hours");
    expect(v.short).toBe("5d 11h");
  });

  it("goes through the states in order", () => {
    const d = make(START, DUE);
    expect(computeDeadline(d, at(2026, 10, 20)).state).toBe("upcoming");
    expect(computeDeadline(d, at(2026, 10, 20)).countdown).toBe("Starts in 2 days 18 hours");
    expect(computeDeadline(d, at(2026, 10, 23)).state).toBe("active");
    expect(computeDeadline(d, at(2026, 11, 1, 12)).state).toBe("urgent");
    const today = computeDeadline(d, at(2026, 11, 2, 9));
    expect([today.state, today.label]).toEqual(["today", "Due today 11:59 PM"]);
    const late = computeDeadline(d, at(2026, 11, 3, 2));
    expect([late.state, late.countdown, late.label, late.fraction]).toEqual(["overdue", "Overdue 2 hours", "Overdue by 2h", 0]);
    expect(computeDeadline({ ...d, completedAt: 1 }, at(2026, 11, 3)).state).toBe("completed");
  });

  it("is urgent with under 15% of a long period left", () => {
    const d = make(at(2026, 1, 1), at(2026, 3, 1));
    expect(computeDeadline(d, at(2026, 2, 22)).state).toBe("urgent");
  });

  it("shows one cell per day up to a year", () => {
    const v = computeDeadline(make(at(2026, 1, 1), at(2026, 12, 31)), at(2026, 3, 4));
    expect(v.byWeek).toBe(false);
    expect(v.cells).toHaveLength(365);
  });

  it("collapses periods longer than a year into weeks", () => {
    const v = computeDeadline(make(at(2026, 1, 1), at(2027, 6, 30)), at(2026, 3, 4));
    expect(v.byWeek).toBe(true);
    expect(v.cells).toHaveLength(78);
    expect(v.cells.filter((c) => c.kind === "today")).toHaveLength(1);
  });

  it("refreshes faster near the end", () => {
    const d = make(START, DUE);
    expect(computeDeadline(d, DUE - 30_000).refreshMs).toBe(1000);
    expect(computeDeadline(d, DUE - 30 * 60_000).refreshMs).toBe(10_000);
    expect(computeDeadline(d, START).refreshMs).toBe(60_000);
  });
});

describe("countdownWords", () => {
  it("uses the design's units, rounded down", () => {
    expect(countdownWords(8.9 * 86_400_000).long).toBe("8 days");
    expect(countdownWords(4.5 * 86_400_000).long).toBe("4 days 12 hours");
    expect(countdownWords(31.9 * 3_600_000).long).toBe("31 hours");
    expect(countdownWords(42.5 * 60_000).long).toBe("42 minutes");
    expect(countdownWords(37_900).long).toBe("37 seconds");
    expect(countdownWords(60_000).long).toBe("1 minute");
  });
});
