import { invoke } from "@tauri-apps/api/core";

/** Mirrors `BackupInfo` in src-tauri/src/backup.rs. */
export interface BackupInfo {
  path: string;
  bytes: number;
  attachments: number;
}

/** Asks where to save; null when the dialog was closed. */
export const makeBackup = (password: string) => invoke<BackupInfo | null>("make_backup", { password });
/** Asks for the file; Focus restarts with it. Null when the dialog was closed. */
export const restoreBackup = (password: string) => invoke<number | null>("restore_backup", { password });
