import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { THEMES, applyTheme, isThemeId, withPalette } from "@focus/ui";
import { getUiSettings, saveUiSetting, setWindowEffect, type UiSettings, type WindowEffect } from "../ipc/ui";

/** Last appearance used on this PC, so the first frame already looks right (no flash). */
const CACHE_KEY = "focus.ui";
const UI_EVENT = "ui-changed";

const DEFAULTS: UiSettings = {
  theme: "glass",
  backdrop: "acrylic",
  sidebarCollapsed: false,
  sidebarMode: "full",
  titleBar: "always",
  glassBlur: 60,
  glassTransparency: 90,
  terminalBlur: 40,
  terminalTransparency: 90,
  glassWindowsBlur: true,
  terminalWindowsBlur: true,
  miniGlass: "blur",
  glassPalette: "",
  terminalPalette: "",
  glassCustom: null,
  terminalCustom: null,
  terminalShell: "powershell",
  terminalCrt: false,
  terminalAscii: false,
  terminalCrtSound: false,
  terminalStyle: "classic",
  terminalGlow: "soft",
  newDashboard: true,
  notesGrain: "black",
  glassText: "data",
  glassEdgeGlow: true,
  keySound: "creamy-thock",
  keyVolume: 50,
};

/** Ctrl+B and the menu button switch between full and icons only. Hidden is chosen in Settings only (Ps asked). */
export function nextSidebarMode(mode: UiSettings["sidebarMode"]): UiSettings["sidebarMode"] {
  return mode === "full" ? "icons" : "full";
}

/** The chosen palette id for a theme. */
export function paletteIdOf(ui: UiSettings, theme = ui.theme): string {
  return theme === "glass" ? ui.glassPalette : ui.terminalPalette;
}

/** Your own colours for a theme, if made. */
export function customOf(ui: UiSettings, theme = ui.theme) {
  return theme === "glass" ? ui.glassCustom : ui.terminalCustom;
}

const SHARED_KEY = "focus.ui.extColorsSent";

/** Sends the colours to the browser extension's pages (blocked page, popup), so they match the app. */
function shareColors(theme: string, c: ReturnType<typeof tokensFor>["colors"]) {
  const value = {
    theme,
    bg: c.bg,
    bgImage: c.bgImage,
    surface: c.surface,
    raised: c.surfaceRaised,
    border: c.border,
    text: c.text,
    muted: c.textMuted,
    accent: c.accent,
    onAccent: c.onStatus,
    ok: c.ok,
    failed: c.failed,
    number: c.number,
  };
  const json = JSON.stringify(value);
  try {
    if (localStorage.getItem(SHARED_KEY) === json) return;
  } catch {
    // Send it anyway.
  }
  invoke("set_ui_setting", { key: "ui.extColors", value })
    .then(() => {
      try {
        localStorage.setItem(SHARED_KEY, json);
      } catch {
        // Only saves a resend.
      }
    })
    .catch(() => {});
}

/** The theme's tokens in its chosen palette. */
const tokensFor = (ui: UiSettings) => withPalette(THEMES[ui.theme], paletteIdOf(ui), customOf(ui));

export interface Look {
  transparency: number;
  /** Windows blurs the windows behind Focus (its frosted Acrylic); off = sharp see-through. */
  blur: boolean;
}

/** The look settings for a theme. */
export function lookOf(ui: UiSettings, theme = ui.theme): Look {
  return theme === "glass"
    ? { transparency: ui.glassTransparency, blur: ui.glassWindowsBlur }
    : { transparency: ui.terminalTransparency, blur: ui.terminalWindowsBlur };
}

/** The mini timer is meant to sit over other windows, so it is always more see-through. */
const IS_MINI = typeof window !== "undefined" && window.location.hash.startsWith("#mini");

type SaveState = { kind: "idle" } | { kind: "saved" } | { kind: "error"; message: string };

interface UiContextValue extends UiSettings {
  /** Whether Windows' blur is really showing behind the window. */
  backdropOn: boolean;
  update: <K extends keyof UiSettings>(key: K, value: UiSettings[K]) => void;
  /** Shows a value right away and saves it shortly after (for sliders being dragged). */
  preview: <K extends keyof UiSettings>(key: K, value: UiSettings[K]) => void;
  saveState: SaveState;
  /** Your Glass effect setting. `miniGlass` above is what is drawn: "blur" while recording mode is on. */
  glassSetting: UiSettings["miniGlass"];
  /** Recording mode: Real glass is swapped for Blur so screen recordings and screenshots show Focus. */
  recording: boolean;
  setRecording: (on: boolean) => void;
}

const UiContext = createContext<UiContextValue | null>(null);

function readCache(): UiSettings {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
    if (parsed && typeof parsed === "object") {
      const c = { ...DEFAULTS, ...(parsed as Partial<UiSettings>) };
      if (!["classic", "app", "shell"].includes(c.terminalStyle)) c.terminalStyle = "classic";
      if (!["soft", "strong", "off"].includes(c.terminalGlow)) c.terminalGlow = "soft";
      if (isThemeId(c.theme)) return c;
    }
  } catch {
    // Storage unavailable or corrupt: use defaults.
  }
  return DEFAULTS;
}

function writeCache(s: UiSettings) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(s));
  } catch {
    // Only a convenience; the database holds the real settings.
  }
}

/** Sets the CSS variables the look sliders drive. */
function applyLook(root: HTMLElement, look: { transparency: number }) {
  // Opacity of the window background: 100% at transparency 0, down to 5% at 100.
  let opacity = 1 - (look.transparency / 100) * 0.95;
  if (IS_MINI) opacity *= 0.35;
  root.style.setProperty("--window-opacity", opacity.toFixed(3));
  // Panels stay a little more solid than the background so text stays readable.
  root.style.setProperty("--panel-opacity", Math.min(1, opacity + 0.2).toFixed(3));
}

/** Paints the theme before React renders. Called from main.tsx. */
export function paintInitialTheme() {
  const cached = readCache();
  applyTheme(document.documentElement, tokensFor(cached));
  applyLook(document.documentElement, lookOf(cached));
  if (cached.theme === "terminal" && !IS_MINI) document.documentElement.dataset.termStyle = cached.terminalStyle;
}

export function UiProvider(props: { children: ReactNode }) {
  const [ui, setUi] = useState<UiSettings>(readCache);
  const [backdropOn, setBackdropOn] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const latest = useRef(ui);
  latest.current = ui;

  useEffect(() => writeCache(ui), [ui]);

  // Colours and transparency apply instantly; then ask Windows for the blur behind the window.
  const look = lookOf(ui);
  const palette = paletteIdOf(ui);
  const custom = JSON.stringify(customOf(ui));
  useEffect(() => {
    const root = document.documentElement;
    const tokens = tokensFor(latest.current);
    applyTheme(root, tokens);
    if (!IS_MINI) shareColors(ui.theme, tokens.colors);
  }, [ui.theme, palette, custom]);

  useEffect(() => applyLook(document.documentElement, look), [look.transparency]);

  // Terminal theme extras that are pure CSS: the old CRT screen look.
  useEffect(() => {
    document.documentElement.dataset.crt = ui.theme === "terminal" && ui.terminalCrt && !IS_MINI ? "on" : "off";
  }, [ui.theme, ui.terminalCrt]);
  // Glow and distortion (styles.css "terminal glow"; the character background is app/terminal/TermNoise.tsx).
  useEffect(() => {
    const on = ui.theme === "terminal" && !IS_MINI;
    document.documentElement.dataset.termGlow = on ? (ui.terminalGlow ?? "soft") : "off";
  }, [ui.theme, ui.terminalGlow]);
  // ASCII graphics: the parts drawn by CSS alone (chart bars) read this.
  useEffect(() => {
    document.documentElement.dataset.ascii = ui.theme === "terminal" && ui.terminalAscii ? "on" : "off";
  }, [ui.theme, ui.terminalAscii]);

  // Film grain behind the Notes page (styles.css "notes grain"). Older backends send nothing: black.
  useEffect(() => {
    document.documentElement.dataset.notesGrain = ui.notesGrain ?? "black";
  }, [ui.notesGrain]);

  // Glass text style (styles.css "glass text"). Older backends send nothing: the new look.
  useEffect(() => {
    document.documentElement.dataset.glassText = ui.glassText ?? "data";
  }, [ui.glassText]);

  // Terminal style: every page's layout follows html[data-term-style] (styles.css). Glass has none.
  useEffect(() => {
    const root = document.documentElement;
    if (ui.theme === "terminal" && !IS_MINI) root.dataset.termStyle = ui.terminalStyle;
    else delete root.dataset.termStyle;
  }, [ui.theme, ui.terminalStyle]);

  // The window is transparent; Windows either blurs what is behind it or leaves it sharp.
  // Same in every window, as in 0.21.38.B. Never the plain "blur" effect: it showed pitch black.
  // Real glass draws over this, and it shows again if Windows refuses the screen copy.
  const effect: WindowEffect = look.blur ? "acrylic" : "none";
  // Acrylic's own dark tint follows the transparency slider (0–200 of 255).
  const tint = Math.round((1 - look.transparency / 100) * 200 * (IS_MINI ? 0.35 : 1));
  useEffect(() => {
    const root = document.documentElement;
    let current = true;
    const timer = window.setTimeout(() => {
      setWindowEffect(effect, tint)
        .catch(() => false)
        .then((on) => {
          if (!current) return; // a newer change already happened
          setBackdropOn(on);
          root.dataset.backdrop = on ? "on" : "off";
        });
    }, 120); // don't call Windows on every pixel of a slider drag
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [effect, tint]);

  // The database is the source of truth (it also syncs to the other PC later).
  useEffect(() => {
    getUiSettings()
      .then(setUi)
      .catch(() => {
        // Keep the cached look; Settings → Diagnostics shows database problems.
      });
  }, []);

  // A change made in one window (main or mini timer) shows in the other straight away.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    listen<UiSettings>(UI_EVENT, (e) => setUi(e.payload))
      .then((u) => (alive ? (unlisten = u) : u()))
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const update = useCallback(<K extends keyof UiSettings>(key: K, value: UiSettings[K]) => {
    const next = { ...latest.current, [key]: value };
    // Several changes in one click (Custom sets its colours and the palette) build on each other.
    latest.current = next;
    setUi(next);
    saveUiSetting(key, value)
      .then(() => {
        setSaveState({ kind: "saved" });
        return emit(UI_EVENT, latest.current);
      })
      .catch((err) => setSaveState({ kind: "error", message: String(err) }));
  }, []);

  // Slider drags: show at once, save once the hand stops moving.
  const pending = useRef<Partial<UiSettings>>({});
  const saveTimer = useRef<number | undefined>(undefined);
  const preview = useCallback(<K extends keyof UiSettings>(key: K, value: UiSettings[K]) => {
    latest.current = { ...latest.current, [key]: value };
    setUi(latest.current);
    pending.current[key] = value;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const changes = pending.current;
      pending.current = {};
      for (const [k, v] of Object.entries(changes)) update(k as keyof UiSettings, v as never);
    }, 400);
  }, [update]);

  // Recording mode is kept by the native core (tray menu, every window), not saved: off after a restart.
  const [recording, setRecordingState] = useState(false);
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<boolean>("recording-mode", (e) => setRecordingState(Boolean(e.payload)))
      .then((u) => (alive ? (unlisten = u) : u()))
      .catch(() => {});
    invoke<boolean>("get_recording_mode")
      .then((v) => alive && setRecordingState(v))
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
  const setRecording = useCallback((on: boolean) => {
    setRecordingState(on);
    invoke("set_recording_mode", { on }).catch(() => {});
  }, []);
  const recordingRef = useRef(recording);
  recordingRef.current = recording;

  // Ctrl+B moves to the next menu style, from anywhere in the app.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // A shortcut the focused control already used (Ctrl+B = bold in a note) is not ours.
      if (!e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const key = e.key.toLowerCase();
      // (Ctrl+Shift+T no longer switches theme: only Settings does, Ps asked.)
      if (e.shiftKey && key === "r") {
        // Ctrl+Shift+R: recording mode on/off.
        e.preventDefault();
        setRecording(!recordingRef.current);
      } else if (!e.shiftKey && key === "b") {
        e.preventDefault();
        update("sidebarMode", nextSidebarMode(latest.current.sidebarMode));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [update, setRecording]);

  const drawn = recording && ui.miniGlass === "lens" ? "blur" : ui.miniGlass;
  return (
    <UiContext.Provider value={{ ...ui, miniGlass: drawn, glassSetting: ui.miniGlass, recording, setRecording, backdropOn, update, preview, saveState }}>{props.children}</UiContext.Provider>
  );
}

export function useUi(): UiContextValue {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error("useUi must be used inside UiProvider");
  return ctx;
}
