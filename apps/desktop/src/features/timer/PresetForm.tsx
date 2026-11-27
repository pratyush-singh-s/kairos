import { useState, type FormEvent } from "react";
import type { Preset } from "../../ipc/database";
import type { PresetInput } from "../../ipc/presets";
import { ENDLESS_FOCUS_S, REPEAT_SESSIONS } from "../../ipc/timer";

const BLANK: PresetInput = {
  name: "",
  focusS: 25 * 60,
  shortBreakS: 5 * 60,
  longBreakS: 15 * 60,
  sessionsPerCycle: 4,
  longBreakEvery: 4,
  autoStartBreak: true,
  autoStartFocus: false,
};

/** Create or edit a preset. Durations are typed in minutes and stored in seconds. */
export function PresetForm(props: {
  preset: Preset | null;
  onSave: (input: PresetInput) => Promise<void>;
  onDelete?: () => Promise<void>;
  onCancel: () => void;
}) {
  const start = props.preset ?? BLANK;
  const [name, setName] = useState(start.name);
  // Old presets made with Focus left blank (24 hours, "endless") need a length again.
  const [focus, setFocus] = useState(start.focusS >= ENDLESS_FOCUS_S ? "" : String(start.focusS / 60));
  const [short, setShort] = useState(String(start.shortBreakS / 60));
  const [long, setLong] = useState(String(start.longBreakS / 60));
  // Blank sessions = repeat focus and breaks until you stop (stored as REPEAT_SESSIONS).
  const [sessions, setSessions] = useState(start.sessionsPerCycle >= REPEAT_SESSIONS ? "" : String(start.sessionsPerCycle));
  const repeat = sessions.trim() === "";
  const [every, setEvery] = useState(String(start.longBreakEvery));
  const [autoBreak, setAutoBreak] = useState(start.autoStartBreak);
  const [autoFocus, setAutoFocus] = useState(start.autoStartFocus);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const minutes = (v: string) => Math.round(Number(v) * 60);
    const input: PresetInput = {
      name,
      focusS: minutes(focus),
      shortBreakS: minutes(short),
      longBreakS: minutes(long),
      sessionsPerCycle: repeat ? REPEAT_SESSIONS : Math.round(Number(sessions)),
      longBreakEvery: Math.round(Number(every)),
      autoStartBreak: autoBreak,
      autoStartFocus: autoFocus,
    };
    if ([input.focusS, input.shortBreakS, input.longBreakS, input.sessionsPerCycle, input.longBreakEvery].some(Number.isNaN)) {
      setError("Please enter numbers in every duration field.");
      return;
    }
    void run(() => props.onSave(input));
  }

  return (
    <form className="preset-form" onSubmit={submit} aria-label={props.preset ? `Edit ${props.preset.name}` : "New preset"}>
      <label className="field wide">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoFocus />
      </label>
      <label className="field">
        <span>Focus (min)</span>
        <input type="number" min={1} max={1439} step={1} value={focus} onChange={(e) => setFocus(e.target.value)} required />
      </label>
      <label className="field">
        <span>Short break (min)</span>
        <input type="number" min={0} max={1440} step={1} value={short} onChange={(e) => setShort(e.target.value)} required />
      </label>
      <label className="field">
        <span>Long break (min)</span>
        <input type="number" min={0} max={1440} step={1} value={long} onChange={(e) => setLong(e.target.value)} required />
      </label>
      <label className="field">
        <span>Sessions</span>
        <input type="number" min={1} max={REPEAT_SESSIONS - 1} step={1} value={sessions} placeholder="Endless" onChange={(e) => setSessions(e.target.value)} />
        <span className="hint">{repeat ? "Endless: focus and breaks repeat until you stop" : "Leave blank for endless"}</span>
      </label>
      <label className="field">
        <span>Long break every</span>
        <input type="number" min={0} max={24} step={1} value={every} onChange={(e) => setEvery(e.target.value)} required />
        <span className="hint">sessions (0 = never)</span>
      </label>
      <label className="check wide">
        <input type="checkbox" checked={autoBreak} onChange={(e) => setAutoBreak(e.target.checked)} />
        Start breaks automatically
      </label>
      <label className="check wide">
        <input type="checkbox" checked={autoFocus} onChange={(e) => setAutoFocus(e.target.checked)} />
        Start the next focus session automatically after a break
      </label>
      {error && (
        <p className="error wide" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions wide">
        <button type="submit" className="button primary" disabled={busy}>
          {props.preset ? "Save changes" : "Create preset"}
        </button>
        <button type="button" className="button" onClick={props.onCancel} disabled={busy}>
          Cancel
        </button>
        {props.onDelete &&
          (confirmDelete ? (
            <span className="confirm">
              Delete "{props.preset?.name}"?{" "}
              <button type="button" className="button danger" onClick={() => void run(props.onDelete!)} disabled={busy}>
                Yes, delete
              </button>{" "}
              <button type="button" className="button" onClick={() => setConfirmDelete(false)}>
                Keep it
              </button>
            </span>
          ) : (
            <button type="button" className="button danger push-right" onClick={() => setConfirmDelete(true)} disabled={busy}>
              Delete preset
            </button>
          ))}
      </div>
    </form>
  );
}
