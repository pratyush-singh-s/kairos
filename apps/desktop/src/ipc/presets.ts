import { invoke } from "@tauri-apps/api/core";
import type { Preset } from "./database";

/** Mirrors `PresetInput` in crates/focus-store/src/presets.rs. Durations are in seconds. */
export interface PresetInput {
  name: string;
  focusS: number;
  shortBreakS: number;
  longBreakS: number;
  sessionsPerCycle: number;
  longBreakEvery: number;
  autoStartBreak: boolean;
  autoStartFocus: boolean;
}

export function createPreset(input: PresetInput): Promise<Preset> {
  return invoke<Preset>("create_preset", { input });
}

export function updatePreset(id: string, input: PresetInput): Promise<Preset> {
  return invoke<Preset>("update_preset", { id, input });
}

export function deletePreset(id: string): Promise<void> {
  return invoke("delete_preset", { id });
}

export function lastPresetId(): Promise<string | null> {
  return invoke<string | null>("last_preset_id");
}
