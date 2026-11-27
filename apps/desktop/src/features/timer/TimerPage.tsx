import { useEffect, useState } from "react";
import { Card } from "../../components/Card";
import { listPresets, type Preset } from "../../ipc/database";
import { createPreset, deletePreset, lastPresetId, updatePreset } from "../../ipc/presets";
import {
  ENDLESS_FOCUS_S,
  PHASE_LABEL,
  isEndless,
  REPEAT_SESSIONS,
  repeats,
  continueTimer,
  isActive,
  pauseTimer,
  resumeTimer,
  skipPhase,
  startTimer,
  stopTimer,
  type TimerSnapshot,
} from "../../ipc/timer";
import { useUi } from "../../theme/UiProvider";
import { useCommand } from "../../useCommand";
import { PresetForm } from "./PresetForm";
import { PhoneFocusNote } from "./PhoneFocusNote";
import { TimerRing } from "./TimerRing";
import { useTimer } from "./useTimer";
import { openMiniTimer } from "../../ipc/windows";

/** `embedded`: shown as the Focus tab of the Timer page, which carries the heading. */
export function TimerPage(props: { embedded?: boolean } = {}) {
  const [timer, setTimer] = useTimer();
  const [presets, reloadPresets] = useCommand(listPresets);
  const [lastId] = useCommand(lastPresetId);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Preset | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const { theme } = useUi();

  const list = presets.kind === "ready" ? presets.value : [];
  const snap = timer.kind === "ready" ? timer.value : null;
  const active = snap !== null && isActive(snap);
  const endless = snap !== null && active && isEndless(snap);

  // Pick the running preset, else the last used one, else the first.
  useEffect(() => {
    if (list.length === 0) return;
    const wanted = (active && snap?.presetId) || selected || (lastId.kind === "ready" ? lastId.value : null);
    const exists = list.some((p) => p.id === wanted);
    setSelected(exists ? wanted : list[0]!.id);
  }, [list, lastId, active, snap?.presetId, selected]);

  const preset = list.find((p) => p.id === selected) ?? null;

  async function act(run: () => Promise<TimerSnapshot>) {
    setError(null);
    setConfirmStop(false);
    try {
      setTimer(await run());
    } catch (err) {
      setError(String(err));
    }
  }

  // Space starts, pauses and resumes (when not typing or on a button).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== "Space" || e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, button, [contenteditable]")) return;
      if (!snap) return;
      e.preventDefault();
      if (snap.status === "running") void act(pauseTimer);
      else if (snap.status === "paused") void act(resumeTimer);
      else if (snap.status === "waiting") void act(continueTimer);
      else if (preset) void act(() => startTimer(preset.id));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <section aria-labelledby="timer-title">
      <h1 id="timer-title" className={props.embedded ? "sr-only" : "page-title"}>
        Focus timer
      </h1>

      <div className="timer-layout">
        <div className="card timer-card">
          {timer.kind === "error" && <p className="error">The timer is unavailable: {timer.message}</p>}
          <button
            type="button"
            className="icon-button pop-out"
            aria-label="Pop out: small timer that stays on top"
            title="Pop out (small timer on top of other windows)"
            onClick={() => openMiniTimer().catch((err: unknown) => setError(String(err)))}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 8 8M6.5 3.5h-3v9h9v-3" /></svg>
          </button>
          {snap && (
            <>
              <PhoneFocusNote />
              <TimerRing snap={snap} idleDurationMs={(preset?.focusS ?? 0) * 1000} terminal={theme === "terminal"} />
              <p className="timer-preset muted">
                {active || snap.status === "finished" ? snap.presetName : preset?.name}
                {snap.status === "running" && !endless && <NextUp snap={snap} preset={preset} />}
                {endless && <> · Counts up until you press Finish</>}
              </p>
              <div className="timer-controls">
                {(snap.status === "idle" || snap.status === "finished") && (
                  <button type="button" className="button primary big" disabled={!preset} onClick={() => preset && void act(() => startTimer(preset.id))}>
                    {snap.status === "finished" ? "Start again" : "Start focus"}
                  </button>
                )}
                {snap.status === "running" && (
                  <button type="button" className="button primary big" onClick={() => void act(pauseTimer)}>
                    Pause
                  </button>
                )}
                {snap.status === "paused" && (
                  <button type="button" className="button primary big" onClick={() => void act(resumeTimer)}>
                    Resume
                  </button>
                )}
                {snap.status === "waiting" && (
                  <button type="button" className="button primary big" onClick={() => void act(continueTimer)}>
                    Start {PHASE_LABEL[snap.phase].toLowerCase()}
                  </button>
                )}
                {endless && (
                  <button type="button" className="button" onClick={() => void act(stopTimer)} title="End the session; it is saved as completed">
                    Finish
                  </button>
                )}
                {!endless && (snap.status === "running" || snap.status === "paused") && (
                  <button type="button" className="button" onClick={() => void act(skipPhase)}>
                    Skip {snap.phase === "focus" ? "session" : "break"}
                  </button>
                )}
                {active && !endless && !confirmStop && (
                  <button type="button" className="button" onClick={() => setConfirmStop(true)}>
                    Stop
                  </button>
                )}
              </div>
              {confirmStop && (
                <p className="confirm" role="alert">
                  Stop now? {snap.phase === "focus" && snap.status !== "waiting" ? "This focus session will count as interrupted. " : ""}
                  <button type="button" className="button danger" onClick={() => void act(stopTimer)}>
                    Yes, stop
                  </button>{" "}
                  <button type="button" className="button" onClick={() => setConfirmStop(false)}>
                    Keep going
                  </button>
                </p>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <p className="muted small">
                <kbd>Space</kbd> starts and pauses.
              </p>
            </>
          )}
        </div>

        <div className="timer-side">
        <Card title="Presets" className="presets-card">
          {presets.kind === "error" && <p className="error">Could not read presets: {presets.message}</p>}
          {active && <p className="muted small">Locked while a session runs.</p>}
          <fieldset className="preset-list" disabled={active}>
            <legend className="sr-only">Preset</legend>
            {list.map((p) => (
              <label key={p.id} className="preset-option" data-selected={p.id === selected}>
                <input type="radio" name="preset" checked={p.id === selected} onChange={() => setSelected(p.id)} />
                <span className="preset-text">
                  <strong>{p.name}</strong>
                  <span className="muted small">{describe(p)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {editing === null ? (
            <div className="form-actions">
              <button type="button" className="button" onClick={() => setEditing("new")}>
                New preset
              </button>
              {preset && (
                <button type="button" className="button" disabled={active} onClick={() => setEditing(preset)}>
                  Edit {preset.name}
                </button>
              )}
            </div>
          ) : (
            <PresetForm
              key={editing === "new" ? "new" : editing.id}
              preset={editing === "new" ? null : editing}
              onCancel={() => setEditing(null)}
              onSave={async (input) => {
                const saved = editing === "new" ? await createPreset(input) : await updatePreset(editing.id, input);
                setEditing(null);
                setSelected(saved.id);
                reloadPresets();
              }}
              onDelete={
                editing === "new" || list.length <= 1
                  ? undefined
                  : async () => {
                      await deletePreset(editing.id);
                      setEditing(null);
                      setSelected(null);
                      reloadPresets();
                    }
              }
            />
          )}
        </Card>

        </div>
      </div>
    </section>
  );
}

function describe(p: Preset): string {
  if (p.focusS >= ENDLESS_FOCUS_S) return "Endless · counts up until you finish";
  const m = (s: number) => `${Math.round(s / 60)}`;
  const repeat = p.sessionsPerCycle >= REPEAT_SESSIONS;
  const parts = [`${m(p.focusS)} / ${m(p.shortBreakS)}`, repeat ? "endless" : `${p.sessionsPerCycle} session${p.sessionsPerCycle === 1 ? "" : "s"}`];
  // A long break only happens if it falls before the last session.
  if (p.longBreakEvery > 0 && (repeat || p.longBreakEvery < p.sessionsPerCycle)) parts.push(`${m(p.longBreakS)} min long break every ${p.longBreakEvery}`);
  return parts.join(" · ");
}

function NextUp(props: { snap: TimerSnapshot; preset: Preset | null }) {
  const s = props.snap;
  if (s.phase !== "focus") return <> · Next: focus session {s.session + 1}</>;
  if (!repeats(s) && s.session >= s.sessions) return <> · Last session</>;
  return <> · Next: break</>;
}
