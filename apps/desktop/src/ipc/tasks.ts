import { invoke } from "@tauri-apps/api/core";
import { localDay } from "@focus/core";

export type Priority = "low" | "normal" | "high";

/** Mirrors `Task` in crates/focus-store/src/tasks.rs. Dates are local YYYY-MM-DD. */
export interface Task {
  id: string;
  title: string;
  /** Ticked. A repeating task is only ticked on the day it was done. */
  done: boolean;
  doneDate: string | null;
  dueDate: string | null;
  priority: Priority;
  /** Weekday bits, Sunday = 1 ... Saturday = 64; 0 = one-off. */
  repeatDays: number;
  /** The dot before the name, "#rrggbb"; null = no colour. */
  color: string | null;
  deadlineId: string | null;
  /** Local "HH:MM" on the task's day. */
  startTime: string | null;
  endTime: string | null;
  /** Planned minutes. */
  durationMin: number | null;
  /** Small label under the name. */
  category: string | null;
  /** Free text shown on the card and in the editor; "" = none. */
  description: string;
  /** The workspace; null = Everyday. */
  spaceId: string | null;
  /** In a day-by-day plan, the step's day (1 = Day 1); null = no day yet. */
  planDay: number | null;
  createdAt: number;
}

/** Mirrors `TaskInput` in crates/focus-store/src/tasks.rs. */
export interface TaskInput {
  title: string;
  dueDate: string | null;
  priority: Priority;
  repeatDays: number;
  color: string | null;
  /** Only used when creating: puts the task on that deadline's checklist. */
  deadlineId?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  durationMin?: number | null;
  category?: string | null;
  description?: string;
  spaceId?: string | null;
  planDay?: number | null;
}

/** The editable fields of an existing task, e.g. to move it to another day. */
export function inputOf(t: Task): TaskInput {
  return {
    title: t.title,
    dueDate: t.dueDate,
    priority: t.priority,
    repeatDays: t.repeatDays,
    color: t.color,
    startTime: t.startTime,
    endTime: t.endTime,
    durationMin: t.durationMin,
    category: t.category,
    description: t.description,
    spaceId: t.spaceId,
    planDay: t.planDay,
  };
}

/** Today's local date; read fresh on every call so the list rolls over at midnight. */
export const today = () => localDay(new Date()).isoDate;

export const listTasks = () => invoke<Task[]>("list_tasks", { today: today() });
export const createTask = (input: TaskInput) => invoke<Task>("create_task", { input, today: today() });
export const updateTask = (id: string, input: TaskInput) => invoke<Task>("update_task", { id, input, today: today() });
export const setTaskDone = (id: string, done: boolean) => invoke<Task>("set_task_done", { id, done, today: today() });
export const deleteTasks = (ids: string[]) => invoke<void>("delete_tasks", { ids });
export const restoreTasks = (ids: string[]) => invoke<void>("restore_tasks", { ids });
/** Deletes the ticked one-off tasks of one space (null = Everyday). */
export const clearDoneTasks = (spaceId: string | null) => invoke<string[]>("clear_done_tasks", { spaceId });
export const setTaskColor = (id: string, color: string | null) => invoke<Task>("set_task_color", { id, color, today: today() });
/** Colours used last on tasks, newest first (up to 5). */
export const recentTaskColors = () => invoke<string[]>("recent_task_colors");
