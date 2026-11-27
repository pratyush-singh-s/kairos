//! Writes the timer's progress to the database: one history row per focus session or break,
//! and the running timer itself, so Focus can pick up where it was after a restart.

use std::sync::Mutex;

use focus_store::sessions::{self, NewSession, Outcome};
use focus_store::{Store, ids, local};
use focus_timer::{Event, Phase, Timer};
use serde::{Deserialize, Serialize};

/// What the recorder knows about the run in progress.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    /// One id for all the sessions and breaks of a run (start → done or stop).
    pub cycle_id: Option<String>,
    /// The history row of the phase that is running now (no end time yet).
    pub open_row: Option<String>,
    /// The deadline this run was started for ("Start focus" on a pinned deadline).
    #[serde(default)]
    pub deadline_id: Option<String>,
}

pub struct RecordState(pub Mutex<Recording>);

/// The running timer as saved on disk (this PC only, never synced).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    timer: Timer,
    recording: Recording,
    /// The last moment Focus was known to be open.
    last_alive: u64,
}

const SAVED_KEY: &str = "timer.saved";

fn phase_name(p: Phase) -> &'static str {
    match p {
        Phase::Focus => "focus",
        Phase::ShortBreak => "short_break",
        Phase::LongBreak => "long_break",
    }
}

/// Turns timer events into history rows. `timer` is the state after the events.
pub fn record(store: &mut Store, rec: &mut Recording, timer: &Timer, events: &[Event]) -> Result<(), String> {
    let err = |e: focus_store::StoreError| e.to_string();
    for event in events {
        match *event {
            Event::PhaseStarted { phase, session, at_ms } => {
                if let Some(id) = rec.open_row.take() {
                    // Should not happen, but never leave a row open.
                    sessions::finish(store, &id, at_ms as i64, 0, Outcome::Cancelled).map_err(err)?;
                }
                let cycle = rec.cycle_id.get_or_insert_with(ids::new_id).clone();
                let plan = timer.plan().ok_or("the timer has no plan")?;
                let planned_s = (Timer::phase_duration(plan, phase) / 1000) as i64;
                let id = sessions::begin(
                    store,
                    NewSession {
                        cycle_id: &cycle,
                        session_number: session,
                        phase: phase_name(phase),
                        started_at: at_ms as i64,
                        planned_s,
                        preset_id: plan.preset_id.as_deref(),
                        deadline_id: if phase == Phase::Focus { rec.deadline_id.as_deref() } else { None },
                    },
                )
                .map_err(err)?;
                rec.open_row = Some(id);
            }
            Event::PhaseCompleted { phase, at_ms, .. } => {
                if let (Some(id), Some(plan)) = (rec.open_row.take(), timer.plan()) {
                    let actual = (Timer::phase_duration(plan, phase) / 1000) as i64;
                    sessions::finish(store, &id, at_ms as i64, actual, Outcome::Completed).map_err(err)?;
                }
            }
            Event::PhaseSkipped { at_ms, elapsed_ms, .. } => {
                if let Some(id) = rec.open_row.take() {
                    sessions::finish(store, &id, at_ms as i64, (elapsed_ms / 1000) as i64, Outcome::Skipped).map_err(err)?;
                }
            }
            Event::Stopped { phase, at_ms, elapsed_ms, .. } => {
                if let Some(id) = rec.open_row.take() {
                    // An endless session has no end to reach: finishing it is how it completes.
                    let endless = phase == Phase::Focus && timer.plan().is_some_and(|p| p.is_endless());
                    let outcome = if endless { Outcome::Completed } else { Outcome::Interrupted };
                    sessions::finish(store, &id, at_ms as i64, (elapsed_ms / 1000) as i64, outcome)
                        .map_err(err)?;
                }
            }
            Event::RunFinished { .. } => {}
        }
    }
    if !timer.is_active() {
        rec.cycle_id = None;
        rec.deadline_id = None;
    }
    Ok(())
}

/// Saves the timer so a restart can bring it back. An idle or finished timer clears the save.
pub fn save(store: &Store, rec: &Recording, timer: &Timer, now: u64) -> Result<(), String> {
    let result = if timer.is_active() {
        let saved = Saved { timer: timer.clone(), recording: rec.clone(), last_alive: now };
        let json = serde_json::to_string(&saved).map_err(|e| e.to_string())?;
        local::set(store, SAVED_KEY, &json)
    } else {
        local::remove(store, SAVED_KEY)
    };
    result.map_err(|e| e.to_string())
}

/// Loads the timer saved by the last run of Focus (idle if there is none), and closes any
/// history rows that were left open and no longer belong to it.
pub fn restore(store: &mut Store, now: u64) -> (Timer, Recording) {
    let saved = local::get(store, SAVED_KEY)
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str::<Saved>(&json).ok());
    let (timer, mut rec) = match saved {
        Some(s) => (Timer::restore(s.timer, s.last_alive, now), s.recording),
        None => (Timer::new(), Recording::default()),
    };
    if !timer.is_active() {
        rec = Recording::default();
    }
    let _ = sessions::close_unfinished(store, rec.open_row.as_deref());
    (timer, rec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use focus_timer::Plan;

    const MIN: u64 = 60_000;

    fn plan() -> Plan {
        Plan {
            preset_id: None,
            preset_name: "Test".into(),
            focus_ms: 25 * MIN,
            short_break_ms: 5 * MIN,
            long_break_ms: 15 * MIN,
            sessions: 2,
            long_break_every: 4,
            auto_start_break: true,
            auto_start_focus: true,
        }
    }

    fn step(store: &mut Store, rec: &mut Recording, t: &Timer, events: Vec<Event>) {
        record(store, rec, t, &events).unwrap();
    }

    #[test]
    fn a_whole_run_becomes_history_rows() {
        let mut store = Store::open_in_memory().unwrap();
        let mut rec = Recording::default();
        let mut t = Timer::new();
        let e = t.start(plan(), 0).unwrap();
        step(&mut store, &mut rec, &t, e);
        // Focus ends, then the break and the second focus run.
        for at in [25 * MIN, 30 * MIN, 55 * MIN] {
            let e = t.tick(at);
            step(&mut store, &mut rec, &t, e);
        }
        let rows = sessions::list(&store, 0, i64::MAX, true).unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|r| r.outcome.as_deref() == Some("completed")));
        assert!(rows.iter().all(|r| Some(r.cycle_id.as_str()) == rows[0].cycle_id.as_str().into()));
        assert_eq!(rec.cycle_id, None, "a finished run closes the cycle");
        assert_eq!(rec.open_row, None);
    }

    #[test]
    fn stop_records_an_interrupted_session() {
        let mut store = Store::open_in_memory().unwrap();
        let mut rec = Recording::default();
        let mut t = Timer::new();
        let e = t.start(plan(), 0).unwrap();
        step(&mut store, &mut rec, &t, e);
        let e = t.stop(10 * MIN).unwrap();
        step(&mut store, &mut rec, &t, e);
        let rows = sessions::list(&store, 0, i64::MAX, false).unwrap();
        assert_eq!(rows[0].outcome.as_deref(), Some("interrupted"));
        assert_eq!(rows[0].actual_s, Some(600));
    }

    #[test]
    fn a_running_timer_survives_a_restart() {
        let mut store = Store::open_in_memory().unwrap();
        let mut rec = Recording::default();
        let mut t = Timer::new();
        let e = t.start(plan(), 0).unwrap();
        step(&mut store, &mut rec, &t, e);
        save(&store, &rec, &t, 5 * MIN).unwrap();

        let (mut back, mut back_rec) = restore(&mut store, 6 * MIN);
        assert!(back.is_active());
        assert_eq!(back_rec.open_row, rec.open_row);
        // The same history row is finished when the phase ends.
        let e = back.tick(25 * MIN);
        step(&mut store, &mut back_rec, &back, e);
        let rows = sessions::list(&store, 0, i64::MAX, false).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].outcome.as_deref(), Some("completed"));

        // Finishing clears the save.
        let e = back.stop(26 * MIN).unwrap();
        step(&mut store, &mut back_rec, &back, e);
        save(&store, &back_rec, &back, 26 * MIN).unwrap();
        let (idle, _) = restore(&mut store, 27 * MIN);
        assert!(!idle.is_active());
    }

    #[test]
    fn a_deadline_run_logs_its_focus_against_the_deadline() {
        let mut store = Store::open_in_memory().unwrap();
        let input = serde_json::from_value(serde_json::json!({
            "title": "Essay", "startAt": 0, "dueAt": 1_900_000_000_000_i64, "viz": "both"
        }))
        .unwrap();
        let dl = focus_store::deadlines::create(&mut store, input, "2026-10-30").unwrap().id;
        let mut rec = Recording { deadline_id: Some(dl.clone()), ..Recording::default() };
        let mut t = Timer::new();
        let e = t.start(plan(), 0).unwrap();
        step(&mut store, &mut rec, &t, e);
        let e = t.tick(25 * MIN); // focus done, break starts
        step(&mut store, &mut rec, &t, e);
        let e = t.stop(26 * MIN).unwrap();
        step(&mut store, &mut rec, &t, e);
        let rows: Vec<(String, Option<String>)> = store
            .conn()
            .prepare("SELECT phase, deadline_id FROM focus_sessions ORDER BY started_at")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(rows, vec![("focus".into(), Some(dl)), ("short_break".into(), None)]);
        assert_eq!(rec.deadline_id, None, "the next run is not for the deadline");
    }
}
