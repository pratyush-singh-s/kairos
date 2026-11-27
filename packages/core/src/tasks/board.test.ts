import { describe, expect, it } from "vitest";
import { doneOn, formatClock, formatLength, formatTimeRange, formatTotal, minutesBetween, timeHint, tasksForDay, undatedTasks, weekOf, type BoardTaskLike } from "./board";

const FRI = "2026-10-23";
const t = (title: string, over: Partial<BoardTaskLike> = {}): BoardTaskLike & { title: string } => ({
  title, done: false, doneDate: null, dueDate: null, repeatDays: 0, startTime: null, durationMin: null, ...over,
});
const titles = (l: { title: string }[]) => l.map((x) => x.title);

describe("week board", () => {
  it("shows Monday to Sunday by default", () => {
    expect(weekOf(FRI)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(weekOf(FRI, 0)[0]).toBe("2026-10-18");
    expect(weekOf("2026-10-19")[0]).toBe("2026-10-19");
  });

  it("puts each task in its day, timed ones first, and rolls open late ones into today", () => {
    const tasks = [
      t("gym", { repeatDays: 1 << 5 }),
      t("meeting", { dueDate: FRI, startTime: "09:30" }),
      t("lunch", { dueDate: FRI, startTime: "12:30" }),
      t("late", { dueDate: "2026-10-20" }),
      t("late but done", { dueDate: "2026-10-20", done: true }),
      t("someday"),
    ];
    expect(titles(tasksForDay(tasks, FRI, FRI))).toEqual(["meeting", "lunch", "gym", "late"]);
    expect(titles(tasksForDay(tasks, "2026-10-20", FRI))).toEqual(["late but done"]);
    expect(titles(tasksForDay(tasks, "2026-10-24", FRI))).toEqual([]);
    expect(titles(undatedTasks(tasks))).toEqual(["someday"]);
  });

  it("knows which day a repeating task was ticked", () => {
    const gym = t("gym", { repeatDays: 127, done: true, doneDate: FRI });
    expect(doneOn(gym, FRI)).toBe(true);
    expect(doneOn(gym, "2026-10-22")).toBe(false);
  });

  it("formats lengths like the cards", () => {
    expect(formatLength(30)).toBe("0:30h");
    expect(formatLength(90)).toBe("1:30h");
    expect(formatTotal(450)).toBe("7h 30m");
    expect(formatTotal(60)).toBe("1h");
    expect(formatTotal(0)).toBe("");
    expect(minutesBetween("10:00", "10:45")).toBe(45);
    expect(minutesBetween("23:00", "00:00")).toBe(60);
    expect(minutesBetween("22:30", "01:00")).toBe(150);
  });

  it("shows times the 12-hour way", () => {
    expect(formatClock("13:00")).toBe("1 PM");
    expect(formatClock("09:30")).toBe("9:30 AM");
    expect(formatClock("00:00")).toBe("12 AM");
    expect(formatClock("12:15")).toBe("12:15 PM");
    expect(formatTimeRange("13:00", null)).toBe("1 PM");
    expect(formatTimeRange("15:00", "16:00")).toBe("3 PM – 4 PM");
    expect(formatTimeRange("23:00", "00:30")).toBe("11 PM – 12:30 AM");
  });

  it("spots times on the wrong side of noon", () => {
    expect(timeHint("00:00", "13:00")).toEqual({ message: "12 AM is midnight. Did you mean 12 PM?", fix: { startTime: "12:00", endTime: "13:00" } });
    expect(timeHint("03:00", "04:00")).toEqual({ message: "3 AM is at night. Did you mean 3 PM?", fix: { startTime: "15:00", endTime: "16:00" } });
    expect(timeHint("03:30", null)?.fix).toEqual({ startTime: "15:30", endTime: null });
    expect(timeHint("10:00", "23:00")).toEqual({ message: "10 AM – 11 PM is 13h long. Did you mean 10 AM – 11 AM?", fix: { startTime: "10:00", endTime: "11:00" } });
    expect(timeHint("11:00", "00:00")?.fix).toEqual({ startTime: "11:00", endTime: "12:00" });
    expect(timeHint("16:00", "17:00")).toBeNull();
    expect(timeHint("23:00", "00:30")).toBeNull();
    expect(timeHint("", null)).toBeNull();
  });
});
