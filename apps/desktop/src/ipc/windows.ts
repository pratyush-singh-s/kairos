import { invoke } from "@tauri-apps/api/core";

/** The small always-on-top window, showing the focus timer or the countdown. */
export const openMiniTimer = (mode: "focus" | "countdown" = "focus") => invoke<void>("open_mini_timer", { mode });
export const closeMiniTimer = () => invoke<void>("close_mini_timer");
export const showMainWindow = () => invoke<void>("show_main_window");
/** Leaves pop-out mode: closes the mini timer and brings back the main window. */
export async function exitMiniTimer() {
  await showMainWindow();
  await closeMiniTimer();
}
