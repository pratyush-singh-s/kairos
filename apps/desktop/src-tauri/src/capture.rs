//! Quick capture: Ctrl+Shift+Space anywhere in Windows opens a small box on top of everything.
//! One line becomes a to-do for today, or a note when it starts with "n " (focus_store::capture,
//! the same rules as the launcher's "+").

use focus_store::capture::{self, Captured};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

use crate::state::StoreState;

const LABEL: &str = "capture";

/// The quick capture hotkey.
pub fn shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space)
}

/// The global-shortcut plugin, opening the box when the hotkey is pressed.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, sc, event| {
            if event.state() == ShortcutState::Pressed && *sc == shortcut() {
                show(app);
            }
        })
        .build()
}

/// Registers the hotkey. Another program may already own it; Focus then simply goes without.
pub fn register(app: &AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if let Err(e) = app.global_shortcut().register(shortcut()) {
        eprintln!("focus: quick capture hotkey unavailable: {e}");
    }
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit_to(LABEL, "capture-shown", ());
        return;
    }
    let built = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("index.html#capture".into()))
        .title("Quick add")
        .inner_size(460.0, 150.0)
        .resizable(false)
        .always_on_top(true)
        .decorations(false)
        .shadow(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        .build();
    if let Err(e) = built {
        eprintln!("focus: could not open quick capture: {e}");
    }
}

#[tauri::command]
pub fn quick_capture(app: AppHandle, state: tauri::State<'_, StoreState>, line: String, today: String) -> Result<Captured, String> {
    let c = state.with(|s| capture::capture(s, &line, &today).map_err(|e| e.to_string()))?;
    let _ = app.emit(if c.kind == "note" { "notes-changed" } else { "tasks-changed" }, ());
    Ok(c)
}
