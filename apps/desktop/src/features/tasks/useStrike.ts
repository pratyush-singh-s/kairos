import { useEffect, useRef, useState, type SyntheticEvent } from "react";

/** How long the tick animation runs before the task is saved as done (and leaves the list). */
export const STRIKE_MS = 900;

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Ticking a task: a line slashes through the name, it blacks out, then the row folds away.
 * The save waits for the animation, so the list only reloads once it has played.
 * Unticking saves at once. If the row unmounts mid-animation the tick is still saved.
 */
export function useStrike(onToggle: (done: boolean) => void) {
  const [striking, setStriking] = useState(false);
  const timer = useRef<number | null>(null);
  const latest = useRef(onToggle);
  latest.current = onToggle;

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
        latest.current(true);
      }
    },
    [],
  );

  const toggle = (done: boolean, e?: SyntheticEvent<HTMLElement>) => {
    if (timer.current !== null) return;
    if (!done || reducedMotion()) {
      setStriking(false);
      latest.current(done);
      return;
    }
    // Fix the row's height so it can fold to 0 smoothly.
    const row = (e?.currentTarget as HTMLElement | undefined)?.closest("li");
    if (row) row.style.setProperty("--strike-h", `${row.offsetHeight}px`);
    setStriking(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      latest.current(true);
    }, STRIKE_MS);
  };

  return { striking, toggle };
}
