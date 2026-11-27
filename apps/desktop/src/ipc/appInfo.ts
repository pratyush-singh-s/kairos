import { invoke } from "@tauri-apps/api/core";

/** Mirrors `AppInfo` in src-tauri/src/commands.rs. */
export interface AppInfo {
  version: string;
  tauriVersion: string;
  os: string;
  arch: string;
  dataDir: string;
}

export function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}
