import { useCallback, useEffect, useMemo, useState } from "react";
import { timeOfDay } from "@focus/core";
import { addDays, dayStartMs, eventTimeLabel, eventsByDay, monthGrid, parseIsoDate } from "@focus/core";
import { useHistoryChanged } from "../../ipc/history";
import { cancelGoogleSignIn, getGoogleStatus, googleSignIn, type GoogleStatus } from "../../ipc/google";
import {
  connectCalendar,
  getCalendarSync,
  listCalendarEvents,
  listCalendars,
  syncCalendarNow,
  type CalendarEvent,
  type CalendarSource,
  type CalendarSync,
} from "../../ipc/calendar";
import { today } from "../../ipc/tasks";
import type { RouteId } from "../../app/routes";
import { EventForm } from "./EventForm";

const monthTitle = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" });
const weekdayShort = new Intl.DateTimeFormat("en-GB", { weekday: "short" });
const dayTitle = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });

/** How many events a day cell lists before "+2 more". */
const CELL_EVENTS = 3;

type Editing = { event: CalendarEvent | null; day: string } | null;

/** "just now", "5 min ago", "14:05". */
export function syncedLabel(ms: number | null): string {
  if (!ms) return "Not synced yet";
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return "Synced just now";
  if (min < 60) return `Synced ${min} min ago`;
  return `Synced at ${timeOfDay(ms)}`;
}

/** Hook: the sync status, kept up to date. */
export function useCalendarSync(): [CalendarSync | null, () => void] {
  const [sync, setSync] = useState<CalendarSync | null>(null);
  const reload = useCallback(() => {
    getCalendarSync()
      .then(setSync)
      .catch(() => {});
  }, []);
  useEffect(reload, [reload]);
  useHistoryChanged(reload, "calendar-sync");
  useHistoryChanged(reload, "google-changed");
  return [sync, reload];
}

/** Google Calendar: a month of your shown calendars, the picked day's events, and adding or changing events. */
export function CalendarPage(props: { onNavigate: (r: RouteId) => void }) {
  const now = today();
  const [month, setMonth] = useState(() => ({ y: parseIsoDate(now).getFullYear(), m: parseIsoDate(now).getMonth() }));
  const [selected, setSelected] = useState(now);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [sources, setSources] = useState<CalendarSource[]>([]);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [sync] = useCalendarSync();
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const days = useMemo(() => monthGrid(month.y, month.m, sync?.weekStart ?? 1), [month, sync?.weekStart]);

  const reload = useCallback(() => {
    const from = days[0]!;
    const to = addDays(days[days.length - 1]!, 1);
    listCalendarEvents(from, to, dayStartMs(from), dayStartMs(to))
      .then(setEvents)
      .catch((err: unknown) => setError(String(err)));
    listCalendars()
      .then(setSources)
      .catch(() => {});
    getGoogleStatus()
      .then(setGoogle)
      .catch(() => {});
  }, [days]);
  useEffect(reload, [reload]);
  useHistoryChanged(reload, "calendar-changed");
  useHistoryChanged(reload, "google-changed");
  // A sign-in that finished (even one started earlier and replaced) makes the old error stale.
  const clearError = useCallback(() => setError(null), []);
  useHistoryChanged(clearError, "google-changed");

  const byDay = useMemo(() => eventsByDay(events, days), [events, days]);
  const writable = sources.filter((s) => s.selected && s.accessRole !== "reader" && s.accessRole !== "freeBusyReader" && !s.focus);

  function go(delta: number) {
    setMonth(({ y, m }) => {
      const d = new Date(y, m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }

  function goToday() {
    const d = parseIsoDate(now);
    setMonth({ y: d.getFullYear(), m: d.getMonth() });
    setSelected(now);
  }

  async function connect(again: boolean) {
    setConnecting(true);
    setError(null);
    try {
      await (again ? googleSignIn() : connectCalendar());
      reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setConnecting(false);
    }
  }

  if (google && !google.calendar) {
    return (
      <section aria-labelledby="calendar-title">
        <h1 id="calendar-title" className="page-title">
          Calendar
        </h1>
        <div className="card calendar-connect">
          {google.email ? (
            <>
              <p>See your Google Calendar and holidays here, and put your dated to-dos and deadlines into Google Calendar.</p>
              <p className="muted small">
                Kairos adds one calendar called "Focus".
              </p>
              {connecting ? (
                <p className="confirm-left" role="status">
                  Finish on Google's page in your browser…{" "}
                  <button type="button" className="button" onClick={() => void cancelGoogleSignIn()}>
                    Cancel
                  </button>
                </p>
              ) : (
                <button type="button" className="button primary" onClick={() => void connect(false)}>
                  Connect Google Calendar
                </button>
              )}
            </>
          ) : (
            <>
              <p>Connect your Google account first, then come back here.</p>
              <button type="button" className="button primary" onClick={() => props.onNavigate("settings")}>
                Open Settings
              </button>
            </>
          )}
          {error && (
            <p className="error small" role="alert">
              {error}
            </p>
          )}
        </div>
      </section>
    );
  }

  const shownMonth = new Date(month.y, month.m, 1);
  const dayEvents = byDay.get(selected) ?? [];
  const weekdays = days.slice(0, 7);

  return (
    <section aria-labelledby="calendar-title" className="calendar-page">
      <div className="page-head">
        <h1 id="calendar-title" className="page-title">
          Calendar
        </h1>
      </div>

      {sync?.expired ? (
        <p className="calendar-banner error" role="alert">
          Google Calendar disconnected. Your events below are from the last sync.{" "}
          <button type="button" className="button small-button" disabled={connecting} onClick={() => void connect(true)}>
            {connecting ? "Waiting for your browser…" : "Reconnect"}
          </button>
        </p>
      ) : sync?.error ? (
        <p className="calendar-banner muted small" role="status">
          Not synced: {sync.error}
        </p>
      ) : null}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}

      <div className="board-toolbar calendar-toolbar">
        <button type="button" className="button small-button" onClick={goToday}>
          Today
        </button>
        <button type="button" className="icon-button" onClick={() => go(-1)} aria-label="Previous month" title="Previous month">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M12 4l-6 6 6 6" />
          </svg>
        </button>
        <span className="board-range calendar-month">{monthTitle.format(shownMonth)}</span>
        <button type="button" className="icon-button" onClick={() => go(1)} aria-label="Next month" title="Next month">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M8 4l6 6-6 6" />
          </svg>
        </button>
        <span className="push-right" />
        <span className="muted small" role="status">
          {sync?.syncing ? "Syncing…" : syncedLabel(sync?.lastSyncedAt ?? null)}
          {sync && sync.pending > 0 && ` · ${sync.pending} not yet in Google`}
        </span>
        <button type="button" className="button small-button" onClick={() => void syncCalendarNow()} disabled={sync?.syncing}>
          Sync now
        </button>
        <button
          type="button"
          className="button primary"
          onClick={() => setEditing({ event: null, day: selected })}
          disabled={writable.length === 0}
          title={writable.length === 0 ? "None of your shown calendars can be changed" : undefined}
        >
          Add event
        </button>
      </div>

      <div className="calendar-layout">
        <div className="calendar-month-grid card" role="grid" aria-label={monthTitle.format(shownMonth)}>
          <div className="calendar-weekdays" role="row">
            {weekdays.map((d) => (
              <span key={d} role="columnheader">
                {weekdayShort.format(parseIsoDate(d))}
              </span>
            ))}
          </div>
          <div className="calendar-cells" style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(0, 1fr))` }}>
            {days.map((d) => {
              const list = byDay.get(d) ?? [];
              const date = parseIsoDate(d);
              return (
                <div
                  key={d}
                  role="gridcell"
                  tabIndex={d === selected ? 0 : -1}
                  aria-selected={d === selected}
                  aria-label={`${dayTitle.format(date)}, ${list.length === 0 ? "no events" : `${list.length} ${list.length === 1 ? "event" : "events"}`}`}
                  className="calendar-cell"
                  data-today={d === now}
                  data-outside={date.getMonth() !== month.m}
                  data-past={d < now}
                  onClick={() => setSelected(d)}
                  onDoubleClick={() => writable.length > 0 && setEditing({ event: null, day: d })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setEditing({ event: null, day: d });
                  }}
                >
                  <span className="calendar-date num">{date.getDate()}</span>
                  {list.slice(0, CELL_EVENTS).map((e) => (
                    <span key={e.id} className="calendar-chip" data-all-day={e.allDay} style={{ ["--event-color" as string]: e.color ?? "var(--accent)" }} title={e.summary}>
                      {!e.allDay && <span className="calendar-chip-time num">{eventTimeLabel(e, d).replace(/–.*/, "")}</span>}
                      {e.summary}
                    </span>
                  ))}
                  {list.length > CELL_EVENTS && <span className="calendar-more muted">+{list.length - CELL_EVENTS} more</span>}
                </div>
              );
            })}
          </div>
        </div>

        <aside className="card calendar-day" aria-labelledby="calendar-day-title">
          <h2 id="calendar-day-title" className="card-title">
            <span className="card-title-text">{selected === now ? `Today · ${dayTitle.format(parseIsoDate(selected))}` : dayTitle.format(parseIsoDate(selected))}</span>
          </h2>
          {dayEvents.length === 0 ? (
            <p className="muted small">Nothing on this day.</p>
          ) : (
            <ul className="calendar-day-list">
              {dayEvents.map((e) => (
                <li key={e.id}>
                  <button type="button" className="calendar-day-event" style={{ ["--event-color" as string]: e.color ?? "var(--accent)" }} onClick={() => setEditing({ event: e, day: selected })}>
                    <span className="calendar-day-time num">{eventTimeLabel(e, selected)}</span>
                    <span className="calendar-day-name">{e.summary}</span>
                    <span className="calendar-day-meta muted small">
                      {e.calendar}
                      {e.location && ` · ${e.location}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="link-button small" onClick={() => setEditing({ event: null, day: selected })} disabled={writable.length === 0}>
            + Add event on this day
          </button>
        </aside>
      </div>

      {editing && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="modal card" role="dialog" aria-modal="true" aria-label={editing.event ? editing.event.summary : "New event"}>
            <h2 className="card-title">
              <span className="card-title-text">{editing.event ? (editing.event.writable ? "Edit event" : "Event") : "New event"}</span>
            </h2>
            <EventForm
              event={editing.event}
              day={editing.day}
              calendars={writable}
              onDone={() => setEditing(null)}
              onNavigate={(r) => {
                setEditing(null);
                props.onNavigate(r);
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
