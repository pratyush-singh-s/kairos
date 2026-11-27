//! Statistics (Phase 20). Nothing is stored for them: they are read from focus sessions, tracked
//! app time and distraction events. Three numbers are kept apart on purpose:
//! - focus time: what the timer counted (pauses not included),
//! - active computer time: tracked time at the keyboard (only with app tracking on),
//! - app time: the same tracked time, per program,
//! - PC on time: how long this PC was on (`pc_time`), idle or not.
//!
//! Focus from the phone or another PC syncs here too, so the chart compares only this PC's own
//! focus with this PC's on time: focus on one PC can never be longer than that PC was on.
//!
//! Period and day boundaries come from the caller (the UI knows the local time zone), so these
//! functions work on UTC milliseconds only.

use rusqlite::params;
use serde::Serialize;

use crate::Store;
use crate::error::Result;
use crate::ids::new_id;
use crate::store::now_ms;

/// A finished focus session (not a break).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatSession {
    pub started_at: i64,
    pub ended_at: i64,
    pub actual_s: i64,
    pub outcome: String,
    /// Timed on this PC (not synced from the phone or another PC).
    pub here: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppStat {
    pub name: String,
    /// All tracked time in the period.
    pub seconds: i64,
    /// The part of it during focus sessions.
    pub focus_seconds: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DomainCount {
    pub domain: String,
    pub count: i64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Distractions {
    /// Times a blocked site or video was opened during focus.
    pub blocked: i64,
    /// Times "Continue anyway" was pressed after the countdown.
    pub continued: i64,
    pub top_domains: Vec<DomainCount>,
}

/// Everything the Statistics page shows for one period. Mirrors `StatsData` in src/ipc/stats.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsData {
    pub sessions: Vec<StatSession>,
    /// Active computer seconds in each bucket (`bounds[i]..bounds[i + 1]`).
    pub active: Vec<i64>,
    /// Seconds this PC was on in each bucket.
    pub pc_on: Vec<i64>,
    /// Focus seconds timed on this PC in each bucket, spread over each session's start to end,
    /// so a session over midnight counts on both days. Never more than `pc_on`.
    pub focus_here: Vec<i64>,
    pub apps: Vec<AppStat>,
    pub distractions: Distractions,
    /// Start times of completed focus sessions from `streak_from_ms` to the period's end, for streaks.
    pub focus_starts: Vec<i64>,
    /// When app tracking first recorded anything that is still kept, if ever.
    pub tracked_since: Option<i64>,
    /// "Why are you here?" answers in the period, most frequent first.
    pub reasons: Vec<crate::reasons::ReasonCount>,
}

/// `bounds` are the bucket edges of the period (days, or months for a year), oldest first.
pub fn load(store: &Store, bounds: &[i64], streak_from_ms: i64) -> Result<StatsData> {
    let (Some(&from), Some(&to)) = (bounds.first(), bounds.last()) else {
        return Ok(StatsData {
            sessions: vec![],
            active: vec![],
            pc_on: vec![],
            focus_here: vec![],
            apps: vec![],
            distractions: Distractions::default(),
            focus_starts: vec![],
            tracked_since: None,
            reasons: vec![],
        });
    };
    let active = bounds.windows(2).map(|w| active_seconds(store, w[0], w[1])).collect::<Result<Vec<_>>>()?;
    let on = crate::pc_time::on_ranges(store, from, to)?;
    let pc_on: Vec<i64> = bounds.windows(2).map(|w| crate::pc_time::seconds_within(&on, w[0], w[1])).collect();
    let sessions = sessions(store, from, to)?;
    let focus_here = bounds
        .windows(2)
        .zip(&pc_on)
        .map(|(w, &on)| sessions.iter().filter(|s| s.here).map(|s| spread(s, w[0], w[1])).sum::<i64>().min(on))
        .collect();
    Ok(StatsData {
        sessions,
        active,
        pc_on,
        focus_here,
        apps: apps(store, from, to, 8)?,
        distractions: distractions(store, from, to, 5)?,
        focus_starts: focus_starts(store, streak_from_ms.min(from), to)?,
        tracked_since: store.conn().query_row("SELECT min(started_at) FROM activity_spans", [], |r| r.get(0))?,
        reasons: crate::reasons::top(store, from, to, 8)?,
    })
}

fn sessions(store: &Store, from: i64, to: i64) -> Result<Vec<StatSession>> {
    let mut stmt = store.conn().prepare(
        "SELECT started_at, ended_at, coalesce(actual_s, 0), coalesce(outcome, ''), device_id = ?3 FROM focus_sessions
         WHERE phase = 'focus' AND deleted_at IS NULL AND ended_at IS NOT NULL AND outcome != 'cancelled'
           AND started_at >= ?1 AND started_at < ?2
         ORDER BY started_at",
    )?;
    let rows = stmt.query_map(params![from, to, store.device_id()], |r| {
        Ok(StatSession { started_at: r.get(0)?, ended_at: r.get(1)?, actual_s: r.get(2)?, outcome: r.get(3)?, here: r.get(4)? })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// The part of a session's focus seconds that falls in `from..to`. Pauses are spread evenly, and
/// a session never counts faster than the clock (if the PC clock jumped, `actual_s` may not fit).
fn spread(s: &StatSession, from: i64, to: i64) -> i64 {
    let span = s.ended_at - s.started_at;
    if span <= 0 || s.actual_s <= 0 {
        return 0;
    }
    let inside = (s.ended_at.min(to) - s.started_at.max(from)).max(0);
    let focus_ms = (s.actual_s * 1000).min(span);
    ((focus_ms as i128 * inside as i128 / span as i128) / 1000) as i64
}

/// Tracked seconds at the computer in `from..to`, any program.
fn active_seconds(store: &Store, from: i64, to: i64) -> Result<i64> {
    Ok(store.conn().query_row(
        "SELECT coalesce(sum(min(ended_at, ?2) - max(started_at, ?1)), 0) / 1000
         FROM activity_spans WHERE ended_at > ?1 AND started_at < ?2",
        params![from, to],
        |r| r.get(0),
    )?)
}

/// Most used programs, with how much of each was during focus.
fn apps(store: &Store, from: i64, to: i64, limit: i64) -> Result<Vec<AppStat>> {
    let mut stmt = store.conn().prepare(
        "WITH total AS (
             SELECT s.app_id, sum(min(s.ended_at, ?2) - max(s.started_at, ?1)) / 1000 AS secs
             FROM activity_spans s WHERE s.ended_at > ?1 AND s.started_at < ?2 GROUP BY s.app_id
         ), focus AS (
             SELECT u.app_id, sum(u.active_s) AS secs
             FROM app_usage u JOIN focus_sessions f ON f.id = u.session_id
             WHERE u.deleted_at IS NULL AND f.deleted_at IS NULL AND f.started_at >= ?1 AND f.started_at < ?2
             GROUP BY u.app_id
         )
         SELECT a.display_name, max(coalesce(t.secs, 0), coalesce(f.secs, 0)) AS all_secs, coalesce(f.secs, 0)
         FROM apps a LEFT JOIN total t ON t.app_id = a.id LEFT JOIN focus f ON f.app_id = a.id
         WHERE all_secs > 0 ORDER BY all_secs DESC LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![from, to, limit], |r| {
        Ok(AppStat { name: r.get(0)?, seconds: r.get(1)?, focus_seconds: r.get(2)? })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn distractions(store: &Store, from: i64, to: i64, limit: i64) -> Result<Distractions> {
    let (blocked, continued) = store.conn().query_row(
        "SELECT coalesce(sum(kind = 'blocked_hit'), 0), coalesce(sum(kind = 'continued'), 0)
         FROM distraction_events WHERE deleted_at IS NULL AND at >= ?1 AND at < ?2",
        params![from, to],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let mut stmt = store.conn().prepare(
        "SELECT domain, count(*) AS n FROM distraction_events
         WHERE deleted_at IS NULL AND kind = 'blocked_hit' AND domain IS NOT NULL AND at >= ?1 AND at < ?2
         GROUP BY domain ORDER BY n DESC, domain LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![from, to, limit], |r| Ok(DomainCount { domain: r.get(0)?, count: r.get(1)? }))?;
    Ok(Distractions { blocked, continued, top_domains: rows.collect::<std::result::Result<_, _>>()? })
}

fn focus_starts(store: &Store, from: i64, to: i64) -> Result<Vec<i64>> {
    let mut stmt = store.conn().prepare(
        "SELECT started_at FROM focus_sessions
         WHERE phase = 'focus' AND deleted_at IS NULL AND outcome = 'completed' AND started_at >= ?1 AND started_at < ?2
         ORDER BY started_at",
    )?;
    let rows = stmt.query_map(params![from, to], |r| r.get(0))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// What the browser extension reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistractionKind {
    BlockedHit,
    Continued,
}

impl DistractionKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "blocked_hit" => Some(Self::BlockedHit),
            "continued" => Some(Self::Continued),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::BlockedHit => "blocked_hit",
            Self::Continued => "continued",
        }
    }
}

/// A site name as it may be stored: lower case, no "www.", only host characters. Never a full address.
pub fn clean_domain(raw: &str) -> Option<String> {
    let d = raw.trim().to_ascii_lowercase();
    let d = d.strip_prefix("www.").unwrap_or(&d);
    let ok = !d.is_empty() && d.len() <= 253 && d.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    ok.then(|| d.to_string())
}

/// Saves one distraction during the focus session `session_id`.
pub fn add_distraction(store: &mut Store, session_id: Option<&str>, kind: DistractionKind, domain: Option<&str>, at: i64) -> Result<()> {
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    store.conn().execute(
        "INSERT INTO distraction_events (id, session_id, kind, domain, at, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![new_id(), session_id, kind.as_str(), domain, at, now_ms() as i64, stamp, device],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::{self, Sample};
    use crate::sessions::{self, NewSession, Outcome};

    const S: i64 = 1000;
    const H: i64 = 3600 * S;

    fn focus(store: &mut Store, start: i64, actual: i64, outcome: Outcome) -> String {
        let id = sessions::begin(
            store,
            NewSession { cycle_id: "c", session_number: 1, phase: "focus", started_at: start, planned_s: 1500, preset_id: None, deadline_id: None },
        )
        .unwrap();
        sessions::finish(store, &id, start + actual * S, actual, outcome).unwrap();
        id
    }

    fn track(store: &mut Store, exe: &str, from: i64, to: i64, session: Option<&str>) {
        let name = exe.trim_end_matches(".exe");
        activity::add(store, Sample { exe, display_name: name, from_ms: from, to_ms: to, span: None, session_id: session }).unwrap();
    }

    #[test]
    fn sessions_active_time_and_apps_are_kept_apart() {
        let mut store = Store::open_in_memory().unwrap();
        let a = focus(&mut store, H, 1500, Outcome::Completed);
        focus(&mut store, 30 * H, 600, Outcome::Interrupted);
        // Outside the period.
        focus(&mut store, 60 * H, 1500, Outcome::Completed);
        track(&mut store, "Code.exe", H, H + 1200 * S, Some(&a));
        track(&mut store, "firefox.exe", H + 1200 * S, H + 1500 * S, Some(&a));
        track(&mut store, "firefox.exe", 5 * H, 6 * H, None);

        let d = load(&store, &[0, 24 * H, 48 * H], 0).unwrap();
        assert_eq!(d.sessions.len(), 2);
        assert_eq!(d.sessions[0].actual_s, 1500);
        assert_eq!(d.sessions[1].outcome, "interrupted");
        assert_eq!(d.active, vec![1500 + 3600, 0]);
        assert_eq!(d.apps[0], AppStat { name: "firefox".into(), seconds: 300 + 3600, focus_seconds: 300 });
        assert_eq!(d.apps[1], AppStat { name: "Code".into(), seconds: 1200, focus_seconds: 1200 });
        assert_eq!(d.focus_starts, vec![H]);
        assert_eq!(d.tracked_since, Some(H));
    }

    #[test]
    fn focus_on_this_pc_never_beats_pc_on_time() {
        let mut store = Store::open_in_memory().unwrap();
        // 25 minutes on this PC, from 23:50 to 00:15: ten minutes on day one, fifteen on day two.
        focus(&mut store, 24 * H - 600 * S, 1500, Outcome::Completed);
        // An hour timed on the phone, synced here.
        let phone = focus(&mut store, 30 * H, 3600, Outcome::Completed);
        store.conn().execute("UPDATE focus_sessions SET device_id = 'phone' WHERE id = ?1", [&phone]).unwrap();
        // The PC was on for twenty minutes of day two, from midnight.
        for t in (0..=1200).step_by(15) {
            crate::pc_time::note(&store, 24 * H + t * S).unwrap();
        }

        let d = load(&store, &[0, 24 * H, 48 * H], 0).unwrap();
        assert_eq!(d.sessions.iter().map(|s| s.here).collect::<Vec<_>>(), vec![true, false]);
        // The session itself shows the PC was on before midnight.
        assert_eq!(d.pc_on, vec![600, 1200]);
        assert_eq!(d.focus_here, vec![600, 900]);
        assert!(d.focus_here.iter().zip(&d.pc_on).all(|(f, on)| f <= on));
    }

    #[test]
    fn distractions_count_by_kind_and_site() {
        let mut store = Store::open_in_memory().unwrap();
        for (kind, domain, at) in [
            (DistractionKind::BlockedHit, "youtube.com", H),
            (DistractionKind::BlockedHit, "youtube.com", 2 * H),
            (DistractionKind::BlockedHit, "reddit.com", 3 * H),
            (DistractionKind::Continued, "youtube.com", 3 * H),
            (DistractionKind::BlockedHit, "reddit.com", 50 * H),
        ] {
            add_distraction(&mut store, None, kind, Some(domain), at).unwrap();
        }
        let d = load(&store, &[0, 24 * H], 0).unwrap().distractions;
        assert_eq!((d.blocked, d.continued), (3, 1));
        assert_eq!(d.top_domains[0], DomainCount { domain: "youtube.com".into(), count: 2 });
        assert_eq!(d.top_domains[1], DomainCount { domain: "reddit.com".into(), count: 1 });
    }

    #[test]
    fn domains_are_cleaned() {
        assert_eq!(clean_domain(" WWW.YouTube.com ").as_deref(), Some("youtube.com"));
        assert_eq!(clean_domain("https://x.com/a"), None);
        assert_eq!(clean_domain(""), None);
        assert_eq!(DistractionKind::parse("continued"), Some(DistractionKind::Continued));
        assert_eq!(DistractionKind::parse("other"), None);
    }

    #[test]
    fn empty_bounds_give_empty_stats() {
        let store = Store::open_in_memory().unwrap();
        assert!(load(&store, &[], 0).unwrap().sessions.is_empty());
    }
}
