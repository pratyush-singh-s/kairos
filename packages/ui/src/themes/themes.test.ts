import { describe, expect, it } from "vitest";
import { cssVariables } from "./apply";
import { contrastRatio, over, parseColor } from "./contrast";
import { THEMES } from "./index";
import { PALETTES, withPalette } from "./palettes";
import { CUSTOM_ID, customContrast } from "./custom";

/**
 * Backdrops a glass card can sit on: the app's own fallback background, and a dark and a
 * light-ish Mica tint (Focus requests dark Mica, but wallpaper colour bleeds through).
 */
const BACKDROPS = ["#0c1120", "#202020", "#3a3a3a"];

/** Custom colours someone might pick: dark, light and coloured backgrounds with readable text. */
const CUSTOMS = [
  { name: "dark teal", bg: "#0b1f24", text: "#e8f4f2", accent: "#4fd1c5" },
  { name: "light paper", bg: "#f6f1e7", text: "#2b2622", accent: "#9c4221" },
  { name: "navy gold", bg: "#101b3a", text: "#f2f2f2", accent: "#f2c14e" },
];

const ALL = [
  ...Object.values(THEMES).flatMap((t) => PALETTES[t.id].map((p) => ({ ...withPalette(t, p.id), label: `${t.label} ${p.label}` }))),
  // A light custom background is checked as drawn, without the dark Mica backdrop behind it.
  ...Object.values(THEMES).flatMap((t) =>
    CUSTOMS.map((c) => {
      const tokens = withPalette(t, CUSTOM_ID, c);
      return { ...tokens, material: { ...tokens.material, windowEffect: "none" as const }, label: `${t.label} custom ${c.name}` };
    }),
  ),
];

describe.each(ALL)("$label", (theme) => {
  const c = theme.colors;
  const backdrops = theme.material.windowEffect === "mica" ? BACKDROPS : [c.bg];

  function cardBackgrounds() {
    return backdrops.flatMap((b) => {
      const base = over(parseColor(theme.material.windowEffect === "mica" ? c.bgOverEffect : c.bg), parseColor(b));
      return [over(parseColor(c.surface), base), over(parseColor(c.surfaceRaised), base)];
    });
  }

  it("body text meets WCAG AA (4.5:1) on every card background", () => {
    for (const bg of cardBackgrounds()) {
      expect(contrastRatio(parseColor(c.text), bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(parseColor(c.textMuted), bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("accent, figures and status colours meet 3:1 for large text and icons", () => {
    for (const bg of cardBackgrounds()) {
      for (const color of [c.accent, c.number, c.ok, c.failed, c.pending, c.focusRing]) {
        expect(contrastRatio(parseColor(color), bg)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("text on status badges is readable", () => {
    for (const s of [c.ok, c.failed, c.pending]) {
      expect(contrastRatio(parseColor(c.onStatus), parseColor(s))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("produces the same set of CSS variables as every other theme", () => {
    const keys = Object.keys(cssVariables(theme)).sort();
    expect(keys).toEqual(Object.keys(cssVariables(THEMES.glass)).sort());
    expect(Object.values(cssVariables(theme)).every((v) => v.length > 0)).toBe(true);
  });
});

describe("custom colours", () => {
  it("falls back to the theme's own colours until they are made", () => {
    expect(withPalette(THEMES.glass, CUSTOM_ID, null).colors).toEqual(THEMES.glass.colors);
  });

  it("measures how readable the picked colours are", () => {
    const c = customContrast({ bg: "#000000", text: "#ffffff", accent: "#777777" });
    expect(c.text).toBeCloseTo(21, 0);
    expect(c.accent).toBeLessThan(5);
  });
});

describe("contrast helpers", () => {
  it("matches known WCAG values", () => {
    expect(contrastRatio(parseColor("#000000"), parseColor("#ffffff"))).toBeCloseTo(21, 0);
    expect(contrastRatio(parseColor("#777777"), parseColor("#ffffff"))).toBeCloseTo(4.48, 1);
  });

  it("blends translucent colours", () => {
    const mid = over(parseColor("rgba(255, 255, 255, 0.5)"), parseColor("#000000"));
    expect(Math.round(mid.r)).toBe(128);
  });
});
