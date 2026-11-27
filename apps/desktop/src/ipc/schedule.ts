import { invoke } from "@tauri-apps/api/core";

/** Mirrors `Schedule` in crates/focus-store/src/schedule.rs. */
export interface Schedule {
  id: string;
  name: string;
  /** Sunday = 1, Monday = 2 … Saturday = 64. */
  days: number;
  /** "09:00", 24-hour. */
  start: string;
  end: string;
  enabled: boolean;
  /** "focus": a focus session runs (and blocks). "block": blocking only, no session. Missing = focus. */
  kind?: ScheduleKind;
}

export type ScheduleKind = "focus" | "block";

/** A schedule's window that is open now. */
export interface ScheduleWindow {
  scheduleId: string;
  name: string;
  key: string;
  startedAtMs: number;
  endsAtMs: number;
  kind?: ScheduleKind;
}

export interface ScheduleView {
  schedules: Schedule[];
  current: ScheduleWindow | null;
}

export function getSchedules(): Promise<ScheduleView> {
  return invoke<ScheduleView>("get_schedules");
}

export function saveSchedules(schedules: Schedule[]): Promise<ScheduleView> {
  return invoke<ScheduleView>("save_schedules", { schedules });
}
