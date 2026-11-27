//! Daily focus goal and streak: how many minutes of focus you want each day
//! (`goal.dailyMinutes`, synced; 0 = no goal), today's minutes, and how many days in a row you
//! reached it. Focus time is what the timer counted on any device (laptop or phone), from the
//! synced session history, split into days by this device's local time.

use std::collections::HashMap;

use chrono::{Duration, Local, NaiveDate, TimeZone};
use rusqlite::params;
use serde::Serialize;

use crate::Store;
use crate::error::Result;
use crate::settings;

/// Days looked back for the streak and the best streak.
const LOOK_BACK_DAYS: i64 = 400;

/// Mirrored by `GoalStatus` in packages/core/src/goal.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoalStatus {
    /// 0 = no goal set.
    pub goal_min: u32,
    pub today_min: u32,
    /// Days in a row the goal was reached, up to today (today counts once reached;
    /// until then the streak from yesterday still stands).
    pub streak: u32,
    pub best_streak: u32,
    /// Minutes on each of the last 7 days, oldest first (the last is today).
    pub week: Vec<u32>,
}

pub fn goal_minutes(store: &Store) -> Result<u32> {
    let m: i64 = settings::get(store, "goal.dailyMinutes")?;
    Ok(m.clamp(0, 24 * 60) as u32)
}

pub fn set_goal_minutes(store: &mut Store, minutes: u32) -> Result<()> {
    settings::set(store, "goal.dailyMinutes", &minutes.min(24 * 60))
}

fn day_of(ms: i64) -> NaiveDate {
    Local.timestamp_millis_opt(ms).single().map(|d| d.date_naive()).unwrap_or_default()
}

fn start_of(day: NaiveDate) -> i64 {
    day.and_hms_opt(0, 0, 0)
        .and_then(|t| Local.from_local_datetime(&t).earliest())
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

/// Focus seconds per local day since `from_ms` (finished focus phases, any device).
fn per_day(store: &Store, from_ms: i64) -> Result<HashMap<NaiveDate, i64>> {
    let mut stmt = store.conn().prepare(
        "SELECT started_at, coalesce(actual_s, 0) FROM focus_sessions
         WHERE phase = 'focus' AND deleted_at IS NULL AND ended_at IS NOT NULL AND coalesce(outcome, '') != 'cancelled'
           AND started_at >= ?1",
    )?;
    let mut days: HashMap<NaiveDate, i64> = HashMap::new();
    for row in stmt.query_map(params![from_ms], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
        let (at, secs) = row?;
        *days.entry(day_of(at)).or_default() += secs.max(0);
    }
    Ok(days)
}

/// Works out the goal, today's minutes and the streaks for local day `today`.
pub fn compute(goal_min: u32, today: NaiveDate, seconds: &HashMap<NaiveDate, i64>) -> GoalStatus {
    let mins = |d: NaiveDate| (seconds.get(&d).copied().unwrap_or(0) / 60).max(0) as u32;
    let met = |d: NaiveDate| goal_min > 0 && mins(d) >= goal_min;
    let today_min = mins(today);
    let mut streak = 0;
    let mut day = if met(today) { today } else { today - Duration::days(1) };
    while met(day) && streak < LOOK_BACK_DAYS as u32 {
        streak += 1;
        day -= Duration::days(1);
    }
    let (mut best, mut run) = (0, 0);
    for back in (0..LOOK_BACK_DAYS).rev() {
        if met(today - Duration::days(back)) {
            run += 1;
            best = best.max(run);
        } else {
            run = 0;
        }
    }
    GoalStatus {
        goal_min,
        today_min,
        streak,
        best_streak: best,
        week: (0..7).rev().map(|back| mins(today - Duration::days(back))).collect(),
    }
}

pub fn status(store: &Store, now_ms: u64) -> Result<GoalStatus> {
    let today = day_of(now_ms as i64);
    let from = start_of(today - Duration::days(LOOK_BACK_DAYS));
    Ok(compute(goal_minutes(store)?, today, &per_day(store, from)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn streak_counts_days_in_a_row() {
        let mut secs = HashMap::new();
        for (day, min) in [("2026-10-20", 130), ("2026-10-22", 120), ("2026-10-23", 200), ("2026-10-24", 121), ("2026-10-26", 30)] {
            secs.insert(d(day), min * 60);
        }
        // Monday the 26th: not reached yet, the 25th was missed: no streak.
        let s = compute(120, d("2026-10-26"), &secs);
        assert_eq!((s.today_min, s.streak, s.best_streak), (30, 0, 3));
        // Saturday the 24th: three in a row.
        assert_eq!(compute(120, d("2026-10-24"), &secs).streak, 3);
        // Sunday the 25th, nothing yet today: the streak up to yesterday still stands.
        assert_eq!(compute(120, d("2026-10-25"), &secs).streak, 3);
        assert_eq!(compute(120, d("2026-10-26"), &secs).week, vec![130, 0, 120, 200, 121, 0, 30]);
        assert_eq!(compute(0, d("2026-10-24"), &secs).streak, 0, "no goal, no streak");
    }

    #[test]
    fn reads_finished_focus_from_history() {
        use crate::sessions::{self, NewSession, Outcome};
        let mut store = Store::open_in_memory().unwrap();
        set_goal_minutes(&mut store, 25).unwrap();
        let now = crate::store::now_ms() as i64;
        let id = sessions::begin(&mut store, NewSession { cycle_id: "c", session_number: 1, phase: "focus", started_at: now - 30 * 60_000, planned_s: 1500, preset_id: None, deadline_id: None }).unwrap();
        sessions::finish(&mut store, &id, now - 60_000, 1500, Outcome::Completed).unwrap();
        let s = status(&store, now as u64).unwrap();
        // Unless the test runs just after midnight, the session is today's.
        if day_of(now - 30 * 60_000) == day_of(now) {
            assert_eq!((s.goal_min, s.today_min, s.streak), (25, 25, 1));
        }
    }
}
