//! Read-only queries for the dashboard. Day boundaries come from the caller (the UI knows
//! the user's local time zone), so these functions work purely on UTC milliseconds.

use rusqlite::params;
use serde::Serialize;

use crate::Store;
use crate::error::Result;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FocusSummary {
    /// Seconds of actual focus (not breaks) in finished focus sessions.
    pub focus_seconds: i64,
    pub completed_sessions: i64,
    pub interrupted_sessions: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteItem {
    pub id: String,
    pub title: String,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub today: FocusSummary,
    pub upcoming_deadlines: Vec<crate::deadlines::Deadline>,
    pub today_tasks: Vec<crate::tasks::Task>,
    pub pinned_notes: Vec<NoteItem>,
    /// Programs used today (only with app tracking on), most used first.
    pub today_apps: Vec<crate::activity::AppTime>,
    /// Seconds this PC has been on today (see `pc_time`).
    pub pc_on_today: i64,
}

/// `day_start_ms..day_end_ms` is today in local time; `today` is the local date `YYYY-MM-DD`.
pub fn load(store: &Store, _now_ms: i64, day_start_ms: i64, day_end_ms: i64, today: &str) -> Result<Dashboard> {
    Ok(Dashboard {
        today: focus_summary(store, day_start_ms, day_end_ms)?,
        upcoming_deadlines: crate::deadlines::upcoming(store.conn(), today, 4)?,
        today_tasks: crate::tasks::for_day(store.conn(), today, 30)?,
        pinned_notes: pinned_notes(store, 3)?,
        today_apps: crate::activity::totals(store, day_start_ms, day_end_ms, 50)?,
        pc_on_today: crate::pc_time::seconds_within(&crate::pc_time::on_ranges(store, day_start_ms, day_end_ms)?, day_start_ms, day_end_ms),
    })
}

pub fn focus_summary(store: &Store, from_ms: i64, to_ms: i64) -> Result<FocusSummary> {
    Ok(store.conn().query_row(
        "SELECT coalesce(sum(actual_s), 0),
                coalesce(sum(outcome = 'completed'), 0),
                coalesce(sum(outcome = 'interrupted'), 0)
         FROM focus_sessions
         WHERE phase = 'focus' AND deleted_at IS NULL AND ended_at IS NOT NULL
           AND started_at >= ?1 AND started_at < ?2",
        params![from_ms, to_ms],
        |r| Ok(FocusSummary { focus_seconds: r.get(0)?, completed_sessions: r.get(1)?, interrupted_sessions: r.get(2)? }),
    )?)
}

fn pinned_notes(store: &Store, limit: i64) -> Result<Vec<NoteItem>> {
    let mut stmt = store.conn().prepare(
        "SELECT id, title, substr(plain_text, 1, 140) FROM notes
         WHERE deleted_at IS NULL AND pinned = 1 ORDER BY edited_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| Ok(NoteItem { id: r.get(0)?, title: r.get(1)?, preview: r.get(2)? }))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::new_id;

    fn session(store: &mut Store, started: i64, actual: i64, outcome: &str, phase: &str) {
        let stamp = store.next_stamp();
        let device = store.device_id().to_string();
        store
            .conn()
            .execute(
                "INSERT INTO focus_sessions (id, cycle_id, session_number, phase, started_at, ended_at, planned_s,
                                             actual_s, outcome, created_at, updated_at, device_id)
                 VALUES (?1, 'c', 1, ?2, ?3, ?4, 1500, ?5, ?6, 0, ?7, ?8)",
                params![new_id(), phase, started, started + actual * 1000, actual, outcome, stamp, device],
            )
            .unwrap();
    }

    #[test]
    fn empty_database_gives_empty_dashboard() {
        let store = Store::open_in_memory().unwrap();
        let d = load(&store, 1_000, 0, 86_400_000, "1970-01-01").unwrap();
        assert_eq!(d.today, FocusSummary { focus_seconds: 0, completed_sessions: 0, interrupted_sessions: 0 });
        assert!(d.upcoming_deadlines.is_empty() && d.today_tasks.is_empty() && d.pinned_notes.is_empty());
    }

    #[test]
    fn focus_summary_counts_only_focus_phases_inside_the_day() {
        let mut store = Store::open_in_memory().unwrap();
        session(&mut store, 1_000, 1500, "completed", "focus");
        session(&mut store, 2_000, 1380, "interrupted", "focus");
        session(&mut store, 3_000, 300, "completed", "short_break"); // break: not focus time
        session(&mut store, 90_000_000, 1500, "completed", "focus"); // next day
        let s = focus_summary(&store, 0, 86_400_000).unwrap();
        assert_eq!(s, FocusSummary { focus_seconds: 2880, completed_sessions: 1, interrupted_sessions: 1 });
    }
}
