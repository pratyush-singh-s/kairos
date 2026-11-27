import { invoke } from "@tauri-apps/api/core";
import { today } from "./tasks";

/** Mirrors `DayPlan` in crates/focus-store/src/day_plan.rs. */
export interface DayPlan {
  date: string;
  /** Up to three to-do ids, most important first. */
  top: string[];
  reviewed: boolean;
}

export interface DayPlanView {
  plan: DayPlan;
  /** Local hour (0–23) from which the evening review shows. */
  reviewHour: number;
}

export const getDayPlan = () => invoke<DayPlanView>("get_day_plan", { today: today() });
export const saveDayPlan = (plan: DayPlan) => invoke<DayPlanView>("save_day_plan", { plan });
export const setReviewHour = (hour: number) => invoke<DayPlanView>("set_review_hour", { hour, today: today() });
