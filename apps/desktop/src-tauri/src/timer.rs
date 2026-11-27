//! Runs the focus timer in the native core, so it keeps going while the window is hidden.
//! A background thread ticks it four times a second; every change is sent to the window as a
//! `timer-changed` event, shown in the tray tooltip, and announced with a Windows notification.
//! Every change is also written to the history and saved, so a restart picks up where it was.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use focus_store::presets::{self, Preset};
use focus_store::settings;
use focus_timer::{Event, Phase, Plan, Snapshot, Status, Timer};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::bridge::{BridgeState, FocusState};
use crate::history::{self, RecordState};
use crate::sound::{self, Chime};
use crate::state::StoreState;

pub struct TimerState(pub Mutex<Timer>);

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// How often a running timer's save is refreshed, so a restart knows when Focus was last open.
const HEARTBEAT_MS: u64 = 30_000;

pub fn spawn_ticker(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_tooltip = String::new();
        let mut last_saved = 0u64;
        // What the phone was last told (None = not yet this run, so the first tick tells it).
        let mut shared: Option<focus_store::phone_block::FocusLive> = None;
        let me = app.state::<StoreState>().with(|s| Ok(s.device_id().to_string())).unwrap_or_default();
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let now = now_ms();
            let records = app.state::<RecordState>();
            let Ok(mut rec) = records.0.lock() else { return };
            let (events, snap, timer) = {
                let state = app.state::<TimerState>();
                let Ok(mut timer) = state.0.lock() else { return };
                let events = timer.tick(now);
                (events, timer.snapshot(now), timer.clone())
            };
            if !events.is_empty() || (timer.is_active() && now.saturating_sub(last_saved) >= HEARTBEAT_MS) {
                persist(&app, &mut rec, &timer, &events, now);
                last_saved = now;
            }
            drop(rec);
            // A scheduled session just started: the next tick shows it.
            if crate::follow::tick(&app, &snap, now) {
                continue;
            }
            let live = FocusState::from_snapshot(&snap);
            app.state::<BridgeState>().publish(crate::follow::combined(&app, live.clone()));
            let for_phone = crate::bridge::live_for_phone(&live, &snap, &me, now);
            if shared.as_ref().is_none_or(|s| !s.same_as(&for_phone)) && crate::bridge::share_with_phone(&app, &for_phone) {
                shared = Some(for_phone);
            }
            if !events.is_empty() {
                announce(&app, &events, &snap);
                let _ = app.emit("timer-changed", &snap);
            }
            let tooltip = tooltip(&snap);
            if tooltip != last_tooltip {
                if let Some(tray) = app.tray_by_id("main") {
                    let _ = tray.set_tooltip(Some(&tooltip));
                }
                last_tooltip = tooltip;
            }
        }
    });
}

/// Writes events to the history and saves the timer. A database problem must never stop
/// the timer itself, so failures are only logged.
fn persist(app: &AppHandle, rec: &mut history::Recording, timer: &Timer, events: &[Event], now: u64) {
    let result = app.state::<StoreState>().with(|store| {
        history::record(store, rec, timer, events)?;
        history::save(store, rec, timer, now)
    });
    if let Err(e) = result {
        eprintln!("focus: could not save the timer: {e}");
    }
    if events.iter().any(|e| matches!(e, Event::PhaseCompleted { .. } | Event::PhaseSkipped { .. } | Event::Stopped { .. })) {
        // The history page and the dashboard refresh when this arrives.
        let _ = app.emit("history-changed", ());
    }
}

/// Tells the user that a session from before the restart is back.
pub fn announce_resumed(app: &AppHandle) {
    let now = now_ms();
    let snap = match app.state::<TimerState>().0.lock() {
        Ok(t) => t.snapshot(now),
        Err(_) => return,
    };
    let body = match snap.status {
        Status::Paused => format!("Your {} is paused where you left off. Resume it when you're ready.", phase_label(snap.phase)),
        Status::Running if snap.is_endless() => format!("Your endless focus carried on: {} so far.", clock(snap.elapsed_ms())),
        Status::Running => format!("Your {} carried on: {} left.", phase_label(snap.phase), clock(snap.remaining_ms)),
        _ => "Your session is ready to continue.".into(),
    };
    let _ = app.notification().builder().title("Focus session restored").body(body).show();
}

/// Applies a user action, then tells the window and (where useful) Windows about it.
pub fn act(
    app: &AppHandle,
    f: impl FnOnce(&mut Timer, u64) -> Result<Vec<Event>, String>,
) -> Result<Snapshot, String> {
    let now = now_ms();
    let records = app.state::<RecordState>();
    let mut rec = records.0.lock().map_err(|_| "the timer is unavailable after an internal error")?;
    let (events, snap, timer) = {
        let state = app.state::<TimerState>();
        let mut timer = state.0.lock().map_err(|_| "the timer is unavailable after an internal error")?;
        let events = f(&mut timer, now)?;
        (events, timer.snapshot(now), timer.clone())
    };
    persist(app, &mut rec, &timer, &events, now);
    drop(rec);
    crate::follow::after_events(app, &events);
    app.state::<BridgeState>().publish(crate::follow::combined(app, FocusState::from_snapshot(&snap)));
    announce(app, &events, &snap);
    let _ = app.emit("timer-changed", &snap);
    Ok(snap)
}

pub fn plan_for(app: &AppHandle, preset_id: &str) -> Result<Plan, String> {
    let store = app.state::<StoreState>();
    let preset = store.with(|s| {
        let p = presets::get(s.conn(), preset_id).map_err(|e| e.to_string())?;
        // Remember the choice for next time; failure to save it must not block the timer.
        let _ = settings::set(s, "timer.lastPresetId", &preset_id);
        p.ok_or_else(|| "that preset no longer exists".to_string())
    })?;
    Ok(plan_from(&preset))
}

fn plan_from(p: &Preset) -> Plan {
    let ms = |s: i64| (s.max(0) as u64) * 1000;
    let endless = ms(p.focus_s) >= focus_timer::ENDLESS_FOCUS_MS;
    Plan {
        preset_id: Some(p.id.clone()),
        preset_name: p.name.clone(),
        focus_ms: ms(p.focus_s),
        short_break_ms: ms(p.short_break_s),
        long_break_ms: ms(p.long_break_s),
        // Endless: one session, no breaks.
        sessions: if endless { 1 } else { p.sessions_per_cycle.clamp(1, 24) as u32 },
        long_break_every: p.long_break_every.clamp(0, 24) as u32,
        auto_start_break: p.auto_start_break,
        auto_start_focus: p.auto_start_focus,
    }
}

fn tooltip(s: &Snapshot) -> String {
    let label = phase_label(s.phase);
    match s.status {
        Status::Idle => "Kairos".into(),
        Status::Running if s.is_endless() => format!("Kairos · {} so far (endless)", clock(s.elapsed_ms())),
        Status::Paused if s.is_endless() => format!("Kairos · paused at {} (endless)", clock(s.elapsed_ms())),
        Status::Running if s.sessions == u32::MAX => format!("Kairos · {} {} · session {} (repeats)", clock(s.remaining_ms), label, s.session),
        Status::Running => format!("Kairos · {} {} · {}/{}", clock(s.remaining_ms), label, s.session, s.sessions),
        Status::Paused => format!("Kairos · paused at {} ({})", clock(s.remaining_ms), label),
        Status::Waiting => format!("Kairos · {label} ready to start"),
        Status::Finished => "Kairos · all sessions done".into(),
    }
}

/// "3 of 4", or just "3" when the run repeats until stopped.
fn of(session: u32, total: u32) -> String {
    if total == u32::MAX {
        session.to_string()
    } else {
        format!("{session} of {total}")
    }
}

fn announce(app: &AppHandle, events: &[Event], snap: &Snapshot) {
    // A countdown's "count as focus" run: the countdown rings for it instead.
    let countdown_run = events.iter().any(|e| matches!(e, Event::RunFinished { .. })) && crate::countdown::owns_finished_run(app, snap);
    let events: Vec<Event> = if countdown_run { events.iter().filter(|e| !matches!(e, Event::RunFinished { .. })).cloned().collect() } else { events.to_vec() };
    let events = &events[..];
    play_chime(app, events, snap.sessions);
    let total = snap.sessions;
    for event in events {
        let message = match *event {
            Event::PhaseCompleted { phase: Phase::Focus, session, .. } if session < total => {
                let next = if snap.status == Status::Running && snap.phase.is_break() {
                    format!("{} started: {}.", phase_title(snap.phase), minutes(snap.duration_ms))
                } else {
                    "Your break is ready. Start it from Kairos when you are.".into()
                };
                Some((format!("Focus session {} complete", of(session, total)), next))
            }
            Event::PhaseCompleted { phase, session, .. } if phase.is_break() => {
                let next = if snap.status == Status::Running {
                    format!("Focus session {} started.", of(session + 1, total))
                } else {
                    format!("Start focus session {} when you're ready.", session + 1)
                };
                Some(("Break over".into(), next))
            }
            Event::RunFinished { sessions, .. } => Some((
                "All focus sessions done".into(),
                format!("You finished {sessions} of {sessions}. Nice work."),
            )),
            Event::Stopped { phase: Phase::Focus, elapsed_ms, .. } if snap.is_endless() => Some((
                "Focus session done".into(),
                format!("You focused for {}. Nice work.", minutes(elapsed_ms)),
            )),
            Event::Stopped { phase: Phase::Focus, session, elapsed_ms, .. } => Some((
                "Focus session interrupted".into(),
                format!("Session {session} of {total} stopped after {}.", minutes(elapsed_ms)),
            )),
            _ => None,
        };
        if let Some((title, body)) = message {
            let _ = app.notification().builder().title(title).body(body).show();
        }
    }
}

/// One chime per batch of events: the most important thing that just happened.
fn play_chime(app: &AppHandle, events: &[Event], total: u32) {
    let chime = events.iter().rev().find_map(|e| match *e {
        Event::RunFinished { .. } => Some(Chime::Finished),
        Event::PhaseCompleted { phase: Phase::Focus, session, .. } if session < total => Some(Chime::ToBreak),
        Event::PhaseCompleted { phase, .. } if phase.is_break() => Some(Chime::ToFocus),
        _ => None,
    });
    let Some(chime) = chime else { return };
    let (on, volume) = sound_settings(app);
    if on {
        let _ = sound::play(chime, volume);
    }
}

/// (sound on, volume 0–100). Defaults if the database is unavailable.
pub fn sound_settings(app: &AppHandle) -> (bool, u8) {
    app.state::<StoreState>()
        .with(|s| {
            let on: bool = settings::get(s, "timer.soundOn").map_err(|e| e.to_string())?;
            let volume: i64 = settings::get(s, "timer.volume").map_err(|e| e.to_string())?;
            Ok((on, volume.clamp(0, 100) as u8))
        })
        .unwrap_or((true, 60))
}

fn phase_label(p: Phase) -> &'static str {
    match p {
        Phase::Focus => "focus",
        Phase::ShortBreak => "short break",
        Phase::LongBreak => "long break",
    }
}

fn phase_title(p: Phase) -> &'static str {
    match p {
        Phase::Focus => "Focus",
        Phase::ShortBreak => "Short break",
        Phase::LongBreak => "Long break",
    }
}

fn clock(ms: u64) -> String {
    let s = ms.div_ceil(1000);
    if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else { format!("{}:{:02}", s / 60, s % 60) }
}

fn minutes(ms: u64) -> String {
    let m = ms / 60_000;
    match m {
        0 => format!("{}s", ms / 1000),
        1 => "1 minute".into(),
        60.. if m % 60 == 0 => format!("{} h", m / 60),
        60.. => format!("{} h {} min", m / 60, m % 60),
        _ => format!("{m} minutes"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_rounds_up_like_the_ui() {
        assert_eq!(clock(25 * 60_000), "25:00");
        assert_eq!(clock(1_472_001), "24:33");
        assert_eq!(clock(90 * 60_000), "1:30:00");
    }
}
