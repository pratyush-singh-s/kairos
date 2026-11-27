import { invoke } from "@tauri-apps/api/core";
import type { CustomColors, ThemeId } from "@focus/ui";

export type Backdrop = "acrylic" | "mica" | "solid";
export type TitleBarMode = "auto" | "always";
export type SidebarMode = "full" | "icons" | "hidden";
export type TerminalShell = "powershell" | "bash" | "cmd";
export type MiniGlass = "lens" | "blur";
/** Terminal theme layout: today's look, a full-screen TUI, plain shell output, or a Neovim buffer. */
/** "nvim" was an option in a test build; it now reads as "classic" (the Code page keeps its Neovim look). */
export type TerminalStyle = "classic" | "app" | "shell";
/** Fine film grain behind the Notes page (the dark grainy look of ryoku.dev). */
export type NotesGrain = "black" | "theme" | "off";
/** Terminal theme: glowing text, glitches and a moving character background. */
export type TerminalGlow = "soft" | "strong" | "off";
/** Glass theme text: dashboard-style mono labels and grey text, or the older look. */
export type GlassText = "data" | "classic";
export type KeySound = "off" | "creamy" | "thock" | "creamy-thock";

/** Mirrored by `UiSettings` in src-tauri/src/commands.rs. */
export interface UiSettings {
  theme: ThemeId;
  backdrop: Backdrop;
  sidebarCollapsed: boolean;
  /** The menu: full, icons only, or hidden until you swipe from the left or touch the left edge. */
  sidebarMode: SidebarMode;
  titleBar: TitleBarMode;
  /** Look sliders, 0–100, one pair per theme. */
  glassBlur: number;
  glassTransparency: number;
  terminalBlur: number;
  terminalTransparency: number;
  /** Use Windows' own blur (fixed strength, blurs the windows behind) instead of the Blur slider. */
  glassWindowsBlur: boolean;
  terminalWindowsBlur: boolean;
  /** Mini timer background: "lens" = real glass (bends the screen behind it), "blur" = Windows blur. */
  miniGlass: MiniGlass;
  /** Colour palette id per theme (see packages/ui palettes.ts); "" = the theme's own. */
  glassPalette: string;
  terminalPalette: string;
  /** Your own colours per theme (palette "custom"); null = not made yet. */
  glassCustom: CustomColors | null;
  terminalCustom: CustomColors | null;
  /** Terminal theme: whose prompt is drawn at the top and bottom of each page. */
  terminalShell: TerminalShell;
  /** Terminal theme: old CRT screen look (scan lines, soft glow). */
  terminalCrt: boolean;
  /** Terminal theme: rings, bars and charts drawn with text characters. */
  terminalAscii: boolean;
  /** With the CRT look: its power-on sound and quiet hum. */
  terminalCrtSound: boolean;
  /** Terminal theme: how pages are laid out (see TerminalStyle). */
  terminalStyle: TerminalStyle;
  /** Terminal theme: glow, distortion and character background strength. */
  terminalGlow: TerminalGlow;
  /** The dashboard's newer layout instead of the card grid. */
  newDashboard: boolean;
  /** Film grain behind the Notes page. */
  notesGrain: NotesGrain;
  /** Glass theme text style (see GlassText). */
  glassText: GlassText;
  /** Glass theme: a glow on the window edge that follows the mouse (on by default). */
  glassEdgeGlow: boolean;
  /** Keyboard sound while typing, and its volume 0–100. */
  keySound: KeySound;
  keyVolume: number;
}

export const UI_KEYS: Record<keyof UiSettings, string> = {
  theme: "ui.theme",
  backdrop: "ui.backdrop",
  sidebarCollapsed: "ui.sidebarCollapsed",
  sidebarMode: "ui.sidebarMode",
  titleBar: "ui.titleBar",
  glassBlur: "ui.glassBlur",
  glassTransparency: "ui.glassTransparency",
  terminalBlur: "ui.terminalBlur",
  terminalTransparency: "ui.terminalTransparency",
  glassWindowsBlur: "ui.glassWindowsBlur",
  terminalWindowsBlur: "ui.terminalWindowsBlur",
  miniGlass: "ui.glassEffect",
  glassPalette: "ui.glassPalette",
  terminalPalette: "ui.terminalPalette",
  glassCustom: "ui.glassCustom",
  terminalCustom: "ui.terminalCustom",
  terminalShell: "ui.terminalShell",
  terminalCrt: "ui.terminalCrt",
  terminalAscii: "ui.terminalAscii",
  terminalCrtSound: "ui.terminalCrtSound",
  terminalStyle: "ui.terminalStyle",
  terminalGlow: "ui.terminalGlow",
  newDashboard: "ui.nowDashboard",
  notesGrain: "ui.notesGrain",
  glassText: "ui.glassText",
  glassEdgeGlow: "ui.edgeGlowOn",
  keySound: "ui.keySound",
  keyVolume: "ui.keyVolume",
};

export function getUiSettings(): Promise<UiSettings> {
  return invoke<UiSettings>("get_ui_settings");
}

export function saveUiSetting<K extends keyof UiSettings>(key: K, value: UiSettings[K]): Promise<void> {
  return invoke("set_ui_setting", { key: UI_KEYS[key], value });
}

/** Asks Windows for a window backdrop. Resolves to whether it is actually showing. */
export type WindowEffect = "none" | "blur" | "acrylic" | "mica";

export function setWindowEffect(effect: WindowEffect, tint?: number): Promise<boolean> {
  return invoke<boolean>("set_window_effect", { effect, tint });
}

/** Real-glass mini timer: hide the window from screen capture so it can copy what is behind it. */
export function glassCapture(on: boolean): Promise<boolean> {
  return invoke<boolean>("glass_capture", { on });
}

/** The screen behind the mini timer: 8-byte header (width, height as u32 LE), then BGRA rows. */
export function glassFrame(scale = 1): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("glass_frame", { scale });
}
