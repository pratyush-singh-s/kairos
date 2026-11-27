/**
 * Unloads (discards) tabs you haven't used for a while, to save memory. An unloaded tab stays in
 * the tab bar and loads again when you click it. Pinned tabs, tabs playing sound and the tab you
 * are on are never unloaded.
 */
import { load } from "./state";

export const UNLOAD_ALARM = "unload-tabs";
export const MIN_UNLOAD_MINUTES = 1;
export const MAX_UNLOAD_MINUTES = 1440;

export function clampUnloadMinutes(n: number): number {
  if (!Number.isFinite(n)) return 10;
  return Math.min(MAX_UNLOAD_MINUTES, Math.max(MIN_UNLOAD_MINUTES, Math.round(n)));
}

/** When the extension last saw each tab in use (or first saw it), ms. */
const seen = new Map<number, number>();

export function markUsed(tabId: number, now = Date.now()): void {
  seen.set(tabId, now);
}

export function forget(tabId: number): void {
  seen.delete(tabId);
}

/** Unloads every tab that has been unused for longer than the set time. */
export async function unloadIdleTabs(now = Date.now()): Promise<void> {
  const s = await load();
  const tabs = await browser.tabs.query({});
  const ids = new Set<number>();
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    ids.add(tab.id);
    if (tab.active) markUsed(tab.id, now);
    else if (!seen.has(tab.id)) markUsed(tab.id, now); // new to us: give it the full time
  }
  for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id);
  if (!s.unloadTabs.on) return;
  const limit = s.unloadTabs.minutes * 60_000;
  for (const tab of tabs) {
    if (tab.id === undefined || tab.active || tab.pinned || tab.audible || tab.discarded) continue;
    if (!tab.url || !/^https?:/.test(tab.url)) continue;
    if ((tab as { autoDiscardable?: boolean }).autoDiscardable === false) continue;
    const last = Math.max(seen.get(tab.id) ?? now, tab.lastAccessed ?? 0);
    if (now - last < limit) continue;
    await browser.tabs.discard(tab.id).catch(() => {});
  }
}
