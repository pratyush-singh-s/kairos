import { invoke } from "@tauri-apps/api/core";

/** Mirrors `SoundSettings` in src-tauri/src/commands.rs. */
export interface SoundSettings {
  on: boolean;
  /** 0–100 */
  volume: number;
}

/** Mirrors `Chime` in src-tauri/src/sound.rs. */
export type Chime = "to_break" | "to_focus" | "finished";

export const getSoundSettings = () => invoke<SoundSettings>("get_sound_settings");
export const saveSoundSettings = (settings: SoundSettings) => invoke<void>("set_sound_settings", { settings });
export const previewSound = (chime: Chime, volume: number) => invoke<void>("preview_sound", { chime, volume });
