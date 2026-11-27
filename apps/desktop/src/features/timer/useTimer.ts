import { useEffect, useState } from "react";
import { getTimer, onTimerChanged, type TimerSnapshot } from "../../ipc/timer";
import type { Loadable } from "../../useCommand";

/** The timer as the native core sees it, kept current by its `timer-changed` events. */
export function useTimer(): [Loadable<TimerSnapshot>, (s: TimerSnapshot) => void] {
  const [state, setState] = useState<Loadable<TimerSnapshot>>({ kind: "loading" });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    onTimerChanged((s) => setState({ kind: "ready", value: s }))
      .then((u) => (alive ? (unlisten = u) : u()))
      .catch(() => {});
    getTimer()
      .then((s) => setState({ kind: "ready", value: s }))
      .catch((err: unknown) => setState({ kind: "error", message: String(err) }));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return [state, (s) => setState({ kind: "ready", value: s })];
}

/** Milliseconds left, recomputed every animation frame while running so the ring moves smoothly. */
export function useRemaining(s: TimerSnapshot): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (s.status !== "running") return;
    let frame = requestAnimationFrame(function loop() {
      setNow(Date.now());
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [s.status, s.endsAtMs]);
  if (s.status === "running" && s.endsAtMs !== null) return Math.max(0, s.endsAtMs - now);
  return s.remainingMs;
}
