//! Google Calendar sync. A worker thread reads your calendars into the local copy (focus-store
//! `calendar`) on start, every 5 minutes, on "Sync now" and soon after any to-do or deadline
//! changes, and writes dated to-dos, plan steps and deadlines into a "Focus" calendar.
//!
//! Google push notifications need a public server, which Focus does not have, so it polls.
//! Events Focus writes get an ID made from the to-do's own ID, so when both PCs write the same
//! to-do Google keeps one event.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveTime, TimeZone, Utc};
use focus_store::calendar::{self, Dated, EventInfo, SourceInfo, When};
use focus_store::settings;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::google;
use crate::state::StoreState;

const API: &str = "https://www.googleapis.com/calendar/v3";
/// How often Focus looks for changes in Google.
const POLL: Duration = Duration::from_secs(300);
/// After a to-do changes, wait this long for more changes before writing to Google.
const SETTLE: Duration = Duration::from_secs(3);
/// The first sync of a calendar starts this many days back.
const HISTORY_DAYS: i64 = 30;
const FOCUS_CALENDAR: &str = "Focus";

enum Wake {
    Now,
    Soon,
}

/// What the Calendar page and Settings show about syncing. Mirrored by `CalendarSync` in
/// src/ipc/calendar.ts.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// Calendar access is granted.
    pub connected: bool,
    pub syncing: bool,
    /// UTC ms of the last sync that worked.
    pub last_synced_at: Option<i64>,
    /// Why the last sync failed; None = it worked.
    pub error: Option<String>,
    /// Google no longer accepts the sign-in: Reconnect.
    pub expired: bool,
    /// To-dos and deadlines not yet in Google (offline or refused).
    pub pending: usize,
    /// Your first day of the week in Google Calendar: 0 = Sunday, 1 = Monday, 6 = Saturday.
    pub week_start: u8,
    pub push_focus: bool,
    /// Sync by itself (on start, every 5 minutes, after to-do changes). Off = only "Sync now".
    pub auto_sync: bool,
}

pub struct CalendarState {
    wake: Mutex<Option<Sender<Wake>>>,
    status: Mutex<SyncStatus>,
}

impl CalendarState {
    pub fn new() -> Self {
        Self { wake: Mutex::new(None), status: Mutex::new(SyncStatus { week_start: 1, push_focus: true, auto_sync: true, ..Default::default() }) }
    }
}

/// Sync now (after connecting, Sync now, or a change to which calendars are shown).
pub fn wake(app: &AppHandle) {
    send(app, Wake::Now);
}

fn send(app: &AppHandle, w: Wake) {
    if let Some(tx) = app.state::<CalendarState>().wake.lock().unwrap().as_ref() {
        let _ = tx.send(w);
    }
}

/// Starts the sync worker.
pub fn spawn(app: AppHandle) {
    let (tx, rx) = mpsc::channel();
    *app.state::<CalendarState>().wake.lock().unwrap() = Some(tx);
    for event in ["tasks-changed", "deadlines-changed"] {
        let handle = app.clone();
        app.listen_any(event, move |_| send(&handle, Wake::Soon));
    }
    std::thread::spawn(move || {
        // Let the window open first.
        let mut wait = Duration::from_secs(4);
        let mut failures = 0u32;
        loop {
            let now = match rx.recv_timeout(wait) {
                Ok(Wake::Soon) => {
                    // Collect a burst of changes (typing, dragging) into one sync.
                    std::thread::sleep(SETTLE);
                    let mut now = false;
                    while let Ok(w) = rx.try_recv() {
                        now |= matches!(w, Wake::Now);
                    }
                    now
                }
                Ok(Wake::Now) => {
                    while rx.try_recv().is_ok() {}
                    true
                }
                Err(RecvTimeoutError::Timeout) => false,
                Err(RecvTimeoutError::Disconnected) => return,
            };
            // Auto sync off: only "Sync now" (and connecting) sync.
            if !now && !status(&app).auto_sync {
                wait = POLL;
                continue;
            }
            let ok = run_once(&app);
            // Back off after failures: 1, 2, 4 minutes, then the usual 5.
            failures = if ok { 0 } else { failures + 1 };
            wait = if failures == 0 { POLL } else { POLL.min(Duration::from_secs(60 << (failures - 1).min(3))) };
        }
    });
}

/// The status as Settings and the Calendar page see it.
pub fn status(app: &AppHandle) -> SyncStatus {
    let mut s = app.state::<CalendarState>().status.lock().unwrap().clone();
    let _ = app.state::<StoreState>().with(|store| {
        s.connected = google::status(store)?.calendar;
        s.week_start = settings::get::<u8>(store, "google.weekStart").unwrap_or(1);
        s.push_focus = settings::get::<bool>(store, "calendar.pushFocus").unwrap_or(true);
        s.auto_sync = settings::get::<bool>(store, "calendar.autoSync").unwrap_or(true);
        Ok(())
    });
    s
}

fn set_status(app: &AppHandle, f: impl FnOnce(&mut SyncStatus)) {
    f(&mut app.state::<CalendarState>().status.lock().unwrap());
    let _ = app.emit("calendar-sync", status(app));
}

/// One sync. Returns false when it failed (so the next try comes sooner).
fn run_once(app: &AppHandle) -> bool {
    if !status(app).connected {
        set_status(app, |s| *s = SyncStatus { week_start: s.week_start, push_focus: s.push_focus, auto_sync: s.auto_sync, ..Default::default() });
        return true;
    }
    set_status(app, |s| s.syncing = true);
    let result = sync(app);
    let ok = result.is_ok();
    set_status(app, |s| {
        s.syncing = false;
        match result {
            Ok(pending) => {
                s.last_synced_at = Some(chrono::Utc::now().timestamp_millis());
                s.error = None;
                s.expired = false;
                s.pending = pending;
            }
            Err(e) => {
                s.expired = e == google::EXPIRED;
                s.error = Some(e);
            }
        }
    });
    if ok {
        publish_mirror(app);
    }
    let _ = app.emit("calendar-changed", ());
    ok
}

// ---------------------------------------------------------------- the phone's copy

/// The phone doesn't sign in to Google: it shows the copy this PC keeps in the synced setting
/// "calendar.mirror". This is what was last put there (hash of the events, and when).
static PUBLISHED: Mutex<Option<(String, i64)>> = Mutex::new(None);
/// The phone's copy covers this many days back and ahead.
const MIRROR_BACK: u64 = 62;
const MIRROR_AHEAD: u64 = 400;
/// Even with no changes, refresh the copy this often so the phone's "synced" time is about right.
const MIRROR_REFRESH_MS: i64 = 30 * 60_000;

fn publish_mirror(app: &AppHandle) {
    let today = Local::now().date_naive();
    let (Some(from), Some(to)) = (today.checked_sub_days(chrono::Days::new(MIRROR_BACK)), today.checked_add_days(chrono::Days::new(MIRROR_AHEAD))) else {
        return;
    };
    let ms = |d: NaiveDate| local_instant(d, "00:00").map(|t| t.timestamp_millis()).unwrap_or_default();
    let date = |d: NaiveDate| d.format("%Y-%m-%d").to_string();
    let Ok(events) = store(app, |s| calendar::events_between(s.conn(), &date(from), &date(to), ms(from), ms(to)).map_err(|e| e.to_string())) else {
        return;
    };
    let week_start = setting::<u8>(app, "google.weekStart");
    let digest = hash(&json!({ "w": week_start, "e": events }));
    let now = Utc::now().timestamp_millis();
    let mut last = PUBLISHED.lock().unwrap_or_else(|e| e.into_inner());
    if last.as_ref().is_some_and(|(h, at)| *h == digest && now - at < MIRROR_REFRESH_MS) {
        return;
    }
    let mirror = calendar::Mirror { synced_at: now, week_start, from: crate::sync::computer_name(), events };
    if set_setting(app, "calendar.mirror", &mirror).is_ok() {
        *last = Some((digest, now));
    }
}

// ---------------------------------------------------------------- talking to Google

struct Api<'a> {
    app: &'a AppHandle,
    agent: ureq::Agent,
}

struct Reply {
    status: u16,
    body: Value,
}

impl Reply {
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// Google's own words for a failure.
    fn message(&self) -> String {
        let msg = self.body.pointer("/error/message").and_then(Value::as_str).unwrap_or("no details");
        match self.status {
            403 | 429 if msg.to_lowercase().contains("rate") => "Google asked Kairos to slow down; trying again shortly.".into(),
            500..=599 => format!("Google Calendar is having trouble ({}); trying again shortly.", self.status),
            s => format!("Google Calendar said {s}: {msg}"),
        }
    }
}

impl<'a> Api<'a> {
    fn new(app: &'a AppHandle) -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .http_status_as_error(false)
            .build()
            .new_agent();
        Self { app, agent }
    }

    /// One call; a 401 gets a fresh access token and one more try.
    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Reply, String> {
        let url = if path.starts_with("https://") { path.to_string() } else { format!("{API}{path}") };
        for attempt in 0..2 {
            let auth = format!("Bearer {}", google::access_token(self.app)?);
            let text = body.map(|b| b.to_string()).unwrap_or_default();
            let sent = match method {
                "GET" => self.agent.get(&url).header("Authorization", &auth).call(),
                "DELETE" => self.agent.delete(&url).header("Authorization", &auth).call(),
                "POST" => self.agent.post(&url).header("Authorization", &auth).header("Content-Type", "application/json").send(&text),
                "PUT" => self.agent.put(&url).header("Authorization", &auth).header("Content-Type", "application/json").send(&text),
                "PATCH" => self.agent.patch(&url).header("Authorization", &auth).header("Content-Type", "application/json").send(&text),
                m => return Err(format!("unknown method {m}")),
            };
            let mut response = sent.map_err(|e| format!("Could not reach Google Calendar ({e}). Check the internet connection."))?;
            let status = response.status().as_u16();
            let text = response.body_mut().read_to_string().unwrap_or_default();
            if status == 401 && attempt == 0 {
                google::forget_access_token(self.app);
                continue;
            }
            if status == 401 {
                return Err(google::EXPIRED.into());
            }
            return Ok(Reply { status, body: serde_json::from_str(&text).unwrap_or(Value::Null) });
        }
        unreachable!()
    }

    /// A call that must work; anything else stops this sync.
    fn must(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let reply = self.call(method, path, body)?;
        if reply.ok() { Ok(reply.body) } else { Err(reply.message()) }
    }
}

/// Percent-encodes a calendar or event ID for a URL path or query.
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn store<T>(app: &AppHandle, f: impl FnOnce(&mut focus_store::Store) -> Result<T, String>) -> Result<T, String> {
    app.state::<StoreState>().with(f)
}

fn setting<T: serde::de::DeserializeOwned + Default>(app: &AppHandle, key: &str) -> T {
    store(app, |s| settings::get::<T>(s, key).map_err(|e| e.to_string())).unwrap_or_default()
}

fn set_setting<T: Serialize>(app: &AppHandle, key: &str, value: &T) -> Result<(), String> {
    store(app, |s| settings::set(s, key, value).map_err(|e| e.to_string()))
}

/// Reads Google, then writes the Focus calendar. Returns how many to-dos and deadlines could
/// not be written.
fn sync(app: &AppHandle) -> Result<usize, String> {
    let api = Api::new(app);

    // Your time zone and first day of the week, as set in Google Calendar.
    let time_zone = api.must("GET", "/users/me/settings/timezone", None)?["value"].as_str().unwrap_or_default().to_string();
    set_setting(app, "google.timeZone", &time_zone)?;
    if let Ok(week) = api.must("GET", "/users/me/settings/weekStart", None)
        && let Some(n) = week["value"].as_str().and_then(|v| v.parse::<u8>().ok())
    {
        set_setting(app, "google.weekStart", &n)?;
    }

    // Your calendars, with the Focus calendar made if it is missing.
    let mut list = calendar_list(&api)?;
    let push: bool = store(app, |s| settings::get::<bool>(s, "calendar.pushFocus").map_err(|e| e.to_string()))?;
    let mut focus_id: String = setting(app, "google.focusCalendarId");
    if !list.iter().any(|c| c.google_id == focus_id) {
        // Made by the other PC, or before a reconnect?
        focus_id = list.iter().find(|c| c.summary == FOCUS_CALENDAR && c.access_role == "owner").map(|c| c.google_id.clone()).unwrap_or_default();
        if focus_id.is_empty() && push {
            let made = api.must(
                "POST",
                "/calendars",
                Some(&json!({ "summary": FOCUS_CALENDAR, "description": "Dated to-dos and deadlines from the Focus app.", "timeZone": time_zone })),
            )?;
            focus_id = made["id"].as_str().ok_or("Google did not say which calendar it made.")?.to_string();
            list.push(SourceInfo {
                google_id: focus_id.clone(),
                summary: FOCUS_CALENDAR.into(),
                color: None,
                access_role: "owner".into(),
                primary: false,
                google_selected: true,
            });
        }
        set_setting(app, "google.focusCalendarId", &focus_id)?;
        store(app, |s| calendar::forget_all_pushes(s.conn()).map_err(|e| e.to_string()))?;
    }
    store(app, |s| calendar::sync_sources(s.conn_mut(), &list, Some(&focus_id).filter(|f| !f.is_empty()).map(|f| f.as_str())).map_err(|e| e.to_string()))?;

    // Write before reading, so the Focus calendar comes back with today's changes.
    let pending = if focus_id.is_empty() { 0 } else { push_focus(app, &api, &focus_id, &time_zone, push)? };

    let sources = store(app, |s| calendar::sources(s.conn()).map_err(|e| e.to_string()))?;
    for source in sources.iter().filter(|s| s.selected) {
        sync_events(app, &api, &source.id, &source.google_id)?;
    }
    Ok(pending)
}

fn calendar_list(api: &Api) -> Result<Vec<SourceInfo>, String> {
    let mut out = Vec::new();
    let mut page: Option<String> = None;
    for _ in 0..10 {
        let mut path = "/users/me/calendarList?maxResults=250".to_string();
        if let Some(p) = &page {
            path.push_str(&format!("&pageToken={}", enc(p)));
        }
        let body = api.must("GET", &path, None)?;
        for item in body["items"].as_array().into_iter().flatten() {
            let Some(id) = item["id"].as_str() else { continue };
            if item["deleted"].as_bool() == Some(true) {
                continue;
            }
            out.push(SourceInfo {
                google_id: id.to_string(),
                summary: item["summaryOverride"].as_str().or(item["summary"].as_str()).unwrap_or(id).to_string(),
                color: item["backgroundColor"].as_str().map(String::from),
                access_role: item["accessRole"].as_str().unwrap_or("reader").to_string(),
                primary: item["primary"].as_bool().unwrap_or(false),
                google_selected: item["selected"].as_bool().unwrap_or(false),
            });
        }
        page = body["nextPageToken"].as_str().map(String::from);
        if page.is_none() {
            break;
        }
    }
    Ok(out)
}

/// Reads one calendar: everything from 30 days ago the first time, then only what changed.
fn sync_events(app: &AppHandle, api: &Api, source_id: &str, google_id: &str) -> Result<(), String> {
    let mut token = store(app, |s| calendar::sync_token(s.conn(), source_id).map_err(|e| e.to_string()))?;
    'restart: for _ in 0..2 {
        let full = token.is_none();
        let (mut events, mut cancelled) = (Vec::new(), Vec::new());
        let mut page: Option<String> = None;
        let mut next_token = None;
        for _ in 0..40 {
            let mut path = format!("/calendars/{}/events?singleEvents=true&maxResults=2500", enc(google_id));
            match &token {
                Some(t) => path.push_str(&format!("&syncToken={}", enc(t))),
                None => {
                    let from = Utc::now() - chrono::Duration::days(HISTORY_DAYS);
                    path.push_str(&format!("&timeMin={}", enc(&from.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))));
                }
            }
            if let Some(p) = &page {
                path.push_str(&format!("&pageToken={}", enc(p)));
            }
            let reply = api.call("GET", &path, None)?;
            if reply.status == 410 {
                // Google forgot where we were: start this calendar over.
                store(app, |s| calendar::reset_source(s.conn(), source_id).map_err(|e| e.to_string()))?;
                token = None;
                continue 'restart;
            }
            if !reply.ok() {
                return Err(reply.message());
            }
            for item in reply.body["items"].as_array().into_iter().flatten() {
                let Some(id) = item["id"].as_str() else { continue };
                if item["status"].as_str() == Some("cancelled") {
                    cancelled.push(id.to_string());
                } else if let Some(e) = parse_event(item) {
                    events.push(e);
                }
            }
            page = reply.body["nextPageToken"].as_str().map(String::from);
            next_token = reply.body["nextSyncToken"].as_str().map(String::from);
            if page.is_none() {
                break;
            }
        }
        return store(app, |s| {
            calendar::apply_sync(s.conn_mut(), source_id, full, &events, &cancelled, next_token.as_deref()).map_err(|e| e.to_string())
        });
    }
    Err("Google Calendar kept asking to start over; trying again later.".into())
}

/// An event from Google's JSON; None for ones Focus cannot place (no start).
pub fn parse_event(item: &Value) -> Option<EventInfo> {
    let when = |v: &Value| -> Option<Result<i64, String>> {
        if let Some(d) = v["date"].as_str() {
            return Some(Err(d.to_string()));
        }
        let t = DateTime::parse_from_rfc3339(v["dateTime"].as_str()?).ok()?;
        Some(Ok(t.timestamp_millis()))
    };
    let start = when(&item["start"])?;
    let end = when(&item["end"]).unwrap_or_else(|| start.clone());
    let when = match (start, end) {
        (Ok(s), Ok(e)) => When::Timed { start: s, end: e },
        (Err(s), Err(e)) => When::AllDay { start: s, end: e },
        (Err(s), Ok(_)) => When::AllDay { end: next_day(&s)?, start: s },
        (Ok(s), Err(_)) => When::Timed { start: s, end: s },
    };
    Some(EventInfo {
        google_event_id: item["id"].as_str()?.to_string(),
        etag: item["etag"].as_str().map(String::from),
        summary: item["summary"].as_str().unwrap_or("(No title)").to_string(),
        when,
        time_zone: item["start"]["timeZone"].as_str().map(String::from),
        location: item["location"].as_str().unwrap_or_default().to_string(),
        description: item["description"].as_str().unwrap_or_default().to_string(),
        html_link: item["htmlLink"].as_str().map(String::from),
        recurring: item["recurringEventId"].is_string(),
    })
}

fn next_day(date: &str) -> Option<String> {
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    Some(d.succ_opt()?.format("%Y-%m-%d").to_string())
}

// ---------------------------------------------------------------- the Focus calendar

/// The Google event ID for a to-do or deadline: Google allows 0-9 and a-v, 5 to 1024 long.
pub fn event_id(key: &str) -> String {
    let hash = Sha256::digest(key.as_bytes());
    format!("fc{}", hash.iter().take(15).map(|b| format!("{b:02x}")).collect::<String>())
}

const WEEKDAYS: [&str; 7] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

fn local_date_of(ms: i64) -> Option<NaiveDate> {
    Local.timestamp_millis_opt(ms).single().map(|d| d.date_naive())
}

/// "2026-10-23" + "09:30" on this PC's clock, as Google wants it.
fn local_instant(date: NaiveDate, time: &str) -> Option<DateTime<Local>> {
    let t = NaiveTime::parse_from_str(time, "%H:%M").ok()?;
    Local.from_local_datetime(&date.and_time(t)).earliest()
}

/// The Google event for a to-do or deadline. `time_zone` (your Google one) is needed for
/// repeating events.
pub fn event_body(item: &Dated, time_zone: &str) -> Option<Value> {
    let key = item.key();
    let mut body = match item {
        Dated::Task { title, description, done, date, repeat_days, created_at, start_time, end_time, duration_min, space, .. } => {
            let day = match date {
                Some(d) => NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()?,
                None => {
                    // A repeating task starts on its first repeat day on or after the day it was made.
                    let mut d = local_date_of(*created_at)?;
                    for _ in 0..7 {
                        if repeat_days & (1 << d.weekday().num_days_from_sunday()) != 0 {
                            break;
                        }
                        d = d.succ_opt()?;
                    }
                    d
                }
            };
            let tz = if time_zone.is_empty() { "UTC" } else { time_zone };
            let (start, end) = match start_time.as_deref().and_then(|t| local_instant(day, t)) {
                Some(start) => {
                    let end = end_time
                        .as_deref()
                        .and_then(|t| {
                            let e = local_instant(day, t)?;
                            // An end at or before the start is past midnight, on the next day.
                            if e > start { Some(e) } else { local_instant(day.succ_opt()?, t) }
                        })
                        .filter(|e| *e > start)
                        .unwrap_or_else(|| start + chrono::Duration::minutes(duration_min.filter(|m| *m > 0).unwrap_or(30)));
                    (json!({ "dateTime": start.to_rfc3339(), "timeZone": tz }), json!({ "dateTime": end.to_rfc3339(), "timeZone": tz }))
                }
                None => (json!({ "date": day.format("%Y-%m-%d").to_string() }), json!({ "date": day.succ_opt()?.format("%Y-%m-%d").to_string() })),
            };
            let from = space.as_deref().map(|s| format!("From Focus · {s}")).unwrap_or_else(|| "From Focus · To-do".into());
            let mut body = json!({
                "summary": format!("{}{title}", if *done { "✓ " } else { "" }),
                "description": join_text(description, &from),
                "start": start,
                "end": end,
            });
            if *repeat_days > 0 {
                let days: Vec<&str> = (0..7).filter(|i| repeat_days & (1 << i) != 0).map(|i| WEEKDAYS[i]).collect();
                body["recurrence"] = json!([format!("RRULE:FREQ=WEEKLY;BYDAY={}", days.join(","))]);
            }
            body
        }
        Dated::Deadline { title, description, due_at, all_day, completed, .. } => {
            let (start, end) = if *all_day {
                let day = local_date_of(*due_at)?;
                (json!({ "date": day.format("%Y-%m-%d").to_string() }), json!({ "date": day.succ_opt()?.format("%Y-%m-%d").to_string() }))
            } else {
                let due = Utc.timestamp_millis_opt(*due_at).single()?;
                let end = due + chrono::Duration::minutes(30);
                (json!({ "dateTime": due.to_rfc3339() }), json!({ "dateTime": end.to_rfc3339() }))
            };
            json!({
                "summary": format!("{}Due: {title}", if *completed { "✓ " } else { "" }),
                "description": join_text(description, "From Focus · Deadlines"),
                "start": start,
                "end": end,
            })
        }
    };
    // No pop-ups from Google for these; Focus has its own reminders.
    body["reminders"] = json!({ "useDefault": false });
    body["status"] = json!("confirmed");
    body["extendedProperties"] = json!({ "private": { "focusKey": key } });
    Some(body)
}

/// The item's own description, then where it came from.
fn join_text(description: &str, from: &str) -> String {
    let d = description.trim();
    if d.is_empty() { from.to_string() } else { format!("{d}\n\n{from}") }
}

fn hash(body: &Value) -> String {
    Sha256::digest(body.to_string().as_bytes()).iter().take(12).map(|b| format!("{b:02x}")).collect()
}

/// Brings the Focus calendar in line with your to-dos and deadlines: writes what is new or
/// changed and deletes what is gone (everything, when `push` is off). Returns how many could not
/// be written.
fn push_focus(app: &AppHandle, api: &Api, focus_id: &str, time_zone: &str, push: bool) -> Result<usize, String> {
    let items = if push { store(app, |s| calendar::dated_items(s.conn()).map_err(|e| e.to_string()))? } else { Vec::new() };
    let done: HashMap<String, calendar::Push> =
        store(app, |s| calendar::pushes(s.conn()).map_err(|e| e.to_string()))?.into_iter().map(|p| (p.key.clone(), p)).collect();
    let events = format!("/calendars/{}/events", enc(focus_id));
    let mut failed = 0;
    let mut wanted = std::collections::HashSet::new();

    for item in &items {
        let key = item.key();
        wanted.insert(key.clone());
        let Some(mut body) = event_body(item, time_zone) else { continue };
        let h = hash(&body);
        let id = event_id(&key);
        let before = done.get(&key);
        if before.is_some_and(|p| p.hash == h) {
            continue;
        }
        body["id"] = json!(id);
        let one = format!("{events}/{id}");
        // Change it if it should be there; make it if not. A deleted event keeps its ID in
        // Google, so making it again is a change too.
        let mut reply = if before.is_some() { api.call("PUT", &one, Some(&body))? } else { api.call("POST", &events, Some(&body))? };
        if reply.status == 404 && before.is_some() {
            reply = api.call("POST", &events, Some(&body))?;
        } else if reply.status == 409 {
            reply = api.call("PUT", &one, Some(&body))?;
        }
        if reply.ok() {
            store(app, |s| calendar::record_push(s.conn(), &key, &id, &h).map_err(|e| e.to_string()))?;
        } else if reply.status == 404 {
            // The Focus calendar itself is gone; it is made again next time.
            set_setting(app, "google.focusCalendarId", &"")?;
            return Err("The Focus calendar was removed in Google. Kairos will make it again.".into());
        } else if reply.status == 429 || reply.status >= 500 || reply.message().contains("slow down") {
            return Err(reply.message());
        } else {
            failed += 1;
        }
        // Stay well under Google's limit of writes per minute.
        std::thread::sleep(Duration::from_millis(120));
    }

    for (key, p) in done.iter().filter(|(k, _)| !wanted.contains(*k)) {
        let reply = api.call("DELETE", &format!("{events}/{}", p.event_id), None)?;
        if reply.ok() || reply.status == 404 || reply.status == 410 {
            store(app, |s| calendar::forget_push(s.conn(), key).map_err(|e| e.to_string()))?;
        } else {
            failed += 1;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    Ok(failed)
}

// ---------------------------------------------------------------- your own events

/// A new or changed event from the Calendar page. Mirrored by `EventInput` in src/ipc/calendar.ts.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInput {
    pub source_id: String,
    pub summary: String,
    pub all_day: bool,
    /// All-day: first day and the day after the last ("YYYY-MM-DD").
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// Timed: UTC ms.
    pub start_at: Option<i64>,
    pub end_at: Option<i64>,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub description: String,
}

fn input_body(input: &EventInput) -> Result<Value, String> {
    let summary = input.summary.trim();
    if summary.is_empty() {
        return Err("Give the event a name.".into());
    }
    let (start, end) = if input.all_day {
        let s = input.start_date.as_deref().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()).ok_or("Pick a day.")?;
        let e = input.end_date.as_deref().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()).filter(|e| *e > s);
        let e = e.or(s.succ_opt()).ok_or("Pick a day.")?;
        (json!({ "date": s.format("%Y-%m-%d").to_string(), "dateTime": null }), json!({ "date": e.format("%Y-%m-%d").to_string(), "dateTime": null }))
    } else {
        let s = input.start_at.and_then(|ms| Utc.timestamp_millis_opt(ms).single()).ok_or("Pick a start time.")?;
        let e = input.end_at.and_then(|ms| Utc.timestamp_millis_opt(ms).single()).ok_or("Pick an end time.")?;
        if e < s {
            return Err("The event ends before it starts.".into());
        }
        (json!({ "dateTime": s.to_rfc3339(), "date": null }), json!({ "dateTime": e.to_rfc3339(), "date": null }))
    };
    Ok(json!({
        "summary": summary,
        "location": input.location.trim(),
        "description": input.description.trim(),
        "start": start,
        "end": end,
    }))
}

fn writable_source(app: &AppHandle, source_id: &str) -> Result<calendar::Source, String> {
    let source = store(app, |s| calendar::source(s.conn(), source_id).map_err(|e| e.to_string()))?.ok_or("That calendar is no longer there.")?;
    if !source.writable() {
        return Err(if source.focus {
            "Events in the Focus calendar follow your to-dos and deadlines; change them there.".into()
        } else {
            format!("You can only look at \"{}\", not change it.", source.summary)
        });
    }
    Ok(source)
}

fn after_write(app: &AppHandle, api: &Api, source: &calendar::Source) -> Result<(), String> {
    let result = sync_events(app, api, &source.id, &source.google_id);
    publish_mirror(app);
    let _ = app.emit("calendar-changed", ());
    result
}

#[tauri::command]
pub fn calendar_status(app: AppHandle) -> SyncStatus {
    status(&app)
}

#[tauri::command]
pub fn list_calendars(state: tauri::State<'_, StoreState>) -> Result<Vec<calendar::Source>, String> {
    state.with(|s| calendar::sources(s.conn()).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn set_calendar_shown(app: AppHandle, state: tauri::State<'_, StoreState>, id: String, shown: bool) -> Result<(), String> {
    state.with(|s| calendar::set_selected(s.conn_mut(), &id, shown).map_err(|e| e.to_string()))?;
    publish_mirror(&app);
    let _ = app.emit("calendar-changed", ());
    wake(&app);
    Ok(())
}

#[tauri::command]
pub fn set_calendar_push(app: AppHandle, state: tauri::State<'_, StoreState>, on: bool) -> Result<(), String> {
    state.with(|s| settings::set(s, "calendar.pushFocus", &on).map_err(|e| e.to_string()))?;
    wake(&app);
    Ok(())
}

/// "Sync Google Calendar automatically". Turning it on syncs right away.
#[tauri::command]
pub fn set_calendar_auto(app: AppHandle, state: tauri::State<'_, StoreState>, on: bool) -> Result<(), String> {
    state.with(|s| settings::set(s, "calendar.autoSync", &on).map_err(|e| e.to_string()))?;
    if on {
        wake(&app);
    }
    let _ = app.emit("calendar-sync", status(&app));
    Ok(())
}

#[tauri::command]
pub fn calendar_sync_now(app: AppHandle) {
    wake(&app);
}

/// Events of the shown calendars in a range (the page works out the local dates and times).
#[tauri::command]
pub fn list_calendar_events(
    state: tauri::State<'_, StoreState>,
    from_date: String,
    to_date: String,
    from_ms: i64,
    to_ms: i64,
) -> Result<Vec<calendar::Event>, String> {
    state.with(|s| calendar::events_between(s.conn(), &from_date, &to_date, from_ms, to_ms).map_err(|e| e.to_string()))
}

/// Adds an event (no `id`) or changes one, in Google first, then here.
#[tauri::command]
pub async fn save_calendar_event(app: AppHandle, id: Option<String>, input: EventInput) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let api = Api::new(&app);
        let body = input_body(&input)?;
        match id {
            None => {
                let source = writable_source(&app, &input.source_id)?;
                api.must("POST", &format!("/calendars/{}/events", enc(&source.google_id)), Some(&body))?;
                after_write(&app, &api, &source)
            }
            Some(id) => {
                let (source, google_event) =
                    store(&app, |s| calendar::event(s.conn(), &id).map_err(|e| e.to_string()))?.ok_or("That event is no longer there.")?;
                writable_source(&app, &source.id)?;
                let path = format!("/calendars/{}/events/{}", enc(&source.google_id), enc(&google_event));
                if source.id == input.source_id {
                    api.must("PATCH", &path, Some(&body))?;
                    after_write(&app, &api, &source)
                } else {
                    // Moved to another calendar: make it there, then remove the old one.
                    let target = writable_source(&app, &input.source_id)?;
                    api.must("POST", &format!("/calendars/{}/events", enc(&target.google_id)), Some(&body))?;
                    api.must("DELETE", &path, None)?;
                    after_write(&app, &api, &source)?;
                    after_write(&app, &api, &target)
                }
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_calendar_event(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let api = Api::new(&app);
        let (source, google_event) =
            store(&app, |s| calendar::event(s.conn(), &id).map_err(|e| e.to_string()))?.ok_or("That event is no longer there.")?;
        writable_source(&app, &source.id)?;
        let reply = api.call("DELETE", &format!("/calendars/{}/events/{}", enc(&source.google_id), enc(&google_event)), None)?;
        if !(reply.ok() || reply.status == 404 || reply.status == 410) {
            return Err(reply.message());
        }
        after_write(&app, &api, &source)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(date: Option<&str>, repeat: i64, start: Option<&str>, end: Option<&str>) -> Dated {
        Dated::Task {
            id: "t1".into(),
            title: "Gym".into(),
            description: String::new(),
            done: false,
            date: date.map(String::from),
            repeat_days: repeat,
            // Friday 23 Oct 2026, midday UTC.
            created_at: 1_792_756_800_000,
            start_time: start.map(String::from),
            end_time: end.map(String::from),
            duration_min: None,
            space: None,
        }
    }

    #[test]
    fn event_ids_are_stable_and_allowed_by_google() {
        let a = event_id("task:0192-abc");
        assert_eq!(a, event_id("task:0192-abc"));
        assert_ne!(a, event_id("deadline:0192-abc"));
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_digit() || ('a'..='v').contains(&c)));
    }

    #[test]
    fn a_dated_task_is_an_all_day_event() {
        let body = event_body(&task(Some("2026-10-25"), 0, None, None), "Asia/Kolkata").unwrap();
        assert_eq!(body["start"]["date"], "2026-10-25");
        assert_eq!(body["end"]["date"], "2026-10-26");
        assert_eq!(body["summary"], "Gym");
        assert_eq!(body["description"], "From Focus · To-do");
        assert_eq!(body["extendedProperties"]["private"]["focusKey"], "task:t1");
        assert!(body.get("recurrence").is_none());
    }

    #[test]
    fn a_timed_task_lasts_until_its_end_or_half_an_hour() {
        let body = event_body(&task(Some("2026-10-25"), 0, Some("09:30"), Some("11:00")), "Asia/Kolkata").unwrap();
        let start = DateTime::parse_from_rfc3339(body["start"]["dateTime"].as_str().unwrap()).unwrap();
        let end = DateTime::parse_from_rfc3339(body["end"]["dateTime"].as_str().unwrap()).unwrap();
        assert_eq!((end - start).num_minutes(), 90);
        let body = event_body(&task(Some("2026-10-25"), 0, Some("09:30"), None), "").unwrap();
        let start = DateTime::parse_from_rfc3339(body["start"]["dateTime"].as_str().unwrap()).unwrap();
        let end = DateTime::parse_from_rfc3339(body["end"]["dateTime"].as_str().unwrap()).unwrap();
        assert_eq!((end - start).num_minutes(), 30);
        assert_eq!(body["start"]["timeZone"], "UTC");
        let body = event_body(&task(Some("2026-10-25"), 0, Some("23:00"), Some("00:00")), "").unwrap();
        let start = DateTime::parse_from_rfc3339(body["start"]["dateTime"].as_str().unwrap()).unwrap();
        let end = DateTime::parse_from_rfc3339(body["end"]["dateTime"].as_str().unwrap()).unwrap();
        assert_eq!((end - start).num_minutes(), 60, "an end past midnight is the next day");
    }

    #[test]
    fn a_repeating_task_repeats_weekly_from_its_first_day() {
        // Monday and Wednesday.
        let body = event_body(&task(None, 2 | 8, None, None), "Asia/Kolkata").unwrap();
        assert_eq!(body["recurrence"][0], "RRULE:FREQ=WEEKLY;BYDAY=MO,WE");
        let first = NaiveDate::parse_from_str(body["start"]["date"].as_str().unwrap(), "%Y-%m-%d").unwrap();
        assert!(matches!(first.weekday(), chrono::Weekday::Mon | chrono::Weekday::Wed));
        assert!(first >= NaiveDate::from_ymd_opt(2026, 10, 22).unwrap() && first <= NaiveDate::from_ymd_opt(2026, 10, 29).unwrap());
    }

    #[test]
    fn deadlines_are_due_events() {
        let d = Dated::Deadline { id: "d1".into(), title: "Essay".into(), description: String::new(), due_at: 1_792_756_800_000, all_day: false, completed: true };
        let body = event_body(&d, "").unwrap();
        assert_eq!(body["summary"], "✓ Due: Essay");
        assert_eq!(body["start"]["dateTime"], "2026-10-23T12:00:00+00:00");
        assert_eq!(body["end"]["dateTime"], "2026-10-23T12:30:00+00:00");
        assert_eq!(body["reminders"]["useDefault"], false);
    }

    #[test]
    fn google_events_are_read() {
        let timed = parse_event(&json!({
            "id": "e1", "summary": "Call", "start": {"dateTime": "2026-10-23T10:00:00+05:30"}, "end": {"dateTime": "2026-10-23T11:00:00+05:30"},
            "recurringEventId": "r"
        }))
        .unwrap();
        assert_eq!(timed.when, When::Timed { start: 1_792_729_800_000, end: 1_792_733_400_000 });
        assert!(timed.recurring);
        let holiday = parse_event(&json!({ "id": "h", "summary": "Diwali", "start": {"date": "2026-11-08"}, "end": {"date": "2026-11-09"} })).unwrap();
        assert_eq!(holiday.when, When::AllDay { start: "2026-11-08".into(), end: "2026-11-09".into() });
        assert_eq!(parse_event(&json!({ "id": "x" })), None);
    }

    #[test]
    fn your_events_are_checked() {
        let input = |all_day: bool, start_at: Option<i64>, end_at: Option<i64>| EventInput {
            source_id: "s".into(),
            summary: " Dentist ".into(),
            all_day,
            start_date: Some("2026-10-30".into()),
            end_date: None,
            start_at,
            end_at,
            location: String::new(),
            description: String::new(),
        };
        let body = input_body(&input(true, None, None)).unwrap();
        assert_eq!((body["summary"].as_str(), body["end"]["date"].as_str()), (Some("Dentist"), Some("2026-10-31")));
        assert!(input_body(&input(false, Some(2_000), Some(1_000))).is_err());
        assert!(input_body(&input(false, Some(1_000), Some(2_000))).is_ok());
    }
}
