import { invoke } from "@tauri-apps/api/core";
import type { BlockRule, YoutubeRules } from "@focus/core";

/** Mirrors `BlockingLists` in crates/focus-store/src/blocking.rs. */
export interface BlockingLists {
  rules: BlockRule[];
  youtube: YoutubeRules | null;
  /** Countdown for newly added "wait" sites, in seconds. */
  defaultWait: number;
}

/** Mirrors `Blocking`: the lists plus whether they were ever saved (or handed over by a browser). */
export interface Blocking extends BlockingLists {
  configured: boolean;
}

export const getBlocking = () => invoke<Blocking>("get_blocking");
export const saveBlocking = (lists: BlockingLists) => invoke<void>("save_blocking", { lists });

export type AppMode = "wait" | "block";

/** Mirrors `AppRule` in crates/focus-store/src/blocking.rs: one Windows program blocked during focus. */
export interface AppRule {
  /** File name, lowercase, e.g. "discord.exe". */
  exe: string;
  name: string;
  mode: AppMode;
  waitSeconds: number;
}

/** Mirrors `AppBlocking`: the blocked programs, and the ones Windows needs that can never be blocked. */
export interface AppBlocking {
  apps: AppRule[];
  protected: string[];
}

/** A program the picker offers: open now, or seen by App tracking. */
export interface AppChoice {
  exe: string;
  name: string;
  open: boolean;
}

/** What the blocked screen shows. */
export interface BlockedApp {
  exe: string;
  name: string;
  mode: AppMode;
  waitSeconds: number;
  sinceMs: number;
  nowMs: number;
}

export const getAppBlocking = () => invoke<AppBlocking>("get_app_blocking");
export const saveAppBlocking = (apps: AppRule[]) => invoke<AppRule[]>("save_app_blocking", { apps });
export const listAppChoices = () => invoke<AppChoice[]>("list_app_choices");
export const pickAppExe = () => invoke<AppChoice | null>("pick_app_exe");
export const blockedApp = () => invoke<BlockedApp | null>("app_block_current");
export const continueBlockedApp = (reason: string) => invoke<void>("app_block_continue", { reason });
export const backToFocus = () => invoke<void>("app_block_back");
