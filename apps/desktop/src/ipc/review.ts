import { invoke } from "@tauri-apps/api/core";
import { today } from "./tasks";

/** Mirrors `DeadlineFocus` in crates/focus-store/src/review.rs. */
export interface DeadlineFocus {
  deadlineId: string;
  seconds: number;
  sessions: number;
}

/** Mirrors `DeadlineFocusState` in src-tauri/src/commands.rs (and the phone's focus.rs). */
export interface DeadlineFocusState {
  /** All focus logged against each deadline. */
  totals: DeadlineFocus[];
  /** The deadline whose focus session is running on this device now. */
  active: { deadlineId: string; leftMs: number; paused: boolean } | null;
}

/** Mirrors `ReviewDeadline` in review.rs. */
export interface ReviewDeadline {
  id: string;
  title: string;
  dueAt: number;
  completedAt: number | null;
  color: string | null;
  outcome: "hit" | "missed" | "open";
  focusSeconds: number;
}

/** Mirrors `WeekReview` in review.rs. */
export interface WeekReview {
  focusByDay: number[];
  focusSeconds: number;
  prevFocusSeconds: number;
  sessions: number;
  deadlineFocusSeconds: number;
  deadlines: ReviewDeadline[];
  blockedTotal: number;
  topBlocked: { name: string; kind: "site" | "app"; count: number }[];
}

/** One focus session of `minutes` for a deadline; blocking is on while it runs. */
export const startDeadlineFocus = (deadlineId: string, minutes: number) =>
  invoke<void>("deadline_focus_start", { deadlineId, minutes, today: today() });
export const stopDeadlineFocus = () => invoke<void>("deadline_focus_stop");
export const deadlineFocusState = () => invoke<DeadlineFocusState>("deadline_focus_state");
/** `bounds`: the edges of the week's days, oldest first. */
export const loadWeekReview = (bounds: number[]) => invoke<WeekReview>("weekly_review", { bounds });
