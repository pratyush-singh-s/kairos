import { invoke } from "@tauri-apps/api/core";

/** Mirrors `StoreStatus` in crates/focus-store/src/store.rs. */
export interface DbStatus {
  path: string;
  schemaVersion: number;
  tableCount: number;
  sizeBytes: number;
  deviceId: string;
  presetCount: number;
}

/** Mirrors `Preset` in crates/focus-store/src/presets.rs. */
export interface Preset {
  id: string;
  name: string;
  focusS: number;
  shortBreakS: number;
  longBreakS: number;
  sessionsPerCycle: number;
  longBreakEvery: number;
  autoStartBreak: boolean;
  autoStartFocus: boolean;
  blockingProfileId: string | null;
}

export function getDbStatus(): Promise<DbStatus> {
  return invoke<DbStatus>("db_status");
}

export function listPresets(): Promise<Preset[]> {
  return invoke<Preset[]>("list_presets");
}
