import { invoke } from "@tauri-apps/api/core";

export type TrackingMode = "off" | "focus" | "always";

/** Mirrors `AppTime` in crates/focus-store/src/activity.rs. */
export interface AppTime {
  name: string;
  seconds: number;
}

export const getTrackingMode = () => invoke<TrackingMode>("get_tracking_mode");
export const setTrackingMode = (mode: TrackingMode) => invoke<void>("set_tracking_mode", { mode });
export const clearActivity = () => invoke<void>("clear_activity");

/** Time per program between two moments (ms), most used first. */
export const getAppTotals = (fromMs: number, toMs: number) => invoke<AppTime[]>("app_totals", { fromMs, toMs });
