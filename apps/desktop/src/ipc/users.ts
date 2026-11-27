import { invoke } from "@tauri-apps/api/core";

/** Mirrors `UsersInfo` in src-tauri/src/users.rs. */
export interface UsersInfo {
  /** A users database is built into this release. */
  builtIn: boolean;
  /** This install is counted (Settings > Data & accounts). */
  share: boolean;
}

/** Mirrors `Person` in users.rs. Dates are RFC 3339. */
export interface Person {
  email: string;
  name: string;
  firstSeen: string;
  lastSeen: string;
  version: string;
}

/** Mirrors `UsersOverview` in users.rs. `owner` is true only for the app's maker. */
export interface UsersOverview {
  builtIn: boolean;
  owner: boolean;
  installs: number;
  activeWeek: number;
  newWeek: number;
  people: Person[];
  error: string | null;
}

export const getUsersInfo = () => invoke<UsersInfo>("users_info");
export const setUsersShare = (on: boolean) => invoke<void>("set_users_share", { on });
export const getUsersOverview = () => invoke<UsersOverview>("users_overview");
