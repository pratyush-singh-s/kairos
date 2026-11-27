import { useCallback, useEffect, useState } from "react";
import { formatClock, formatDurationShort } from "@focus/core";
import { useHistoryChanged } from "../../ipc/history";
import { deadlineFocusState, startDeadlineFocus, stopDeadlineFocus, type DeadlineFocusState } from "../../ipc/review";

const LENGTHS = [25, 45, 60, 90];
const LENGTH_KEY = "focus.deadlineFocusMinutes";

function savedLength(): number {
  try {
    const n = Number(localStorage.getItem(LENGTH_KEY));
    return LENGTHS.includes(n) ? n : 25;
  } catch {
    return 25;
  }
}

/** Focus logged against each deadline and the deadline being focused on now, kept fresh. */
export function useDeadlineFocus(): { state: DeadlineFocusState; reload: () => void } {
  const [state, setState] = useState<DeadlineFocusState>({ totals: [], active: null });
  const reload = useCallback(() => {
    deadlineFocusState().then(setState, () => {});
  }, []);
  useEffect(reload, [reload]);
  useHistoryChanged(reload);
  useHistoryChanged(reload, "timer-changed");
  useHistoryChanged(reload, "phone-blocking-changed");
  // Count down while a session runs; otherwise look again now and then (a session may end).
  const running = state.active !== null && !state.active.paused;
  useEffect(() => {
    const t = window.setInterval(reload, running ? 1000 : 30_000);
    return () => window.clearInterval(t);
  }, [reload, running]);
  return { state, reload };
}

/** "3h 20m in 5 sessions" logged for one deadline, or null. */
export function loggedFor(state: DeadlineFocusState, id: string): { seconds: number; sessions: number } | null {
  const t = state.totals.find((x) => x.deadlineId === id);
  return t && t.seconds > 0 ? t : null;
}

/**
 * "Start focus" on a pinned deadline: pick a length and start one focus session for it. Blocking
 * is on while it runs, and the time is logged against the deadline.
 */
export function DeadlineFocusPanel(props: { deadlineId: string; done: boolean; focus: { state: DeadlineFocusState; reload: () => void } }) {
  const { state, reload } = props.focus;
  const [minutes, setMinutes] = useState(savedLength);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logged = loggedFor(state, props.deadlineId);
  const mine = state.active?.deadlineId === props.deadlineId ? state.active : null;
  const other = state.active !== null && !mine;

  function pick(n: number) {
    setMinutes(n);
    try {
      localStorage.setItem(LENGTH_KEY, String(n));
    } catch {
      // Only a convenience.
    }
  }

  function run(f: () => Promise<void>) {
    setBusy(true);
    setError(null);
    f()
      .catch((e: unknown) => setError(String(e)))
      .finally(() => {
        setBusy(false);
        reload();
      });
  }

  return (
    <div className="case-focus" data-running={mine ? "true" : undefined}>
      <span className="case-looks-label">Focus on this</span>
      <p className="case-paper-line">
        <strong>Focused so far:</strong>{" "}
        {logged ? `${formatDurationShort(logged.seconds)} in ${logged.sessions} ${logged.sessions === 1 ? "session" : "sessions"}` : "nothing yet"}
      </p>
      {mine ? (
        <div className="case-focus-live">
          <span className="case-focus-dot" aria-hidden="true" />
          <span>
            {mine.paused ? "Paused" : "Focusing now"} · <span className="num">{formatClock(Math.ceil(mine.leftMs / 1000))}</span> left
          </span>
          <button type="button" className="button small-button" disabled={busy} onClick={() => run(stopDeadlineFocus)}>
            Stop
          </button>
        </div>
      ) : (
        <>
          <div className="case-focus-lengths" role="radiogroup" aria-label="How long">
            {LENGTHS.map((n) => (
              <button key={n} type="button" role="radio" aria-checked={minutes === n} onClick={() => pick(n)}>
                {n < 60 ? `${n}m` : `${n / 60}h`.replace(".5h", "h 30m")}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="button primary case-focus-start"
            disabled={busy || other || props.done}
            onClick={() => run(() => startDeadlineFocus(props.deadlineId, minutes))}
          >
            Start focus
          </button>
          <p className="case-paper-muted small">
            {props.done
              ? "This deadline is finished."
              : other
                ? "Another deadline's focus session is running."
                : "Blocking turns on until the session ends."}
          </p>
        </>
      )}
      {error && (
        <p className="case-paper-muted small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
