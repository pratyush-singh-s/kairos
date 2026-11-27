import { invoke } from "@tauri-apps/api/core";

/** Mirrors `GoalStatus` in crates/focus-store/src/goals.rs. */
export interface GoalStatus {
  /** 0 = no goal. */
  goalMin: number;
  todayMin: number;
  streak: number;
  bestStreak: number;
  /** Minutes on each of the last 7 days, oldest first (the last is today). */
  week: number[];
}

export function goalStatus(): Promise<GoalStatus> {
  return invoke<GoalStatus>("goal_status");
}

export function setDailyGoal(minutes: number): Promise<GoalStatus> {
  return invoke<GoalStatus>("set_daily_goal", { minutes });
}
