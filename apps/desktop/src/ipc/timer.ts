import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type TimerStatus = "idle" | "running" | "paused" | "waiting" | "finished";
export type TimerPhase = "focus" | "short_break" | "long_break";

/** Mirrors `Snapshot` in crates/focus-timer/src/lib.rs. Times are milliseconds. */
export interface TimerSnapshot {
  status: TimerStatus;
  phase: TimerPhase;
  session: number;
  sessions: number;
  durationMs: number;
  remainingMs: number;
  /** Wall-clock end of the current phase; set only while running. */
  endsAtMs: number | null;
  presetId: string | null;
  presetName: string | null;
}

export const getTimer = () => invoke<TimerSnapshot>("timer_state");
export const startTimer = (presetId: string) => invoke<TimerSnapshot>("timer_start", { presetId });
export const pauseTimer = () => invoke<TimerSnapshot>("timer_pause");
export const resumeTimer = () => invoke<TimerSnapshot>("timer_resume");
export const skipPhase = () => invoke<TimerSnapshot>("timer_skip");
export const stopTimer = () => invoke<TimerSnapshot>("timer_stop");
export const continueTimer = () => invoke<TimerSnapshot>("timer_continue");

/** Called whenever the timer changes, including when a phase ends while the window is hidden. */
export function onTimerChanged(handler: (s: TimerSnapshot) => void): Promise<UnlistenFn> {
  return listen<TimerSnapshot>("timer-changed", (e) => handler(e.payload));
}

export const PHASE_LABEL: Record<TimerPhase, string> = {
  focus: "Focus",
  short_break: "Short break",
  long_break: "Long break",
};

/** Mirrors ENDLESS_FOCUS_MS in crates/focus-timer: a preset saved with Focus left blank. */
export const ENDLESS_FOCUS_MS = 86_400_000;
export const ENDLESS_FOCUS_S = ENDLESS_FOCUS_MS / 1000;

/** One open-ended focus session that counts up until you finish it. */
/** Mirrors REPEAT_SESSIONS in crates/focus-timer: a preset saved with Sessions left blank. */
export const REPEAT_SESSIONS = 24;

/** The run goes focus, break, focus … until stopped (the timer reports its sessions as u32::MAX). */
export const repeats = (s: { sessions: number }) => s.sessions > 1_000_000;

/** "3 / 4", or "3" when the run repeats until stopped. */
export const sessionCount = (s: { session: number; sessions: number }, sep = " / ") => (repeats(s) ? `${s.session}` : `${s.session}${sep}${s.sessions}`);

export function isEndless(s: TimerSnapshot): boolean {
  return s.phase === "focus" && s.durationMs >= ENDLESS_FOCUS_MS;
}

export function isActive(s: TimerSnapshot): boolean {
  return s.status === "running" || s.status === "paused" || s.status === "waiting";
}
