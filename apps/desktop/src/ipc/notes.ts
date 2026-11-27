import { invoke } from "@tauri-apps/api/core";

/** "text": typed rich text. "ink": handwritten on a drawing board. */
export type NoteKind = "text" | "ink";

/** Mirrors `Note` in crates/focus-store/src/notes.rs. */
export interface Note {
  id: string;
  title: string;
  pinned: boolean;
  /** The folder it is in, as a path ("School/Physics"); null = not in a folder. */
  folder: string | null;
  kind: NoteKind;
  /** The editor's JSON document, or a handwritten note's strokes (see InkBoard); "" = empty. */
  body: string;
  plainText: string;
  createdAt: number;
  editedAt: number;
}

/** Mirrors `NoteSummary` in crates/focus-store/src/notes.rs. */
export interface NoteSummary {
  id: string;
  title: string;
  pinned: boolean;
  folder: string | null;
  kind: NoteKind;
  preview: string;
  editedAt: number;
}

/** The note the Notes page should open next (set by the dashboard's pinned notes). */
export const OPEN_NOTE_KEY = "focus.openNote";

export const listNotes = (search: string) => invoke<NoteSummary[]>("list_notes", { search: search.trim() || null });
export const getNote = (id: string) => invoke<Note | null>("get_note", { id });
export const createNote = (kind: NoteKind = "text") => invoke<Note>("create_note", { kind });
export const saveNote = (id: string, title: string, body: string, plainText: string) =>
  invoke<Note>("save_note", { id, title, body, plainText });
export const setNotePinned = (id: string, pinned: boolean) => invoke<void>("set_note_pinned", { id, pinned });
/** Every folder, parents included, in name order ("School", "School/Physics"). */
export const listNoteFolders = () => invoke<string[]>("list_note_folders");
/** Makes an empty folder; resolves to its tidy path. */
export const addNoteFolder = (path: string) => invoke<string>("add_note_folder", { path });
/** Puts a note in a folder (null = no folder). */
export const setNoteFolder = (id: string, folder: string | null) => invoke<void>("set_note_folder", { id, folder });
/** Renames or moves a folder with everything in it (to null = up to the top level). */
export const moveNoteFolder = (from: string, to: string | null) => invoke<void>("move_note_folder", { from, to });
/** Removes a folder; what was in it moves up into its parent. Notes are never deleted. */
export const removeNoteFolder = (path: string) => invoke<void>("remove_note_folder", { path });
export const deleteNotes = (ids: string[]) => invoke<void>("delete_notes", { ids });
export const restoreNotes = (ids: string[]) => invoke<void>("restore_notes", { ids });

/** Mirrors `Attachment` in crates/focus-store/src/attachments.rs. */
export interface NoteAttachment {
  id: string;
  noteId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: number;
  /** False while the file is still on another device (it comes with the next sync). */
  available: boolean;
}

export const listNoteAttachments = (noteId: string) => invoke<NoteAttachment[]>("list_note_attachments", { noteId });
/** Opens the file picker (the system one on the phone); [] when it is closed. */
export const attachFiles = (noteId: string) => invoke<NoteAttachment[]>("attach_files", { noteId });
export const openAttachment = (id: string) => invoke<void>("open_attachment", { id });
/** Saves a copy (a save dialog on the PC, Downloads/Focus on the phone); where it went, or null. */
export const saveAttachment = (id: string) => invoke<string | null>("save_attachment", { id });
export const removeAttachment = (id: string) => invoke<void>("remove_attachment", { id });
export const restoreAttachment = (id: string) => invoke<void>("restore_attachment", { id });

/** Saves a made file (a save dialog on the PC, Android's save screen on the phone); where it went, or null. */
export const saveExport = (name: string, bytes: Uint8Array) =>
  invoke<string | null>("save_export", bytes, { headers: { "x-file-name": encodeURIComponent(name) } });
