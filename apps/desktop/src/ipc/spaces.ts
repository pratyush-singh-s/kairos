import { invoke } from "@tauri-apps/api/core";

export type SpaceKind = "board" | "plan" | "free" | "case";

/** Week boards and plans hold tasks; free boards and case boards hold their own things (ipc/boards.ts). */
export const holdsTasks = (kind: SpaceKind) => kind === "board" || kind === "plan";

/** Mirrors `Space` in crates/focus-store/src/spaces.rs. */
export interface Space {
  id: string;
  name: string;
  /** "board" = a week board like Everyday; "plan" = Day 1, Day 2 ...; "free" = lists of cards; "case" = a detective board. */
  kind: SpaceKind;
  color: string | null;
  /** A plan's Day 1 (YYYY-MM-DD); null = not dated. */
  startDate: string | null;
  /** How many days a plan has. */
  days: number;
  createdAt: number;
}

/** Mirrors `SpaceInput` in crates/focus-store/src/spaces.rs. */
export interface SpaceInput {
  name: string;
  /** Only used when creating. */
  kind: SpaceKind;
  color: string | null;
  startDate: string | null;
  days: number;
}

export const spaceInputOf = (s: Space): SpaceInput => ({ name: s.name, kind: s.kind, color: s.color, startDate: s.startDate, days: s.days });

export const listSpaces = () => invoke<Space[]>("list_spaces");
export const createSpace = (input: SpaceInput) => invoke<Space>("create_space", { input });
export const updateSpace = (id: string, input: SpaceInput) => invoke<Space>("update_space", { id, input });
export const deleteSpace = (id: string) => invoke<void>("delete_space", { id });
export const restoreSpace = (id: string) => invoke<void>("restore_space", { id });
