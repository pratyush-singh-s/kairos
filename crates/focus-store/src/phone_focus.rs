//! The phone's own focus timer, for when there is no laptop running one: focus, break, focus...
//! for a number of rounds. Only when it started and how long it was paused are saved; the phase
//! at any moment is worked out from that, so the timer needs nothing running while the app is
//! closed. During a focus phase (also while paused) the phone blocks, and so do browsers linked
//! to the phone (apps/mobile/src-tauri/src/browser_link.rs). The timer itself is never synced;
//! the laptop sees it as `focus.livePhone` and can pause or stop it (`crate::remote`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Store;
use crate::error::Result;
use crate::phone_block::{FocusLive, LiveClock};
use crate::settings;

const MINUTE: u64 = 60_000;

/// What Start was pressed with. Mirrored by `PhoneTimer` in apps/mobile/src/ipc/phoneFocus.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PhoneTimer {
    pub started_at_ms: u64,
    pub focus_min: u32,
    /// 0 = no breaks between rounds.
    pub break_min: u32,
    pub rounds: u32,
    pub paused_at_ms: Option<u64>,
    /// Time spent paused before the current pause.
    pub paused_total_ms: u64,
    /// Time skipped with Skip.
    #[serde(default)]
    pub skipped_ms: u64,
    /// Focus rounds already written to the session history (`record`).
    #[serde(default)]
    pub recorded: u32,
    /// Started with "Start focus" on a deadline: its rounds count towards it.
    #[serde(default)]
    pub deadline_id: Option<String>,
    /// What the timer is called while it runs (the deadline's title); None = "Phone timer".
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Focus,
    Break,
    Done,
}

/// Where the timer is at one moment. Mirrored by `TimerStatus` in phoneFocus.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimerStatus {
    pub phase: Phase,
    /// 1-based; for a break, the round just finished.
    pub round: u32,
    pub rounds: u32,
    pub focus_min: u32,
    pub break_min: u32,
    pub left_ms: u64,
    pub paused: bool,
    /// When this phase ends (ms since epoch); None while paused or done.
    pub ends_at_ms: Option<u64>,
    /// The deadline this timer was started for, if any.
    pub deadline_id: Option<String>,
}

impl PhoneTimer {
    pub fn new(focus_min: u32, break_min: u32, rounds: u32, now_ms: u64) -> Self {
        PhoneTimer {
            started_at_ms: now_ms,
            focus_min: focus_min.clamp(1, 1440),
            break_min: break_min.min(60),
            rounds: rounds.clamp(1, 12),
            paused_at_ms: None,
            paused_total_ms: 0,
            skipped_ms: 0,
            recorded: 0,
            deadline_id: None,
            title: None,
        }
    }

    /// Where focus round `round` (1-based) starts and ends on the timer's own clock.
    fn focus_span(&self, round: u32) -> (u64, u64) {
        let lap = (self.focus_min as u64 + self.break_min as u64) * MINUTE;
        let start = (round.saturating_sub(1)) as u64 * lap;
        (start, start + self.focus_min as u64 * MINUTE)
    }

    /// Wall-clock time (ms) of a point on the timer's own clock, near enough for the history.
    fn wall(&self, t: u64, now_ms: u64) -> u64 {
        let elapsed = self.elapsed(now_ms);
        now_ms.saturating_sub(elapsed.saturating_sub(t))
    }

    /// Time the timer has run (not counting pauses).
    fn elapsed(&self, now_ms: u64) -> u64 {
        let until = self.paused_at_ms.unwrap_or(now_ms);
        (until.saturating_sub(self.started_at_ms) + self.skipped_ms).saturating_sub(self.paused_total_ms)
    }

    pub fn status(&self, now_ms: u64) -> TimerStatus {
        let elapsed = self.elapsed(now_ms);
        let focus = self.focus_min as u64 * MINUTE;
        let brk = self.break_min as u64 * MINUTE;
        let paused = self.paused_at_ms.is_some();
        let mut t = 0;
        for round in 1..=self.rounds {
            for (phase, len) in [(Phase::Focus, focus), (Phase::Break, if round < self.rounds { brk } else { 0 })] {
                if len == 0 {
                    continue;
                }
                if elapsed < t + len {
                    let left = t + len - elapsed;
                    return TimerStatus {
                        phase,
                        round,
                        rounds: self.rounds,
                        focus_min: self.focus_min,
                        break_min: self.break_min,
                        left_ms: left,
                        paused,
                        ends_at_ms: (!paused).then_some(now_ms + left),
                        deadline_id: self.deadline_id.clone(),
                    };
                }
                t += len;
            }
        }
        TimerStatus { phase: Phase::Done, round: self.rounds, rounds: self.rounds, focus_min: self.focus_min, break_min: self.break_min, left_ms: 0, paused: false, ends_at_ms: None, deadline_id: self.deadline_id.clone() }
    }

    fn name(&self) -> String {
        self.title.clone().unwrap_or_else(|| "Phone timer".into())
    }

    /// Pausing holds the whole timer; a break can't be paused (it ends on time).
    pub fn pause(&mut self, now_ms: u64) {
        if self.paused_at_ms.is_none() && self.status(now_ms).phase == Phase::Focus {
            self.paused_at_ms = Some(now_ms);
        }
    }

    pub fn resume(&mut self, now_ms: u64) {
        if let Some(at) = self.paused_at_ms.take() {
            self.paused_total_ms += now_ms.saturating_sub(at);
        }
    }

    /// Ends this phase now.
    pub fn skip(&mut self, now_ms: u64) {
        self.resume(now_ms);
        self.skipped_ms += self.status(now_ms).left_ms;
    }

    /// The timer as the laptop's focus state looks, so blocking treats both alike; None off focus.
    pub fn live(&self, now_ms: u64) -> Option<FocusLive> {
        let s = self.status(now_ms);
        (s.phase == Phase::Focus).then(|| FocusLive {
            active: true,
            paused: s.paused,
            ends_at_ms: s.ends_at_ms,
            preset_name: Some(self.name()),
            updated_at_ms: now_ms,
            clock: None,
        })
    }

    /// The timer as the laptop sees it (`focus.livePhone`): blocking as `live`, plus the clock,
    /// breaks included. None once done.
    pub fn shared(&self, device_id: &str, now_ms: u64) -> Option<FocusLive> {
        let s = self.status(now_ms);
        let phase = match s.phase {
            Phase::Focus => "focus",
            Phase::Break => "break",
            Phase::Done => return None,
        };
        Some(FocusLive {
            active: s.phase == Phase::Focus,
            paused: s.paused,
            ends_at_ms: if s.phase == Phase::Focus { s.ends_at_ms } else { None },
            preset_name: Some(self.name()),
            updated_at_ms: now_ms,
            clock: Some(LiveClock {
                device_id: device_id.to_string(),
                phase: phase.into(),
                round: s.round,
                rounds: s.rounds,
                paused: s.paused,
                left_ms: s.paused.then_some(s.left_ms),
                ends_at_ms: s.ends_at_ms,
            }),
        })
    }
}

/// Writes the focus rounds that have ended to the session history (so they count for stats and
/// the daily goal on every device), and, when `stopping`, the round cut short. Rounds already
/// written are remembered in the timer, so calling this often is fine.
pub fn record(store: &mut Store, timer: &mut PhoneTimer, now_ms: u64, stopping: bool) -> Result<()> {
    use crate::sessions::{self, NewSession, Outcome};
    let elapsed = timer.elapsed(now_ms);
    let cycle = format!("phone-{}", timer.started_at_ms);
    while timer.recorded < timer.rounds {
        let round = timer.recorded + 1;
        let (start, end) = timer.focus_span(round);
        let (outcome, actual) = if elapsed >= end {
            (Outcome::Completed, end - start)
        } else if stopping && elapsed > start {
            (Outcome::Interrupted, elapsed - start)
        } else {
            break;
        };
        timer.recorded = round;
        if actual < MINUTE {
            continue;
        }
        let started_at = timer.wall(start, now_ms) as i64;
        let id = sessions::begin(store, NewSession {
            cycle_id: &cycle,
            session_number: round,
            phase: "focus",
            started_at,
            planned_s: (timer.focus_min as i64) * 60,
            preset_id: None,
            deadline_id: timer.deadline_id.as_deref(),
        })?;
        let ended_at = timer.wall(start + actual, now_ms) as i64;
        sessions::finish(store, &id, ended_at, (actual / 1000) as i64, outcome)?;
    }
    Ok(())
}

/// Brings the saved timer up to date: records finished rounds, clears a finished timer, and
/// tells the laptop (`focus.livePhone`). Returns the timer as it is now.
pub fn settle(store: &mut Store, now_ms: u64) -> Result<Option<PhoneTimer>> {
    apply_remote(store, now_ms)?;
    let Some(mut t) = get_timer(store)? else {
        share_live(store, None, now_ms)?;
        return Ok(None);
    };
    let before = t.recorded;
    record(store, &mut t, now_ms, false)?;
    let next = (t.status(now_ms).phase != Phase::Done).then_some(t);
    if next.as_ref().map(|t| t.recorded) != Some(before) {
        save_timer(store, next.as_ref())?;
    }
    share_live(store, next.as_ref(), now_ms)?;
    Ok(next)
}

/// Pause, Resume, Skip or Stop pressed on the laptop for this timer (`crate::remote`).
fn apply_remote(store: &mut Store, now_ms: u64) -> Result<()> {
    let Some(action) = crate::remote::take(store, now_ms)? else { return Ok(()) };
    let Some(mut t) = get_timer(store)? else { return Ok(()) };
    match action.as_str() {
        "stop" => return stop(store, now_ms),
        "pause" => t.pause(now_ms),
        "resume" => t.resume(now_ms),
        "skip" => t.skip(now_ms),
        _ => return Ok(()),
    }
    save_timer(store, Some(&t))
}

/// Stops the phone timer: records what was done and tells the laptop.
pub fn stop(store: &mut Store, now_ms: u64) -> Result<()> {
    if let Some(mut t) = get_timer(store)? {
        record(store, &mut t, now_ms, true)?;
    }
    save_timer(store, None)?;
    share_live(store, None, now_ms)
}

/// The phone's own focus for the laptop (synced `focus.livePhone`); written only on change.
pub fn share_live(store: &mut Store, timer: Option<&PhoneTimer>, now_ms: u64) -> Result<()> {
    let device = store.device_id().to_string();
    let live = timer.and_then(|t| t.shared(&device, now_ms)).unwrap_or(FocusLive {
        active: false,
        paused: false,
        ends_at_ms: None,
        preset_name: None,
        updated_at_ms: now_ms,
        clock: None,
    });
    let old: Option<FocusLive> = serde_json::from_value(settings::get(store, "focus.livePhone")?).ok();
    if old.is_some_and(|o| o.same_as(&live)) {
        return Ok(());
    }
    settings::set(store, "focus.livePhone", &live)
}

/// What the phone last said about its own focus, as the laptop reads it.
pub fn phone_live(store: &Store) -> Result<Option<FocusLive>> {
    Ok(serde_json::from_value(settings::get(store, "focus.livePhone")?).ok())
}

/// The scheduled focus window open now, as a focus state.
pub fn scheduled_live(store: &Store, now_ms: u64) -> Result<Option<FocusLive>> {
    Ok(crate::schedule::current(store, now_ms)?.map(|w| FocusLive {
        active: true,
        paused: false,
        ends_at_ms: Some(w.ends_at_ms),
        preset_name: Some(w.name),
        updated_at_ms: now_ms,
        clock: None,
    }))
}

pub fn get_timer(store: &Store) -> Result<Option<PhoneTimer>> {
    let raw: Value = settings::get(store, "phone.timer")?;
    Ok(serde_json::from_value(raw).ok())
}

pub fn save_timer(store: &mut Store, timer: Option<&PhoneTimer>) -> Result<()> {
    settings::set(store, "phone.timer", &timer)
}

/// The focus state the phone follows: the laptop's while it runs a focus phase, else the phone's
/// own timer, else a scheduled focus window, else the laptop's last word.
pub fn effective_live(store: &Store, now_ms: u64) -> Result<Option<FocusLive>> {
    let laptop = crate::phone_block::get_live(store)?;
    if laptop.as_ref().is_some_and(|l| l.blocks_at(now_ms)) {
        return Ok(laptop);
    }
    if let Some(own) = get_timer(store)?.and_then(|t| t.live(now_ms)) {
        return Ok(Some(own));
    }
    if let Some(planned) = scheduled_live(store, now_ms)? {
        return Ok(Some(planned));
    }
    Ok(laptop)
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: u64 = MINUTE;

    #[test]
    fn phases_follow_each_other() {
        let t = PhoneTimer::new(25, 5, 2, 0);
        let s = t.status(10 * M);
        assert_eq!((s.phase, s.round, s.left_ms, s.ends_at_ms), (Phase::Focus, 1, 15 * M, Some(25 * M)));
        assert_eq!(t.status(25 * M).phase, Phase::Break);
        let s = t.status(31 * M);
        assert_eq!((s.phase, s.round), (Phase::Focus, 2));
        assert_eq!(t.status(55 * M).phase, Phase::Done, "no break after the last round");
        assert!(t.live(26 * M).is_none(), "breaks don't block");
        assert_eq!(t.live(10 * M).unwrap().ends_at_ms, Some(25 * M));
    }

    #[test]
    fn pause_holds_and_resume_moves_the_end() {
        let mut t = PhoneTimer::new(10, 0, 3, 0);
        t.pause(4 * M);
        let s = t.status(100 * M);
        assert!(s.paused && s.ends_at_ms.is_none());
        assert_eq!(s.left_ms, 6 * M);
        let l = t.live(100 * M).unwrap();
        assert!(l.paused && l.blocks_at(100 * M));
        t.resume(20 * M);
        assert_eq!(t.status(20 * M).ends_at_ms, Some(26 * M));
        assert_eq!(t.status(26 * M).round, 2, "no breaks: the next round starts straight away");
    }

    #[test]
    fn skip_ends_the_phase_now() {
        let mut t = PhoneTimer::new(25, 5, 2, 0);
        t.skip(3 * M);
        let s = t.status(3 * M);
        assert_eq!((s.phase, s.left_ms), (Phase::Break, 5 * M));
    }

    #[test]
    fn the_laptop_comes_first() {
        let mut store = Store::open_in_memory().unwrap();
        assert_eq!(effective_live(&store, 0).unwrap(), None);
        save_timer(&mut store, Some(&PhoneTimer::new(25, 5, 1, 0))).unwrap();
        assert_eq!(effective_live(&store, M).unwrap().unwrap().preset_name.as_deref(), Some("Phone timer"));
        let laptop = FocusLive { active: true, paused: false, ends_at_ms: Some(90 * M), preset_name: Some("Deep".into()), updated_at_ms: 0, clock: None };
        crate::phone_block::publish_live(&mut store, &laptop).unwrap();
        assert_eq!(effective_live(&store, M).unwrap(), Some(laptop));
        assert!(settings::LOCAL_ONLY.contains(&"phone.timer"));
        save_timer(&mut store, None).unwrap();
        assert_eq!(get_timer(&store).unwrap(), None);
    }

    #[test]
    fn finished_rounds_go_to_the_history_once() {
        let mut store = Store::open_in_memory().unwrap();
        let start = 1_800_000_000_000;
        let mut t = PhoneTimer::new(25, 5, 3, start);
        record(&mut store, &mut t, start + 40 * M, false).unwrap();
        assert_eq!(t.recorded, 1);
        record(&mut store, &mut t, start + 41 * M, false).unwrap();
        assert_eq!(t.recorded, 1, "round 2 is still running");
        record(&mut store, &mut t, start + 45 * M, true).unwrap();
        assert_eq!(t.recorded, 2);
        let rows: Vec<(i64, String)> = store
            .conn()
            .prepare("SELECT actual_s, outcome FROM focus_sessions ORDER BY started_at")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(rows, vec![(1500, "completed".to_string()), (900, "interrupted".to_string())]);
    }

    #[test]
    fn the_laptop_sees_breaks_and_can_pause_and_stop_the_phone() {
        let mut store = Store::open_in_memory().unwrap();
        let me = store.device_id().to_string();
        let start = 1_800_000_000_000;
        save_timer(&mut store, Some(&PhoneTimer::new(25, 5, 2, start))).unwrap();
        settle(&mut store, start + 26 * M).unwrap();
        let live = phone_live(&store).unwrap().unwrap();
        let clock = live.clock.clone().unwrap();
        assert!(!live.active, "a break doesn't block");
        assert!(live.showing_at(start + 26 * M), "but the laptop shows it");
        assert_eq!((clock.phase.as_str(), clock.round, clock.ends_at_ms), ("break", 1, Some(start + 30 * M)));
        assert_eq!(clock.device_id, me);

        settle(&mut store, start + 31 * M).unwrap();
        crate::remote::send(&mut store, &me, "pause", start + 32 * M).unwrap();
        settle(&mut store, start + 32 * M).unwrap();
        let live = phone_live(&store).unwrap().unwrap();
        assert!(live.paused && live.clock.as_ref().unwrap().left_ms == Some(23 * M));

        crate::remote::send(&mut store, &me, "stop", start + 40 * M).unwrap();
        assert_eq!(settle(&mut store, start + 40 * M).unwrap(), None);
        assert!(!phone_live(&store).unwrap().unwrap().showing_at(start + 40 * M));
    }

    #[test]
    fn the_laptop_hears_about_the_phone_timer() {
        let mut store = Store::open_in_memory().unwrap();
        save_timer(&mut store, Some(&PhoneTimer::new(25, 5, 1, 0))).unwrap();
        settle(&mut store, M).unwrap();
        assert!(phone_live(&store).unwrap().unwrap().blocks_at(M));
        stop(&mut store, 2 * M).unwrap();
        assert!(!phone_live(&store).unwrap().unwrap().active);
        assert!(!settings::LOCAL_ONLY.contains(&"focus.livePhone"));
    }
}
