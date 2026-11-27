import { glass } from "./glass";
import { terminal } from "./terminal";
import type { ThemeId, ThemeTokens } from "./tokens";

export const THEMES: Record<ThemeId, ThemeTokens> = { glass, terminal };

export function isThemeId(value: unknown): value is ThemeId {
  return value === "glass" || value === "terminal";
}
