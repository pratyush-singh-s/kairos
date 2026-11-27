import { luminance, parseColor } from "./contrast";
import type { ThemeTokens } from "./tokens";

/** Flattens tokens into CSS custom properties (`--color-bg`, `--radius`, ...). */
export function cssVariables(t: ThemeTokens): Record<string, string> {
  const c = t.colors;
  return {
    "--bg": c.bg,
    "--bg-image": c.bgImage,
    "--bg-over-effect": c.bgOverEffect,
    "--surface": c.surface,
    "--surface-raised": c.surfaceRaised,
    "--border": c.border,
    "--text": c.text,
    "--text-muted": c.textMuted,
    "--accent": c.accent,
    "--number": c.number,
    "--focus-ring": c.focusRing,
    "--ok": c.ok,
    "--failed": c.failed,
    "--pending": c.pending,
    "--on-status": c.onStatus,
    "--font-ui": t.typography.fontUi,
    "--font-mono": t.typography.fontMono,
    "--font-numeric": t.typography.fontNumeric,
    "--title-transform": t.typography.titleTransform,
    "--title-letter-spacing": t.typography.titleLetterSpacing,
    "--radius": t.shape.radius,
    "--radius-sm": t.shape.radiusSmall,
    "--border-width": t.shape.borderWidth,
    "--shadow": t.shape.shadow,
    "--blur": t.material.blur,
    "--duration": t.motion.duration,
    "--easing": t.motion.easing,
    "--layout-duration": t.motion.layoutDuration,
    "--layout-easing": t.motion.layoutEasing,
  };
}

/** Applies a theme to the document root in one step. */
export function applyTheme(root: HTMLElement, t: ThemeTokens): void {
  for (const [name, value] of Object.entries(cssVariables(t))) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = t.id;
  // Form controls (date pickers, scrollbars) follow a light custom background.
  root.style.colorScheme = luminance(parseColor(t.colors.bg)) > 0.3 ? "light" : "dark";
}
