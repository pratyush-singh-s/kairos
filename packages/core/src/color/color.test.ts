import { describe, expect, it } from "vitest";
import { hexToHsv, hsvToHex, normalizeHex } from "./color";

describe("colour helpers", () => {
  it("normalises hex input", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex(" 4F8CFF ")).toBe("#4f8cff");
    expect(normalizeHex("#12345")).toBeNull();
    expect(normalizeHex("red")).toBeNull();
  });

  it("converts between hex and the wheel's hue/saturation/brightness", () => {
    expect(hsvToHex({ h: 0, s: 1, v: 1 })).toBe("#ff0000");
    expect(hsvToHex({ h: 120, s: 1, v: 1 })).toBe("#00ff00");
    expect(hsvToHex({ h: 240, s: 1, v: 0.5 })).toBe("#000080");
    expect(hsvToHex({ h: 0, s: 0, v: 1 })).toBe("#ffffff");
    for (const hex of ["#4f8cff", "#e05a47", "#33aa77", "#808080", "#000000"]) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });
});
