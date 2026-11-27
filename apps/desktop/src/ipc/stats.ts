import { invoke } from "@tauri-apps/api/core";
import type { StatSession } from "@focus/core";

/** Mirrors `AppStat` in crates/focus-store/src/stats.rs. */
export interface AppStat {
  name: string;
  /** All tracked time in the period. */
  seconds: number;
  /** The part of it during focus sessions. */
  focusSeconds: number;
}

/** Mirrors `StatsData` in crates/focus-store/src/stats.rs. */
export interface StatsData {
  sessions: StatSession[];
  /** Active computer seconds per bucket. */
  active: number[];
  /** Seconds this PC was on per bucket (idle and locked time included). */
  pcOn: number[];
  /** Focus seconds timed on this PC per bucket; never more than `pcOn`. */
  focusHere: number[];
  apps: AppStat[];
  distractions: { blocked: number; continued: number; topDomains: { domain: string; count: number }[] };
  focusStarts: number[];
  trackedSince: number | null;
  /** "Why are you here?" answers in the period, most frequent first. */
  reasons?: { text: string; count: number; what: string[] }[];
}

/** `bounds`: bucket edges, oldest first; `streakFromMs`: how far back to look for streaks. */
export const loadStats = (bounds: number[], streakFromMs: number) => invoke<StatsData>("load_stats", { bounds, streakFromMs });
