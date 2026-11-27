import { contrastRatio, luminance, over, parseColor, type Rgba } from "./contrast";
import type { Palette } from "./palettes";
import type { ThemeId, ThemeTokens } from "./tokens";

/** The palette id of your own colours. */
export const CUSTOM_ID = "custom";

/** The colours you pick for a custom theme, as "#rrggbb"; the rest are worked out from them. */
export interface CustomColors {
  bg: string;
  text: string;
  accent: string;
  /** Big figures (timer, counts); missing = worked out. */
  number?: string;
  /** The green "done" colour; missing = worked out. */
  ok?: string;
}

const hex = (c: Rgba) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const rgba = (c: string, a: number) => {
  const { r, g, b } = parseColor(c);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};
/** `a` mixed with `share` of `b`. */
const mix = (a: string, b: string, share: number) => {
  const x = parseColor(a);
  const y = parseColor(b);
  return hex({ r: x.r + (y.r - x.r) * share, g: x.g + (y.g - x.g) * share, b: x.b + (y.b - x.b) * share, a: 1 });
};

export function isLight(bg: string): boolean {
  return luminance(parseColor(bg)) > 0.3;
}

/** Status colours that stay readable on a dark or a light background. */
const STATUS = {
  dark: { ok: "#5be49b", failed: "#ff8a8a", pending: "#ffd166", onStatus: "#0b0f1a" },
  light: { ok: "#1a7f37", failed: "#c62828", pending: "#8a5a00", onStatus: "#ffffff" },
};

/** How readable your colours are against the background (WCAG ratios). */
export function customContrast(c: CustomColors): { text: number; accent: number; number: number; ok: number } {
  const bg = parseColor(c.bg);
  const p = customPalette("terminal", c).colors;
  const ratio = (x: string) => contrastRatio(parseColor(x), bg);
  return { text: ratio(c.text), accent: ratio(c.accent), number: ratio(c.number ?? p.number!), ok: ratio(p.ok!) };
}

/**
 * Grey text: the text faded towards the background, but never below 4.5:1 on the background or
 * on a raised card (a little text colour over it), if the text itself allows it.
 */
function mutedText(c: CustomColors): string {
  const bg = parseColor(c.bg);
  const grounds = [bg, over(parseColor(rgba(c.text, 0.12)), bg)];
  for (let share = 0.4; share > 0; share -= 0.05) {
    const m = parseColor(mix(c.text, c.bg, share));
    if (grounds.every((g) => contrastRatio(m, g) >= 4.6)) return hex(m);
  }
  return c.text;
}

/** A full palette for a theme from your three colours. */
export function customPalette(theme: ThemeId, c: CustomColors): Palette {
  const status = isLight(c.bg) ? STATUS.light : STATUS.dark;
  const shared = {
    bg: c.bg,
    text: c.text,
    textMuted: mutedText(c),
    accent: c.accent,
    focusRing: mix(c.accent, c.text, 0.35),
    ...status,
    ...(c.ok ? { ok: c.ok } : {}),
  };
  const colors: Partial<ThemeTokens["colors"]> =
    theme === "glass"
      ? {
          ...shared,
          bgImage: `radial-gradient(1200px 600px at 10% -10%, ${rgba(c.accent, 0.18)}, transparent 60%), radial-gradient(900px 500px at 110% 110%, ${rgba(c.accent, 0.1)}, transparent 60%)`,
          bgOverEffect: rgba(c.bg, 0.35),
          surface: rgba(c.text, 0.06),
          surfaceRaised: rgba(c.text, 0.1),
          border: rgba(c.text, 0.14),
          number: c.number ?? c.text,
        }
      : {
          ...shared,
          bgImage: "none",
          bgOverEffect: c.bg,
          surface: mix(c.bg, c.text, 0.03),
          surfaceRaised: rgba(c.text, 0.08),
          border: rgba(c.text, 0.34),
          number: c.number ?? c.accent,
        };
  return { id: CUSTOM_ID, label: "Custom", colors };
}
