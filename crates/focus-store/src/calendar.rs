//! Google Calendar, kept on this PC: the calendars you have (with which ones to show), a copy of
//! their events for the Calendar page and the dashboard, and a note of what this PC last wrote to
//! the "Focus" calendar. Google stays the one calendar; each PC reads it for itself, so none of
//! this is synced PC-to-PC. Talking to Google is in the desktop app (src-tauri/src/gcal.rs).

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::ids::new_id;
use crate::store::now_ms;

/// One of your calendars. Mirrored by `CalendarSource` in src/ipc/calendar.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub google_id: String,
    pub summary: String,
    /// "#rrggbb" from Google.
    pub color: Option<String>,
    /// "owner", "writer", "reader" or "freeBusyReader".
    pub access_role: String,
    pub primary: bool,
    pub holiday: bool,
    /// Shown in Focus (your choice; new calendars follow Google's own tick).
    pub selected: bool,
    /// The calendar Focus writes your to-dos and deadlines into.
    pub focus: bool,
    pub last_synced_at: Option<i64>,
}

impl Source {
    /// Focus may add and change events here (not in the Focus calendar, which follows your to-dos).
    pub fn writable(&self) -> bool {
        matches!(self.access_role.as_str(), "owner" | "writer") && !self.focus
    }
}

/// A calendar as Google's calendar list describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceInfo {
    pub google_id: String,
    pub summary: String,
    pub color: Option<String>,
    pub access_role: String,
    pub primary: bool,
    /// Ticked in Google Calendar itself.
    pub google_selected: bool,
}

/// Holiday calendars are the ones Google publishes, e.g. "en.indian#holiday@group.v.calendar.google.com".
pub fn is_holiday_calendar(google_id: &str) -> bool {
    google_id.contains("#holiday@")
}

/// An event as Google sent it, ready to store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventInfo {
    pub google_event_id: String,
    pub etag: Option<String>,
    pub summary: String,
    pub when: When,
    pub time_zone: Option<String>,
    pub location: String,
    pub description: String,
    pub html_link: Option<String>,
    pub recurring: bool,
}

/// When an event happens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum When {
    /// UTC milliseconds; end is exclusive.
    Timed { start: i64, end: i64 },
    /// Local dates "YYYY-MM-DD"; end is exclusive, as Google sends it.
    AllDay { start: String, end: String },
}

/// An event for the Calendar page. Mirrored by `CalendarEvent` in src/ipc/calendar.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub source_id: String,
    pub google_event_id: String,
    pub summary: String,
    pub all_day: bool,
    pub start_at: Option<i64>,
    pub end_at: Option<i64>,
    pub start_date: Option<String>,
    /// Exclusive: a one-day event on the 5th ends on the 6th.
    pub end_date: Option<String>,
    pub location: String,
    pub description: String,
    pub html_link: Option<String>,
    pub recurring: bool,
    pub calendar: String,
    pub color: Option<String>,
    pub holiday: bool,
    /// In the Focus calendar (made from a to-do or deadline).
    pub focus: bool,
    /// Can be edited from Focus.
    pub writable: bool,
}

const SOURCE_COLUMNS: &str =
    "id, google_calendar_id, summary, color, access_role, is_primary, is_holiday, selected, is_focus, last_synced_at";

fn read_source(r: &rusqlite::Row<'_>) -> rusqlite::Result<Source> {
    Ok(Source {
        id: r.get(0)?,
        google_id: r.get(1)?,
        summary: r.get(2)?,
        color: r.get(3)?,
        access_role: r.get(4)?,
        primary: r.get::<_, i64>(5)? == 1,
        holiday: r.get::<_, i64>(6)? == 1,
        selected: r.get::<_, i64>(7)? == 1,
        focus: r.get::<_, i64>(8)? == 1,
        last_synced_at: r.get(9)?,
    })
}

/// Your calendars: your main one first, then your own, then the rest (holidays last), by name.
pub fn sources(conn: &Connection) -> Result<Vec<Source>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SOURCE_COLUMNS} FROM calendar_sources
         ORDER BY is_primary DESC, is_focus DESC, is_holiday, access_role != 'owner', summary COLLATE NOCASE"
    ))?;
    let rows = stmt.query_map([], read_source)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn source(conn: &Connection, id: &str) -> Result<Option<Source>> {
    Ok(conn
        .query_row(&format!("SELECT {SOURCE_COLUMNS} FROM calendar_sources WHERE id = ?1"), [id], read_source)
        .optional()?)
}

/// Brings the list of calendars in line with Google's: new ones are added (shown if they are
/// ticked in Google), changed names and colours are copied, and removed ones go with their events.
/// `focus_google_id` is the Focus calendar, if there is one.
pub fn sync_sources(conn: &mut Connection, list: &[SourceInfo], focus_google_id: Option<&str>) -> Result<()> {
    let tx = conn.transaction()?;
    for s in list {
        let focus = Some(s.google_id.as_str()) == focus_google_id;
        tx.execute(
            "INSERT INTO calendar_sources
                 (id, google_calendar_id, summary, color, access_role, is_primary, is_holiday, selected, is_focus)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (google_calendar_id) DO UPDATE SET
                 summary = excluded.summary, color = excluded.color, access_role = excluded.access_role,
                 is_primary = excluded.is_primary, is_holiday = excluded.is_holiday, is_focus = excluded.is_focus",
            params![
                new_id(),
                s.google_id,
                s.summary,
                s.color,
                s.access_role,
                s.primary as i64,
                is_holiday_calendar(&s.google_id) as i64,
                (s.google_selected || s.primary || focus) as i64,
                focus as i64
            ],
        )?;
    }
    let keep: Vec<&str> = list.iter().map(|s| s.google_id.as_str()).collect();
    let existing: Vec<String> = {
        let mut stmt = tx.prepare("SELECT google_calendar_id FROM calendar_sources")?;
        stmt.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?
    };
    for gone in existing.iter().filter(|g| !keep.contains(&g.as_str())) {
        tx.execute("DELETE FROM calendar_sources WHERE google_calendar_id = ?1", [gone])?;
    }
    tx.commit()?;
    Ok(())
}

/// Shows or hides a calendar. A hidden calendar's events are dropped and fetched again in full
/// when it is shown again.
pub fn set_selected(conn: &mut Connection, id: &str, selected: bool) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("UPDATE calendar_sources SET selected = ?2 WHERE id = ?1", params![id, selected as i64])?;
    if !selected {
        tx.execute("DELETE FROM calendar_events WHERE source_id = ?1", [id])?;
        tx.execute("UPDATE calendar_sources SET sync_token = NULL, last_synced_at = NULL WHERE id = ?1", [id])?;
    }
    tx.commit()?;
    Ok(())
}

/// Where the last sync of this calendar stopped; None = fetch everything.
pub fn sync_token(conn: &Connection, source_id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT sync_token FROM calendar_sources WHERE id = ?1", [source_id], |r| r.get(0))
        .optional()?
        .flatten())
}

/// Stores one sync of a calendar. `full` replaces everything stored for it; otherwise the
/// events are changes (`cancelled` lists events deleted in Google).
pub fn apply_sync(
    conn: &mut Connection,
    source_id: &str,
    full: bool,
    events: &[EventInfo],
    cancelled: &[String],
    next_token: Option<&str>,
) -> Result<()> {
    let tx = conn.transaction()?;
    if full {
        tx.execute("DELETE FROM calendar_events WHERE source_id = ?1", [source_id])?;
    }
    for id in cancelled {
        tx.execute("DELETE FROM calendar_events WHERE source_id = ?1 AND google_event_id = ?2", params![source_id, id])?;
    }
    for e in events {
        let (all_day, start_at, end_at, start_date, end_date) = match &e.when {
            When::Timed { start, end } => (0, Some(*start), Some((*end).max(*start)), None, None),
            When::AllDay { start, end } => (1, None, None, Some(start.clone()), Some(end.clone().max(start.clone()))),
        };
        tx.execute(
            "INSERT INTO calendar_events
                 (id, source_id, google_event_id, etag, summary, start_at, end_at, start_date, end_date, all_day,
                  time_zone, status, location, description, html_link, recurring)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'confirmed', ?12, ?13, ?14, ?15)
             ON CONFLICT (source_id, google_event_id) DO UPDATE SET
                 etag = excluded.etag, summary = excluded.summary, start_at = excluded.start_at,
                 end_at = excluded.end_at, start_date = excluded.start_date, end_date = excluded.end_date,
                 all_day = excluded.all_day, time_zone = excluded.time_zone, location = excluded.location,
                 description = excluded.description, html_link = excluded.html_link, recurring = excluded.recurring",
            params![
                new_id(),
                source_id,
                e.google_event_id,
                e.etag,
                e.summary,
                start_at,
                end_at,
                start_date,
                end_date,
                all_day,
                e.time_zone,
                e.location,
                e.description,
                e.html_link,
                e.recurring as i64
            ],
        )?;
    }
    tx.execute(
        "UPDATE calendar_sources SET sync_token = coalesce(?2, sync_token), last_synced_at = ?3 WHERE id = ?1",
        params![source_id, next_token, now_ms() as i64],
    )?;
    tx.commit()?;
    Ok(())
}

/// Forgets a calendar's events so the next sync fetches it in full (Google said 410 Gone).
pub fn reset_source(conn: &Connection, source_id: &str) -> Result<()> {
    conn.execute("DELETE FROM calendar_events WHERE source_id = ?1", [source_id])?;
    conn.execute("UPDATE calendar_sources SET sync_token = NULL WHERE id = ?1", [source_id])?;
    Ok(())
}

/// Events of the shown calendars that touch the range: all-day events from `from_date` up to
/// (not including) `to_date`, timed events between `from_ms` and `to_ms`.
pub fn events_between(conn: &Connection, from_date: &str, to_date: &str, from_ms: i64, to_ms: i64) -> Result<Vec<Event>> {
    let mut stmt = conn.prepare(
        "SELECT e.id, e.source_id, e.google_event_id, e.summary, e.all_day, e.start_at, e.end_at, e.start_date, e.end_date,
                e.location, e.description, e.html_link, e.recurring,
                s.summary, s.color, s.is_holiday, s.is_focus, s.access_role
         FROM calendar_events e JOIN calendar_sources s ON s.id = e.source_id
         WHERE s.selected = 1 AND e.status != 'cancelled' AND (
               (e.all_day = 1 AND e.start_date < ?2 AND e.end_date > ?1)
            OR (e.all_day = 0 AND e.start_at < ?4 AND (e.end_at > ?3 OR (e.end_at = e.start_at AND e.start_at >= ?3))))
         ORDER BY e.all_day DESC, coalesce(e.start_date, ''), e.start_at, s.is_holiday DESC, e.summary
         LIMIT 3000",
    )?;
    let rows = stmt.query_map(params![from_date, to_date, from_ms, to_ms], |r| {
        let focus = r.get::<_, i64>(16)? == 1;
        let role: String = r.get(17)?;
        Ok(Event {
            id: r.get(0)?,
            source_id: r.get(1)?,
            google_event_id: r.get(2)?,
            summary: r.get(3)?,
            all_day: r.get::<_, i64>(4)? == 1,
            start_at: r.get(5)?,
            end_at: r.get(6)?,
            start_date: r.get(7)?,
            end_date: r.get(8)?,
            location: r.get(9)?,
            description: r.get(10)?,
            html_link: r.get(11)?,
            recurring: r.get::<_, i64>(12)? == 1,
            calendar: r.get(13)?,
            color: r.get(14)?,
            holiday: r.get::<_, i64>(15)? == 1,
            focus,
            writable: !focus && matches!(role.as_str(), "owner" | "writer"),
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// One stored event (to edit or delete it).
pub fn event(conn: &Connection, id: &str) -> Result<Option<(Source, String)>> {
    let found: Option<(String, String)> = conn
        .query_row("SELECT source_id, google_event_id FROM calendar_events WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let Some((source_id, google_id)) = found else { return Ok(None) };
    Ok(source(conn, &source_id)?.map(|s| (s, google_id)))
}

// ---------------------------------------------------------------- the phone's copy

/// The shown calendars as this PC last read them, kept in the synced setting "calendar.mirror" so
/// the phone (which doesn't sign in to Google) can show them. Read-only there.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Mirror {
    /// When the PC last read Google (UTC ms).
    pub synced_at: i64,
    /// 0 = Sunday, 1 = Monday, 6 = Saturday.
    pub week_start: u8,
    /// Name of the PC it came from.
    pub from: String,
    pub events: Vec<Event>,
}

/// The copy's events that touch a range, with the same rules as `events_between`.
pub fn mirror_events_between(mirror: &Mirror, from_date: &str, to_date: &str, from_ms: i64, to_ms: i64) -> Vec<Event> {
    mirror
        .events
        .iter()
        .filter(|e| {
            if e.all_day {
                matches!((&e.start_date, &e.end_date), (Some(s), Some(end)) if s.as_str() < to_date && end.as_str() > from_date)
            } else {
                match (e.start_at, e.end_at) {
                    (Some(s), Some(end)) => s < to_ms && (end > from_ms || (end == s && s >= from_ms)),
                    (Some(s), None) => s < to_ms && s >= from_ms,
                    _ => false,
                }
            }
        })
        .cloned()
        .map(|mut e| {
            e.writable = false;
            e
        })
        .collect()
}

/// Disconnecting Google: forget every calendar, event and what was written to Google.
pub fn clear(conn: &Connection) -> Result<()> {
    conn.execute_batch("DELETE FROM calendar_events; DELETE FROM calendar_sources; DELETE FROM calendar_pushes;")?;
    Ok(())
}

// ---------------------------------------------------------------- the Focus calendar

/// What this PC last wrote to Google for one to-do or deadline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Push {
    pub key: String,
    pub event_id: String,
    pub hash: String,
}

pub fn pushes(conn: &Connection) -> Result<Vec<Push>> {
    let mut stmt = conn.prepare("SELECT key, event_id, hash FROM calendar_pushes ORDER BY key")?;
    let rows = stmt.query_map([], |r| Ok(Push { key: r.get(0)?, event_id: r.get(1)?, hash: r.get(2)? }))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn record_push(conn: &Connection, key: &str, event_id: &str, hash: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO calendar_pushes (key, event_id, hash, pushed_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (key) DO UPDATE SET event_id = excluded.event_id, hash = excluded.hash, pushed_at = excluded.pushed_at",
        params![key, event_id, hash, now_ms() as i64],
    )?;
    Ok(())
}

pub fn forget_push(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM calendar_pushes WHERE key = ?1", [key])?;
    Ok(())
}

/// The Focus calendar was made again: everything has to be written again.
pub fn forget_all_pushes(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM calendar_pushes", [])?;
    Ok(())
}

/// A to-do, plan step or deadline that belongs in Google Calendar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dated {
    Task {
        id: String,
        title: String,
        description: String,
        done: bool,
        /// The day it is on ("YYYY-MM-DD"); for a repeating task, None.
        date: Option<String>,
        /// Weekday bits (Sunday = 1 … Saturday = 64); 0 = once.
        repeat_days: i64,
        /// When the task was made (UTC ms), where a repeating task starts.
        created_at: i64,
        start_time: Option<String>,
        end_time: Option<String>,
        duration_min: Option<i64>,
        /// The space's name, for the event's description.
        space: Option<String>,
    },
    Deadline {
        id: String,
        title: String,
        description: String,
        due_at: i64,
        all_day: bool,
        completed: bool,
    },
}

impl Dated {
    /// "task:<id>" or "deadline:<id>": stable, so the Google event ID derived from it is too.
    pub fn key(&self) -> String {
        match self {
            Dated::Task { id, .. } => format!("task:{id}"),
            Dated::Deadline { id, .. } => format!("deadline:{id}"),
        }
    }
}

/// Every to-do with a day (one-off with a date, repeating, or a step of a dated plan) and every
/// deadline. Undated to-dos and deadline checklists stay out of the calendar.
pub fn dated_items(conn: &Connection) -> Result<Vec<Dated>> {
    let mut out = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT t.id, t.title, t.description, t.done,
                CASE WHEN s.kind = 'plan' THEN date(s.start_date, printf('+%d days', t.plan_day - 1)) ELSE t.due_date END,
                CASE WHEN coalesce(s.kind, 'board') = 'board' THEN t.repeat_days ELSE 0 END,
                t.created_at, t.start_time, t.end_time, t.duration_min, s.name
         FROM tasks t LEFT JOIN spaces s ON s.id = t.space_id
         WHERE t.deleted_at IS NULL AND t.deadline_id IS NULL AND (t.space_id IS NULL OR s.deleted_at IS NULL) AND (
               (coalesce(s.kind, 'board') = 'board' AND (t.repeat_days > 0 OR t.due_date IS NOT NULL))
            OR (s.kind = 'plan' AND s.start_date IS NOT NULL AND t.plan_day IS NOT NULL))
         ORDER BY t.created_at LIMIT 3000",
    )?;
    let rows = stmt.query_map([], |r| {
        let repeat_days: i64 = r.get(5)?;
        Ok(Dated::Task {
            id: r.get(0)?,
            title: r.get(1)?,
            description: r.get(2)?,
            done: repeat_days == 0 && r.get::<_, i64>(3)? == 1,
            date: if repeat_days > 0 { None } else { r.get(4)? },
            repeat_days,
            created_at: r.get(6)?,
            start_time: r.get(7)?,
            end_time: r.get(8)?,
            duration_min: r.get(9)?,
            space: r.get(10)?,
        })
    })?;
    for row in rows {
        out.push(row?);
    }
    let mut stmt = conn.prepare(
        "SELECT id, title, description, due_at, all_day, completed_at IS NOT NULL
         FROM deadlines WHERE deleted_at IS NULL ORDER BY due_at LIMIT 1000",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Dated::Deadline {
            id: r.get(0)?,
            title: r.get(1)?,
            description: r.get(2)?,
            due_at: r.get(3)?,
            all_day: r.get::<_, i64>(4)? == 1,
            completed: r.get::<_, i64>(5)? == 1,
        })
    })?;
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;
    use crate::spaces::{self, SpaceInput};
    use crate::tasks::{self, TaskInput};

    fn info(id: &str, summary: &str, selected: bool) -> SourceInfo {
        SourceInfo {
            google_id: id.into(),
            summary: summary.into(),
            color: Some("#4285f4".into()),
            access_role: "owner".into(),
            primary: false,
            google_selected: selected,
        }
    }

    fn all_day(id: &str, start: &str, end: &str) -> EventInfo {
        EventInfo {
            google_event_id: id.into(),
            etag: None,
            summary: id.into(),
            when: When::AllDay { start: start.into(), end: end.into() },
            time_zone: None,
            location: String::new(),
            description: String::new(),
            html_link: None,
            recurring: false,
        }
    }

    #[test]
    fn calendars_follow_google_and_keep_your_choice() {
        let mut store = Store::open_in_memory().unwrap();
        let holidays = "en.indian#holiday@group.v.calendar.google.com";
        sync_sources(store.conn_mut(), &[info("me@gmail.com", "Me", true), info(holidays, "Holidays in India", false), info("f@group", "Focus", false)], Some("f@group")).unwrap();
        let list = sources(store.conn()).unwrap();
        let names: Vec<_> = list.iter().map(|s| (s.summary.as_str(), s.selected, s.holiday, s.focus)).collect();
        assert_eq!(names, [("Focus", true, false, true), ("Me", true, false, false), ("Holidays in India", false, true, false)]);
        assert!(!list[0].writable() && list[1].writable());

        // Your choice survives the next sync; a renamed calendar is renamed; a removed one goes.
        let me = list[1].id.clone();
        set_selected(store.conn_mut(), &me, false).unwrap();
        sync_sources(store.conn_mut(), &[info("me@gmail.com", "Me (renamed)", true), info(holidays, "Holidays in India", false)], None).unwrap();
        let list = sources(store.conn()).unwrap();
        assert_eq!(list.len(), 2);
        let me = list.iter().find(|s| s.id == me).unwrap();
        assert_eq!((me.summary.as_str(), me.selected), ("Me (renamed)", false));
    }

    #[test]
    fn events_are_stored_changed_and_found_by_range() {
        let mut store = Store::open_in_memory().unwrap();
        sync_sources(store.conn_mut(), &[info("me", "Me", true)], None).unwrap();
        let src = sources(store.conn()).unwrap()[0].id.clone();
        let timed = EventInfo { when: When::Timed { start: 1_000, end: 2_000 }, ..all_day("call", "", "") };
        apply_sync(store.conn_mut(), &src, true, &[all_day("diwali", "2026-11-08", "2026-11-09"), timed.clone()], &[], Some("t1")).unwrap();
        assert_eq!(sync_token(store.conn(), &src).unwrap().as_deref(), Some("t1"));

        let in_nov = events_between(store.conn(), "2026-11-01", "2026-12-01", 0, 0).unwrap();
        assert_eq!(in_nov.iter().map(|e| e.summary.as_str()).collect::<Vec<_>>(), ["diwali"]);
        assert!(in_nov[0].writable && !in_nov[0].focus);
        // An event ending on the 9th (exclusive) is not on the 9th.
        assert!(events_between(store.conn(), "2026-11-09", "2026-11-10", 0, 0).unwrap().is_empty());
        assert_eq!(events_between(store.conn(), "x", "x", 1_500, 3_000).unwrap().len(), 1);

        // A change and a deletion.
        let moved = EventInfo { summary: "Call (moved)".into(), ..timed };
        apply_sync(store.conn_mut(), &src, false, &[moved], &["diwali".into()], Some("t2")).unwrap();
        let all = events_between(store.conn(), "2000-01-01", "2100-01-01", 0, i64::MAX).unwrap();
        assert_eq!(all.iter().map(|e| e.summary.as_str()).collect::<Vec<_>>(), ["Call (moved)"]);

        // Hidden calendars show nothing and start over.
        set_selected(store.conn_mut(), &src, false).unwrap();
        assert!(events_between(store.conn(), "2000-01-01", "2100-01-01", 0, i64::MAX).unwrap().is_empty());
        assert_eq!(sync_token(store.conn(), &src).unwrap(), None);
    }

    #[test]
    fn dated_items_are_the_ones_with_a_day() {
        let mut store = Store::open_in_memory().unwrap();
        let today = "2026-10-23";
        let input = |title: &str, due: Option<&str>, repeat: i64| TaskInput {
            title: title.into(),
            due_date: due.map(String::from),
            priority: "normal".into(),
            repeat_days: repeat,
            ..serde_json::from_str::<TaskInput>(r#"{"title":"x","priority":"normal","repeatDays":0}"#).unwrap()
        };
        tasks::create(&mut store, input("Dated", Some("2026-10-25"), 0), today).unwrap();
        tasks::create(&mut store, input("Undated", None, 0), today).unwrap();
        tasks::create(&mut store, input("Gym", None, 2 | 8), today).unwrap();
        let plan = spaces::create(
            &mut store,
            serde_json::from_value::<SpaceInput>(serde_json::json!({"name":"App v2","kind":"plan","startDate":"2026-10-24","days":3})).unwrap(),
        )
        .unwrap();
        let mut step = input("Debugging", None, 0);
        step.space_id = Some(plan.id.clone());
        step.plan_day = Some(2);
        tasks::create(&mut store, step, today).unwrap();

        let items = dated_items(store.conn()).unwrap();
        let tasks: Vec<_> = items
            .iter()
            .map(|d| match d {
                Dated::Task { title, date, repeat_days, .. } => (title.as_str(), date.clone(), *repeat_days),
                Dated::Deadline { .. } => unreachable!(),
            })
            .collect();
        assert_eq!(
            tasks,
            [("Dated", Some("2026-10-25".into()), 0), ("Gym", None, 10), ("Debugging", Some("2026-10-25".into()), 0)]
        );
        assert!(items[0].key().starts_with("task:"));
    }

    #[test]
    fn pushes_are_remembered() {
        let store = Store::open_in_memory().unwrap();
        record_push(store.conn(), "task:a", "fc01", "h1").unwrap();
        record_push(store.conn(), "task:a", "fc01", "h2").unwrap();
        assert_eq!(pushes(store.conn()).unwrap(), [Push { key: "task:a".into(), event_id: "fc01".into(), hash: "h2".into() }]);
        forget_push(store.conn(), "task:a").unwrap();
        assert!(pushes(store.conn()).unwrap().is_empty());
    }

    fn ev(id: &str, all_day: bool, start: (Option<&str>, Option<i64>), end: (Option<&str>, Option<i64>)) -> Event {
        Event {
            id: id.into(),
            source_id: "s".into(),
            google_event_id: id.into(),
            summary: id.into(),
            all_day,
            start_at: start.1,
            end_at: end.1,
            start_date: start.0.map(Into::into),
            end_date: end.0.map(Into::into),
            location: String::new(),
            description: String::new(),
            html_link: None,
            recurring: false,
            calendar: "Me".into(),
            color: None,
            holiday: false,
            focus: false,
            writable: true,
        }
    }

    #[test]
    fn the_phones_copy_finds_events_like_the_pc_does() {
        let mirror = Mirror {
            synced_at: 1,
            week_start: 1,
            from: "PC".into(),
            events: vec![
                ev("day", true, (Some("2026-10-24"), None), (Some("2026-10-25"), None)),
                ev("trip", true, (Some("2026-10-20"), None), (Some("2026-10-27"), None)),
                ev("later", true, (Some("2026-10-25"), None), (Some("2026-10-26"), None)),
                ev("call", false, (None, Some(1_000)), (None, Some(2_000))),
                ev("past", false, (None, Some(100)), (None, Some(500))),
            ],
        };
        let found = mirror_events_between(&mirror, "2026-10-24", "2026-10-25", 900, 5_000);
        let ids: Vec<&str> = found.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["day", "trip", "call"]);
        assert!(found.iter().all(|e| !e.writable), "read-only on the phone");
        let json = serde_json::to_string(&mirror).unwrap();
        assert_eq!(serde_json::from_str::<Mirror>(&json).unwrap(), mirror);
    }
}
