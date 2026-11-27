import { invoke } from "@tauri-apps/api/core";

/** "off" = allowed, "focus" = blocked during focus, "always" = always blocked. */
export type PrivateMode = "off" | "focus" | "always";

export interface PrivateStatus {
  mode: PrivateMode;
  /** Private windows are switched off right now. */
  blocked: boolean;
  error: string | null;
}

export function getPrivateWindows(): Promise<PrivateStatus> {
  return invoke<PrivateStatus>("get_private_windows");
}

/** May show one Windows permission prompt the first time. */
export function setPrivateWindows(mode: PrivateMode): Promise<PrivateStatus> {
  return invoke<PrivateStatus>("set_private_windows", { mode });
}
