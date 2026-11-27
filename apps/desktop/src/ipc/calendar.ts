import { invoke } from "@tauri-apps/api/core";

/** Mirrors `Source` in crates/focus-store/src/calendar.rs. */
export interface CalendarSource {
  id: string;
  googleId: string;
  summary: string;
  color: string | null;
  /** "owner", "writer", "reader" or "freeBusyReader". */
  accessRole: string;
  primary: boolean;
  holiday: boolean;
  /** Shown in Focus. */
  selected: boolean;
  /** The calendar Focus writes your to-dos and deadlines into. */
  focus: boolean;
  lastSyncedAt: number | null;
}

/** Mirrors `Event` in crates/focus-store/src/calendar.rs. */
export interface CalendarEvent {
  id: string;
  sourceId: string;
  googleEventId: string;
  summary: string;
  allDay: boolean;
  startAt: number | null;
  endAt: number | null;
  startDate: string | null;
  /** Exclusive: a one-day event on the 5th ends on the 6th. */
  endDate: string | null;
  location: string;
  description: string;
  htmlLink: string | null;
  /** One time of a repeating event. */
  recurring: boolean;
  calendar: string;
  color: string | null;
  holiday: boolean;
  /** Made from a to-do or deadline. */
  focus: boolean;
  writable: boolean;
}

/** Mirrors `SyncStatus` in src-tauri/src/gcal.rs. */
export interface CalendarSync {
  connected: boolean;
  syncing: boolean;
  lastSyncedAt: number | null;
  error: string | null;
  /** Google no longer accepts the sign-in: Reconnect. */
  expired: boolean;
  /** To-dos and deadlines not yet in Google. */
  pending: number;
  /** 0 = Sunday, 1 = Monday, 6 = Saturday. */
  weekStart: number;
  pushFocus: boolean;
  /** Sync by itself; off = only Sync now. */
  autoSync: boolean;
}

/** Mirrors `EventInput` in src-tauri/src/gcal.rs. */
export interface EventInput {
  sourceId: string;
  summary: string;
  allDay: boolean;
  startDate: string | null;
  /** Exclusive. */
  endDate: string | null;
  startAt: number | null;
  endAt: number | null;
  location: string;
  description: string;
}

export const getCalendarSync = () => invoke<CalendarSync>("calendar_status");
export const listCalendars = () => invoke<CalendarSource[]>("list_calendars");
export const setCalendarShown = (id: string, shown: boolean) => invoke<void>("set_calendar_shown", { id, shown });
export const setCalendarPush = (on: boolean) => invoke<void>("set_calendar_push", { on });
export const setCalendarAuto = (on: boolean) => invoke<void>("set_calendar_auto", { on });
export const syncCalendarNow = () => invoke<void>("calendar_sync_now");
/** `toDate` and `toMs` are exclusive. */
export const listCalendarEvents = (fromDate: string, toDate: string, fromMs: number, toMs: number) =>
  invoke<CalendarEvent[]>("list_calendar_events", { fromDate, toDate, fromMs, toMs });
export const saveCalendarEvent = (id: string | null, input: EventInput) => invoke<void>("save_calendar_event", { id, input });
export const deleteCalendarEvent = (id: string) => invoke<void>("delete_calendar_event", { id });
export const connectCalendar = () => invoke<import("./google").GoogleStatus>("google_connect_calendar");
