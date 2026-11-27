import { describe, expect, it } from "vitest";
import { greeting, isoDate, localDay } from "./localDay";

describe("localDay", () => {
  it("spans local midnight to the next local midnight", () => {
    const d = localDay(new Date(2026, 9, 22, 18, 30));
    expect(new Date(d.startMs)).toEqual(new Date(2026, 9, 22, 0, 0));
    expect(new Date(d.endMs)).toEqual(new Date(2026, 9, 23, 0, 0));
    expect(d.isoDate).toBe("2026-10-22");
  });

  it("handles month and year ends", () => {
    expect(localDay(new Date(2026, 11, 31, 23, 59)).isoDate).toBe("2026-12-31");
    expect(new Date(localDay(new Date(2026, 11, 31, 12)).endMs)).toEqual(new Date(2027, 0, 1));
  });
});

describe("isoDate", () => {
  it("pads month and day", () => {
    expect(isoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("greeting", () => {
  it("follows the time of day", () => {
    expect(greeting(new Date(2026, 9, 22, 4, 59))).toBe("Good evening");
    expect(greeting(new Date(2026, 9, 22, 5, 0))).toBe("Good morning");
    expect(greeting(new Date(2026, 9, 22, 12, 0))).toBe("Good afternoon");
    expect(greeting(new Date(2026, 9, 22, 17, 0))).toBe("Good evening");
  });
});
