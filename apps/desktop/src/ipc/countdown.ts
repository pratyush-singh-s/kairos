import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `Countdown` in src-tauri/src/countdown.rs. Times are ms since 1970. */
export interface Countdown {
  atMs: number | null;
  setMs: number;
  label: string;
  name: string;
  done: boolean;
  /** "Count as focus": a focus session runs until the countdown's time. */
  focus: boolean;
}

export const getCountdown = () => invoke<Countdown>("countdown_get");
export const startCountdown = (atMs: number, label: string, name: string, focus = false) =>
  invoke<Countdown>("countdown_start", { atMs, label, name, focus });
export const cancelCountdown = () => invoke<Countdown>("countdown_cancel");
export const dismissCountdown = () => invoke<Countdown>("countdown_dismiss");

export function onCountdownChanged(handler: (c: Countdown) => void): Promise<UnlistenFn> {
  return listen<Countdown>("countdown-changed", (e) => handler(e.payload));
}
