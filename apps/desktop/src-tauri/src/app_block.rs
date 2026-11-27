//! App blocking: programs on the Blocking page can't be used during a focus phase (running or
//! paused, the same as the browsers). When one comes to the front its window is sent down to
//! the taskbar and a small Focus window says it is blocked. "Wait" programs can be used after a
//! countdown until the phase ends; "Full block" ones not until the break. Windows essentials
//! (File Explorer, Task Manager, Settings, Focus itself; `blocking::PROTECTED_APPS`) are never
//! blocked, so you can always get out.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use focus_store::blocking::{self, AppMode, AppRule};
use focus_store::stats::DistractionKind;
use focus_timer::{Phase, Status};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::StoreState;
use crate::timer::{TimerState, now_ms};
use crate::winapps::{self, Window};

const TICK_MS: u64 = 400;
const LABEL: &str = "appblock";
const WINDOW_W: f64 = 460.0;
const WINDOW_H: f64 = 400.0;

/// The program blocked most recently in this focus phase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocked {
    pub exe: String,
    pub name: String,
    pub mode: AppMode,
    pub wait_seconds: u32,
    /// When it was first blocked; the countdown runs from here, so reopening it doesn't restart it.
    pub since_ms: u64,
    #[serde(skip)]
    pub hwnd: isize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    Nothing,
    /// Minimize this window and show the blocked screen. `first` = a new program (count it).
    Block { hwnd: isize, first: bool },
    /// The focus phase ended: close the blocked screen.
    Ended,
}

/// Decides, once a tick, what to do. Kept free of Windows calls so it can be tested anywhere.
#[derive(Default)]
pub struct Gate {
    /// Programs let through after their countdown, until the phase ends.
    allowed: HashSet<String>,
    pub current: Option<Blocked>,
    active: bool,
}

impl Gate {
    pub fn step(&mut self, now: u64, focusing: bool, front: Option<&Window>, rules: &[AppRule]) -> Step {
        if !focusing {
            let was = std::mem::replace(&mut self.active, false);
            self.allowed.clear();
            return if was && self.current.take().is_some() { Step::Ended } else { Step::Nothing };
        }
        self.active = true;
        let Some(w) = front else { return Step::Nothing };
        let exe = w.exe.to_ascii_lowercase();
        if blocking::is_protected(&exe) || self.allowed.contains(&exe) {
            return Step::Nothing;
        }
        let Some(rule) = rules.iter().find(|r| r.exe == exe) else { return Step::Nothing };
        let first = match &mut self.current {
            Some(c) if c.exe == exe => {
                c.hwnd = w.hwnd;
                c.mode = rule.mode;
                c.wait_seconds = rule.wait_seconds;
                false
            }
            _ => {
                self.current = Some(Blocked {
                    exe,
                    name: rule.name.clone(),
                    mode: rule.mode,
                    wait_seconds: rule.wait_seconds,
                    since_ms: now,
                    hwnd: w.hwnd,
                });
                true
            }
        };
        Step::Block { hwnd: w.hwnd, first }
    }

    /// "Continue" on the blocked screen: allowed once a "Wait" program's countdown is over.
    /// Returns the window to bring back.
    pub fn let_through(&mut self, now: u64) -> Result<isize, String> {
        let c = self.current.as_ref().ok_or("nothing is blocked right now")?;
        if c.mode != AppMode::Wait {
            return Err(format!("{} is blocked until your break", c.name));
        }
        // Half a second of slack for the screen's own clock.
        if now + 500 < c.since_ms + c.wait_seconds as u64 * 1000 {
            return Err("the countdown isn't over yet".into());
        }
        let c = self.current.take().expect("checked above");
        self.allowed.insert(c.exe);
        Ok(c.hwnd)
    }
}

pub struct AppBlockState(pub Mutex<Gate>);

impl AppBlockState {
    pub fn new() -> Self {
        AppBlockState(Mutex::new(Gate::default()))
    }
}

/// Focus phase running or paused: the same rule the browsers follow.
fn focusing(app: &AppHandle, now: u64) -> bool {
    app.state::<TimerState>()
        .0
        .lock()
        .map(|t| {
            let s = t.snapshot(now);
            s.phase == Phase::Focus && matches!(s.status, Status::Running | Status::Paused)
        })
        .unwrap_or(false)
        || crate::follow::phone_focusing(app)
}

fn read_rules(app: &AppHandle) -> Vec<AppRule> {
    app.state::<StoreState>().with(|s| blocking::get_apps(s).map_err(|e| e.to_string())).unwrap_or_default()
}

/// Starts the watcher thread.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(TICK_MS));
            let now = now_ms();
            let on = focusing(&app, now);
            let (rules, front) = if on { (read_rules(&app), winapps::foreground()) } else { (Vec::new(), None) };
            let step = match app.state::<AppBlockState>().0.lock() {
                Ok(mut g) => g.step(now, on, front.as_ref(), &rules),
                Err(_) => continue,
            };
            match step {
                Step::Nothing => {}
                Step::Block { hwnd, first } => {
                    winapps::minimize(hwnd);
                    show_screen(&app);
                    let _ = app.emit("app-blocked", ());
                    if first {
                        let name = app.state::<AppBlockState>().0.lock().ok().and_then(|g| g.current.as_ref().map(|c| c.name.clone()));
                        crate::bridge::record_distraction(&app, DistractionKind::BlockedHit, name.map(|n| format!("{n} (app)")));
                    }
                }
                Step::Ended => close_screen(&app),
            }
        }
    });
}

fn show_screen(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("index.html#appblock".into()))
        .title("Blocked during focus")
        .inner_size(WINDOW_W, WINDOW_H)
        .resizable(false)
        .always_on_top(true)
        .decorations(false)
        .shadow(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        .build();
    if let Err(e) = built {
        eprintln!("focus: could not show the blocked screen: {e}");
    }
}

fn close_screen(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
}

/// The Blocking page's programs, and the ones that can never be blocked.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBlocking {
    pub apps: Vec<AppRule>,
    pub protected: Vec<&'static str>,
}

#[tauri::command]
pub fn get_app_blocking(state: tauri::State<'_, StoreState>) -> Result<AppBlocking, String> {
    let apps = state.with(|s| blocking::get_apps(s).map_err(|e| e.to_string()))?;
    Ok(AppBlocking { apps, protected: blocking::PROTECTED_APPS.to_vec() })
}

#[tauri::command]
pub fn save_app_blocking(app: AppHandle, state: tauri::State<'_, StoreState>, apps: Vec<AppRule>) -> Result<Vec<AppRule>, String> {
    let kept = state.with(|s| blocking::save_apps(s, apps).map_err(|e| e.to_string()))?;
    let _ = app.emit("blocking-changed", ());
    Ok(kept)
}

/// A program the picker offers: open now, or seen by App tracking.
#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppChoice {
    pub exe: String,
    pub name: String,
    pub open: bool,
}

#[tauri::command]
pub fn list_app_choices(state: tauri::State<'_, StoreState>) -> Vec<AppChoice> {
    let known = state.with(|s| focus_store::activity::known_apps(s, 200).map_err(|e| e.to_string())).unwrap_or_default();
    let open: Vec<String> = winapps::open_windows().into_iter().map(|w| w.exe).collect();
    choices(&open, known.iter().map(|k| (k.exe.as_str(), k.name.as_str())))
}

/// Open programs first, then tracked ones; no repeats and nothing protected.
fn choices<'a>(open: &[String], known: impl Iterator<Item = (&'a str, &'a str)>) -> Vec<AppChoice> {
    let mut out: Vec<AppChoice> = Vec::new();
    let mut add = |exe: &str, name: Option<&str>, is_open: bool| {
        let Some(e) = blocking::normalize_exe(exe) else { return };
        if blocking::is_protected(&e) || out.iter().any(|c| c.exe == e) {
            return;
        }
        let name = name.map(str::to_string).unwrap_or_else(|| crate::tracking::display_name(exe));
        out.push(AppChoice { exe: e, name, open: is_open });
    };
    for exe in open {
        add(exe, None, true);
    }
    for (exe, name) in known {
        add(exe, Some(name), false);
    }
    out
}

/// "Browse…": asks for a program file. None if the dialog is closed; an error for a protected one.
#[tauri::command]
pub async fn pick_app_exe(app: AppHandle) -> Result<Option<AppChoice>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let picked = app.dialog().file().set_title("Choose a program to block").add_filter("Programs", &["exe"]).blocking_pick_file();
        let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
        let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let exe = blocking::normalize_exe(&file).ok_or("that isn't a program file")?;
        if blocking::is_protected(&exe) {
            return Err(format!("{} can't be blocked: Windows needs it", crate::tracking::display_name(&file)));
        }
        Ok(Some(AppChoice { exe, name: crate::tracking::display_name(&file), open: false }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What the blocked screen shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedView {
    #[serde(flatten)]
    pub blocked: Blocked,
    pub now_ms: u64,
}

#[tauri::command]
pub fn app_block_current(state: tauri::State<'_, AppBlockState>) -> Option<BlockedView> {
    let g = state.0.lock().ok()?;
    g.current.clone().map(|blocked| BlockedView { blocked, now_ms: now_ms() })
}

#[tauri::command]
pub fn app_block_continue(app: AppHandle, state: tauri::State<'_, AppBlockState>, reason: Option<String>) -> Result<(), String> {
    let (hwnd, name) = {
        let mut g = state.0.lock().map_err(|_| "internal error".to_string())?;
        let name = g.current.as_ref().map(|b| b.name.clone()).unwrap_or_default();
        (g.let_through(now_ms())?, name)
    };
    crate::bridge::record_distraction(&app, DistractionKind::Continued, None);
    if let Some(text) = reason.filter(|t| !t.trim().is_empty()) {
        crate::bridge::record_reason(&app, &text, &name);
    }
    close_screen(&app);
    winapps::restore(hwnd);
    Ok(())
}

/// "Back to Focus": closes the blocked screen and opens the main window.
#[tauri::command]
pub fn app_block_back(app: AppHandle) {
    close_screen(&app);
    crate::tray::show_main_window(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(exe: &str, mode: AppMode) -> AppRule {
        AppRule { exe: exe.into(), name: exe.trim_end_matches(".exe").into(), mode, wait_seconds: 10 }
    }

    fn win(exe: &str) -> Window {
        Window { hwnd: 7, exe: exe.into() }
    }

    #[test]
    fn listed_programs_are_blocked_only_during_focus() {
        let rules = [rule("discord.exe", AppMode::Block)];
        let mut g = Gate::default();
        assert_eq!(g.step(0, false, Some(&win("Discord.exe")), &rules), Step::Nothing);
        assert_eq!(g.step(1, true, Some(&win("Discord.exe")), &rules), Step::Block { hwnd: 7, first: true });
        assert_eq!(g.step(2, true, Some(&win("Discord.exe")), &rules), Step::Block { hwnd: 7, first: false });
        assert_eq!(g.step(3, true, Some(&win("Code.exe")), &rules), Step::Nothing);
        assert!(g.let_through(1_000_000).is_err(), "full block has no way through");
        assert_eq!(g.step(4, false, None, &rules), Step::Ended);
        assert_eq!(g.step(5, false, None, &rules), Step::Nothing);
    }

    #[test]
    fn essentials_are_never_blocked_even_if_listed() {
        let rules = [rule("explorer.exe", AppMode::Block), rule("taskmgr.exe", AppMode::Block)];
        let mut g = Gate::default();
        assert_eq!(g.step(0, true, Some(&win("explorer.exe")), &rules), Step::Nothing);
        assert_eq!(g.step(0, true, Some(&win("Taskmgr.exe")), &rules), Step::Nothing);
    }

    #[test]
    fn wait_lets_through_after_the_countdown_until_the_phase_ends() {
        let rules = [rule("steam.exe", AppMode::Wait)];
        let mut g = Gate::default();
        g.step(1_000, true, Some(&win("steam.exe")), &rules);
        assert!(g.let_through(5_000).is_err(), "too early");
        // Coming back to it doesn't restart the countdown.
        g.step(6_000, true, Some(&win("steam.exe")), &rules);
        assert_eq!(g.let_through(11_000), Ok(7));
        assert_eq!(g.step(12_000, true, Some(&win("steam.exe")), &rules), Step::Nothing);
        // A break, then the next focus phase blocks it again.
        g.step(13_000, false, None, &rules);
        assert_eq!(g.step(14_000, true, Some(&win("steam.exe")), &rules), Step::Block { hwnd: 7, first: true });
    }

    #[test]
    fn the_picker_lists_open_programs_first_without_essentials() {
        let open = vec!["Discord.exe".to_string(), "explorer.exe".to_string(), "Discord.exe".to_string()];
        let c = choices(&open, [("discord.exe", "Discord"), ("Spotify.exe", "Spotify"), ("Taskmgr.exe", "Task Manager")].into_iter());
        let exes: Vec<_> = c.iter().map(|x| (x.exe.as_str(), x.open)).collect();
        assert_eq!(exes, [("discord.exe", true), ("spotify.exe", false)]);
        assert_eq!(c[0].name, "Discord");
    }
}
