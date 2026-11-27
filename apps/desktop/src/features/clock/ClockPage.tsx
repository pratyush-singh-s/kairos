import { useEffect, useMemo, useState } from "react";
import { timeOfDay } from "@focus/core";
import {
  cancelCountdown,
  dismissCountdown,
  getCountdown,
  onCountdownChanged,
  startCountdown,
  type Countdown,
} from "../../ipc/countdown";
import { openMiniTimer } from "../../ipc/windows";
import { elapsed, formatStopwatch, stopwatch, useStopwatch } from "./stopwatch";
import { TimerPage } from "../timer/TimerPage";
import { ScheduleTool } from "./ScheduleTool";

export type TimerTab = "focus" | "stopwatch" | "countdown" | "schedule";
const TAB_KEY = "focus.timer.tab";
const TABS: { id: TimerTab; label: string }[] = [
  { id: "focus", label: "Focus" },
  { id: "stopwatch", label: "Stopwatch" },
  { id: "countdown", label: "Countdown" },
  { id: "schedule", label: "Schedule" },
];

function savedTab(): TimerTab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return v === "stopwatch" || v === "countdown" || v === "schedule" ? v : "focus";
  } catch {
    return "focus";
  }
}

/** Opens the Timer page on this tab next time (the dashboard and the status line ask for Focus). */
export function showTimerTab(tab: TimerTab) {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Only a convenience.
  }
}

/** The Timer page: the focus timer, a stopwatch, and a countdown to a clock time, as tabs. */
export function TimerHub() {
  const [tab, setTab] = useState<TimerTab>(savedTab);
  function choose(t: TimerTab) {
    setTab(t);
    showTimerTab(t);
  }
  return (
    <section aria-labelledby="timer-hub-title" className="timer-hub">
      <div className="space-tabs">
        <h1 id="timer-hub-title" className="page-title space-tabs-title">
          Timer
        </h1>
        <div className="space-tab-list" role="tablist" aria-label="Timer">
          {TABS.map((t) => (
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
      {tab === "focus" && <TimerPage embedded />}
      {tab === "stopwatch" && <StopwatchTool />}
      {tab === "countdown" && <CountdownTool />}
      {tab === "schedule" && <ScheduleTool />}
    </section>
  );
}

/* ------------------------------------------------------------ shared ring */

const SIZE = 320;
const STROKE = 12;
const R = (SIZE - STROKE) / 2 - 4;
const CIRC = 2 * Math.PI * R;

export function Ring(props: { progress: number; time: string; caption: string; status: string; sweep?: boolean }) {
  return (
    <div className="timer-ring clock-ring" data-status={props.status}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <circle className="ring-track" cx={SIZE / 2} cy={SIZE / 2} r={R} strokeWidth={STROKE} />
        <circle
          className="ring-progress"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          strokeWidth={STROKE}
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - Math.max(0, Math.min(1, props.progress)))}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          data-sweep={props.sweep || undefined}
        />
      </svg>
      <div className="ring-center">
        <div className="ring-time clock-time">{props.time}</div>
        <div className="ring-phase">{props.caption}</div>
      </div>
    </div>
  );
}

/** Re-renders every animation frame while `on`. */
export function useFrameNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    let frame = requestAnimationFrame(function loop() {
      setNow(Date.now());
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [on]);
  return on ? now : Date.now();
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement;
  return !!t.closest("input, textarea, select, button, [contenteditable]");
}

/* ------------------------------------------------------------ stopwatch */

/** Also the phone's Stopwatch tab (`touch`: no keyboard hint). */
export function StopwatchTool(props: { touch?: boolean } = {}) {
  const sw = useStopwatch();
  const running = sw.startedAt !== null;
  const now = useFrameNow(running);
  const total = elapsed(sw, now);
  const started = running || total > 0;

  // Space starts and pauses, L adds a lap.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.altKey || e.metaKey || isTyping(e)) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (running) stopwatch.pause();
        else stopwatch.start();
      } else if (e.code === "KeyL" && running) {
        stopwatch.lap();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running]);

  // The ring goes round once a minute, like a second hand.
  const progress = started ? (total % 60_000) / 60_000 : 0;
  const laps = sw.laps.map((at, i) => ({ n: i + 1, at, split: at - (sw.laps[i - 1] ?? 0) })).reverse();
  const current = { n: sw.laps.length + 1, split: total - (sw.laps[sw.laps.length - 1] ?? 0) };
  const splits = sw.laps.map((at, i) => at - (sw.laps[i - 1] ?? 0));
  const best = splits.length > 1 ? Math.min(...splits) : null;
  const worst = splits.length > 1 ? Math.max(...splits) : null;

  return (
    <div className="timer-layout clock-layout">
      <div className="card timer-card">
        <Ring
          progress={progress}
          time={formatStopwatch(total)}
          caption={running ? "Running" : started ? "Paused" : "Stopwatch"}
          status={running ? "running" : started ? "paused" : "idle"}
          sweep
        />
        <div className="timer-controls">
          {running ? (
            <button type="button" className="button primary big" onClick={stopwatch.pause}>
              Pause
            </button>
          ) : (
            <button type="button" className="button primary big" onClick={stopwatch.start}>
              {started ? "Resume" : "Start"}
            </button>
          )}
          {running && (
            <button type="button" className="button" onClick={stopwatch.lap}>
              Lap
            </button>
          )}
          {!running && started && (
            <button type="button" className="button" onClick={stopwatch.reset}>
              Reset
            </button>
          )}
        </div>
        <p className="muted small">
          {props.touch ? (
            "Keeps counting in the background."
          ) : (
            <>
              <kbd>Space</kbd> starts and pauses, <kbd>L</kbd> laps.
            </>
          )}
        </p>
      </div>

      <section className="card clock-laps" aria-labelledby="laps-title">
        <h2 id="laps-title" className="card-title">
          <span className="card-title-text">Laps</span>
        </h2>
        {laps.length === 0 ? (
          <p className="muted small">Press Lap to save a split.</p>
        ) : (
          <ol className="lap-list">
            {started && (
              <li className="lap-row lap-current">
                <span className="lap-n">Lap {current.n}</span>
                <span className="num">{formatStopwatch(current.split)}</span>
                <span className="num muted">{formatStopwatch(total)}</span>
              </li>
            )}
            {laps.map((l) => (
              <li
                key={l.n}
                className="lap-row"
                data-best={l.split === best || undefined}
                data-worst={l.split === worst || undefined}
              >
                <span className="lap-n">
                  Lap {l.n}
                  {l.split === best && <span className="lap-tag"> fastest</span>}
                  {l.split === worst && <span className="lap-tag"> slowest</span>}
                </span>
                <span className="num">{formatStopwatch(l.split)}</span>
                <span className="num muted">{formatStopwatch(l.at)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ countdown to a time */

/** The next time the clock shows hh:mm: later today, or tomorrow if that has passed. */
export function nextOccurrence(hhmm: string, now = new Date()): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

export function clockLabel(d: Date, now = new Date()): string {
  const time = timeOfDay(d);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return `${time} today`;
  if (d.toDateString() === tomorrow.toDateString()) return `${time} tomorrow`;
  return `${time} ${d.toLocaleDateString([], { weekday: "short" })}`;
}

/** 1:02:03 or 2:03 */
export function formatLeft(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

export function inWords(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function hhmmOf(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A starting suggestion: half an hour from now, on a 5-minute mark. */
export function suggested(): string {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return hhmmOf(d);
}

export function useCountdown(): [Countdown | null, (c: Countdown) => void, string | null] {
  const [c, setC] = useState<Countdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    onCountdownChanged((v) => setC(v))
      .then((u) => (alive ? (unlisten = u) : u()))
      .catch(() => {});
    getCountdown()
      .then((v) => alive && setC(v))
      .catch((err: unknown) => alive && setError(String(err)));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
  return [c, setC, error];
}

const AS_FOCUS_KEY = "focus.countdown.asFocus";

function savedAsFocus(): boolean {
  try {
    return localStorage.getItem(AS_FOCUS_KEY) === "1";
  } catch {
    return false;
  }
}

function saveAsFocus(on: boolean) {
  try {
    localStorage.setItem(AS_FOCUS_KEY, on ? "1" : "0");
  } catch {
    // Only a convenience.
  }
}

function CountdownTool() {
  const [c, setC, loadError] = useCountdown();
  const [time, setTime] = useState(suggested);
  const [name, setName] = useState("");
  const [asFocus, setAsFocus] = useState(savedAsFocus);
  const [error, setError] = useState<string | null>(null);
  const running = c?.atMs != null;
  const now = useFrameNow(running);
  // Refresh the "in 3 h 12 min" preview every so often while choosing.
  const [, tick] = useState(0);
  useEffect(() => {
    if (running) return;
    const t = window.setInterval(() => tick((n) => n + 1), 15_000);
    return () => window.clearInterval(t);
  }, [running]);

  const target = useMemo(() => nextOccurrence(time), [time, running, now]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(run: () => Promise<Countdown>) {
    setError(null);
    try {
      setC(await run());
    } catch (err) {
      setError(String(err));
    }
  }

  function start() {
    const d = nextOccurrence(time);
    if (!d) {
      setError("Pick a time first.");
      return;
    }
    void act(() => startCountdown(d.getTime(), clockLabel(d), name.trim(), asFocus));
  }

  function quick(minutes: number) {
    setTime(hhmmOf(new Date(Date.now() + minutes * 60_000 + 30_000)));
  }

  // Enter starts (from the time box too); Escape cancels a running countdown.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.code === "Escape" && running) void act(cancelCountdown);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!c) {
    return <div className="timer-layout clock-layout clock-single"><div className="card timer-card">{loadError ? <p className="error">The countdown is unavailable: {loadError}</p> : <p className="muted">Loading…</p>}</div></div>;
  }

  if (c.done) {
    return (
      <div className="timer-layout clock-layout clock-single">
        <div className="card timer-card clock-done" role="alert">
          <Ring progress={1} time="0:00" caption="Time's up" status="finished" />
          <p className="clock-done-text">
            {c.name && (
              <>
                <strong>{c.name}</strong>
                <br />
              </>
            )}
            Counted down to {c.label}.
            {c.focus && (
              <>
                <br />
                <span className="muted">It counted as focus.</span>
              </>
            )}
          </p>
          <div className="timer-controls">
            <button type="button" className="button primary big" onClick={() => void act(dismissCountdown)}>
              OK
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (running && c.atMs != null) {
    const left = c.atMs - now;
    const span = Math.max(1, c.atMs - c.setMs);
    return (
      <div className="timer-layout clock-layout clock-single">
        <div className="card timer-card">
          <button
            type="button"
            className="icon-button pop-out"
            aria-label="Pop out: small countdown that stays on top"
            title="Pop out (small countdown on top of other windows)"
            onClick={() => openMiniTimer("countdown").catch((err: unknown) => setError(String(err)))}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 8 8M6.5 3.5h-3v9h9v-3" /></svg>
          </button>
          <Ring progress={1 - left / span} time={formatLeft(left)} caption={`Until ${c.label}`} status="running" />
          {c.name && <p className="timer-preset">{c.name}</p>}
          {c.focus && <p className="clock-focus-badge">Counting as focus</p>}
          <div className="timer-controls">
            <button type="button" className="button" onClick={() => void act(cancelCountdown)}>
              {c.focus ? "Cancel (ends the focus too)" : "Cancel"}
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <p className="muted small">
            {c.focus ? "Counts as focus, with blocking on." : "Rings when it's done."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="timer-layout clock-layout clock-single">
      <form
        className="card timer-card clock-setup"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <label className="clock-time-field">
          <span className="ring-phase">Count down to</span>
          <input type="time" required value={time} onChange={(e) => setTime(e.target.value)} aria-describedby="clock-when" />
        </label>
        <p id="clock-when" className="muted clock-when" aria-live="polite">
          {target ? `Rings at ${clockLabel(target)}, in ${inWords(target.getTime() - Date.now())}` : "Pick a time"}
        </p>
        <div className="clock-quick" role="group" aria-label="Quick times from now">
          {[5, 15, 30, 60, 120].map((m) => (
            <button key={m} type="button" className="button small" onClick={() => quick(m)}>
              +{m < 60 ? `${m} min` : `${m / 60} h`}
            </button>
          ))}
        </div>
        <label className="field clock-name">
          Name (optional)
          <input type="text" value={name} maxLength={80} placeholder="e.g. Leave for class" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="check-row clock-as-focus">
          <input
            type="checkbox"
            checked={asFocus}
            onChange={(e) => {
              setAsFocus(e.target.checked);
              saveAsFocus(e.target.checked);
            }}
          />
          <span>
            Count as focus
            <span className="muted small clock-as-focus-hint">Blocking on, counted in your stats.</span>
          </span>
        </label>
        <div className="timer-controls">
          <button type="submit" className="button primary big" disabled={!target}>
            {asFocus ? "Start focus countdown" : "Start countdown"}
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="muted small">A time that has passed means tomorrow.</p>
      </form>
    </div>
  );
}
