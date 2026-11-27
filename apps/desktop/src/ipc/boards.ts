import { invoke } from "@tauri-apps/api/core";

/** Kinds of thing on a free board ("list", "card") or a case board ("pin", "sticky", "string"). */
export type BoardKind = "list" | "card" | "pin" | "sticky" | "string";

/** Mirrors `BoardItem` in crates/focus-store/src/boards.rs. `data` is ours to shape (see below). */
export interface BoardItem<D = Record<string, unknown>> {
  id: string;
  spaceId: string;
  kind: BoardKind;
  data: D;
  createdAt: number;
}

/** Mirrors `BoardItemInput`: an `id` that exists replaces that item's data. */
export interface BoardItemInput {
  id: string;
  spaceId: string;
  kind: BoardKind;
  data: Record<string, unknown>;
}

// ---- free board
export interface ListData {
  title: string;
  order: number;
}
export interface CardData {
  list: string;
  title: string;
  text?: string;
  color?: string | null;
  /** YYYY-MM-DD */
  due?: string | null;
  done?: boolean;
  order: number;
}

// ---- case board
/** What a pinned card shows: one of your notes, tasks, deadlines or free boards, or its own text. */
export interface PinRef {
  /** "board" = a free board (a space of kind "free"); `id` is the space's id. */
  type: "note" | "task" | "deadline" | "board";
  id: string;
}
/** How a pinned deadline shows the time left: a day count, a ring, or a box per day. */
export type DeadlineLook = "days" | "ring" | "boxes";
export interface PinData {
  x: number;
  y: number;
  title: string;
  text?: string;
  /** A symbol drawn on the card's picture. */
  icon?: string;
  /** Pinned deadlines only; missing means "days". */
  look?: DeadlineLook;
  ref?: PinRef | null;
  /** The pin's colour; missing means the theme's accent. */
  pin?: string | null;
}
export interface StickyData {
  x: number;
  y: number;
  text: string;
  color?: string;
  /** The pin's colour; missing means the theme's accent. */
  pin?: string | null;
}
export interface StringData {
  from: string;
  to: string;
  color?: string;
}

/** IDs made here so a string can point at a card before the card is saved. */
export const newBoardId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export const listBoardItems = (spaceId: string) => invoke<BoardItem[]>("list_board_items", { spaceId });
export const saveBoardItems = (items: BoardItemInput[]) => invoke<BoardItem[]>("save_board_items", { items });
/** Returns every ID removed (a list takes its cards, a pin its strings) for Undo. */
export const deleteBoardItems = (ids: string[]) => invoke<string[]>("delete_board_items", { ids });
export const restoreBoardItems = (ids: string[]) => invoke<void>("restore_board_items", { ids });
