//! App tracking (opt-in): which program was in front, and for how long.
//! Raw spans stay on this PC and are pruned after a year; per-session totals (`app_usage`)
//! are synced so History on both PCs can say where the focus time went.
//! Only the program's file name is stored (e.g. `Code.exe`), never window titles or content.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::Store;
use crate::error::Result;
use crate::ids::new_id;
use crate::store::now_ms;

/// One stretch of time in one program, as measured by the tracker.
pub struct Sample<'a> {
    /// File name of the program, e.g. "Code.exe".
    pub exe: &'a str,
    /// Friendly name shown in Focus, e.g. "VS Code".
    pub display_name: &'a str,
    pub from_ms: i64,
    pub to_ms: i64,
    /// The span row this continues (returned by the previous call), or None to start a new one.
    pub span: Option<i64>,
    /// The focus session running at the time, if any.
    pub session_id: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppTime {
    pub name: String,
    pub seconds: i64,
}

/// Adds a sample and returns the span row id to continue next time.
pub fn add(store: &mut Store, s: Sample) -> Result<i64> {
    let app_id = ensure_app(store, s.exe, s.display_name)?;
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let now = now_ms() as i64;
    let tx = store.conn_mut().transaction()?;
    // Continue the span if it is still the latest one for this app; otherwise start a new one.
    let span = match s.span {
        Some(id) => tx
            .query_row("SELECT id FROM activity_spans WHERE id = ?1 AND app_id = ?2", params![id, app_id], |r| r.get(0))
            .optional()?,
        None => None,
    };
    let new_span = span.is_none();
    let span = match span {
        Some(id) => {
            tx.execute("UPDATE activity_spans SET ended_at = max(ended_at, ?2) WHERE id = ?1", params![id, s.to_ms])?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO activity_spans (app_id, started_at, ended_at) VALUES (?1, ?2, ?3)",
                params![app_id, s.from_ms, s.to_ms.max(s.from_ms)],
            )?;
            tx.last_insert_rowid()
        }
    };
    if let Some(session) = s.session_id {
        let secs = ((s.to_ms - s.from_ms).max(0) + 500) / 1000;
        let changed = tx.execute(
            "UPDATE app_usage SET active_s = active_s + ?3, activations = activations + ?4, last_active_at = ?5,
                    updated_at = ?6, device_id = ?7
             WHERE session_id = ?1 AND app_id = ?2",
            params![session, app_id, secs, new_span as i64, s.to_ms, stamp, device],
        )?;
        if changed == 0 {
            tx.execute(
                "INSERT INTO app_usage (id, session_id, app_id, active_s, activations, first_active_at, last_active_at,
                                        created_at, updated_at, device_id)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9)",
                params![new_id(), session, app_id, secs, s.from_ms, s.to_ms, now, stamp, device],
            )?;
        }
    }
    tx.commit()?;
    Ok(span)
}

fn ensure_app(store: &mut Store, exe: &str, display_name: &str) -> Result<String> {
    let found: Option<String> =
        store.conn().query_row("SELECT id FROM apps WHERE exe_name = ?1", params![exe], |r| r.get(0)).optional()?;
    if let Some(id) = found {
        return Ok(id);
    }
    let id = new_id();
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    store.conn().execute(
        "INSERT INTO apps (id, exe_name, display_name, created_at, updated_at, device_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, exe, display_name, now_ms() as i64, stamp, device],
    )?;
    Ok(id)
}

/// Time per program in `from_ms..to_ms`, most used first.
pub fn totals(store: &Store, from_ms: i64, to_ms: i64, limit: i64) -> Result<Vec<AppTime>> {
    let mut stmt = store.conn().prepare(
        "SELECT a.display_name, sum(min(s.ended_at, ?2) - max(s.started_at, ?1)) / 1000 AS secs
         FROM activity_spans s JOIN apps a ON a.id = s.app_id
         WHERE s.ended_at > ?1 AND s.started_at < ?2
         GROUP BY a.id HAVING secs > 0 ORDER BY secs DESC LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![from_ms, to_ms, limit], |r| Ok(AppTime { name: r.get(0)?, seconds: r.get(1)? }))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// One program App tracking has seen, for the Blocking page's app picker.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownApp {
    pub exe: String,
    pub name: String,
}

/// Every program App tracking has seen, most used first.
pub fn known_apps(store: &Store, limit: i64) -> Result<Vec<KnownApp>> {
    let mut stmt = store.conn().prepare(
        "SELECT a.exe_name, a.display_name, coalesce(sum(s.ended_at - s.started_at), 0) AS ms
         FROM apps a LEFT JOIN activity_spans s ON s.app_id = a.id
         WHERE a.deleted_at IS NULL GROUP BY a.id ORDER BY ms DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| Ok(KnownApp { exe: r.get(0)?, name: r.get(1)? }))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// The programs used during one focus session, most used first.
pub fn for_session(store: &Store, session_id: &str, limit: i64) -> Result<Vec<AppTime>> {
    let mut stmt = store.conn().prepare(
        "SELECT a.display_name, u.active_s FROM app_usage u JOIN apps a ON a.id = u.app_id
         WHERE u.session_id = ?1 AND u.deleted_at IS NULL AND u.active_s > 0
         ORDER BY u.active_s DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![session_id, limit], |r| Ok(AppTime { name: r.get(0)?, seconds: r.get(1)? }))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// Deletes raw spans older than `keep_days`. Returns how many were removed.
pub fn prune(store: &Store, now_ms: i64, keep_days: i64) -> Result<usize> {
    Ok(store.conn().execute("DELETE FROM activity_spans WHERE ended_at < ?1", params![now_ms - keep_days * 86_400_000])?)
}

/// Removes all tracked activity from this PC (spans and per-session totals).
pub fn clear_all(store: &mut Store) -> Result<()> {
    let tx = store.conn_mut().transaction()?;
    tx.execute("DELETE FROM activity_spans", [])?;
    tx.execute("DELETE FROM app_usage", [])?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::{self, NewSession};

    const S: i64 = 1000;

    fn sample<'a>(exe: &'a str, from: i64, to: i64, span: Option<i64>, session: Option<&'a str>) -> Sample<'a> {
        Sample { exe, display_name: exe.trim_end_matches(".exe"), from_ms: from, to_ms: to, span, session_id: session }
    }

    #[test]
    fn spans_continue_and_totals_add_up() {
        let mut store = Store::open_in_memory().unwrap();
        let a = add(&mut store, sample("Code.exe", 0, 10 * S, None, None)).unwrap();
        let a2 = add(&mut store, sample("Code.exe", 10 * S, 30 * S, Some(a), None)).unwrap();
        assert_eq!(a, a2, "same span continued");
        add(&mut store, sample("firefox.exe", 30 * S, 35 * S, None, None)).unwrap();
        let t = totals(&store, 0, 100 * S, 10).unwrap();
        assert_eq!(t, vec![AppTime { name: "Code".into(), seconds: 30 }, AppTime { name: "firefox".into(), seconds: 5 }]);
        // Only the part inside the range counts.
        assert_eq!(totals(&store, 20 * S, 100 * S, 10).unwrap()[0].seconds, 10);
    }

    #[test]
    fn session_usage_counts_time_and_switches() {
        let mut store = Store::open_in_memory().unwrap();
        let sid = sessions::begin(
            &mut store,
            NewSession { cycle_id: "c", session_number: 1, phase: "focus", started_at: 0, planned_s: 1500, preset_id: None, deadline_id: None },
        )
        .unwrap();
        let a = add(&mut store, sample("Code.exe", 0, 60 * S, None, Some(&sid))).unwrap();
        add(&mut store, sample("Code.exe", 60 * S, 120 * S, Some(a), Some(&sid))).unwrap();
        add(&mut store, sample("firefox.exe", 120 * S, 150 * S, None, Some(&sid))).unwrap();
        add(&mut store, sample("Code.exe", 150 * S, 160 * S, None, Some(&sid))).unwrap();
        let apps = for_session(&store, &sid, 5).unwrap();
        assert_eq!(apps[0], AppTime { name: "Code".into(), seconds: 130 });
        assert_eq!(apps[1], AppTime { name: "firefox".into(), seconds: 30 });
        let switches: i64 = store
            .conn()
            .query_row("SELECT activations FROM app_usage u JOIN apps a ON a.id = u.app_id WHERE a.exe_name = 'Code.exe'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(switches, 2);
    }

    #[test]
    fn prune_and_clear() {
        let mut store = Store::open_in_memory().unwrap();
        add(&mut store, sample("old.exe", 0, S, None, None)).unwrap();
        add(&mut store, sample("new.exe", 40 * 86_400 * S, 40 * 86_400 * S + S, None, None)).unwrap();
        assert_eq!(prune(&store, 41 * 86_400 * S, 30).unwrap(), 1);
        clear_all(&mut store).unwrap();
        assert!(totals(&store, 0, i64::MAX, 10).unwrap().is_empty());
    }
}
