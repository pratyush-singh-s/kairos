import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import type { AppTime } from "./tracking";

/** Mirrors `SessionRow` in crates/focus-store/src/sessions.rs. Times are UTC milliseconds; lengths are seconds. */
export interface SessionRow {
  id: string;
  cycleId: string;
  sessionNumber: number;
  phase: "focus" | "short_break" | "long_break";
  startedAt: number;
  endedAt: number | null;
  plannedS: number;
  actualS: number | null;
  pausedS: number;
  outcome: "completed" | "interrupted" | "skipped" | "cancelled" | null;
  presetName: string | null;
  /** Programs used during this session (app tracking), most used first. */
  apps: AppTime[];
}

export const listHistory = (fromMs: number, toMs: number, includeBreaks: boolean) =>
  invoke<SessionRow[]>("list_history", { fromMs, toMs, includeBreaks });

export const deleteHistorySession = (id: string) => invoke<void>("delete_history_session", { id });

/** Calls `reload` whenever a session ends or is deleted (in this window or the other). */
export function useHistoryChanged(reload: () => void, event = "history-changed") {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    listen(event, () => reload())
      .then((u) => (alive ? (unlisten = u) : u()))
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [reload, event]);
}
