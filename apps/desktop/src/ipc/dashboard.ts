import { invoke } from "@tauri-apps/api/core";
import { localDay } from "@focus/core";
import type { AppTime } from "./tracking";
import type { Task } from "./tasks";
import type { Deadline } from "./deadlines";

/** Mirrors `Dashboard` in crates/focus-store/src/dashboard.rs. */
export interface Dashboard {
  today: { focusSeconds: number; completedSessions: number; interruptedSessions: number };
  upcomingDeadlines: Deadline[];
  todayTasks: Task[];
  pinnedNotes: { id: string; title: string; preview: string }[];
  todayApps: AppTime[];
  /** Seconds this PC has been on today. */
  pcOnToday: number;
}

export function loadDashboard(now = new Date()): Promise<Dashboard> {
  const day = localDay(now);
  return invoke<Dashboard>("load_dashboard", {
    nowMs: now.getTime(),
    dayStartMs: day.startMs,
    dayEndMs: day.endMs,
    today: day.isoDate,
  }).then((d) => ({
    ...d,
    // The home page shows only today's tasks: unfinished ones from earlier days stay on the To-do page (Ps asked).
    todayTasks: d.todayTasks.filter((t) => t.done || t.repeatDays > 0 || t.dueDate === null || t.dueDate >= day.isoDate),
  }));
}
