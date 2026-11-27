import { useCallback, useEffect, useState } from "react";
import { addDays, dayStartMs, eventTimeLabel, eventsByDay } from "@focus/core";
import { listCalendarEvents, type CalendarEvent } from "../../ipc/calendar";
import { useHistoryChanged } from "../../ipc/history";
import { today } from "../../ipc/tasks";
import { useCalendarSync } from "./CalendarPage";

/** Shown at most on the dashboard; the rest is one click away. */
const MAX = 6;

/** The dashboard's "Today's calendar": your Google events and holidays today (to-dos have their own card). */
export function TodayEvents(props: { onOpen: () => void }) {
  const [sync] = useCalendarSync();
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const day = today();
  const reload = useCallback(() => {
    const next = addDays(day, 1);
    listCalendarEvents(day, next, dayStartMs(day), dayStartMs(next))
      .then((list) => {
        setFailed(null);
        setEvents(eventsByDay(list.filter((e) => !e.focus), [day]).get(day) ?? []);
      })
      .catch((err: unknown) => setFailed(String(err)));
  }, [day]);
  useEffect(reload, [reload]);
  useHistoryChanged(reload, "calendar-changed");

  if (sync && !sync.connected) {
    return (
      <p className="muted">
        Not connected.{" "}
        <button type="button" className="link-button" onClick={props.onOpen}>
          Connect Google Calendar
        </button>
      </p>
    );
  }
  if (failed !== null) {
    return (
      <p className="error small" role="alert">
        Couldn't read today's events.{" "}
        <button type="button" className="link-button" onClick={reload}>
          Try again
        </button>
      </p>
    );
  }
  if (events === null) return <p className="muted">Loading…</p>;
  if (events.length === 0) return <p className="muted">Nothing in your calendar today.</p>;
  return (
    <>
      <ul className="today-events">
        {events.slice(0, MAX).map((e) => (
          <li key={e.id}>
            <span className="calendar-dot" style={{ ["--event-color" as string]: e.color ?? "var(--accent)" }} aria-hidden="true" />
            <span className="calendar-day-time num">{eventTimeLabel(e, day)}</span>
            <span className="calendar-day-name" title={e.summary}>
              {e.summary}
            </span>
          </li>
        ))}
      </ul>
      <button type="button" className="link-button small" onClick={props.onOpen}>
        {events.length > MAX ? `${events.length - MAX} more in Calendar` : "Open Calendar"}
      </button>
    </>
  );
}
