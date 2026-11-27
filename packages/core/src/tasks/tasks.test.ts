import { describe, expect, it } from "vitest";
import { EVERY_DAY, WEEKDAYS, addDays, dueLabel, groupTasks, nextDate, repeatLabel, type TaskLike } from "./tasks";

// 2026-10-23 is a Friday.
const FRI = "2026-10-23";

function task(title: string, over: Partial<TaskLike> = {}): TaskLike & { title: string } {
  return { title, done: false, doneDate: null, dueDate: null, repeatDays: 0, ...over };
}

const titles = (list: { title: string }[]) => list.map((t) => t.title);

describe("groupTasks", () => {
  it("puts each task in the right section", () => {
    const s = groupTasks(
      [
        task("ticked today", { done: true, doneDate: FRI }),
        task("shop"),
        task("essay", { dueDate: "2026-10-20" }),
        task("call", { dueDate: FRI }),
        task("dentist", { dueDate: "2026-10-30" }),
        task("tomorrow", { dueDate: "2026-10-24" }),
        task("gym", { repeatDays: EVERY_DAY, done: true, doneDate: FRI }),
        task("work out", { repeatDays: WEEKDAYS & ~(1 << 5) }), // Mon-Thu: not today
        task("old", { done: true, doneDate: "2026-10-01" }),
        task("older", { done: true, doneDate: "2026-09-01" }),
      ],
      FRI,
    );
    expect(titles(s.today)).toEqual(["shop", "essay", "call", "ticked today", "gym"]);
    expect(titles(s.upcoming)).toEqual(["tomorrow", "work out", "dentist"]);
    expect(titles(s.done)).toEqual(["old", "older"]);
  });
});

describe("nextDate", () => {
  it("finds the next repeat day after today", () => {
    expect(nextDate(task("mon", { repeatDays: 1 << 1 }), FRI)).toBe("2026-10-26");
    expect(nextDate(task("fri", { repeatDays: 1 << 5 }), FRI)).toBe("2026-10-30");
  });
});

describe("labels", () => {
  it("names repeat days", () => {
    expect(repeatLabel(0)).toBe("");
    expect(repeatLabel(EVERY_DAY)).toBe("Every day");
    expect(repeatLabel(WEEKDAYS)).toBe("Weekdays");
    expect(repeatLabel((1 << 1) | (1 << 3) | (1 << 5))).toBe("Mon, Wed, Fri");
    expect(repeatLabel((1 << 0) | (1 << 1))).toBe("Mon, Sun");
  });

  it("describes due dates in words", () => {
    expect(dueLabel(FRI, FRI)).toEqual({ text: "Today", overdue: false });
    expect(dueLabel("2026-10-24", FRI).text).toBe("Tomorrow");
    expect(dueLabel("2026-10-22", FRI)).toEqual({ text: "Yesterday", overdue: true });
    expect(dueLabel("2026-10-28", FRI).text).toBe("Wednesday");
    expect(dueLabel("2026-10-31", FRI).text).toBe("Sat 31 Oct");
    expect(dueLabel("2026-10-01", FRI)).toEqual({ text: "Thu 1 Oct", overdue: true });
  });

  it("adds days across month ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });
});
