import { invoke } from "@tauri-apps/api/core";
import { today } from "./tasks";

/** Mirrors `Captured` in crates/focus-store/src/capture.rs. */
export interface Captured {
  kind: "task" | "note";
  id: string;
  title: string;
}

export const quickCapture = (line: string) => invoke<Captured>("quick_capture", { line, today: today() });
