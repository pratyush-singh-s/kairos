import { invoke } from "@tauri-apps/api/core";

/** Mirrors `UpdateInfo` in src-tauri/src/updates.rs. */
export interface UpdateInfo {
  label: string;
  notes: string;
}

export function checkUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>("update_check");
}

/** Downloads, installs and restarts Kairos. */
export function installUpdate(): Promise<void> {
  return invoke<void>("update_install");
}
