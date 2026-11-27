//! Scheduled focus: focus that starts on its own at set times, e.g. weekdays 9:00–12:00.
//! The list is synced, so the laptop and the phone follow the same schedule. The laptop starts
//! a real timer session when a window opens (apps/desktop/src-tauri/src/timer.rs); the phone
//! only works out from the clock that focus is on (`phone_focus::effective_live`), so nothing
//! has to run on the phone. Stopping a scheduled session early skips that window on every
//! device (`focus.scheduleSkips`, synced).

use chrono::{Datelike, Duration, Local, NaiveDate, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::settings;

/// One schedule. Mirrored by `Schedule` in apps/desktop/src/ipc/schedule.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    /// "Morning study". Shown as the session's name.
    pub name: String,
    /// Weekdays it runs on: Sunday = 1, Monday = 2 … Saturday = 64 (like to-do repeats).
    pub days: u8,
    /// "09:00", 24-hour local time.
    pub start: String,
    /// "12:00". Earlier than `start` = ends the next day ("22:00"–"01:00").
    pub end: String,
    pub enabled: bool,
    /// "focus" (default): a focus session runs, and blocking with it. "block": only blocking,
    /// no session (a habit rule, e.g. no games after 22:00). The phone blocks the same for both.
    #[serde(default = "focus_kind")]
    pub kind: String,
}

fn focus_kind() -> String {
    "focus".into()
}

/// A schedule's window that is open now.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub schedule_id: String,
    pub name: String,
    /// `<schedule id>@<YYYY-MM-DD the window started>`: names this one window, for skipping.
    pub key: String,
    pub started_at_ms: u64,
    pub ends_at_ms: u64,
    /// The schedule's `kind`: "focus" or "block".
    pub kind: String,
}

/// At most this many skipped windows are remembered (old ones can't open again anyway).
const SKIPS_KEPT: usize = 40;

fn minutes(hm: &str) -> Option<u32> {
    let (h, m) = hm.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

fn day_bit(date: NaiveDate) -> u8 {
    1 << date.weekday().num_days_from_sunday()
}

impl Schedule {
    fn check(&self) -> Result<()> {
        let bad = |m: &str| Err(StoreError::Invalid(m.into()));
        if self.id.trim().is_empty() {
            return bad("a schedule needs an id");
        }
        if self.name.trim().is_empty() || self.name.chars().count() > 60 {
            return bad("give the schedule a name (up to 60 characters)");
        }
        if self.days & 0x7f == 0 {
            return bad("pick at least one day");
        }
        match (minutes(&self.start), minutes(&self.end)) {
            (Some(a), Some(b)) if a != b => Ok(()),
            (Some(_), Some(_)) => bad("the start and end times are the same"),
            _ => bad("times look like 09:00"),
        }
    }

    /// The window open at local time `at`, if any.
    fn window_at(&self, at: NaiveDateTime) -> Option<(NaiveDateTime, NaiveDateTime)> {
        if !self.enabled {
            return None;
        }
        let (start, end) = (minutes(&self.start)?, minutes(&self.end)?);
        // The window may have started today, or yesterday when it runs past midnight.
        for back in [0i64, 1] {
            let day = at.date() - Duration::days(back);
            if self.days & day_bit(day) == 0 {
                continue;
            }
            let from = day.and_hms_opt(start / 60, start % 60, 0)?;
            let mut to = day.and_hms_opt(end / 60, end % 60, 0)?;
            if end <= start {
                to += Duration::days(1);
            }
            if from <= at && at < to {
                return Some((from, to));
            }
        }
        None
    }
}

fn to_ms(t: NaiveDateTime) -> u64 {
    // A time skipped by a clock change: take the next one that exists.
    Local
        .from_local_datetime(&t)
        .earliest()
        .or_else(|| Local.from_local_datetime(&(t + Duration::hours(1))).earliest())
        .map(|d| d.timestamp_millis().max(0) as u64)
        .unwrap_or(0)
}

fn local_at(now_ms: u64) -> NaiveDateTime {
    Local.timestamp_millis_opt(now_ms as i64).single().map(|d| d.naive_local()).unwrap_or_default()
}

/// The first window open at local time `at`, ignoring the skipped ones.
pub fn open_window(list: &[Schedule], skips: &[String], at: NaiveDateTime) -> Option<Window> {
    list.iter().find_map(|s| {
        let (from, to) = s.window_at(at)?;
        let key = format!("{}@{}", s.id, from.date());
        (!skips.contains(&key)).then(|| Window {
            schedule_id: s.id.clone(),
            name: s.name.clone(),
            key,
            started_at_ms: to_ms(from),
            ends_at_ms: to_ms(to),
            kind: s.kind.clone(),
        })
    })
}

pub fn list(store: &Store) -> Result<Vec<Schedule>> {
    let raw: serde_json::Value = settings::get(store, "focus.schedules")?;
    Ok(serde_json::from_value(raw).unwrap_or_default())
}

pub fn save(store: &mut Store, list: &[Schedule]) -> Result<()> {
    if list.len() > 20 {
        return Err(StoreError::Invalid("up to 20 schedules".into()));
    }
    for s in list {
        s.check()?;
    }
    let tidy: Vec<Schedule> = list
        .iter()
        .map(|s| Schedule { name: s.name.trim().into(), start: s.start.trim().into(), end: s.end.trim().into(), days: s.days & 0x7f, kind: if s.kind == "block" { "block".into() } else { "focus".into() }, ..s.clone() })
        .collect();
    settings::set(store, "focus.schedules", &tidy)
}

pub fn skips(store: &Store) -> Result<Vec<String>> {
    let raw: serde_json::Value = settings::get(store, "focus.scheduleSkips")?;
    Ok(serde_json::from_value(raw).unwrap_or_default())
}

/// Stops this window on every device; it opens again next time the schedule comes round.
pub fn skip(store: &mut Store, key: &str) -> Result<()> {
    let mut all = skips(store)?;
    if all.iter().any(|k| k == key) {
        return Ok(());
    }
    all.push(key.to_string());
    let from = all.len().saturating_sub(SKIPS_KEPT);
    settings::set(store, "focus.scheduleSkips", &all[from..].to_vec())
}

/// The scheduled focus window open now on this device's clock, if any.
pub fn current(store: &Store, now_ms: u64) -> Result<Option<Window>> {
    let list = list(store)?;
    if list.iter().all(|s| !s.enabled) {
        return Ok(None);
    }
    Ok(open_window(&list, &skips(store)?, local_at(now_ms)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(date: &str, hm: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(&format!("{date} {hm}"), "%Y-%m-%d %H:%M").unwrap()
    }

    fn sched(days: u8, start: &str, end: &str) -> Schedule {
        Schedule { id: "s1".into(), name: "Study".into(), days, start: start.into(), end: end.into(), enabled: true, kind: "focus".into() }
    }

    // 2026-10-26 is a Monday.
    const MON: u8 = 2;
    const WEEKDAYS: u8 = 2 | 4 | 8 | 16 | 32;

    #[test]
    fn opens_on_its_days_between_its_times() {
        let s = [sched(WEEKDAYS, "09:00", "12:00")];
        let w = open_window(&s, &[], at("2026-10-26", "10:30")).unwrap();
        assert_eq!(w.key, "s1@2026-10-26");
        assert!(open_window(&s, &[], at("2026-10-26", "12:00")).is_none(), "the end is not inside");
        assert!(open_window(&s, &[], at("2026-10-26", "08:59")).is_none());
        assert!(open_window(&s, &[], at("2026-10-25", "10:00")).is_none(), "Sunday is off");
    }

    #[test]
    fn a_window_can_run_past_midnight() {
        let s = [sched(MON, "22:00", "01:00")];
        assert_eq!(open_window(&s, &[], at("2026-10-27", "00:30")).unwrap().key, "s1@2026-10-26");
        assert!(open_window(&s, &[], at("2026-10-27", "22:30")).is_none(), "Tuesday isn't picked");
    }

    #[test]
    fn skipped_and_disabled_windows_stay_shut() {
        let mut s = sched(WEEKDAYS, "09:00", "12:00");
        assert!(open_window(&[s.clone()], &["s1@2026-10-26".into()], at("2026-10-26", "10:00")).is_none());
        assert!(open_window(&[s.clone()], &["s1@2026-10-26".into()], at("2026-10-27", "10:00")).is_some());
        s.enabled = false;
        assert!(open_window(&[s], &[], at("2026-10-26", "10:00")).is_none());
    }

    #[test]
    fn saving_checks_the_times() {
        let mut store = Store::open_in_memory().unwrap();
        assert!(save(&mut store, &[sched(0, "09:00", "10:00")]).is_err());
        assert!(save(&mut store, &[sched(MON, "9", "10:00")]).is_err());
        assert!(save(&mut store, &[sched(MON, "09:00", "09:00")]).is_err());
        save(&mut store, &[sched(MON, " 09:00", "10:00 ")]).unwrap();
        assert_eq!(list(&store).unwrap()[0].start, "09:00");
        skip(&mut store, "s1@2026-10-26").unwrap();
        skip(&mut store, "s1@2026-10-26").unwrap();
        assert_eq!(skips(&store).unwrap().len(), 1);
    }
}
