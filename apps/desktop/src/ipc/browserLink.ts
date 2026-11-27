import { invoke } from "@tauri-apps/api/core";

/** Mirrors `LinkStatus` in src-tauri/src/bridge.rs. */
export interface BrowserLink {
  /** Focus Blocker asked within the last 40 seconds. */
  linked: boolean;
  /** Linked and a focus phase is on, so the browser is blocking. */
  blocking: boolean;
  /** False when the app could not open its port (another program uses it). */
  listening: boolean;
  /** Which browsers are linked, e.g. ["Firefox", "Chrome"] (Brave shows as Chrome). */
  browsers?: string[];
}

/** "Firefox", "Firefox and Chrome", or "a browser" when the app could not tell. */
export function browserNames(l: BrowserLink): string {
  const names = l.browsers ?? [];
  if (names.length === 0) return "a browser";
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const browserLinkStatus = () => invoke<BrowserLink>("browser_link_status");
