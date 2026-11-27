//! The focus timer as a plain state machine. It never reads the clock itself: every call gets
//! the current time in milliseconds, so it is fully testable and behaves correctly after the
//! PC sleeps (the next `tick` simply sees that the phase has ended).

use serde::{Deserialize, Serialize};

/// A focus length this long means "endless": the session counts up until it is stopped
/// (a preset saved with the focus length left blank). It still ends by itself after 24 hours.
pub const ENDLESS_FOCUS_MS: u64 = 86_400_000;

/// A preset saved with Sessions left blank keeps this number: the run never ends by itself, it
/// goes focus, break, focus, break … until it is stopped. (The database only allows 1–24, so the
/// top value stands for "repeat"; the form offers 1–23.)
pub const REPEAT_SESSIONS: u32 = 24;

/// What one run of the timer looks like. Built from a preset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub preset_id: Option<String>,
    pub preset_name: String,
    pub focus_ms: u64,
    pub short_break_ms: u64,
    pub long_break_ms: u64,
    /// Number of focus sessions in the run (the run ends after the last focus).
    pub sessions: u32,
    /// Every Nth break is a long break; 0 = never.
    pub long_break_every: u32,
    /// Start a break by itself when a focus session ends.
    pub auto_start_break: bool,
    /// Start the next focus by itself when a break ends.
    pub auto_start_focus: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Focus,
    ShortBreak,
    LongBreak,
}

impl Plan {
    /// One open-ended focus session with no breaks (see [`ENDLESS_FOCUS_MS`]).
    pub fn is_endless(&self) -> bool {
        self.focus_ms >= ENDLESS_FOCUS_MS
    }

    /// Repeats focus and breaks until stopped (Sessions left blank).
    pub fn repeats(&self) -> bool {
        self.sessions >= REPEAT_SESSIONS && !self.is_endless()
    }
}

impl Snapshot {
    /// An endless focus session (counts up instead of down).
    pub fn is_endless(&self) -> bool {
        self.phase == Phase::Focus && self.duration_ms >= ENDLESS_FOCUS_MS
    }

    /// Time spent in the current phase so far.
    pub fn elapsed_ms(&self) -> u64 {
        self.duration_ms.saturating_sub(self.remaining_ms)
    }
}

impl Phase {
    pub fn is_break(self) -> bool {
        self != Phase::Focus
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Idle,
    Running,
    Paused,
    /// The next phase is ready but waits for the user (auto-start is off).
    Waiting,
    /// All sessions of the run are done.
    Finished,
}

/// Something that happened, for notifications and (Phase 7) the session history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    PhaseStarted { phase: Phase, session: u32, at_ms: u64 },
    /// The phase ran to its end.
    PhaseCompleted { phase: Phase, session: u32, at_ms: u64 },
    /// The user skipped the phase before its end.
    PhaseSkipped { phase: Phase, session: u32, at_ms: u64, elapsed_ms: u64 },
    /// The user stopped the timer during this phase.
    Stopped { phase: Phase, session: u32, at_ms: u64, elapsed_ms: u64 },
    RunFinished { sessions: u32, at_ms: u64 },
}

/// What the screen needs. `ends_at_ms` lets the UI count down smoothly on its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub status: Status,
    pub phase: Phase,
    pub session: u32,
    pub sessions: u32,
    pub duration_ms: u64,
    pub remaining_ms: u64,
    /// Set only while running.
    pub ends_at_ms: Option<u64>,
    pub preset_id: Option<String>,
    pub preset_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
enum State {
    Idle,
    Running { ends_at: u64, started_at: u64, paused_ms: u64 },
    Paused { remaining: u64, started_at: u64, paused_ms: u64, paused_at: u64 },
    Waiting,
    Finished,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Timer {
    plan: Option<Plan>,
    phase: Phase,
    session: u32,
    state: State,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimerError {
    InvalidPlan(&'static str),
    NotAllowed(&'static str),
}

impl std::fmt::Display for TimerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TimerError::InvalidPlan(m) | TimerError::NotAllowed(m) => f.write_str(m),
        }
    }
}

impl Default for Timer {
    fn default() -> Self {
        Self::new()
    }
}

impl Timer {
    pub fn new() -> Self {
        Timer { plan: None, phase: Phase::Focus, session: 1, state: State::Idle }
    }

    pub fn snapshot(&self, now: u64) -> Snapshot {
        let duration = self.plan.as_ref().map_or(0, |p| self.phase_ms(p, self.phase));
        let (status, remaining, ends_at) = match &self.state {
            State::Idle => (Status::Idle, duration, None),
            State::Running { ends_at, .. } => (Status::Running, ends_at.saturating_sub(now), Some(*ends_at)),
            State::Paused { remaining, .. } => (Status::Paused, *remaining, None),
            State::Waiting => (Status::Waiting, duration, None),
            State::Finished => (Status::Finished, 0, None),
        };
        Snapshot {
            status,
            phase: self.phase,
            session: self.session,
            // u32::MAX: repeats until stopped.
            sessions: self.plan.as_ref().map_or(0, |p| if p.repeats() { u32::MAX } else { p.sessions }),
            duration_ms: duration,
            remaining_ms: remaining,
            ends_at_ms: ends_at,
            preset_id: self.plan.as_ref().and_then(|p| p.preset_id.clone()),
            preset_name: self.plan.as_ref().map(|p| p.preset_name.clone()),
        }
    }

    /// Starts a new run with focus session 1. Allowed when nothing is in progress.
    pub fn start(&mut self, plan: Plan, now: u64) -> Result<Vec<Event>, TimerError> {
        if matches!(self.state, State::Running { .. } | State::Paused { .. } | State::Waiting) {
            return Err(TimerError::NotAllowed("a session is already in progress; stop it first"));
        }
        validate(&plan)?;
        self.plan = Some(plan);
        self.phase = Phase::Focus;
        self.session = 1;
        Ok(vec![self.begin_phase(now)])
    }

    pub fn pause(&mut self, now: u64) -> Result<(), TimerError> {
        match self.state {
            State::Running { ends_at, started_at, paused_ms } => {
                self.state = State::Paused { remaining: ends_at.saturating_sub(now), started_at, paused_ms, paused_at: now };
                Ok(())
            }
            _ => Err(TimerError::NotAllowed("the timer is not running")),
        }
    }

    pub fn resume(&mut self, now: u64) -> Result<(), TimerError> {
        match self.state {
            State::Paused { remaining, started_at, paused_ms, paused_at } => {
                self.state = State::Running {
                    ends_at: now + remaining,
                    started_at,
                    paused_ms: paused_ms + now.saturating_sub(paused_at),
                };
                Ok(())
            }
            _ => Err(TimerError::NotAllowed("the timer is not paused")),
        }
    }

    /// Starts the phase that is waiting for the user.
    pub fn continue_next(&mut self, now: u64) -> Result<Vec<Event>, TimerError> {
        match self.state {
            State::Waiting => Ok(vec![self.begin_phase(now)]),
            _ => Err(TimerError::NotAllowed("nothing is waiting to start")),
        }
    }

    /// Ends the current phase early and moves on as if it had finished.
    pub fn skip(&mut self, now: u64) -> Result<Vec<Event>, TimerError> {
        let elapsed = self.elapsed(now).ok_or(TimerError::NotAllowed("there is no session to skip"))?;
        let mut events = vec![Event::PhaseSkipped { phase: self.phase, session: self.session, at_ms: now, elapsed_ms: elapsed }];
        // A skip is a deliberate choice, so the next phase always starts right away.
        events.extend(self.advance(now, true));
        Ok(events)
    }

    /// Stops the run. A focus session stopped early counts as interrupted.
    pub fn stop(&mut self, now: u64) -> Result<Vec<Event>, TimerError> {
        let mut events = Vec::new();
        match self.state {
            State::Idle => return Err(TimerError::NotAllowed("the timer is not running")),
            State::Finished => {}
            State::Waiting => {}
            State::Running { .. } | State::Paused { .. } => {
                let elapsed = self.elapsed(now).unwrap_or(0);
                events.push(Event::Stopped { phase: self.phase, session: self.session, at_ms: now, elapsed_ms: elapsed });
            }
        }
        self.state = State::Idle;
        self.phase = Phase::Focus;
        self.session = 1;
        Ok(events)
    }

    /// Call often (a few times a second). Returns what happened since the last call.
    pub fn tick(&mut self, now: u64) -> Vec<Event> {
        let mut events = Vec::new();
        // A loop, not an `if`: after a long sleep several short phases may have passed.
        // Each auto-started phase begins at `now`, so it cannot end in the same tick; the bound is a safeguard.
        for _ in 0..64 {
            let State::Running { ends_at, .. } = self.state else { break };
            if now < ends_at {
                break;
            }
            events.push(Event::PhaseCompleted { phase: self.phase, session: self.session, at_ms: ends_at });
            events.extend(self.advance(now, false));
        }
        events
    }

    /// Time spent in the current phase, not counting pauses.
    fn elapsed(&self, now: u64) -> Option<u64> {
        let plan = self.plan.as_ref()?;
        let duration = self.phase_ms(plan, self.phase);
        match self.state {
            State::Running { ends_at, .. } => Some(duration.saturating_sub(ends_at.saturating_sub(now))),
            State::Paused { remaining, .. } => Some(duration.saturating_sub(remaining)),
            _ => None,
        }
    }

    fn phase_ms(&self, plan: &Plan, phase: Phase) -> u64 {
        match phase {
            Phase::Focus => plan.focus_ms,
            Phase::ShortBreak => plan.short_break_ms,
            Phase::LongBreak => plan.long_break_ms,
        }
    }

    fn begin_phase(&mut self, now: u64) -> Event {
        let plan = self.plan.as_ref().expect("a plan is set before any phase begins");
        let duration = self.phase_ms(plan, self.phase);
        self.state = State::Running { ends_at: now + duration, started_at: now, paused_ms: 0 };
        Event::PhaseStarted { phase: self.phase, session: self.session, at_ms: now }
    }

    /// Moves to the phase after the current one. `force_start` ignores the auto-start settings.
    fn advance(&mut self, now: u64, force_start: bool) -> Vec<Event> {
        let plan = self.plan.clone().expect("a plan is set while a phase runs");
        if self.phase == Phase::Focus {
            if !plan.repeats() && self.session >= plan.sessions {
                self.state = State::Finished;
                return vec![Event::RunFinished { sessions: plan.sessions, at_ms: now }];
            }
            let long = plan.long_break_every > 0 && self.session.is_multiple_of(plan.long_break_every);
            let next = if long { Phase::LongBreak } else { Phase::ShortBreak };
            if self.phase_ms(&plan, next) == 0 {
                // No break configured: go straight to the next focus.
                self.session += 1;
                self.phase = Phase::Focus;
                return self.ready(now, force_start || plan.auto_start_focus);
            }
            self.phase = next;
            self.ready(now, force_start || plan.auto_start_break)
        } else {
            self.session += 1;
            self.phase = Phase::Focus;
            self.ready(now, force_start || plan.auto_start_focus)
        }
    }

    fn ready(&mut self, now: u64, start: bool) -> Vec<Event> {
        if start {
            vec![self.begin_phase(now)]
        } else {
            self.state = State::Waiting;
            Vec::new()
        }
    }
}

/// How long Focus can be closed (or the PC off) before a running timer comes back paused
/// instead of still running. Short gaps, like installing an update, keep it running.
pub const RESUME_RUNNING_WITHIN_MS: u64 = 2 * 60_000;

impl Timer {
    /// The whole timer as plain data, saved to disk so it survives Focus restarting.
    pub fn save(&self) -> Timer {
        self.clone()
    }

    /// Brings back a saved timer. `last_alive` is the last time Focus was known to be open.
    /// If Focus was closed for longer than [`RESUME_RUNNING_WITHIN_MS`], a running phase comes
    /// back paused at the moment Focus closed, so time away is not counted as focus.
    /// Anything that does not make sense (bad plan, odd session number) gives an idle timer.
    pub fn restore(saved: Timer, last_alive: u64, now: u64) -> Timer {
        let Some(plan) = saved.plan.as_ref() else { return Timer::new() };
        if validate(plan).is_err() || saved.session == 0 || (!plan.repeats() && saved.session > plan.sessions) {
            return Timer::new();
        }
        let mut timer = saved;
        if let State::Running { ends_at, started_at, paused_ms } = timer.state
            && now.saturating_sub(last_alive) > RESUME_RUNNING_WITHIN_MS
            && ends_at > last_alive
        {
            timer.state = State::Paused { remaining: ends_at - last_alive, started_at, paused_ms, paused_at: last_alive };
        }
        timer
    }

    /// The plan of the current or last run.
    pub fn plan(&self) -> Option<&Plan> {
        self.plan.as_ref()
    }

    /// How long `phase` lasts in `plan`, in milliseconds.
    pub fn phase_duration(plan: &Plan, phase: Phase) -> u64 {
        match phase {
            Phase::Focus => plan.focus_ms,
            Phase::ShortBreak => plan.short_break_ms,
            Phase::LongBreak => plan.long_break_ms,
        }
    }

    /// True while a run is in progress (running, paused, or waiting for the next phase).
    pub fn is_active(&self) -> bool {
        matches!(self.state, State::Running { .. } | State::Paused { .. } | State::Waiting)
    }
}

fn validate(plan: &Plan) -> Result<(), TimerError> {
    const MIN: u64 = 60_000;
    const DAY: u64 = 86_400_000;
    if !(MIN..=DAY).contains(&plan.focus_ms) {
        return Err(TimerError::InvalidPlan("focus must be between 1 minute and 24 hours"));
    }
    if plan.short_break_ms > DAY || plan.long_break_ms > DAY {
        return Err(TimerError::InvalidPlan("breaks must be at most 24 hours"));
    }
    if !(1..=24).contains(&plan.sessions) {
        return Err(TimerError::InvalidPlan("sessions must be between 1 and 24"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60_000;

    fn pomodoro() -> Plan {
        Plan {
            preset_id: Some("p".into()),
            preset_name: "Pomodoro".into(),
            focus_ms: 25 * MIN,
            short_break_ms: 5 * MIN,
            long_break_ms: 15 * MIN,
            sessions: 4,
            long_break_every: 4,
            auto_start_break: true,
            auto_start_focus: true,
        }
    }

    fn phases_of(events: &[Event]) -> Vec<(Phase, u32)> {
        events
            .iter()
            .filter_map(|e| match e {
                Event::PhaseStarted { phase, session, .. } => Some((*phase, *session)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn fresh_start_shows_25_00_focus_session_1_of_4() {
        let mut t = Timer::new();
        t.start(pomodoro(), 0).unwrap();
        let s = t.snapshot(0);
        assert_eq!((s.status, s.phase, s.session, s.sessions), (Status::Running, Phase::Focus, 1, 4));
        assert_eq!(s.remaining_ms, 25 * MIN);
        assert_eq!(t.snapshot(28_000).remaining_ms, 25 * MIN - 28_000); // 24:32
    }

    #[test]
    fn blank_sessions_repeat_until_stopped() {
        let mut plan = pomodoro();
        plan.sessions = REPEAT_SESSIONS;
        let mut t = Timer::new();
        t.start(plan, 0).unwrap();
        assert_eq!(t.snapshot(0).sessions, u32::MAX);
        let mut now = 0;
        // Well past 24 sessions, it is still going.
        for _ in 0..80 {
            now = t.snapshot(now).ends_at_ms.unwrap();
            t.tick(now);
        }
        let s = t.snapshot(now);
        assert_eq!(s.status, Status::Running);
        assert!(s.session > 30);
        // And it comes back after a restart.
        let back = Timer::restore(t.clone(), now, now);
        assert_eq!(back.snapshot(now).session, s.session);
    }

    #[test]
    fn full_pomodoro_run_follows_the_brief() {
        // 25 F, 5 B, 25 F, 5 B, 25 F, 5 B, 25 F, then done.
        let mut t = Timer::new();
        let mut events = t.start(pomodoro(), 0).unwrap();
        let mut now = 0;
        while t.snapshot(now).status == Status::Running {
            now = t.snapshot(now).ends_at_ms.unwrap();
            events.extend(t.tick(now));
        }
        use Phase::*;
        assert_eq!(
            phases_of(&events),
            [(Focus, 1), (ShortBreak, 1), (Focus, 2), (ShortBreak, 2), (Focus, 3), (ShortBreak, 3), (Focus, 4)]
        );
        assert_eq!(t.snapshot(now).status, Status::Finished);
        assert_eq!(now, 4 * 25 * MIN + 3 * 5 * MIN);
        assert!(matches!(events.last(), Some(Event::RunFinished { sessions: 4, .. })));
    }

    #[test]
    fn long_break_comes_every_nth_session() {
        let mut plan = pomodoro();
        plan.sessions = 6;
        plan.long_break_every = 2;
        let mut t = Timer::new();
        let mut events = t.start(plan, 0).unwrap();
        let mut now = 0;
        while t.snapshot(now).status == Status::Running {
            now = t.snapshot(now).ends_at_ms.unwrap();
            events.extend(t.tick(now));
        }
        let breaks: Vec<Phase> = phases_of(&events).into_iter().map(|(p, _)| p).filter(|p| p.is_break()).collect();
        use Phase::*;
        assert_eq!(breaks, [ShortBreak, LongBreak, ShortBreak, LongBreak, ShortBreak]);
    }

    #[test]
    fn pause_freezes_the_countdown() {
        let mut t = Timer::new();
        t.start(pomodoro(), 0).unwrap();
        t.pause(10 * MIN).unwrap();
        assert_eq!(t.snapshot(20 * MIN).remaining_ms, 15 * MIN);
        assert!(t.tick(30 * MIN).is_empty(), "a paused timer never completes");
        t.resume(30 * MIN).unwrap();
        assert_eq!(t.snapshot(30 * MIN).ends_at_ms, Some(45 * MIN));
    }

    #[test]
    fn without_auto_start_the_break_waits() {
        let mut plan = pomodoro();
        plan.auto_start_break = false;
        let mut t = Timer::new();
        t.start(plan, 0).unwrap();
        let events = t.tick(25 * MIN);
        assert_eq!(events, [Event::PhaseCompleted { phase: Phase::Focus, session: 1, at_ms: 25 * MIN }]);
        let s = t.snapshot(26 * MIN);
        assert_eq!((s.status, s.phase, s.remaining_ms), (Status::Waiting, Phase::ShortBreak, 5 * MIN));
        let started = t.continue_next(27 * MIN).unwrap();
        assert_eq!(phases_of(&started), [(Phase::ShortBreak, 1)]);
        assert_eq!(t.snapshot(27 * MIN).ends_at_ms, Some(32 * MIN));
    }

    #[test]
    fn without_auto_next_the_focus_waits_after_a_break() {
        let mut plan = pomodoro();
        plan.auto_start_focus = false;
        let mut t = Timer::new();
        t.start(plan, 0).unwrap();
        t.tick(25 * MIN);
        t.tick(30 * MIN);
        let s = t.snapshot(31 * MIN);
        assert_eq!((s.status, s.phase, s.session), (Status::Waiting, Phase::Focus, 2));
    }

    #[test]
    fn endless_focus_counts_up_until_stopped() {
        let mut plan = pomodoro();
        plan.focus_ms = ENDLESS_FOCUS_MS;
        plan.sessions = 1;
        assert!(plan.is_endless());
        let mut t = Timer::new();
        t.start(plan, 0).unwrap();
        assert!(t.tick(5 * 60 * MIN).is_empty(), "five hours in, still going");
        let s = t.snapshot(5 * 60 * MIN);
        assert!(s.is_endless());
        assert_eq!(s.elapsed_ms(), 5 * 60 * MIN);
        let events = t.stop(5 * 60 * MIN).unwrap();
        assert!(matches!(events.as_slice(), [Event::Stopped { elapsed_ms, .. }] if *elapsed_ms == 5 * 60 * MIN));
    }

    #[test]
    fn skip_moves_on_immediately() {
        let mut plan = pomodoro();
        plan.auto_start_break = false; // skip starts the next phase anyway
        let mut t = Timer::new();
        t.start(plan, 0).unwrap();
        let events = t.skip(10 * MIN).unwrap();
        assert_eq!(events[0], Event::PhaseSkipped { phase: Phase::Focus, session: 1, at_ms: 10 * MIN, elapsed_ms: 10 * MIN });
        assert_eq!(phases_of(&events), [(Phase::ShortBreak, 1)]);
    }

    #[test]
    fn stopping_focus_reports_time_without_pauses() {
        let mut t = Timer::new();
        t.start(pomodoro(), 0).unwrap();
        t.pause(5 * MIN).unwrap();
        t.resume(15 * MIN).unwrap();
        let events = t.stop(20 * MIN).unwrap();
        assert_eq!(events, [Event::Stopped { phase: Phase::Focus, session: 1, at_ms: 20 * MIN, elapsed_ms: 10 * MIN }]);
        assert_eq!(t.snapshot(20 * MIN).status, Status::Idle);
    }

    #[test]
    fn zero_length_break_goes_straight_to_next_focus() {
        let mut plan = pomodoro();
        plan.short_break_ms = 0;
        let mut t = Timer::new();
        t.start(plan, 0).unwrap();
        let events = t.tick(25 * MIN);
        assert_eq!(phases_of(&events), [(Phase::Focus, 2)]);
    }

    #[test]
    fn sleeping_through_several_phases_catches_up() {
        let mut plan = pomodoro();
        plan.focus_ms = MIN;
        plan.short_break_ms = MIN;
        let mut t = Timer::new();
        t.start(plan, 0).unwrap();
        // Wake up after 10 minutes: focus 1 ended; the break starts now, not in the past.
        let events = t.tick(10 * MIN);
        assert_eq!(phases_of(&events), [(Phase::ShortBreak, 1)]);
        assert_eq!(t.snapshot(10 * MIN).ends_at_ms, Some(11 * MIN));
    }

    #[test]
    fn single_session_run_finishes_without_a_break() {
        let mut plan = pomodoro();
        plan.sessions = 1;
        let mut t = Timer::new();
        t.start(plan, 0).unwrap();
        let events = t.tick(25 * MIN);
        assert!(matches!(events.as_slice(), [Event::PhaseCompleted { .. }, Event::RunFinished { sessions: 1, .. }]));
    }

    #[test]
    fn invalid_actions_are_refused() {
        let mut t = Timer::new();
        assert!(t.pause(0).is_err());
        assert!(t.skip(0).is_err());
        assert!(t.stop(0).is_err());
        t.start(pomodoro(), 0).unwrap();
        assert!(t.start(pomodoro(), 1).is_err(), "cannot start twice");
        assert!(t.resume(1).is_err());
        let mut bad = pomodoro();
        bad.focus_ms = 1000;
        assert!(Timer::new().start(bad, 0).is_err());
    }

    #[test]
    fn a_finished_run_can_start_again() {
        let mut plan = pomodoro();
        plan.sessions = 1;
        let mut t = Timer::new();
        t.start(plan.clone(), 0).unwrap();
        t.tick(25 * MIN);
        assert!(t.start(plan, 30 * MIN).is_ok());
    }

    #[test]
    fn restore_after_a_short_restart_keeps_running() {
        let mut t = Timer::new();
        t.start(pomodoro(), 0).unwrap();
        let saved = t.save();
        let back = Timer::restore(saved, 10 * MIN, 10 * MIN + 30_000);
        let s = back.snapshot(10 * MIN + 30_000);
        assert_eq!(s.status, Status::Running);
        assert_eq!(s.remaining_ms, 25 * MIN - 10 * MIN - 30_000);
    }

    #[test]
    fn restore_after_a_long_gap_comes_back_paused_where_it_was() {
        let mut t = Timer::new();
        t.start(pomodoro(), 0).unwrap();
        // Focus was last seen at minute 10, then the PC was off for hours.
        let back = Timer::restore(t.save(), 10 * MIN, 300 * MIN);
        let s = back.snapshot(300 * MIN);
        assert_eq!(s.status, Status::Paused);
        assert_eq!(s.remaining_ms, 15 * MIN);
        let mut back = back;
        back.resume(300 * MIN).unwrap();
        assert_eq!(back.snapshot(300 * MIN).remaining_ms, 15 * MIN);
    }

    #[test]
    fn restore_round_trips_through_json_shape_and_rejects_nonsense() {
        let mut t = Timer::new();
        t.start(pomodoro(), 0).unwrap();
        t.pause(5 * MIN).unwrap();
        let back = Timer::restore(t.save(), 6 * MIN, 600 * MIN);
        assert_eq!(back.snapshot(600 * MIN).status, Status::Paused);
        assert_eq!(back.snapshot(600 * MIN).remaining_ms, 20 * MIN);
        assert!(back.is_active());

        let mut bad = t.save();
        bad.session = 9;
        assert_eq!(Timer::restore(bad, 0, 0).snapshot(0).status, Status::Idle);
        assert_eq!(Timer::restore(Timer::new(), 0, 0).snapshot(0).status, Status::Idle);
    }
}
