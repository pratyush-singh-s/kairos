import { invoke } from "@tauri-apps/api/core";

export function getCloseToTray(): Promise<boolean> {
  return invoke<boolean>("get_close_to_tray");
}

export function setCloseToTray(enabled: boolean): Promise<void> {
  return invoke("set_close_to_tray", { enabled });
}

export function getStartWithWindows(): Promise<boolean> {
  return invoke<boolean>("get_start_with_windows");
}

export function setStartWithWindows(enabled: boolean): Promise<void> {
  return invoke("set_start_with_windows", { enabled });
}

export function quitApp(): Promise<void> {
  return invoke("quit_app");
}
