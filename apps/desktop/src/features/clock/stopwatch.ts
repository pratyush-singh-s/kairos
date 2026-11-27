import { useSyncExternalStore } from "react";

/**
 * The stopwatch lives outside the page, so it keeps running when you open another page, and it is
 * saved in this PC's browser storage, so it keeps counting across a restart too.
 */
export interface StopwatchState {
  /** When it was last started (ms since 1970); null while stopped. */
  startedAt: number | null;
  /** Time counted before `startedAt`. */
  baseMs: number;
  /** Total time at each lap, oldest first. */
  laps: number[];
}

const KEY = "focus.stopwatch";
const EMPTY: StopwatchState = { startedAt: null, baseMs: 0, laps: [] };

function load(): StopwatchState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as Partial<StopwatchState>;
    return {
      startedAt: typeof v.startedAt === "number" ? v.startedAt : null,
      baseMs: typeof v.baseMs === "number" ? v.baseMs : 0,
      laps: Array.isArray(v.laps) ? v.laps.filter((n): n is number => typeof n === "number") : [],
    };
  } catch {
    return EMPTY;
  }
}

let state = load();
const listeners = new Set<() => void>();

function set(next: StopwatchState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: it still works until the app closes.
  }
  listeners.forEach((l) => l());
}

export function elapsed(s: StopwatchState, now = Date.now()): number {
  return s.baseMs + (s.startedAt === null ? 0 : Math.max(0, now - s.startedAt));
}

export const stopwatch = {
  start() {
    if (state.startedAt === null) set({ ...state, startedAt: Date.now() });
  },
  pause() {
    if (state.startedAt !== null) set({ ...state, baseMs: elapsed(state), startedAt: null });
  },
  lap() {
    if (state.startedAt !== null) set({ ...state, laps: [...state.laps, elapsed(state)] });
  },
  reset() {
    set(EMPTY);
  },
};

export function useStopwatch(): StopwatchState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** 1:02:03.45 or 02:03.45 */
export function formatStopwatch(ms: number): string {
  const cs = Math.floor(ms / 10) % 100;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${h > 0 ? `${h}:` : ""}${p(m)}:${p(s)}.${p(cs)}`;
}
