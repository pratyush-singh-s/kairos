import { describe, expect, it } from "vitest";
import { planDayDate, planDayKind, planDayTasks } from "./board";

const step = (title: string, planDay: number | null, startTime: string | null = null) => ({
  title,
  planDay,
  startTime,
  durationMin: null,
  done: false,
  doneDate: null,
  dueDate: null,
  repeatDays: 0,
});

describe("day-by-day plans", () => {
  it("turns plan days into dates from the start date", () => {
    expect(planDayDate("2026-10-30", 1)).toBe("2026-10-30");
    expect(planDayDate("2026-10-30", 3)).toBe("2026-11-01");
    expect(planDayDate(null, 3)).toBeNull();
  });

  it("knows which days are gone, today and to come", () => {
    expect(planDayKind("2026-10-22", 1, "2026-10-23")).toBe("past");
    expect(planDayKind("2026-10-22", 2, "2026-10-23")).toBe("today");
    expect(planDayKind("2026-10-22", 3, "2026-10-23")).toBe("future");
    expect(planDayKind(null, 1, "2026-10-23")).toBeNull();
  });

  it("puts each step on its day, timed steps first", () => {
    const steps = [step("debug", 2), step("write code", 1), step("standup", 2, "09:00"), step("someday", null)];
    expect(planDayTasks(steps, 2).map((s) => s.title)).toEqual(["standup", "debug"]);
    expect(planDayTasks(steps, 1).map((s) => s.title)).toEqual(["write code"]);
    expect(planDayTasks(steps, null).map((s) => s.title)).toEqual(["someday"]);
  });
});
