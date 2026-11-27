import type { ThemeTokens } from "./tokens";

/** Premium glass: translucent cards over Windows 11 Mica, soft depth, clean type. */
export const glass: ThemeTokens = {
  id: "glass",
  label: "Glass",
  colors: {
    bg: "#0c1120",
    bgImage:
      "radial-gradient(1200px 600px at 10% -10%, rgba(110, 140, 255, 0.18), transparent 60%), radial-gradient(900px 500px at 110% 110%, rgba(80, 200, 190, 0.14), transparent 60%)",
    bgOverEffect: "rgba(12, 17, 32, 0.35)",
    surface: "rgba(255, 255, 255, 0.06)",
    surfaceRaised: "rgba(255, 255, 255, 0.10)",
    border: "rgba(255, 255, 255, 0.12)",
    text: "#eef1f6",
    textMuted: "#aab3c3",
    accent: "#8ab4ff",
    number: "#f4f6fb",
    focusRing: "#b9d1ff",
    ok: "#5be49b",
    failed: "#ff8a8a",
    pending: "#ffd166",
    onStatus: "#0b0f1a",
  },
  typography: {
    fontUi: '"Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
    fontMono: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
    fontNumeric: '"Segoe UI Variable Display", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
    titleTransform: "uppercase",
    titleLetterSpacing: "0.06em",
  },
  shape: {
    radius: "16px",
    radiusSmall: "10px",
    borderWidth: "1px",
    shadow: "0 8px 28px rgba(0, 0, 0, 0.28)",
  },
  material: {
    blur: "18px",
    windowEffect: "mica",
  },
  motion: {
    duration: "280ms",
    easing: "cubic-bezier(0.45, 0, 0.55, 1)",
    layoutDuration: "450ms",
    layoutEasing: "cubic-bezier(0.65, 0, 0.35, 1)",
  },
};
