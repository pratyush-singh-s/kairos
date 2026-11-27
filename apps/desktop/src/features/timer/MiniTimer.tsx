import { useEffect, useState } from "react";
import { listPresets } from "../../ipc/database";
import { lastPresetId } from "../../ipc/presets";
import { ENDLESS_FOCUS_MS, continueTimer, isEndless, pauseTimer, resumeTimer, sessionCount, startTimer, type TimerSnapshot } from "../../ipc/timer";
import { formatClock } from "@focus/core";
import { exitMiniTimer } from "../../ipc/windows";
import { useRemaining, useTimer } from "./useTimer";
import { GlassLens } from "./GlassLens";
import { useUi } from "../../theme/UiProvider";
import { listen } from "@tauri-apps/api/event";
import { cancelCountdown, dismissCountdown, type Countdown } from "../../ipc/countdown";
import { formatLeft, useCountdown } from "../clock/ClockPage";

type MiniMode = "focus" | "countdown";

/** The small window shows the focus timer, or the countdown (opened from the Countdown tab). */
export function MiniTimer() {
  const [mode, setMode] = useState<MiniMode>(() => (window.location.hash === "#mini-countdown" ? "countdown" : "focus"));
  // Popping out the other one while this window is open switches what it shows.
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<MiniMode>("mini-mode", (e) => setMode(e.payload === "countdown" ? "countdown" : "focus"))
      .then((u) => (alive ? (unlisten = u) : u()))
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
  return mode === "countdown" ? <MiniCountdown /> : <MiniFocus />;
}

/** The countdown in the small window: time left in big digits, what it counts down to, and a bar. */
function MiniCountdown() {
  const [c, setC, loadError] = useCountdown();
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const running = c?.atMs != null;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [running]);
  const { miniGlass } = useUi();

  async function act(run: () => Promise<Countdown>) {
    setError(null);
    try {
      setC(await run());
    } catch (err) {
      setError(String(err));
    }
  }

  const left = c?.atMs != null ? c.atMs - now : 0;
  const span = c?.atMs != null ? Math.max(1, c.atMs - c.setMs) : 1;
  const progress = c?.done ? 1 : running ? Math.min(1, Math.max(0, 1 - left / span)) : 0;
  return (
    <main className="mini" data-tauri-drag-region>
      <h1 className="sr-only">Countdown</h1>
      {miniGlass === "lens" && <GlassLens className="mini-lens" />}
      <button type="button" className="mini-exit" aria-label="Back to the full Kairos window" title="Back to full view" onClick={() => void exitMiniTimer()}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 13.5 7 9M3 9h4v4M13.5 2.5 9 7M9 3v4h4" /></svg>
      </button>
      <div className="mini-time" data-tauri-drag-region>
        {c?.done ? "0:00" : running ? formatLeft(left) : "--:--"}
      </div>
      <div className="mini-controls" data-tauri-drag-region>
        {c?.done && (
          <button type="button" className="mini-play mini-text" title="Done" onClick={() => void act(dismissCountdown)}>
            OK
          </button>
        )}
        {running && (
          <button type="button" className="mini-play" aria-label="Cancel the countdown" title="Cancel" onClick={() => void act(cancelCountdown)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        )}
        <span className="mini-count" data-tauri-drag-region title={c?.name || undefined}>
          {c?.done ? "Time's up" : running ? `until ${c!.label}` : "No countdown"}
        </span>
      </div>
      <div className="mini-progress" data-status={c?.done ? "finished" : "running"} aria-hidden="true">
        <span style={{ width: `${progress * 100}%` }} />
      </div>
      {loadError && <p className="error small">{loadError}</p>}
      {error && <p className="error small" role="alert">{error}</p>}
    </main>
  );
}

/**
 * The small always-on-top timer window (like the compact view in Windows Clock): just the time,
 * one play/pause button and the session count. The whole background drags the window; the
 * button controls the same timer as the main window.
 */
function MiniFocus() {
  const [timer, setTimer] = useTimer();
  const [error, setError] = useState<string | null>(null);
  const [startId, setStartId] = useState<string | null>(null);
  const [startMs, setStartMs] = useState(0);

  // What "Start" would run: the last used preset, else the first one.
  useEffect(() => {
    Promise.all([listPresets(), lastPresetId()])
      .then(([presets, last]) => {
        const p = presets.find((x) => x.id === last) ?? presets[0];
        setStartId(p?.id ?? null);
        setStartMs((p?.focusS ?? 0) * 1000);
      })
      .catch((err: unknown) => setError(String(err)));
  }, []);

  async function act(run: () => Promise<TimerSnapshot>) {
    setError(null);
    try {
      setTimer(await run());
    } catch (err) {
      setError(String(err));
    }
  }

  const snap = timer.kind === "ready" ? timer.value : null;
  const { miniGlass } = useUi();

  return (
    <main className="mini" data-tauri-drag-region>
      <h1 className="sr-only">Focus timer</h1>
      {miniGlass === "lens" && <GlassLens className="mini-lens" />}
      <button type="button" className="mini-exit" aria-label="Back to the full Kairos window" title="Back to full view" onClick={() => void exitMiniTimer()}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 13.5 7 9M3 9h4v4M13.5 2.5 9 7M9 3v4h4" /></svg>
      </button>
      {snap && <MiniClock snap={snap} idleDurationMs={startMs} />}
      <div className="mini-controls" data-tauri-drag-region>
        {snap && (snap.status === "idle" || snap.status === "finished") && (
          <button type="button" className="mini-play" aria-label="Start focus" title="Start focus" disabled={!startId} onClick={() => startId && void act(() => startTimer(startId))}>
            <PlayIcon />
          </button>
        )}
        {snap?.status === "running" && (
          <button type="button" className="mini-play" aria-label="Pause" title="Pause" onClick={() => void act(pauseTimer)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5v9M10.5 3.5v9" /></svg>
          </button>
        )}
        {snap?.status === "paused" && (
          <button type="button" className="mini-play" aria-label="Resume" title="Resume" onClick={() => void act(resumeTimer)}>
            <PlayIcon />
          </button>
        )}
        {snap?.status === "waiting" && (
          <button type="button" className="mini-play" aria-label="Start next" title="Start next" onClick={() => void act(continueTimer)}>
            <PlayIcon />
          </button>
        )}
        {snap && snap.status !== "idle" && (
          <span className="mini-count" aria-label={`Session ${sessionCount(snap, " of ")}`} data-tauri-drag-region>
            {sessionCount(snap, "/")}
          </span>
        )}
      </div>
      {timer.kind === "error" && <p className="error small">{timer.message}</p>}
      {error && <p className="error small" role="alert">{error}</p>}
    </main>
  );
}

/** Time left in big digits, plus a thin bar along the bottom edge: blue for focus, green for a break, yellow when paused. */
function MiniClock(props: { snap: TimerSnapshot; idleDurationMs: number }) {
  const s = props.snap;
  const remaining = useRemaining(s);
  const idle = s.status === "idle";
  const endless = idle ? props.idleDurationMs >= ENDLESS_FOCUS_MS : s.status !== "finished" && isEndless(s);
  // Endless focus counts up, and the bar sweeps once a minute.
  const shown = endless ? (idle ? 0 : s.durationMs - remaining) : idle ? props.idleDurationMs : remaining;
  const progress = endless
    ? idle ? 0 : (shown % 60_000) / 60_000
    : s.status === "finished" ? 1 : idle || s.durationMs <= 0 ? 0 : Math.min(1, 1 - remaining / s.durationMs);
  const isBreak = s.phase !== "focus" && !idle;
  return (
    <>
      <div className="mini-time" data-tauri-drag-region>
        {formatClock(endless ? shown / 1000 : Math.ceil(shown / 1000))}
      </div>
      <div className="mini-progress" data-break={isBreak} data-status={s.status} aria-hidden="true">
        <span style={{ width: `${progress * 100}%` }} />
      </div>
    </>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3l8 5-8 5z" fill="currentColor" />
    </svg>
  );
}
