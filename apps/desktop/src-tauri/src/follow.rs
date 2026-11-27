//! One focus session everywhere, and scheduled focus.
//!
//! - The phone (or the Focus launcher through it) shares its own focus as the synced setting
//!   `focus.livePhone`. While this PC's timer has no focus phase on, the browsers and blocked
//!   Windows programs follow the phone's instead (`combined`).
//! - Either device can pause, resume, skip or stop the other's timer (`focus_store::remote`):
//!   the phone's commands for this PC are applied here, on the ticker's read.
//! - Scheduled focus (`focus_store::schedule`): when a window opens and the timer is idle, a
//!   session that lasts until the window's end starts on its own. Stopping it early skips that
//!   window on every device.
//!
//! The database is read at most every few seconds; the ticker asks four times a second.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use focus_store::{phone_block, phone_focus, remote, schedule};
use focus_timer::{Event, Plan, Snapshot, Status};
use tauri::{AppHandle, Manager};

use crate::bridge::FocusState;
use crate::state::StoreState;

const CHECK_EVERY: Duration = Duration::from_secs(5);

#[derive(Default)]
struct Inner {
    checked: Option<Instant>,
    /// The phone's focus while it blocks.
    phone: Option<FocusState>,
    /// The phone's timer while it runs (breaks too), for the Timer page.
    phone_clock: Option<phone_block::FocusLive>,
    /// The scheduled window the running session was started for.
    scheduled: Option<String>,
    /// A "block only" schedule open now: blocking on, no timer session.
    block: Option<FocusState>,
}

#[derive(Default)]
pub struct FollowState(Mutex<Inner>);

/// What the browsers and program blocking follow: this PC's focus phase, else the phone's.
pub fn combined(app: &AppHandle, own: FocusState) -> FocusState {
    if own.active {
        return own;
    }
    let (block, phone) = app.state::<FollowState>().0.lock().ok().map(|f| (f.block.clone(), f.phone.clone())).unwrap_or_default();
    block.or(phone).unwrap_or(own)
}

/// The phone's focus phase is on (for program blocking).
pub fn phone_focusing(app: &AppHandle) -> bool {
    app.state::<FollowState>()
        .0
        .lock()
        .ok()
        .map(|f| f.block.is_some() || f.phone.as_ref().is_some_and(|p| p.active))
        .unwrap_or(false)
}

/// Called by the ticker on every tick. Refreshes the phone's state, and starts a scheduled
/// session when one is due (returns true when it did, so the ticker refreshes the window).
pub fn tick(app: &AppHandle, snap: &Snapshot, now: u64) -> bool {
    let follow = app.state::<FollowState>();
    {
        let Ok(mut f) = follow.0.lock() else { return false };
        if f.checked.is_some_and(|t| t.elapsed() < CHECK_EVERY) {
            return false;
        }
        f.checked = Some(Instant::now());
    }
    crate::planning::maybe_remind(app);
    let read = app.state::<StoreState>().with(|s| {
        let phone = phone_focus::phone_live(s).map_err(|e| e.to_string())?;
        let window = schedule::current(s, now).map_err(|e| e.to_string())?;
        let command = remote::take(s, now).map_err(|e| e.to_string())?;
        Ok((phone, window, command))
    });
    let Ok((phone, window, command)) = read else { return false };
    // Pause, Resume, Skip or Stop pressed on the phone for this PC's timer.
    if let Some(action) = command {
        let _ = apply(app, &action);
    }
    let phone_clock = phone.clone().filter(|l| l.showing_at(now));
    let phone = phone.filter(|l| l.blocks_at(now)).map(|l| FocusState {
        active: true,
        paused: l.paused,
        ends_at_ms: if l.paused { None } else { l.ends_at_ms },
        preset_name: l.preset_name.or(Some("Phone".into())),
    });
    let idle = matches!(snap.status, Status::Idle | Status::Finished);
    let block = window.as_ref().filter(|w| w.kind == "block" && w.ends_at_ms > now).map(|w| FocusState {
        active: true,
        paused: false,
        ends_at_ms: Some(w.ends_at_ms),
        preset_name: Some(w.name.clone()),
    });
    let due = window.filter(|w| w.kind != "block" && idle && w.ends_at_ms > now + 60_000);
    {
        let Ok(mut f) = follow.0.lock() else { return false };
        f.phone = phone;
        f.block = block;
        f.phone_clock = phone_clock;
        if idle {
            f.scheduled = None;
        }
    }
    let Some(w) = due else { return false };
    let plan = Plan {
        preset_id: None,
        preset_name: w.name.clone(),
        focus_ms: w.ends_at_ms - now,
        short_break_ms: 0,
        long_break_ms: 0,
        sessions: 1,
        long_break_every: 0,
        auto_start_break: false,
        auto_start_focus: false,
    };
    if crate::timer::act(app, |t, now| t.start(plan, now).map_err(|e| e.to_string())).is_ok() {
        if let Ok(mut f) = follow.0.lock() {
            f.scheduled = Some(w.key);
        }
        return true;
    }
    false
}

/// After timer events: a scheduled session stopped by hand skips its window everywhere.
pub fn after_events(app: &AppHandle, events: &[Event]) {
    if !events.iter().any(|e| matches!(e, Event::Stopped { .. })) {
        return;
    }
    let key = app.state::<FollowState>().0.lock().ok().and_then(|mut f| f.scheduled.take());
    if let Some(key) = key {
        if let Err(e) = app.state::<StoreState>().with(|s| schedule::skip(s, &key).map_err(|e| e.to_string())) {
            eprintln!("focus: could not skip the scheduled focus: {e}");
        }
    }
}

/// Mirrored by `ScheduleView` in src/ipc/schedule.ts.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleView {
    schedules: Vec<schedule::Schedule>,
    /// The window open now (not skipped), if any.
    current: Option<schedule::Window>,
}

fn schedule_view(store: &focus_store::Store) -> Result<ScheduleView, String> {
    Ok(ScheduleView {
        schedules: schedule::list(store).map_err(|e| e.to_string())?,
        current: schedule::current(store, crate::timer::now_ms()).map_err(|e| e.to_string())?,
    })
}

#[tauri::command]
pub fn get_schedules(state: tauri::State<'_, StoreState>) -> Result<ScheduleView, String> {
    state.with(|s| schedule_view(s))
}

#[tauri::command]
pub fn save_schedules(app: AppHandle, state: tauri::State<'_, StoreState>, schedules: Vec<schedule::Schedule>) -> Result<ScheduleView, String> {
    let v = state.with(|s| {
        schedule::save(s, &schedules).map_err(|e| e.to_string())?;
        schedule_view(s)
    })?;
    // Look again at once rather than in a few seconds.
    if let Ok(mut f) = app.state::<FollowState>().0.lock() {
        f.checked = None;
    }
    Ok(v)
}

#[tauri::command]
pub fn goal_status(state: tauri::State<'_, StoreState>) -> Result<focus_store::goals::GoalStatus, String> {
    state.with(|s| focus_store::goals::status(s, crate::timer::now_ms()).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn set_daily_goal(state: tauri::State<'_, StoreState>, minutes: u32) -> Result<focus_store::goals::GoalStatus, String> {
    state.with(|s| {
        focus_store::goals::set_goal_minutes(s, minutes).map_err(|e| e.to_string())?;
        focus_store::goals::status(s, crate::timer::now_ms()).map_err(|e| e.to_string())
    })
}

/// A timer action for this PC's timer, sent from another device.
fn apply(app: &AppHandle, action: &str) -> Result<focus_timer::Snapshot, String> {
    crate::timer::act(app, |t, now| match action {
        "pause" => t.pause(now).map(|()| Vec::new()).map_err(|e| e.to_string()),
        "resume" => t.resume(now).map(|()| Vec::new()).map_err(|e| e.to_string()),
        "skip" => t.skip(now).map_err(|e| e.to_string()),
        "stop" => t.stop(now).map_err(|e| e.to_string()),
        _ => Err(format!("unknown timer action {action:?}")),
    })
}

/// The phone's timer while it runs (breaks too), for the Timer page.
#[tauri::command]
pub fn phone_focus_state(app: AppHandle) -> Option<phone_block::FocusLive> {
    app.state::<FollowState>().0.lock().ok().and_then(|f| f.phone_clock.clone())
}

/// Pause, Resume, Skip or Stop for the timer on the phone: sent through sync, so it lands a
/// few seconds later (when the phone has Focus open, or its blocking service is on).
#[tauri::command]
pub fn phone_timer_action(app: AppHandle, state: tauri::State<'_, StoreState>, action: String) -> Result<(), String> {
    let target = app
        .state::<FollowState>()
        .0
        .lock()
        .ok()
        .and_then(|f| f.phone_clock.as_ref().and_then(|l| l.clock.as_ref().map(|c| c.device_id.clone())))
        .ok_or("The phone's timer isn't running.")?;
    state.with(|s| remote::send(s, &target, &action, crate::timer::now_ms()).map_err(|e| e.to_string()))?;
    crate::sync::sync_soon(&app);
    Ok(())
}
