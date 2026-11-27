//! "Start with Windows": a value under HKCU\...\Run that opens the app hidden in the tray at
//! sign-in. "PC on" in Statistics is counted by the running app (`uptime`), so without this the
//! time before the app is opened is missing.

use tauri::{AppHandle, Manager};

use crate::state::StoreState;
use focus_store::settings;

/// Passed by the Run entry: start in the tray without showing the window.
pub const HIDDEN_ARG: &str = "--hidden";

#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// Run value names. "Focus" is the app's old name; its entry is removed so it can't start twice.
#[cfg(windows)]
const NAME: &str = "Kairos";
#[cfg(windows)]
const OLD_NAMES: &[&str] = &["Focus"];

pub fn enabled(app: &AppHandle) -> bool {
    app.state::<StoreState>().with(|s| settings::get::<bool>(s, "window.startWithWindows").map_err(|e| e.to_string())).unwrap_or(true)
}

/// Makes the Run entry match the setting (and point at this exe, in case it moved).
pub fn sync(app: &AppHandle) {
    apply(enabled(app));
}

#[cfg(windows)]
pub fn apply(on: bool) {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, REG_SZ, RegDeleteKeyValueW, RegSetKeyValueW};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let key = wide(RUN_KEY);
    unsafe {
        for old in OLD_NAMES {
            let name = wide(old);
            RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr());
        }
        let name = wide(NAME);
        if on {
            let Ok(exe) = std::env::current_exe() else { return };
            let cmd = wide(&format!("\"{}\" {HIDDEN_ARG}", exe.display()));
            RegSetKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), REG_SZ, cmd.as_ptr().cast(), (cmd.len() * 2) as u32);
        } else {
            RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr());
        }
    }
}

#[cfg(not(windows))]
pub fn apply(_on: bool) {}

#[tauri::command]
pub fn get_start_with_windows(app: AppHandle) -> bool {
    enabled(&app)
}

#[tauri::command]
pub fn set_start_with_windows(app: AppHandle, enabled: bool) -> Result<(), String> {
    app.state::<StoreState>().with(|s| settings::set(s, "window.startWithWindows", &enabled).map_err(|e| e.to_string()))?;
    apply(enabled);
    Ok(())
}
