//! Focus session history: one row per focus phase or break, written by the timer as it runs.
//! A row is created when a phase starts (ended_at empty) and finished when it ends, so a
//! session in progress is never lost if Focus closes.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::ids::new_id;
use crate::store::now_ms;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Ran to the end.
    Completed,
    /// Stopped early with Stop.
    Interrupted,
    /// Skipped to the next phase.
    Skipped,
    /// Never really ran (e.g. found unfinished from an older crash).
    Cancelled,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Outcome::Completed => "completed",
            Outcome::Interrupted => "interrupted",
            Outcome::Skipped => "skipped",
            Outcome::Cancelled => "cancelled",
        }
    }
}

pub struct NewSession<'a> {
    pub cycle_id: &'a str,
    pub session_number: u32,
    /// "focus", "short_break" or "long_break".
    pub phase: &'a str,
    pub started_at: i64,
    pub planned_s: i64,
    pub preset_id: Option<&'a str>,
    /// The deadline this focus was started for ("Start focus" on a pinned deadline).
    pub deadline_id: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub cycle_id: String,
    pub session_number: i64,
    pub phase: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub planned_s: i64,
    pub actual_s: Option<i64>,
    pub paused_s: i64,
    pub outcome: Option<String>,
    pub preset_name: Option<String>,
    /// Programs used during this session (only with app tracking on), most used first.
    pub apps: Vec<crate::activity::AppTime>,
}

/// Records the start of a phase and returns the new row's id.
pub fn begin(store: &mut Store, s: NewSession) -> Result<String> {
    if !matches!(s.phase, "focus" | "short_break" | "long_break") {
        return Err(StoreError::Invalid(format!("unknown phase {:?}", s.phase)));
    }
    let id = new_id();
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    tx.execute(
        "INSERT INTO focus_sessions
           (id, cycle_id, session_number, phase, started_at, planned_s, preset_id, deadline_id, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            id, s.cycle_id, s.session_number, s.phase, s.started_at, s.planned_s.max(1), s.preset_id, s.deadline_id,
            now_ms() as i64, stamp, device
        ],
    )?;
    let fields = serde_json::json!({
        "cycle_id": s.cycle_id, "session_number": s.session_number, "phase": s.phase,
        "started_at": s.started_at, "planned_s": s.planned_s.max(1), "preset_id": s.preset_id,
        "deadline_id": s.deadline_id,
    });
    log_change(&tx, &id, &fields.to_string(), &stamp, &device)?;
    tx.commit()?;
    Ok(id)
}

/// Records how a phase ended. `actual_s` is time spent in the phase, not counting pauses;
/// paused time is whatever is left of the wall-clock span.
pub fn finish(store: &mut Store, id: &str, ended_at: i64, actual_s: i64, outcome: Outcome) -> Result<()> {
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    let started_at: i64 = tx
        .query_row("SELECT started_at FROM focus_sessions WHERE id = ?1", params![id], |r| r.get(0))
        .map_err(|_| StoreError::Invalid("that session is not in the history".into()))?;
    let ended_at = ended_at.max(started_at);
    let actual_s = actual_s.clamp(0, (ended_at - started_at) / 1000 + 1);
    let paused_s = ((ended_at - started_at) / 1000 - actual_s).max(0);
    tx.execute(
        "UPDATE focus_sessions SET ended_at = ?2, actual_s = ?3, paused_s = ?4, outcome = ?5, updated_at = ?6, device_id = ?7
         WHERE id = ?1",
        params![id, ended_at, actual_s, paused_s, outcome.as_str(), stamp, device],
    )?;
    let fields = serde_json::json!({
        "ended_at": ended_at, "actual_s": actual_s, "paused_s": paused_s, "outcome": outcome.as_str(),
    });
    log_change(&tx, id, &fields.to_string(), &stamp, &device)?;
    tx.commit()?;
    Ok(())
}

/// Closes rows left open by an older version or a crash (all except `keep`), so they don't
/// sit "in progress" forever. They count as cancelled, with no focus time. Only this PC's own
/// rows: an open session synced from another device is still running there.
pub fn close_unfinished(store: &mut Store, keep: Option<&str>) -> Result<usize> {
    let device = store.device_id().to_string();
    let open: Vec<(String, i64)> = {
        let mut stmt = store.conn().prepare(
            "SELECT id, started_at FROM focus_sessions WHERE ended_at IS NULL AND deleted_at IS NULL AND device_id = ?1",
        )?;
        let rows = stmt.query_map(params![device], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    let mut closed = 0;
    for (id, started_at) in open {
        if Some(id.as_str()) != keep {
            finish(store, &id, started_at, 0, Outcome::Cancelled)?;
            closed += 1;
        }
    }
    Ok(closed)
}

/// Sessions that started in `from_ms..to_ms`, newest first. Breaks are left out unless asked for.
pub fn list(store: &Store, from_ms: i64, to_ms: i64, include_breaks: bool) -> Result<Vec<SessionRow>> {
    let mut stmt = store.conn().prepare(
        "SELECT s.id, s.cycle_id, s.session_number, s.phase, s.started_at, s.ended_at, s.planned_s, s.actual_s,
                s.paused_s, s.outcome, p.name
         FROM focus_sessions s LEFT JOIN focus_presets p ON p.id = s.preset_id
         WHERE s.deleted_at IS NULL AND s.started_at >= ?1 AND s.started_at < ?2
           AND (?3 OR s.phase = 'focus')
           AND coalesce(s.outcome, '') <> 'cancelled'
         ORDER BY s.started_at DESC",
    )?;
    let rows = stmt.query_map(params![from_ms, to_ms, include_breaks], |r| {
        Ok(SessionRow {
            id: r.get(0)?,
            cycle_id: r.get(1)?,
            session_number: r.get(2)?,
            phase: r.get(3)?,
            started_at: r.get(4)?,
            ended_at: r.get(5)?,
            planned_s: r.get(6)?,
            actual_s: r.get(7)?,
            paused_s: r.get(8)?,
            outcome: r.get(9)?,
            preset_name: r.get(10)?,
            apps: Vec::new(),
        })
    })?;
    let mut rows: Vec<SessionRow> = rows.collect::<std::result::Result<_, _>>()?;
    for row in rows.iter_mut().filter(|r| r.phase == "focus") {
        row.apps = crate::activity::for_session(store, &row.id, 3)?;
    }
    Ok(rows)
}

/// Removes a session from the history (kept as a tombstone so the other PC learns about it).
pub fn delete(store: &mut Store, id: &str) -> Result<()> {
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let now = now_ms() as i64;
    let tx = store.conn_mut().transaction()?;
    let changed = tx.execute(
        "UPDATE focus_sessions SET deleted_at = ?2, updated_at = ?3, device_id = ?4 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, now, stamp, device],
    )?;
    if changed == 0 {
        return Err(StoreError::Invalid("that session is not in the history".into()));
    }
    log_change(&tx, id, &serde_json::json!({ "deleted_at": now }).to_string(), &stamp, &device)?;
    tx.commit()?;
    Ok(())
}

fn log_change(conn: &Connection, id: &str, fields: &str, stamp: &str, device: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO change_log (entity, entity_id, fields, hlc, device_id) VALUES ('focus_sessions', ?1, ?2, ?3, ?4)",
        params![id, fields, stamp, device],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dashboard::focus_summary;

    const MIN: i64 = 60_000;

    fn focus(store: &mut Store, cycle: &str, n: u32, at: i64) -> String {
        begin(store, NewSession { cycle_id: cycle, session_number: n, phase: "focus", started_at: at, planned_s: 1500, preset_id: None, deadline_id: None })
            .unwrap()
    }

    #[test]
    fn a_full_session_is_recorded_and_counted_today() {
        let mut store = Store::open_in_memory().unwrap();
        let id = focus(&mut store, "c1", 1, 1_000 * MIN);
        // 25 minutes of focus plus a 3-minute pause.
        finish(&mut store, &id, 1_028 * MIN, 1500, Outcome::Completed).unwrap();
        let rows = list(&store, 0, i64::MAX, false).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].actual_s, Some(1500));
        assert_eq!(rows[0].paused_s, 180);
        assert_eq!(rows[0].outcome.as_deref(), Some("completed"));
        let today = focus_summary(&store, 900 * MIN, 1_100 * MIN).unwrap();
        assert_eq!((today.focus_seconds, today.completed_sessions), (1500, 1));
    }

    #[test]
    fn stopped_and_skipped_count_their_minutes_but_not_as_completed() {
        let mut store = Store::open_in_memory().unwrap();
        let a = focus(&mut store, "c1", 1, 0);
        finish(&mut store, &a, 10 * MIN, 600, Outcome::Interrupted).unwrap();
        let b = focus(&mut store, "c2", 1, 20 * MIN);
        finish(&mut store, &b, 25 * MIN, 300, Outcome::Skipped).unwrap();
        let s = focus_summary(&store, 0, 60 * MIN).unwrap();
        assert_eq!((s.focus_seconds, s.completed_sessions, s.interrupted_sessions), (900, 0, 1));
    }

    #[test]
    fn breaks_are_hidden_unless_asked_for_and_deleted_rows_disappear() {
        let mut store = Store::open_in_memory().unwrap();
        let f = focus(&mut store, "c1", 1, 0);
        finish(&mut store, &f, 25 * MIN, 1500, Outcome::Completed).unwrap();
        let b = begin(&mut store, NewSession { cycle_id: "c1", session_number: 1, phase: "short_break", started_at: 25 * MIN, planned_s: 300, preset_id: None, deadline_id: None }).unwrap();
        finish(&mut store, &b, 30 * MIN, 300, Outcome::Completed).unwrap();
        assert_eq!(list(&store, 0, i64::MAX, false).unwrap().len(), 1);
        assert_eq!(list(&store, 0, i64::MAX, true).unwrap().len(), 2);
        delete(&mut store, &f).unwrap();
        assert!(list(&store, 0, i64::MAX, false).unwrap().is_empty());
        assert_eq!(focus_summary(&store, 0, i64::MAX).unwrap().focus_seconds, 0);
        assert!(delete(&mut store, &f).is_err());
    }

    #[test]
    fn unfinished_rows_are_closed_except_the_running_one() {
        let mut store = Store::open_in_memory().unwrap();
        let old = focus(&mut store, "c1", 1, 0);
        let running = focus(&mut store, "c2", 1, 100 * MIN);
        assert_eq!(close_unfinished(&mut store, Some(&running)).unwrap(), 1);
        let rows = list(&store, 0, i64::MAX, false).unwrap();
        assert_eq!(rows.len(), 1, "the cancelled one is hidden");
        assert_eq!(rows[0].id, running);
        assert_eq!(rows[0].ended_at, None);
        let _ = old;
    }

    #[test]
    fn every_write_is_logged_for_sync() {
        let mut store = Store::open_in_memory().unwrap();
        let id = focus(&mut store, "c1", 1, 0);
        finish(&mut store, &id, 25 * MIN, 1500, Outcome::Completed).unwrap();
        let n: i64 = store
            .conn()
            .query_row("SELECT COUNT(*) FROM change_log WHERE entity = 'focus_sessions' AND entity_id = ?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
    }
}
