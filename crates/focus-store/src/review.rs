//! Focus time logged against deadlines ("Start focus" on a pinned deadline) and the weekly review:
//! focus time, deadlines hit or missed, and what blocking stopped most. Nothing is stored for
//! these; they are read from focus sessions, deadlines and distraction events.
//!
//! Week boundaries come from the caller (the UI knows the local time zone), as in `stats`.

use rusqlite::params;
use serde::Serialize;

use crate::Store;
use crate::error::Result;

/// Focus time logged against one deadline. Mirrors `DeadlineFocus` in src/ipc/review.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeadlineFocus {
    pub deadline_id: String,
    pub seconds: i64,
    pub sessions: i64,
}

const FOCUS_ROWS: &str = "phase = 'focus' AND deleted_at IS NULL AND deadline_id IS NOT NULL
    AND ended_at IS NOT NULL AND coalesce(outcome, '') <> 'cancelled' AND coalesce(actual_s, 0) > 0";

/// Focus logged against each deadline in `from..to` (started in it), most first.
pub fn deadline_focus(store: &Store, from: i64, to: i64) -> Result<Vec<DeadlineFocus>> {
    let mut stmt = store.conn().prepare(&format!(
        "SELECT deadline_id, sum(actual_s), count(*) FROM focus_sessions
         WHERE {FOCUS_ROWS} AND started_at >= ?1 AND started_at < ?2
         GROUP BY deadline_id ORDER BY sum(actual_s) DESC"
    ))?;
    let rows = stmt.query_map(params![from, to], |r| Ok(DeadlineFocus { deadline_id: r.get(0)?, seconds: r.get(1)?, sessions: r.get(2)? }))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// How a deadline went in the week.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Finished on or before its due time.
    Hit,
    /// Finished late, or still not finished after its due time.
    Missed,
    /// Due this week but not yet (and not finished).
    Open,
}

/// Mirrors `ReviewDeadline` in src/ipc/review.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDeadline {
    pub id: String,
    pub title: String,
    pub due_at: i64,
    pub completed_at: Option<i64>,
    pub color: Option<String>,
    pub outcome: Outcome,
    /// Focus logged against it this week.
    pub focus_seconds: i64,
}

/// Something blocking stopped: a site, or a Windows program.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Blocked {
    pub name: String,
    /// "site" or "app".
    pub kind: &'static str,
    pub count: i64,
}

/// Mirrors `WeekReview` in src/ipc/review.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeekReview {
    /// Focus seconds per day (`bounds[i]..bounds[i + 1]`), from every device.
    pub focus_by_day: Vec<i64>,
    pub focus_seconds: i64,
    /// Focus in the week before, to compare.
    pub prev_focus_seconds: i64,
    pub sessions: i64,
    /// Focus that was started from a deadline.
    pub deadline_focus_seconds: i64,
    /// Due this week, or finished this week: hit first, then missed, then still open.
    pub deadlines: Vec<ReviewDeadline>,
    pub blocked_total: i64,
    pub top_blocked: Vec<Blocked>,
}

/// `bounds`: the day edges of the week, oldest first (8 numbers for 7 days).
pub fn week(store: &Store, bounds: &[i64], now: i64) -> Result<WeekReview> {
    let (Some(&from), Some(&to)) = (bounds.first(), bounds.last()) else {
        return Ok(WeekReview {
            focus_by_day: vec![],
            focus_seconds: 0,
            prev_focus_seconds: 0,
            sessions: 0,
            deadline_focus_seconds: 0,
            deadlines: vec![],
            blocked_total: 0,
            top_blocked: vec![],
        });
    };
    let conn = store.conn();
    let focus_in = |a: i64, b: i64| -> Result<(i64, i64)> {
        Ok(conn.query_row(
            "SELECT coalesce(sum(actual_s), 0), count(*) FROM focus_sessions
             WHERE phase = 'focus' AND deleted_at IS NULL AND ended_at IS NOT NULL
               AND coalesce(outcome, '') <> 'cancelled' AND coalesce(actual_s, 0) > 0
               AND started_at >= ?1 AND started_at < ?2",
            params![a, b],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    };
    let focus_by_day = bounds.windows(2).map(|w| focus_in(w[0], w[1]).map(|f| f.0)).collect::<Result<Vec<_>>>()?;
    let (focus_seconds, sessions) = focus_in(from, to)?;
    let (prev_focus_seconds, _) = focus_in(from - (to - from), from)?;

    let logged = deadline_focus(store, from, to)?;
    let deadline_focus_seconds = logged.iter().map(|d| d.seconds).sum();
    let mut stmt = conn.prepare(
        "SELECT id, title, due_at, completed_at, color FROM deadlines
         WHERE deleted_at IS NULL
           AND ((due_at >= ?1 AND due_at < ?2) OR (completed_at >= ?1 AND completed_at < ?2))
         ORDER BY due_at",
    )?;
    let rows = stmt.query_map(params![from, to], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<i64>>(3)?, r.get::<_, Option<String>>(4)?))
    })?;
    let mut deadlines = Vec::new();
    for row in rows {
        let (id, title, due_at, completed_at, color) = row?;
        let outcome = match completed_at {
            Some(done) if done <= due_at => Outcome::Hit,
            Some(_) => Outcome::Missed,
            None if now > due_at => Outcome::Missed,
            None => Outcome::Open,
        };
        let focus_seconds = logged.iter().find(|d| d.deadline_id == id).map_or(0, |d| d.seconds);
        deadlines.push(ReviewDeadline { id, title, due_at, completed_at, color, outcome, focus_seconds });
    }
    let rank = |o: Outcome| match o {
        Outcome::Hit => 0,
        Outcome::Missed => 1,
        Outcome::Open => 2,
    };
    deadlines.sort_by_key(|d| (rank(d.outcome), d.due_at));

    let blocked_total = conn.query_row(
        "SELECT count(*) FROM distraction_events WHERE deleted_at IS NULL AND kind = 'blocked_hit' AND at >= ?1 AND at < ?2",
        params![from, to],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT domain, count(*) AS n FROM distraction_events
         WHERE deleted_at IS NULL AND kind = 'blocked_hit' AND domain IS NOT NULL AND at >= ?1 AND at < ?2
         GROUP BY domain ORDER BY n DESC, domain LIMIT 6",
    )?;
    let rows = stmt.query_map(params![from, to], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    let mut top_blocked = Vec::new();
    for row in rows {
        let (name, count) = row?;
        // Windows programs are saved as "Discord (app)" (`app_block`).
        top_blocked.push(match name.strip_suffix(" (app)") {
            Some(app) => Blocked { name: app.to_string(), kind: "app", count },
            None => Blocked { name, kind: "site", count },
        });
    }

    Ok(WeekReview {
        focus_by_day,
        focus_seconds,
        prev_focus_seconds,
        sessions,
        deadline_focus_seconds,
        deadlines,
        blocked_total,
        top_blocked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deadlines::{self, DeadlineInput};
    use crate::sessions::{self, NewSession, Outcome as End};
    use crate::stats::{self, DistractionKind};

    const H: i64 = 3_600_000;
    const D: i64 = 24 * H;
    const T0: i64 = 1_800_000_000_000;

    fn focus(store: &mut Store, at: i64, secs: i64, deadline: Option<&str>) {
        let id = sessions::begin(
            store,
            NewSession { cycle_id: "c", session_number: 1, phase: "focus", started_at: at, planned_s: secs, preset_id: None, deadline_id: deadline },
        )
        .unwrap();
        sessions::finish(store, &id, at + secs * 1000, secs, End::Completed).unwrap();
    }

    fn deadline(store: &mut Store, title: &str, due_at: i64) -> String {
        deadlines::create(store, input(title, due_at), "2027-01-15").unwrap().id
    }

    fn input(title: &str, due_at: i64) -> DeadlineInput {
        serde_json::from_value(serde_json::json!({
            "title": title, "description": "", "startAt": T0 - 30 * D, "dueAt": due_at, "allDay": false,
            "viz": "both", "color": null, "progressStyle": "grid", "cellShape": "rounded", "gridCols": null
        }))
        .unwrap()
    }

    #[test]
    fn focus_is_logged_against_deadlines() {
        let mut store = Store::open_in_memory().unwrap();
        let a = deadline(&mut store, "Essay", T0 + 3 * D);
        focus(&mut store, T0, 1500, Some(&a));
        focus(&mut store, T0 + H, 900, Some(&a));
        focus(&mut store, T0 + 2 * H, 600, None);
        let got = deadline_focus(&store, 0, i64::MAX).unwrap();
        assert_eq!(got, vec![DeadlineFocus { deadline_id: a, seconds: 2400, sessions: 2 }]);
    }

    #[test]
    fn the_week_review_counts_hits_misses_and_blocks() {
        let mut store = Store::open_in_memory().unwrap();
        let bounds: Vec<i64> = (0..=7).map(|i| T0 + i * D).collect();
        let hit = deadline(&mut store, "Hit", T0 + 2 * D);
        let missed = deadline(&mut store, "Missed", T0 + D);
        let open = deadline(&mut store, "Open", T0 + 6 * D);
        deadline(&mut store, "Next week", T0 + 9 * D);
        deadlines::set_completed(&mut store, &hit, true, "2027-01-15").unwrap();
        // Finished now, which is far after T0 + 2D in real time: rewrite it as on time.
        store.conn().execute("UPDATE deadlines SET completed_at = ?2 WHERE id = ?1", params![hit, T0 + D]).unwrap();
        focus(&mut store, T0 + H, 1800, Some(&hit));
        focus(&mut store, T0 + D + H, 1200, None);
        focus(&mut store, T0 - D, 3000, None); // the week before
        for (domain, n) in [("youtube.com", 3), ("Discord (app)", 2)] {
            for i in 0..n {
                stats::add_distraction(&mut store, None, DistractionKind::BlockedHit, Some(domain), T0 + i).unwrap();
            }
        }
        let r = week(&store, &bounds, T0 + 3 * D).unwrap();
        assert_eq!((r.focus_seconds, r.sessions, r.prev_focus_seconds, r.deadline_focus_seconds), (3000, 2, 3000, 1800));
        assert_eq!(r.focus_by_day[..2], [1800, 1200]);
        let got: Vec<(&str, Outcome, i64)> = r.deadlines.iter().map(|d| (d.title.as_str(), d.outcome, d.focus_seconds)).collect();
        assert_eq!(got, vec![("Hit", Outcome::Hit, 1800), ("Missed", Outcome::Missed, 0), ("Open", Outcome::Open, 0)]);
        assert_eq!(r.blocked_total, 5);
        assert_eq!(r.top_blocked[0], Blocked { name: "youtube.com".into(), kind: "site", count: 3 });
        assert_eq!(r.top_blocked[1], Blocked { name: "Discord".into(), kind: "app", count: 2 });
        let _ = (missed, open);
    }
}
