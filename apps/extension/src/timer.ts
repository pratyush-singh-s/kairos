/**
 * The extension's own focus timer, for when neither the Kairos app nor the phone is there:
 * focus, break, focus, break... for a number of rounds. Sites are blocked during focus (also
 * while it's paused) and not on breaks. Only plain data and pure functions here; background.ts
 * runs it with an alarm.
 */

export interface TimerPrefs {
  focusMin: number;
  /** 0 = no breaks: the rounds follow each other. */
  breakMin: number;
  rounds: number;
}

export interface TimerState {
  phase: "focus" | "break";
  /** 1-based. */
  round: number;
  rounds: number;
  focusMin: number;
  breakMin: number;
  /** When this phase ends (ms), counting as if it weren't paused. */
  endsAt: number;
  /** When it was paused, or null while it runs. */
  pausedAt: number | null;
}

export const DEFAULT_TIMER_PREFS: TimerPrefs = { focusMin: 25, breakMin: 5, rounds: 4 };

/** Ready-made lengths shown as buttons. */
export const TIMER_PRESETS: TimerPrefs[] = [
  { focusMin: 25, breakMin: 5, rounds: 4 },
  { focusMin: 50, breakMin: 10, rounds: 2 },
  { focusMin: 90, breakMin: 15, rounds: 1 },
];

export const LIMITS = { focusMin: [1, 240], breakMin: [0, 60], rounds: [1, 12] } as const;

/** A paused focus phase has no end time; blocking holds this long, like the app's pause. */
const PAUSED_HOLD_MS = 24 * 60 * 60_000;

const clamp = (n: unknown, [lo, hi]: readonly [number, number], fallback: number): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;

export function cleanPrefs(p: Partial<TimerPrefs> | undefined): TimerPrefs {
  const d = DEFAULT_TIMER_PREFS;
  return {
    focusMin: clamp(p?.focusMin, LIMITS.focusMin, d.focusMin),
    breakMin: clamp(p?.breakMin, LIMITS.breakMin, d.breakMin),
    rounds: clamp(p?.rounds, LIMITS.rounds, d.rounds),
  };
}

const minutes = (m: number) => m * 60_000;

export function startTimer(prefs: TimerPrefs, now = Date.now()): TimerState {
  const p = cleanPrefs(prefs);
  return { phase: "focus", round: 1, rounds: p.rounds, focusMin: p.focusMin, breakMin: p.breakMin, endsAt: now + minutes(p.focusMin), pausedAt: null };
}

export function timeLeft(t: TimerState, now = Date.now()): number {
  return Math.max(0, t.endsAt - (t.pausedAt ?? now));
}

export function pauseTimer(t: TimerState, now = Date.now()): TimerState {
  return t.pausedAt === null ? { ...t, pausedAt: now } : t;
}

export function resumeTimer(t: TimerState, now = Date.now()): TimerState {
  return t.pausedAt === null ? t : { ...t, endsAt: t.endsAt + (now - t.pausedAt), pausedAt: null };
}

/** The phase after this one, starting at `from`; null when the last focus round is done. */
export function nextPhase(t: TimerState, from: number): TimerState | null {
  if (t.phase === "focus") {
    if (t.round >= t.rounds) return null;
    if (t.breakMin > 0) return { ...t, phase: "break", endsAt: from + minutes(t.breakMin), pausedAt: null };
  }
  return { ...t, phase: "focus", round: t.round + 1, endsAt: from + minutes(t.focusMin), pausedAt: null };
}

/**
 * Moves past every phase that has ended by `now` (the browser may have been closed through
 * several). Each phase starts when the one before it ended.
 */
export function catchUp(t: TimerState | null, now = Date.now()): { timer: TimerState | null; changed: boolean } {
  let cur = t;
  let changed = false;
  while (cur && cur.pausedAt === null && cur.endsAt <= now) {
    cur = nextPhase(cur, cur.endsAt);
    changed = true;
  }
  return { timer: cur, changed };
}

/** The blocking session the timer asks for: during focus only. */
export function timerSession(t: TimerState | null, now = Date.now()): { until: number; source: "timer" } | null {
  if (!t || t.phase !== "focus") return null;
  if (t.pausedAt !== null) return { until: t.pausedAt + PAUSED_HOLD_MS, source: "timer" };
  return t.endsAt > now ? { until: t.endsAt, source: "timer" } : null;
}

/** "Focus 2 of 4", "Break 1 of 3" (breaks come between rounds). */
export function phaseLabel(t: TimerState): string {
  if (t.phase === "break") return `Break · next is focus ${t.round + 1} of ${t.rounds}`;
  return t.rounds > 1 ? `Focus ${t.round} of ${t.rounds}` : "Focus";
}
