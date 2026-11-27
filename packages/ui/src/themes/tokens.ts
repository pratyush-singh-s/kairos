/**
 * Design tokens. Every theme provides every token (a missing one is a compile error),
 * and components only ever read tokens through CSS variables, so switching themes never
 * touches component state.
 */
export type ThemeId = "glass" | "terminal";

export interface ThemeTokens {
  id: ThemeId;
  label: string;
  colors: {
    /** Window background when no system effect is active. */
    bg: string;
    /** Extra background layer (gradients); "none" for flat. */
    bgImage: string;
    /** Background when a Windows Mica effect sits behind the app (glass only). */
    bgOverEffect: string;
    surface: string;
    surfaceRaised: string;
    border: string;
    text: string;
    textMuted: string;
    accent: string;
    /** Big figures such as times and counts. */
    number: string;
    focusRing: string;
    ok: string;
    failed: string;
    pending: string;
    /** Text drawn on top of ok/failed/pending badges. */
    onStatus: string;
  };
  typography: {
    fontUi: string;
    fontMono: string;
    /** Font for timer digits and figures. */
    fontNumeric: string;
    titleTransform: "none" | "uppercase" | "lowercase";
    titleLetterSpacing: string;
  };
  shape: {
    radius: string;
    radiusSmall: string;
    borderWidth: string;
    shadow: string;
  };
  material: {
    /** Backdrop blur for cards; "0px" disables it. */
    blur: string;
    /** Windows window effect to request behind the app. */
    windowEffect: "mica" | "none";
  };
  motion: {
    /** Small changes: hover, colour. */
    duration: string;
    easing: string;
    /** Things that move or resize: title bar slide, sidebar collapse. Always eased in and out. */
    layoutDuration: string;
    layoutEasing: string;
  };
}
