//! The Countdown on the "Stopwatch & countdown" page: count down from now to a clock time
//! (e.g. 1:55). It runs here in the native core, so it rings even when the window is hidden or
//! the page is closed, and it is saved to a small file so it survives a restart. When the time
//! comes: a Windows notification, the soft "finished" chime twice, and a `countdown-changed` event.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::sound::{self, Chime};
use crate::timer::now_ms;

/// Mirrored by `Countdown` in src/ipc/countdown.ts.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Countdown {
    /// When it rings (ms since 1970). None = no countdown set.
    pub at_ms: Option<u64>,
    /// When it was set, so the ring can show how much is left.
    pub set_ms: u64,
    /// The target time as the user sees it, e.g. "1:55 PM" (made by the window, in local time).
    pub label: String,
    /// Optional name, e.g. "Leave for class".
    pub name: String,
    /// It rang and has not been dismissed yet.
    pub done: bool,
    /// "Count as focus": a one-session focus run (blocking, stats, island, mini timer) was
    /// started with it and lasts until the countdown's time.
    pub focus: bool,
}

/// The name the focus run gets, so it can be recognised later (and shows in stats and history).
pub fn focus_name(c: &Countdown) -> String {
    if c.name.trim().is_empty() {
        format!("Countdown to {}", c.label)
    } else {
        c.name.trim().to_string()
    }
}

/// True while the focus timer is running the focus that this countdown started.
fn runs_our_focus(app: &AppHandle, c: &Countdown) -> Option<focus_timer::Snapshot> {
    if !c.focus {
        return None;
    }
    let snap = app.state::<crate::timer::TimerState>().0.lock().ok().map(|t| (t.is_active(), t.snapshot(now_ms())))?;
    let (active, snap) = snap;
    (active && snap.preset_id.is_none() && snap.preset_name.as_deref() == Some(focus_name(c).as_str())).then_some(snap)
}

/// The timer's own "all sessions done" chime and notification are skipped for a countdown's
/// focus, because the countdown rings for it.
pub fn owns_finished_run(app: &AppHandle, snap: &focus_timer::Snapshot) -> bool {
    let state = app.state::<CountdownState>();
    let Ok(c) = state.0.lock() else { return false };
    c.focus && (c.at_ms.is_some() || c.done) && snap.preset_id.is_none() && snap.preset_name.as_deref() == Some(focus_name(&c).as_str())
}

fn stop_our_focus(app: &AppHandle, c: &Countdown, only_if_behind: bool) {
    let Some(snap) = runs_our_focus(app, c) else { return };
    // On time it ends by itself a moment later; stop it here only if it was paused and fell behind.
    if only_if_behind && snap.status == focus_timer::Status::Running && snap.remaining_ms <= 3_000 {
        return;
    }
    let _ = crate::timer::act(app, |t, now| t.stop(now).map_err(|e| e.to_string()));
}

pub struct CountdownState(Mutex<Countdown>);

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("countdown.json"))
}

impl CountdownState {
    pub fn load(app: &AppHandle) -> Self {
        let saved = file(app)
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|b| serde_json::from_slice::<Countdown>(&b).ok())
            .unwrap_or_default();
        CountdownState(Mutex::new(saved))
    }
}

fn save(app: &AppHandle, c: &Countdown) {
    if let Some(f) = file(app) {
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec(c) {
            let _ = std::fs::write(f, json);
        }
    }
}

fn change(app: &AppHandle, f: impl FnOnce(&mut Countdown)) -> Result<Countdown, String> {
    let state = app.state::<CountdownState>();
    let mut c = state.0.lock().map_err(|_| "the countdown is unavailable")?;
    f(&mut c);
    save(app, &c);
    let snap = c.clone();
    drop(c);
    let _ = app.emit("countdown-changed", &snap);
    Ok(snap)
}

/// Checks twice a second against the wall clock, so it still rings on time after the PC sleeps.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let due = {
            let state = app.state::<CountdownState>();
            let Ok(c) = state.0.lock() else { return };
            c.at_ms.filter(|&at| now_ms() >= at)
        };
        if let Some(at) = due {
            // More than 5 minutes late means Focus was closed then: say so, quietly.
            ring(&app, now_ms().saturating_sub(at) > 5 * 60_000);
        }
    });
}

fn ring(app: &AppHandle, missed: bool) {
    let Ok(c) = change(app, |c| {
        c.at_ms = None;
        c.done = true;
    }) else {
        return;
    };
    // "Count as focus" ends with the countdown, even if the focus was paused along the way.
    stop_our_focus(app, &c, true);
    let body = if c.name.trim().is_empty() {
        format!("It's {}.", c.label)
    } else {
        format!("{} · {}", c.name.trim(), c.label)
    };
    let title = if missed { "Countdown ended while Kairos was closed" } else { "Time's up" };
    let _ = app.notification().builder().title(title).body(body).show();
    if missed {
        return;
    }
    let (_, volume) = crate::timer::sound_settings(app);
    // Twice, a few seconds apart, so it is hard to miss but still gentle.
    std::thread::spawn(move || {
        let _ = sound::play(Chime::Finished, volume.max(20));
        std::thread::sleep(Duration::from_millis(4500));
        let _ = sound::play(Chime::Finished, volume.max(20));
    });
}

#[tauri::command]
pub fn countdown_get(app: AppHandle) -> Result<Countdown, String> {
    let state = app.state::<CountdownState>();
    let c = state.0.lock().map_err(|_| "the countdown is unavailable")?;
    Ok(c.clone())
}

#[tauri::command]
pub fn countdown_start(app: AppHandle, at_ms: u64, label: String, name: String, focus: Option<bool>) -> Result<Countdown, String> {
    let now = now_ms();
    if at_ms <= now {
        return Err("That time has already passed.".into());
    }
    let focus = focus.unwrap_or(false);
    let next = Countdown { at_ms: Some(at_ms), set_ms: now, label, name: name.chars().take(80).collect(), done: false, focus };
    if focus {
        start_focus(&app, &next, at_ms - now)?;
    }
    change(&app, |c| *c = next)
}

/// One focus session that lasts until the countdown's time: no breaks, named after the countdown.
fn start_focus(app: &AppHandle, c: &Countdown, ms: u64) -> Result<(), String> {
    if app.state::<crate::timer::TimerState>().0.lock().map(|t| t.is_active()).unwrap_or(true) {
        return Err("A focus session is already running. Stop it first, or untick \"Count as focus\".".into());
    }
    if ms < 60_000 {
        return Err("To count as focus, the countdown must be at least 1 minute long.".into());
    }
    let plan = focus_timer::Plan {
        preset_id: None,
        preset_name: focus_name(c),
        // Just under a day: a full day would read as an endless focus.
        focus_ms: ms.min(focus_timer::ENDLESS_FOCUS_MS - 1000),
        short_break_ms: 0,
        long_break_ms: 0,
        sessions: 1,
        long_break_every: 0,
        auto_start_break: false,
        auto_start_focus: false,
    };
    if let Ok(mut rec) = app.state::<crate::history::RecordState>().0.lock() {
        rec.deadline_id = None;
    }
    crate::timer::act(app, |t, now| t.start(plan, now).map_err(|e| e.to_string())).map(|_| ())
}

#[tauri::command]
pub fn countdown_cancel(app: AppHandle) -> Result<Countdown, String> {
    let before = countdown_get(app.clone())?;
    // Cancelling also ends the focus it started.
    stop_our_focus(&app, &before, false);
    change(&app, |c| {
        c.at_ms = None;
        c.done = false;
        c.focus = false;
    })
}

#[tauri::command]
pub fn countdown_dismiss(app: AppHandle) -> Result<Countdown, String> {
    change(&app, |c| c.done = false)
}
