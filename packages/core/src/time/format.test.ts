import { describe, expect, it } from "vitest";
import { formatAgo, formatBytes, formatClock, formatDurationShort } from "./format";

describe("formatClock", () => {
  it("formats minutes and seconds with padding", () => {
    expect(formatClock(25 * 60)).toBe("25:00");
    expect(formatClock(24 * 60 + 32)).toBe("24:32");
    expect(formatClock(4 * 60 + 7)).toBe("04:07");
  });

  it("adds hours when needed", () => {
    expect(formatClock(90 * 60)).toBe("1:30:00");
  });

  it("rounds down fractional seconds so it never shows more time than remains", () => {
    expect(formatClock(59.9)).toBe("00:59");
  });

  it("clamps negative and invalid input to zero", () => {
    expect(formatClock(-5)).toBe("00:00");
    expect(formatClock(Number.NaN)).toBe("00:00");
  });
});

describe("formatDurationShort", () => {
  it("uses the largest sensible units", () => {
    expect(formatDurationShort(2 * 3600 + 35 * 60)).toBe("2h 35m");
    expect(formatDurationShort(15 * 60 + 42)).toBe("15m 42s");
    expect(formatDurationShort(3 * 60 + 6)).toBe("3m 06s");
    expect(formatDurationShort(37)).toBe("37s");
  });

  it("drops zero parts", () => {
    expect(formatDurationShort(3600)).toBe("1h");
    expect(formatDurationShort(300)).toBe("5m");
    expect(formatDurationShort(0)).toBe("0s");
  });
});

describe("formatBytes", () => {
  it("picks a readable unit", () => {
    expect(formatBytes(820)).toBe("820 B");
    expect(formatBytes(14.2 * 1024)).toBe("14.2 KB");
    expect(formatBytes(3.1 * 1024 * 1024)).toBe("3.1 MB");
    expect(formatBytes(-1)).toBe("0 B");
  });
});

describe("formatAgo", () => {
  it("says how long ago in words", () => {
    const now = 1_000_000_000;
    expect(formatAgo(now - 10_000, now)).toBe("just now");
    expect(formatAgo(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(formatAgo(now - 26 * 3_600_000, now)).toBe("yesterday");
    expect(formatAgo(now - 72 * 3_600_000, now)).toBe("3 days ago");
  });
});
