//! System tray icon and close-to-tray behaviour.

use focus_store::settings;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::Emitter;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::state::StoreState;

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Kairos", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Kairos", true, None::<&str>)?;
    // Real glass is kept out of screen captures; recording mode swaps it for Blur so they show Focus.
    let rec = CheckMenuItem::with_id(app, "recording", "Recording mode (show Kairos in recordings)", true, false, None::<&str>)?;
    let _ = app.manage(RecordingItem(rec.clone()));
    let menu = Menu::with_items(app, &[&open, &rec, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Kairos")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            "recording" => set_recording(app, !RECORDING.load(Ordering::Relaxed)),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Reads the setting; if the database is unavailable, quit normally rather than hide.
pub fn close_to_tray_enabled(app: &AppHandle) -> bool {
    app.state::<StoreState>().with(|s| settings::get::<bool>(s, "window.closeToTray").map_err(|e| e.to_string())).unwrap_or(false)
}

pub fn hide_to_tray(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    // Tell the user once, so a hidden window never looks like a crash.
    let state = app.state::<StoreState>();
    let first_time = state
        .with(|s| settings::get::<bool>(s, "window.trayNoticeShown").map_err(|e| e.to_string()))
        .map(|shown| !shown)
        .unwrap_or(false);
    if first_time {
        let shown = app
            .notification()
            .builder()
            .title("Kairos is still running")
            .body("It's in the system tray. Right-click the Kairos icon there to quit.")
            .show();
        if shown.is_ok() {
            let _ = state.with(|s| settings::set(s, "window.trayNoticeShown", &true).map_err(|e| e.to_string()));
        }
    }
}

/// Recording mode: every window draws Blur instead of Real glass, so captures can see Focus.
/// Not saved: it is off again after a restart.
static RECORDING: AtomicBool = AtomicBool::new(false);

struct RecordingItem(CheckMenuItem<tauri::Wry>);

fn set_recording(app: &AppHandle, on: bool) {
    RECORDING.store(on, Ordering::Relaxed);
    if let Some(item) = app.try_state::<RecordingItem>() {
        let _ = item.0.set_checked(on);
    }
    let _ = app.emit("recording-mode", on);
}

#[tauri::command]
pub fn get_recording_mode() -> bool {
    RECORDING.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_recording_mode(app: AppHandle, on: bool) {
    set_recording(&app, on);
}
