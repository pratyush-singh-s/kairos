import { useState, type FormEvent } from "react";
import { addDays, eventTimeLabel, parseIsoDate } from "@focus/core";
import { deleteCalendarEvent, saveCalendarEvent, type CalendarEvent, type CalendarSource } from "../../ipc/calendar";
import type { RouteId } from "../../app/routes";

const dayTitle = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Local "YYYY-MM-DD" + "HH:MM" as UTC ms. */
function toMs(date: string, time: string): number {
  const [h, m] = time.split(":").map(Number);
  const d = parseIsoDate(date);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.getTime();
}

/**
 * Add or change an event in one of your Google calendars. Events Focus cannot change (holidays,
 * calendars shared read-only, and the Focus calendar that follows your to-dos) are shown, not edited.
 */
export function EventForm(props: EventFormProps) {
  const e = props.event;
  if (e && !e.writable) return <EventDetails event={e} day={props.day} onDone={props.onDone} onNavigate={props.onNavigate} />;
  return <EventEditor {...props} />;
}

interface EventFormProps {
  event: CalendarEvent | null;
  day: string;
  calendars: CalendarSource[];
  onDone: () => void;
  onNavigate: (r: RouteId) => void;
}

function EventEditor(props: EventFormProps) {
  const e = props.event;
  const first = props.calendars.find((c) => c.primary) ?? props.calendars[0];
  const [summary, setSummary] = useState(e?.summary ?? "");
  const [sourceId, setSourceId] = useState(e?.sourceId ?? first?.id ?? "");
  const [allDay, setAllDay] = useState(e?.allDay ?? false);
  const [date, setDate] = useState(e ? (e.allDay ? e.startDate! : localDate(e.startAt!)) : props.day);
  // All-day: the last day, inclusive (Google's end date is the day after).
  const [lastDate, setLastDate] = useState(e?.allDay && e.endDate ? addDays(e.endDate, -1) : e && !e.allDay ? date : props.day);
  const [start, setStart] = useState(e && !e.allDay ? localTime(e.startAt!) : "09:00");
  const [end, setEnd] = useState(e && !e.allDay ? localTime(e.endAt ?? e.startAt!) : "10:00");
  const [location, setLocation] = useState(e?.location ?? "");
  const [description, setDescription] = useState(e?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    let startAt: number | null = null;
    let endAt: number | null = null;
    if (!allDay) {
      startAt = toMs(date, start);
      endAt = toMs(date, end);
      // Ending at or before it starts means it ends the next day (e.g. 22:00 to 01:00).
      if (endAt <= startAt) endAt = toMs(addDays(date, 1), end);
    } else if (lastDate < date) {
      setError("The last day is before the first.");
      return;
    }
    setBusy(true);
    try {
      await saveCalendarEvent(e?.id ?? null, {
        sourceId,
        summary,
        allDay,
        startDate: allDay ? date : null,
        endDate: allDay ? addDays(lastDate, 1) : null,
        startAt,
        endAt,
        location,
        description,
      });
      props.onDone();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!e) return;
    setBusy(true);
    try {
      await deleteCalendarEvent(e.id);
      props.onDone();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  if (!first && !e) return <p className="muted">None of your shown calendars can be changed from Kairos.</p>;

  return (
    <form className="deadline-form event-form" onSubmit={submit} aria-label={e ? `Edit ${e.summary}` : "New event"}>
      <label className="field wide">
        <span>Name</span>
        <input value={summary} onChange={(x) => setSummary(x.target.value)} maxLength={300} required autoFocus autoComplete="off" />
      </label>

      <fieldset className="dl-when wide">
        <legend>When</legend>
        <input type="date" aria-label={allDay ? "First day" : "Day"} value={date} onChange={(x) => x.target.value && (setDate(x.target.value), lastDate < x.target.value && setLastDate(x.target.value))} />
        {allDay ? (
          <>
            <span className="muted">to</span>
            <input type="date" aria-label="Last day" value={lastDate} min={date} onChange={(x) => x.target.value && setLastDate(x.target.value)} />
          </>
        ) : (
          <>
            <input type="time" aria-label="Starts" value={start} onChange={(x) => x.target.value && setStart(x.target.value)} />
            <span className="muted">to</span>
            <input type="time" aria-label="Ends" value={end} onChange={(x) => x.target.value && setEnd(x.target.value)} />
          </>
        )}
        <label className="inline-check">
          <input type="checkbox" checked={allDay} onChange={(x) => setAllDay(x.target.checked)} /> All day
        </label>
      </fieldset>

      <label className="field">
        <span>Calendar</span>
        <select value={sourceId} onChange={(x) => setSourceId(x.target.value)}>
          {props.calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.summary}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Place</span>
        <input value={location} onChange={(x) => setLocation(x.target.value)} maxLength={300} autoComplete="off" />
      </label>
      <label className="field wide">
        <span>Notes</span>
        <textarea value={description} onChange={(x) => setDescription(x.target.value)} rows={3} maxLength={4000} />
      </label>

      {e?.recurring && <p className="muted small wide">This is one time of a repeating event; only this time changes.</p>}
      {error && (
        <p className="error wide" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions wide">
        <button type="submit" className="button primary" disabled={busy || !summary.trim() || !sourceId}>
          {busy ? "Saving…" : e ? "Save changes" : "Add event"}
        </button>
        <button type="button" className="button" onClick={props.onDone} disabled={busy}>
          Cancel
        </button>
        {e &&
          (confirmDelete ? (
            <button type="button" className="button danger push-right" onClick={() => void remove()} disabled={busy}>
              Delete from Google Calendar
            </button>
          ) : (
            <button type="button" className="button danger push-right" onClick={() => setConfirmDelete(true)} disabled={busy}>
              Delete
            </button>
          ))}
      </div>
    </form>
  );
}

/** A holiday, a read-only calendar's event, or one made from a to-do or deadline. */
function EventDetails(props: { event: CalendarEvent; day: string; onDone: () => void; onNavigate: (r: RouteId) => void }) {
  const e = props.event;
  const fromDeadline = e.focus && e.summary.replace(/^✓ /, "").startsWith("Due: ");
  return (
    <div className="event-details">
      <p className="event-details-name">{e.summary}</p>
      <p className="muted">
        {dayTitle.format(parseIsoDate(props.day))} · {eventTimeLabel(e, props.day)}
      </p>
      <p className="small">
        <span className="calendar-dot" style={{ ["--event-color" as string]: e.color ?? "var(--accent)" }} aria-hidden="true" /> {e.calendar}
        {e.location && ` · ${e.location}`}
      </p>
      {e.description && <p className="event-details-text small">{e.description}</p>}
      <p className="muted small">
        {e.focus
          ? `Made from your ${fromDeadline ? "deadline" : "to-do"}. Change it there and Google Calendar follows.`
          : e.holiday
            ? "A holiday from Google's holiday calendar."
            : "This calendar is shared with you to look at only."}
      </p>
      <div className="form-actions">
        {e.focus && (
          <button type="button" className="button" onClick={() => props.onNavigate(fromDeadline ? "deadlines" : "tasks")}>
            Open {fromDeadline ? "Deadlines" : "To-do"}
          </button>
        )}
        <button type="button" className="button primary" onClick={props.onDone}>
          Close
        </button>
      </div>
    </div>
  );
}
