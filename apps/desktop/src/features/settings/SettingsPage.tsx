import { useEffect, useState } from "react";
import { formatClock, formatDurationShort } from "@focus/core";
import { Card } from "../../components/Card";
import { BackupCard } from "./BackupCard";
import { GoogleCard } from "./GoogleCard";
import { UsersCard } from "./UsersCard";
import { Status } from "../../components/Status";
import { getAppInfo } from "../../ipc/appInfo";
import { playSplash } from "../../app/Splash";
import { checkForUpdateNow } from "../update/UpdatePopup";
import { getDbStatus } from "../../ipc/database";
import { getCloseToTray, getStartWithWindows, quitApp, setCloseToTray, setStartWithWindows } from "../../ipc/settings";
import { getSoundSettings, previewSound, saveSoundSettings, type Chime, type SoundSettings } from "../../ipc/sound";
import { useCommand } from "../../useCommand";
import { clearActivity, getTrackingMode, setTrackingMode, type TrackingMode } from "../../ipc/tracking";
import { CUSTOM_ID, PALETTES, THEMES, customContrast, paletteOf, withPalette, type CustomColors, type ThemeId } from "@focus/ui";
import { customOf, lookOf, paletteIdOf, useUi } from "../../theme/UiProvider";
import type { KeySound, MiniGlass, NotesGrain, TerminalGlow, TerminalShell, TerminalStyle, TitleBarMode } from "../../ipc/ui";
import { playKey } from "../../app/useTypingSound";
import { playCrtOn } from "../../app/useCrtSound";

const SIDEBAR_MODES: { id: "full" | "icons" | "hidden"; label: string; note: string }[] = [
  { id: "full", label: "Full", note: "Icons and names." },
  { id: "icons", label: "Icons only", note: "A narrow strip; hover an icon for its name." },
  { id: "hidden", label: "Hidden", note: "Move to the left edge to show it." },
];

type SettingsTab = "look" | "layout" | "sound" | "data" | "app";
const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "look", label: "Look" },
  { id: "layout", label: "Layout" },
  { id: "sound", label: "Sound" },
  { id: "data", label: "Data & accounts" },
  { id: "app", label: "App" },
];
const SETTINGS_TAB_KEY = "focus.settings.tab";

function savedSettingsTab(): SettingsTab {
  try {
    const v = localStorage.getItem(SETTINGS_TAB_KEY);
    return SETTINGS_TABS.some((t) => t.id === v) ? (v as SettingsTab) : "look";
  } catch {
    return "look";
  }
}

/** Settings in groups (tabs), so only one group's cards are on screen at a time. */
export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>(savedSettingsTab);
  function choose(t: SettingsTab) {
    setTab(t);
    try {
      localStorage.setItem(SETTINGS_TAB_KEY, t);
    } catch {
      // Only a convenience.
    }
  }
  return (
    <section aria-labelledby="settings-title">
      <div className="space-tabs">
        <h1 id="settings-title" className="page-title space-tabs-title">
          Settings
        </h1>
        <div className="space-tab-list" role="tablist" aria-label="Settings groups">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className="space-tab"
              aria-selected={tab === t.id}
              data-active={tab === t.id}
              onClick={() => choose(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {tab === "look" && <Appearance />}
      {tab === "layout" && <LayoutCard />}
      {tab === "sound" && (
        <>
          <SoundCard />
          <TypingSoundCard />
        </>
      )}
      {tab === "data" && (
        <>
          <TrackingCard />
          <GoogleCard />
          <UsersCard />
          <BackupCard />
        </>
      )}
      {tab === "app" && (
        <>
          <WindowSettings />
          <Diagnostics />
        </>
      )}
    </section>
  );
}

/**
 * One setting with a few choices, shown as a single button with the current choice: click it for
 * the next one (Shift+click or right-click goes back). The note under it describes the current choice.
 */
export function Cycle<T extends string>(props: {
  label: string;
  options: { id: T; label: string; note?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const i = Math.max(0, props.options.findIndex((o) => o.id === props.value));
  const current = props.options[i] ?? { id: props.value, label: String(props.value) };
  const n = props.options.length;
  const step = (by: number) => props.onChange((props.options[(i + by + n) % n] ?? current).id as T);
  return (
    <div className="cycle-row">
      <span className="cycle-label">{props.label}</span>
      <button
        type="button"
        className="cycle-button"
        title={`Click for the next choice (${props.options.map((o) => o.label).join(" / ")})`}
        aria-label={`${props.label}: ${current.label}. Click to change.`}
        onClick={(e) => step(e.shiftKey ? -1 : 1)}
        onContextMenu={(e) => {
          e.preventDefault();
          step(-1);
        }}
      >
        <span className="cycle-value">{current.label}</span>
        <span className="cycle-dots" aria-hidden="true">
          {props.options.map((o) => (
            <span key={o.id} data-on={o.id === current.id} />
          ))}
        </span>
      </button>
      {"note" in current && current.note && <span className="hint cycle-note">{current.note}</span>}
    </div>
  );
}

const KEY_SOUNDS: { id: KeySound; label: string; note: string }[] = [
  { id: "creamy-thock", label: "Creamy + thock", note: "Deep and smooth, like a lubed linear board." },
  { id: "thock", label: "Thock", note: "Low, muffled knock." },
  { id: "creamy", label: "Creamy", note: "Soft, rounded and a little brighter." },
  { id: "off", label: "Off", note: "" },
];

/** The keyboard sound while typing anywhere in Focus. */
function TypingSoundCard() {
  const { keySound, keyVolume, update, preview } = useUi();
  return (
    <Card title="Typing sound">
      <Cycle
        label="Sound"
        options={KEY_SOUNDS}
        value={keySound}
        onChange={(k) => {
          update("keySound", k);
          playKey(k, keyVolume, "key");
        }}
      />
      <label className="field volume">
        <span>Volume: {keyVolume}%</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={keyVolume}
          disabled={keySound === "off"}
          onChange={(e) => {
            preview("keyVolume", Number(e.target.value));
            playKey(keySound, Number(e.target.value), "key");
          }}
        />
      </label>
      <label className="field">
        <span>Try it here</span>
        <input type="text" placeholder="Type something…" spellCheck={false} />
      </label>
    </Card>
  );
}

const TITLE_BARS: { id: TitleBarMode; label: string; note: string }[] = [
  { id: "auto", label: "On hover", note: "Shows when you move to the top." },
  { id: "always", label: "Always", note: "Always shown." },
];

const MINI_GLASS: { id: MiniGlass; label: string; note: string }[] = [
  { id: "blur", label: "Blur", note: "Frosted blur. Shows in screenshots." },
  {
    id: "lens",
    label: "Real glass",
    note: "Bends what is behind, like real glass. Hidden from screenshots.",
  },
];

const SHELLS: { id: TerminalShell; label: string; sample: string }[] = [
  { id: "powershell", label: "PowerShell", sample: "PS C:\\Kairos>" },
  { id: "bash", label: "Bash", sample: "you@focus:~$" },
  { id: "cmd", label: "Command Prompt", sample: "C:\\Kairos>" },
];

const TERMINAL_STYLES: { id: TerminalStyle; label: string; note: string }[] = [
  { id: "classic", label: "Classic", note: "Boxed panels and a status line." },
  { id: "app", label: "Full-screen app", note: "Like lazygit or btop." },
  { id: "shell", label: "Shell session", note: "Plain text, no boxes." },
];

const TERMINAL_GLOW: { id: TerminalGlow; label: string; note: string }[] = [
  { id: "soft", label: "Soft", note: "Glowing text, a faint moving character background." },
  { id: "strong", label: "Strong", note: "Brighter glow, more glitches." },
  { id: "off", label: "Off", note: "Plain text." },
];

/** Terminal theme: how pages are laid out, whose prompt is drawn, and the CRT screen look. */
function TerminalWindow() {
  const { terminalShell, terminalCrt, terminalCrtSound, terminalAscii, terminalStyle, terminalGlow, keyVolume, update } = useUi();
  return (
    <>
      <Cycle label="Terminal style" options={TERMINAL_STYLES} value={terminalStyle} onChange={(v) => update("terminalStyle", v)} />
      <Cycle
        label="Shell"
        options={SHELLS.map((s) => ({ id: s.id, label: s.label, note: s.sample }))}
        value={terminalShell}
        onChange={(v) => update("terminalShell", v)}
      />
      <Cycle label="Glow and distortion" options={TERMINAL_GLOW} value={terminalGlow ?? "soft"} onChange={(v) => update("terminalGlow", v)} />
      <label className="check crt-check">
        <input type="checkbox" checked={terminalCrt} onChange={(e) => update("terminalCrt", e.target.checked)} />
        Old CRT screen look
      </label>
      {terminalCrt && (
        <label className="check crt-check crt-sound-check">
          <input
            type="checkbox"
            checked={terminalCrtSound}
            onChange={(e) => {
              update("terminalCrtSound", e.target.checked);
              if (e.target.checked) playCrtOn(keyVolume);
            }}
          />
          Old CRT screen sound
        </label>
      )}
      <label className="check crt-check">
        <input type="checkbox" checked={terminalAscii} onChange={(e) => update("terminalAscii", e.target.checked)} />
        ASCII graphics
      </label>
    </>
  );
}

const NOTES_GRAIN: { id: NotesGrain; label: string; note: string }[] = [
  { id: "black", label: "Black grain", note: "Black, with grain on the paper." },
  { id: "theme", label: "Grain", note: "The same fine grain over the theme's own colours." },
  { id: "off", label: "Plain", note: "No grain." },
];

function Appearance() {
  const { theme, glassSetting, recording, setRecording, notesGrain, glassText, glassEdgeGlow, update } = useUi();
  return (
    <Card title="Appearance">
      <Cycle
        label="Theme"
        options={(Object.keys(THEMES) as ThemeId[]).map((id) => ({ id, label: THEMES[id].label }))}
        value={theme}
        onChange={(v) => update("theme", v)}
      />
      <Cycle label="Glass effect" options={MINI_GLASS} value={glassSetting} onChange={(v) => update("miniGlass", v)} />
      {glassSetting === "lens" && (
        <Cycle
          label="Recording mode"
          options={[
            { id: "off", label: "Off", note: "Kairos is hidden from recordings." },
            { id: "on", label: "On", note: "Kairos shows in recordings. Ctrl+Shift+R." },
          ]}
          value={recording ? "on" : "off"}
          onChange={(v) => setRecording(v === "on")}
        />
      )}

      {/* Only the theme that is on: its look and its colours. */}
      <LookSliders theme={theme} />
      <PalettePicker theme={theme} />
      {theme === "glass" && (
        <Cycle
          label="Text style"
          options={[
            { id: "data", label: "Data", note: "Mono labels, big numbers, grey text." },
            { id: "classic", label: "Classic", note: "The older Glass text." },
          ]}
          value={glassText ?? "data"}
          onChange={(v) => update("glassText", v as "data" | "classic")}
        />
      )}
      {theme === "glass" && (
        <Cycle
          label="Edge glow"
          options={[
            { id: "off", label: "Off", note: "No glow on the window edge." },
            { id: "on", label: "On", note: "The window edge glows near the mouse." },
          ]}
          value={glassEdgeGlow ? "on" : "off"}
          onChange={(v) => update("glassEdgeGlow", v === "on")}
        />
      )}
      {theme === "terminal" && <TerminalWindow />}
      <Cycle label="Notes background" options={NOTES_GRAIN} value={notesGrain ?? "black"} onChange={(v) => update("notesGrain", v)} />
      <SaveState />
    </Card>
  );
}

/** Where things sit: the menu, the title bar and the dashboard. */
function LayoutCard() {
  const { theme, titleBar, sidebarMode, newDashboard, update } = useUi();
  return (
    <Card title="Layout">
      <Cycle label="Menu" options={SIDEBAR_MODES} value={sidebarMode} onChange={(v) => update("sidebarMode", v)} />
      <Cycle label="Title bar" options={TITLE_BARS} value={titleBar} onChange={(v) => update("titleBar", v)} />
      <Cycle
        label="Dashboard"
        options={[
          { id: "new", label: "Main", note: "Now, Today, Coming up, Screen time." },
          { id: "grid", label: "Old cards", note: "The cards as before." },
        ]}
        value={newDashboard ? "new" : "grid"}
        onChange={(v) => update("newDashboard", v === "new")}
      />

      <p className="muted small">
        Shortcuts: <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>T</kbd> switches theme, <kbd>Ctrl</kbd> + <kbd>B</kbd>{" "}
        switches the menu style.
        {theme === "terminal" && (
          <>
            {" "}
            <kbd>Ctrl</kbd> + <kbd>`</kbd> jumps to the prompt at the bottom of each page (type <code>help</code>).
          </>
        )}
      </p>
      <SaveState />
    </Card>
  );
}

function SaveState() {
  const { saveState } = useUi();
  return (
    <p className="small" role="status" aria-live="polite">
      {saveState.kind === "saved" && <span className="muted">Saved.</span>}
      {saveState.kind === "error" && <span className="error">Not saved: {saveState.message}</span>}
    </p>
  );
}

/** Transparency and blur for one theme. Changes show while dragging and are saved when you let go. */
function LookSliders(props: { theme: ThemeId }) {
  const ui = useUi();
  const keys =
    props.theme === "glass"
      ? ({ transparency: "glassTransparency", blur: "glassWindowsBlur" } as const)
      : ({ transparency: "terminalTransparency", blur: "terminalWindowsBlur" } as const);
  const look = lookOf(ui, props.theme);
  const active = ui.theme === props.theme;
  const name = THEMES[props.theme].label;
  return (
    <fieldset className="look-sliders">
      <legend>{name} look</legend>
      <label className="slider">
        <span>Transparency</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={look.transparency}
          onChange={(e) => ui.preview(keys.transparency, Number(e.target.value))}
        />
        <span className="num slider-value">{look.transparency === 0 ? "Solid" : `${look.transparency}%`}</span>
      </label>
      <p className="hint slider-hint">
        {look.blur
          ? "The windows behind Kairos show through, frosted."
          : "The windows behind Kairos show through, sharp."}
      </p>
      <label className="check slider-check">
        <input type="checkbox" checked={look.blur} onChange={(e) => ui.update(keys.blur, e.target.checked)} />
        Blur the windows behind Kairos
      </label>
      {active && look.blur && !ui.backdropOn && (
        <p className="error small">Windows did not turn on its blur here, so the background is not blurred.</p>
      )}
    </fieldset>
  );
}

/** Colour palettes for one theme, each shown as a small swatch of its background and colours, plus your own. */
export function PalettePicker(props: { theme: ThemeId }) {
  const ui = useUi();
  const key = props.theme === "glass" ? "glassPalette" : "terminalPalette";
  const customKey = props.theme === "glass" ? "glassCustom" : "terminalCustom";
  const chosen = paletteIdOf(ui, props.theme);
  const custom = customOf(ui, props.theme);
  const current = chosen === CUSTOM_ID ? CUSTOM_ID : paletteOf(props.theme, chosen).id;

  // Until you change something, Custom starts as a copy of the palette that was on before.
  const seed = (from: string) => {
    const c = withPalette(THEMES[props.theme], from).colors;
    return {
      bg: asHex(c.bg, "#101216"),
      text: asHex(c.text, "#eeeeee"),
      accent: asHex(c.accent, "#8ab4ff"),
      number: asHex(c.number, "#ffa657"),
      ok: asHex(c.ok, "#7ee787"),
    };
  };
  const shownCustom: CustomColors = custom ?? seed(chosen === CUSTOM_ID ? "" : chosen);

  function pickCustom() {
    if (!custom) ui.update(customKey, shownCustom);
    ui.update(key, CUSTOM_ID);
  }

  const swatch = (c: { bg: string; border: string; accent: string; ok: string; number: string; text: string }) => (
    <span className="palette-swatch" style={{ background: c.bg, borderColor: c.border }} aria-hidden="true">
      {[c.accent, c.ok, c.number, c.text].map((color, i) => (
        <span key={i} style={{ background: color }} />
      ))}
    </span>
  );

  return (
    <fieldset className="palette-picker">
      <legend>{THEMES[props.theme].label} colours</legend>
      <div className="palette-list">
        {PALETTES[props.theme].map((p) => (
          <label key={p.id} className="palette-choice" data-selected={current === p.id}>
            <input type="radio" name={`palette-${props.theme}`} checked={current === p.id} onChange={() => ui.update(key, p.id)} />
            {swatch(withPalette(THEMES[props.theme], p.id).colors)}
            <span className="palette-name">{p.label}</span>
          </label>
        ))}
        <label className="palette-choice" data-selected={current === CUSTOM_ID}>
          <input type="radio" name={`palette-${props.theme}`} checked={current === CUSTOM_ID} onChange={pickCustom} />
          {current === CUSTOM_ID || custom ? (
            swatch(withPalette(THEMES[props.theme], CUSTOM_ID, shownCustom).colors)
          ) : (
            <span className="palette-swatch palette-swatch-new" aria-hidden="true">
              +
            </span>
          )}
          <span className="palette-name">Custom</span>
        </label>
      </div>
      {current === CUSTOM_ID && <CustomColorsEditor colors={shownCustom} theme={props.theme} onChange={(c) => ui.preview(customKey, c)} />}
    </fieldset>
  );
}

/** "#rrggbb" as is; anything else (rgba, gradients) gets the fallback. */
const asHex = (c: string, fallback: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : fallback);

/** The background and the four swatch dots, in the order the swatch shows them. */
const CUSTOM_ROLES: [keyof CustomColors, string][] = [
  ["bg", "Background"],
  ["accent", "Accent"],
  ["ok", "Done"],
  ["number", "Numbers"],
  ["text", "Text"],
];

/** Your own theme: the background and the four swatch colours; cards, borders and grey text follow from them. */
function CustomColorsEditor(props: { colors: CustomColors; theme: ThemeId; onChange: (c: CustomColors) => void }) {
  const ratio = customContrast(props.colors);
  const derived = withPalette(THEMES[props.theme], CUSTOM_ID, props.colors).colors;
  const valueOf = (role: keyof CustomColors) => props.colors[role] ?? asHex(role === "ok" ? derived.ok : derived.number, "#888888");
  const hard = [
    ratio.text < 4.5 && "the text",
    ratio.accent < 3 && "the accent",
    ratio.number < 3 && "the numbers",
    ratio.ok < 3 && "the done colour",
  ].filter(Boolean);
  return (
    <div className="custom-colors">
      {CUSTOM_ROLES.map(([role, label]) => (
        <HexColor key={role} label={label} value={valueOf(role)} onChange={(v) => props.onChange({ ...props.colors, [role]: v })} />
      ))}
      <p className="hint custom-colors-note">
        Cards, borders and grey text are worked out from these. Done is the tick and "finished" colour; Numbers is the timer and counts.
        {hard.length > 0 && <span className="error"> Hard to see on this background: {hard.join(", ")}.</span>}
      </p>
    </div>
  );
}

/** A colour well plus its hex code; the code can be typed (#abc or #aabbcc). */
function HexColor(props: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  return (
    <label className="hex-color">
      <span>{props.label}</span>
      <input type="color" value={props.value} onChange={(e) => props.onChange(e.target.value)} aria-label={`${props.label} colour`} />
      <input
        className="hex-input"
        value={text}
        maxLength={7}
        spellCheck={false}
        aria-label={`${props.label} hex code`}
        onChange={(e) => {
          setText(e.target.value);
          const v = e.target.value.trim().replace(/^#?/, "#").toLowerCase();
          if (/^#[0-9a-f]{6}$/.test(v)) props.onChange(v);
          else if (/^#[0-9a-f]{3}$/.test(v)) props.onChange(`#${[...v.slice(1)].map((c) => c + c).join("")}`);
        }}
        onBlur={() => setText(props.value)}
      />
    </label>
  );
}

const TRACKING_MODES: { id: TrackingMode; label: string; note: string }[] = [
  { id: "off", label: "Off", note: "Nothing is recorded." },
  { id: "focus", label: "During focus sessions", note: "See which programs you used in each session." },
  { id: "always", label: "All the time", note: "Also outside focus sessions." },
];

/** App tracking is opt-in: off until you choose otherwise. */
function TrackingCard() {
  const [loaded] = useCommand(getTrackingMode);
  const [mode, setMode] = useState<TrackingMode | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (loaded.kind === "ready") setMode(loaded.value);
  }, [loaded]);

  function choose(next: TrackingMode) {
    setMode(next);
    setTrackingMode(next)
      .then(() => setMessage({ error: false, text: "Saved." }))
      .catch((err: unknown) => setMessage({ error: true, text: `Not saved: ${String(err)}` }));
  }

  async function clear() {
    try {
      await clearActivity();
      setConfirmClear(false);
      setMessage({ error: false, text: "All app activity on this PC was deleted." });
    } catch (err) {
      setMessage({ error: true, text: `Not deleted: ${String(err)}` });
    }
  }

  return (
    <Card title="App tracking">
      <p className="muted small">
        Records which app you use, by name only. Stays on this PC.
      </p>
      {loaded.kind === "error" && <p className="error">Could not read the setting: {loaded.message}</p>}
      {mode && (
        <fieldset className="radio-group theme-choices">
          <legend>Track apps</legend>
          {TRACKING_MODES.map((m) => (
            <label key={m.id} className="theme-choice">
              <input type="radio" name="tracking" checked={mode === m.id} onChange={() => choose(m.id)} />
              <span>
                <strong>{m.label}</strong>
                <span className="hint">{m.note}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {confirmClear ? (
        <p className="confirm-left">
          Delete all recorded app activity on this PC?{" "}
          <button type="button" className="button danger" onClick={() => void clear()}>
            Delete
          </button>{" "}
          <button type="button" className="button" onClick={() => setConfirmClear(false)}>
            Keep
          </button>
        </p>
      ) : (
        <button type="button" className="button" onClick={() => setConfirmClear(true)}>
          Delete recorded activity…
        </button>
      )}
      {message && (
        <p className={`small ${message.error ? "error" : "muted"}`} role="status">
          {message.text}
        </p>
      )}
    </Card>
  );
}

const CHIMES: { id: Chime; label: string }[] = [
  { id: "to_break", label: "Focus done" },
  { id: "to_focus", label: "Break over" },
  { id: "finished", label: "All done" },
];

function SoundCard() {
  const [loaded] = useCommand(getSoundSettings);
  const [sound, setSound] = useState<SoundSettings | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  useEffect(() => {
    if (loaded.kind === "ready") setSound(loaded.value);
  }, [loaded]);

  function save(next: SoundSettings) {
    setSound(next);
    saveSoundSettings(next)
      .then(() => setMessage({ error: false, text: "Saved." }))
      .catch((err: unknown) => setMessage({ error: true, text: `Not saved: ${String(err)}` }));
  }

  return (
    <Card title="Sound">
      {loaded.kind === "error" && <p className="error">Could not read sound settings: {loaded.message}</p>}
      {sound && (
        <>
          <label className="check">
            <input type="checkbox" checked={sound.on} onChange={(e) => save({ ...sound, on: e.target.checked })} />
            Chime when a session or break ends
          </label>
          <label className="field volume">
            <span>Volume: {sound.volume}%</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={sound.volume}
              disabled={!sound.on}
              onChange={(e) => setSound({ ...sound, volume: Number(e.target.value) })}
              onPointerUp={() => save(sound)}
              onKeyUp={() => save(sound)}
            />
          </label>
          <div className="form-actions">
            <span className="muted small">Listen:</span>
            {CHIMES.map((c) => (
              <button
                key={c.id}
                type="button"
                className="button"
                onClick={() =>
                  previewSound(c.id, sound.volume).catch((err: unknown) => setMessage({ error: true, text: String(err) }))
                }
              >
                {c.label}
              </button>
            ))}
          </div>
          <p className="muted small">Notifications stay silent.</p>
        </>
      )}
      <p className="small" role="status" aria-live="polite">
        {message && <span className={message.error ? "error" : "muted"}>{message.text}</span>}
      </p>
    </Card>
  );
}

function WindowSettings() {
  const [closeToTray] = useCommand(getCloseToTray);
  const [startup] = useCommand(getStartWithWindows);
  const [atStart, setAtStart] = useState<boolean | null>(null);
  const [value, setValue] = useState<boolean | null>(null);
  const [saveState, setSaveState] = useState<{ kind: "idle" | "saved" } | { kind: "error"; message: string }>({
    kind: "idle",
  });

  useEffect(() => {
    if (closeToTray.kind === "ready") setValue(closeToTray.value);
  }, [closeToTray]);
  useEffect(() => {
    if (startup.kind === "ready") setAtStart(startup.value);
  }, [startup]);

  async function chooseStart(next: boolean) {
    const previous = atStart;
    setAtStart(next);
    try {
      await setStartWithWindows(next);
      setSaveState({ kind: "saved" });
    } catch (err) {
      setAtStart(previous);
      setSaveState({ kind: "error", message: String(err) });
    }
  }

  async function choose(next: boolean) {
    const previous = value;
    setValue(next);
    try {
      await setCloseToTray(next);
      setSaveState({ kind: "saved" });
    } catch (err) {
      setValue(previous);
      setSaveState({ kind: "error", message: String(err) });
    }
  }

  return (
    <Card title="Window">
      <fieldset className="radio-group" disabled={value === null}>
        <legend>When I close the Kairos window</legend>
        <label>
          <input type="radio" name="close" checked={value === true} onChange={() => void choose(true)} />
          Keep Kairos running in the system tray <span className="muted">(recommended: timers keep running)</span>
        </label>
        <label>
          <input type="radio" name="close" checked={value === false} onChange={() => void choose(false)} />
          Quit Kairos completely
        </label>
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={atStart === true} disabled={atStart === null} onChange={(e) => void chooseStart(e.target.checked)} />
        Start with Windows <span className="muted">(in the tray, so PC on time counts)</span>
      </label>
      {closeToTray.kind === "error" && <p className="error">Could not read this setting: {closeToTray.message}</p>}
      <p className="small" role="status" aria-live="polite">
        {saveState.kind === "saved" && <span className="muted">Saved.</span>}
        {saveState.kind === "error" && <span className="error">Not saved: {saveState.message}</span>}
      </p>
      <p className="muted small">
        To quit while Kairos is in the tray, right-click its icon and choose "Quit Kairos", or use this button:
      </p>
      <button type="button" className="button" onClick={() => void quitApp()}>
        Quit Kairos
      </button>
    </Card>
  );
}

function Diagnostics() {
  const [info] = useCommand(getAppInfo);
  const [db] = useCommand(getDbStatus);
  const sharedOk = formatClock(25 * 60) === "25:00" && formatDurationShort(9342) === "2h 35m";

  return (
    <Card title="Diagnostics">
      <ul className="checks">
        <li>
          {info.kind === "ready" ? (
            <Status ok label="Native core" detail={`Kairos ${info.value.version}`} />
          ) : info.kind === "error" ? (
            <Status failed label="Native core" detail={info.message} />
          ) : (
            <Status label="Native core" detail="Checking…" />
          )}
        </li>
        <li>
          <Status ok={sharedOk} failed={!sharedOk} label="Shared logic" detail="Time formatting self-check" />
        </li>
        <li>
          {db.kind === "ready" ? (
            <Status
              ok
              label="Local database"
              detail={`Schema version ${db.value.schemaVersion}, ${db.value.tableCount} tables, ${formatBytes(db.value.sizeBytes)}`}
            />
          ) : db.kind === "error" ? (
            <Status failed label="Local database" detail={db.message} />
          ) : (
            <Status label="Local database" detail="Checking…" />
          )}
        </li>
      </ul>

      {info.kind === "ready" && (
        <dl className="about">
          <dt>Version</dt>
          <dd>
            {info.value.version}{" "}
            <button type="button" className="link-button small" onClick={playSplash}>
              Play start animation
            </button>
          </dd>
          <dt>Updates</dt>
          <dd>
            <UpdateCheck />
          </dd>
          <dt>Tauri</dt>
          <dd>{info.value.tauriVersion}</dd>
          <dt>System</dt>
          <dd>
            {info.value.os} ({info.value.arch})
          </dd>
          <dt>Data folder</dt>
          <dd>
            <code>{info.value.dataDir}</code>
            <span className="hint">Kept when you install an update.</span>
          </dd>
          {db.kind === "ready" && (
            <>
              <dt>This PC's ID</dt>
              <dd>
                <code>{db.value.deviceId}</code>
              </dd>
            </>
          )}
        </dl>
      )}
    </Card>
  );
}

/** "Check for updates": the update popup opens if there is one. */
function UpdateCheck() {
  const [state, setState] = useState<"idle" | "checking" | "none" | "error">("idle");
  async function check() {
    setState("checking");
    try {
      setState((await checkForUpdateNow()) ? "idle" : "none");
    } catch {
      setState("error");
    }
  }
  return (
    <>
      <button type="button" className="button" onClick={() => void check()} disabled={state === "checking"}>
        Check for updates
      </button>{" "}
      {state !== "idle" && (
        <span className="hint" role="status">
          {state === "checking" ? "Checking…" : state === "none" ? "You have the newest version." : "Couldn't check. Are you online?"}
        </span>
      )}
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
