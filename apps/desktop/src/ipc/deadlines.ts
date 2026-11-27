import { invoke } from "@tauri-apps/api/core";
import { today, type Task } from "./tasks";

export type Viz = "ring" | "grid" | "both";
/** How the day progress is drawn: rows of cells, or one tall bar per day. */
export type ProgressStyle = "grid" | "bars";
export type CellShape = "rounded" | "circle" | "square";

/** Mirrors `Deadline` in crates/focus-store/src/deadlines.rs. Times are UTC milliseconds. */
export interface Deadline {
  id: string;
  title: string;
  description: string;
  startAt: number;
  dueAt: number;
  allDay: boolean;
  viz: Viz;
  color: string | null;
  progressStyle: ProgressStyle;
  cellShape: CellShape;
  /** Cells per row; null = automatic. */
  gridCols: number | null;
  completedAt: number | null;
  /** 0-based day numbers from the start day that were marked done. */
  markedDays: number[];
  /** The deadline's own checklist. */
  tasks: Task[];
}

/** Mirrors `DeadlineInput` in crates/focus-store/src/deadlines.rs. */
export interface DeadlineInput {
  title: string;
  description: string;
  /** null = now (new) or unchanged (edit). */
  startAt: number | null;
  dueAt: number;
  allDay: boolean;
  viz: Viz;
  color: string | null;
  progressStyle: ProgressStyle;
  cellShape: CellShape;
  gridCols: number | null;
}

/** The editable fields of a deadline as they are now (start kept). */
export function deadlineInputOf(d: Deadline): DeadlineInput {
  return {
    title: d.title,
    description: d.description,
    startAt: null,
    dueAt: d.dueAt,
    allDay: d.allDay,
    viz: d.viz,
    color: d.color,
    progressStyle: d.progressStyle,
    cellShape: d.cellShape,
    gridCols: d.gridCols,
  };
}

export const listDeadlines = () => invoke<Deadline[]>("list_deadlines", { today: today() });
export const createDeadline = (input: DeadlineInput) => invoke<Deadline>("create_deadline", { input, today: today() });
export const updateDeadline = (id: string, input: DeadlineInput) =>
  invoke<Deadline>("update_deadline", { id, input, today: today() });
export const setDeadlineCompleted = (id: string, completed: boolean) =>
  invoke<Deadline>("set_deadline_completed", { id, completed, today: today() });
export const markDeadlineDay = (id: string, dayIndex: number, done: boolean) =>
  invoke<Deadline>("mark_deadline_day", { id, dayIndex, done, today: today() });
export const deleteDeadlines = (ids: string[]) => invoke<void>("delete_deadlines", { ids });
export const restoreDeadlines = (ids: string[]) => invoke<void>("restore_deadlines", { ids });
