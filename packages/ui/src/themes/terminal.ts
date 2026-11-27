import type { ThemeTokens } from "./tokens";

/**
 * Terminal: looks like a TUI (btop, LazyVim) running in a see-through terminal. Thin box-drawing
 * lines with the title set into the top border, monospace everywhere, full-row highlights.
 */
export const terminal: ThemeTokens = {
  id: "terminal",
  label: "Terminal",
  colors: {
    bg: "#101216",
    bgImage: "none",
    bgOverEffect: "#101216",
    // Panels are drawn see-through by the Transparency slider (see styles.css).
    surface: "#14171c",
    surfaceRaised: "rgba(201, 209, 217, 0.08)",
    border: "rgba(201, 209, 217, 0.34)", // box-drawing lines
    text: "#d4d7dc",
    textMuted: "#8b929c", // "comment" grey
    accent: "#d2a8ff", // "keyword" violet
    number: "#ffa657", // "number" orange
    focusRing: "#79c0ff",
    ok: "#7ee787", // "string" green
    failed: "#ff7b72",
    pending: "#e3b341",
    onStatus: "#0d1117",
  },
  typography: {
    fontUi: '"Cascadia Code Variable", "Cascadia Code", "Cascadia Mono", "JetBrains Mono", Consolas, monospace',
    fontMono: '"Cascadia Code Variable", "Cascadia Code", "Cascadia Mono", "JetBrains Mono", Consolas, monospace',
    fontNumeric: '"Cascadia Code Variable", "Cascadia Code", "Cascadia Mono", "JetBrains Mono", Consolas, monospace',
    titleTransform: "lowercase",
    titleLetterSpacing: "0",
  },
  shape: {
    radius: "0px",
    radiusSmall: "0px",
    borderWidth: "1px",
    shadow: "none",
  },
  material: {
    blur: "0px",
    windowEffect: "none",
  },
  motion: {
    duration: "0ms",
    easing: "linear",
    // Terminal keeps colours instant, but moving parts still glide so they don't jump.
    layoutDuration: "300ms",
    layoutEasing: "cubic-bezier(0.65, 0, 0.35, 1)",
  },
};
