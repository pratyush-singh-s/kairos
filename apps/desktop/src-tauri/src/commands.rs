use focus_store::StoreStatus;
use focus_store::dashboard::{self, Dashboard};
use focus_store::presets::{self, Preset, PresetInput};
use focus_store::sessions::{self, SessionRow};
use focus_store::deadlines::{self, Deadline, DeadlineInput};
use focus_store::notes::{self, Note, NoteSummary};
use focus_store::boards::{self, BoardItem, BoardItemInput};
use focus_store::spaces::{self, Space, SpaceInput};
use focus_store::tasks::{self, Task, TaskInput};
use focus_timer::Snapshot;
use focus_store::settings;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::StoreState;
use crate::timer::{self, TimerState};

/// Basic facts about this install, shown on the setup screen.
/// Mirrored by `AppInfo` in src/ipc/appInfo.ts.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    tauri_version: String,
    os: String,
    arch: String,
    data_dir: String,
}

/// The version shown in Settings, e.g. "0.21.4.B": a letter per look of the same release line (A = the
/// original, B = the terminal window). Windows and the installer still use the plain semver in
/// tauri.conf.json, which must go up for an in-place upgrade.
pub const RELEASE_LABEL: &str = include_str!("../RELEASE_LABEL");

#[tauri::command]
pub fn app_info(app: AppHandle) -> Result<AppInfo, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the data folder: {e}"))?;

    Ok(AppInfo {
        version: RELEASE_LABEL.trim().to_string(),
        tauri_version: tauri::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        data_dir: data_dir.display().to_string(),
    })
}

#[tauri::command]
pub fn db_status(state: tauri::State<'_, StoreState>) -> Result<StoreStatus, String> {
    state.with(|store| store.status().map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn list_presets(state: tauri::State<'_, StoreState>) -> Result<Vec<Preset>, String> {
    state.with(|store| presets::list(store.conn()).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn load_dashboard(
    state: tauri::State<'_, StoreState>,
    now_ms: i64,
    day_start_ms: i64,
    day_end_ms: i64,
    today: String,
) -> Result<Dashboard, String> {
    state.with(|store| dashboard::load(store, now_ms, day_start_ms, day_end_ms, &today).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn get_close_to_tray(state: tauri::State<'_, StoreState>) -> Result<bool, String> {
    state.with(|store| settings::get(store, "window.closeToTray").map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn set_close_to_tray(state: tauri::State<'_, StoreState>, enabled: bool) -> Result<(), String> {
    state.with(|store| settings::set(store, "window.closeToTray", &enabled).map_err(|e| e.to_string()))
}

/// Appearance settings, read in one go at start-up. Mirrored by `UiSettings` in src/ipc/ui.ts.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSettings {
    theme: String,
    backdrop: String,
    sidebar_collapsed: bool,
    /// "full", "icons" or "hidden".
    sidebar_mode: String,
    title_bar: String,
    /// 0–100 per theme. Blur 0 = no blur; transparency 0 = solid.
    glass_blur: i64,
    glass_transparency: i64,
    terminal_blur: i64,
    terminal_transparency: i64,
    /// Windows blurs the windows behind Focus (Acrylic); false = they show through sharp.
    glass_windows_blur: bool,
    terminal_windows_blur: bool,
    /// Mini timer background: "lens" (real glass) or "blur".
    mini_glass: String,
    /// Colour palette id per theme; "" = the theme's own colours. Unknown ids fall back in the UI.
    glass_palette: String,
    terminal_palette: String,
    /// Your own colours per theme ({"bg", "text", "accent"}); null = not made yet.
    glass_custom: serde_json::Value,
    terminal_custom: serde_json::Value,
    /// Terminal theme: whose prompt is drawn ("powershell", "bash", "cmd") and the CRT look.
    terminal_shell: String,
    terminal_crt: bool,
    terminal_ascii: bool,
    terminal_crt_sound: bool,
    /// Terminal theme layout: "classic", "app" or "shell".
    terminal_style: String,
    /// Terminal theme glow and distortion: "off", "soft" or "strong".
    terminal_glow: String,
    /// The dashboard's newer layout instead of the card grid.
    new_dashboard: bool,
    /// Film grain on the Notes page: "black", "theme" or "off".
    notes_grain: String,
    /// Glass theme text: "data" (mono labels, big numbers, grey text) or "classic".
    glass_text: String,
    /// Glass theme: mouse-following glow on the window edge.
    glass_edge_glow: bool,
    /// Typing sound: "off", "creamy", "thock", "creamy-thock"; volume 0–100.
    key_sound: String,
    key_volume: i64,
}

/// The four look sliders, all 0–100.
const LOOK_KEYS: &[&str] = &["ui.glassBlur", "ui.glassTransparency", "ui.terminalBlur", "ui.terminalTransparency"];

const THEMES: &[&str] = &["glass", "terminal"];
const BACKDROPS: &[&str] = &["acrylic", "mica", "solid"];
const TITLE_BARS: &[&str] = &["always", "auto"];
const SIDEBAR_MODES: &[&str] = &["full", "icons", "hidden"];
const SHELLS: &[&str] = &["powershell", "bash", "cmd"];
const TERMINAL_STYLES: &[&str] = &["classic", "app", "shell"];
const KEY_SOUNDS: &[&str] = &["off", "creamy", "thock", "creamy-thock"];
const MINI_GLASS: &[&str] = &["blur", "lens"];
const NOTES_GRAIN: &[&str] = &["black", "theme", "off"];
const GLASS_TEXT: &[&str] = &["data", "classic"];
/// Terminal glow, distortion and the moving character background. First is the default.
const TERMINAL_GLOW: &[&str] = &["soft", "strong", "off"];

/// A value written by a newer Focus on the other PC falls back to the default instead of failing.
fn one_of(value: String, allowed: &[&str]) -> String {
    if allowed.contains(&value.as_str()) { value } else { allowed[0].to_string() }
}

fn percent(v: serde_json::Value) -> i64 {
    v.as_i64().unwrap_or(0).clamp(0, 100)
}

/// The colour roles of a custom theme.
const CUSTOM_ROLES: &[&str] = &["bg", "text", "accent"];
/// Colour roles a custom theme may also set (big numbers, the green "done" colour).
const CUSTOM_EXTRA_ROLES: &[&str] = &["number", "ok"];

fn is_hex_color(v: &serde_json::Value) -> bool {
    v.as_str().is_some_and(|c| c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|h| h.is_ascii_hexdigit()))
}

/// Custom colours, or null when anything is missing or malformed.
fn custom_colors(v: serde_json::Value) -> serde_json::Value {
    let ok = v.as_object().is_some_and(|o| {
        CUSTOM_ROLES.iter().all(|k| o.get(*k).is_some_and(is_hex_color))
            && o.iter().all(|(k, c)| (CUSTOM_ROLES.contains(&k.as_str()) || CUSTOM_EXTRA_ROLES.contains(&k.as_str())) && is_hex_color(c))
    });
    if ok { v } else { serde_json::Value::Null }
}

#[tauri::command]
pub fn get_ui_settings(state: tauri::State<'_, StoreState>) -> Result<UiSettings, String> {
    state.with(|store| {
        let get = |key: &str| settings::get::<serde_json::Value>(store, key).map_err(|e| e.to_string());
        let text = |v: serde_json::Value| v.as_str().unwrap_or_default().to_string();
        Ok(UiSettings {
            theme: one_of(text(get("ui.theme")?), THEMES),
            backdrop: one_of(text(get("ui.backdrop")?), BACKDROPS),
            sidebar_collapsed: get("ui.sidebarCollapsed")?.as_bool().unwrap_or(false),
            sidebar_mode: match text(get("ui.sidebarMode")?) {
                // Not chosen yet: 0.21.0's hidden menu was ui.sidebarCollapsed.
                m if m.is_empty() => if get("ui.sidebarCollapsed")?.as_bool().unwrap_or(false) { "hidden".into() } else { "full".into() },
                m => one_of(m, SIDEBAR_MODES),
            },
            title_bar: one_of(text(get("ui.titleBar")?), TITLE_BARS),
            glass_blur: percent(get("ui.glassBlur")?),
            glass_transparency: percent(get("ui.glassTransparency")?),
            terminal_blur: percent(get("ui.terminalBlur")?),
            terminal_transparency: percent(get("ui.terminalTransparency")?),
            glass_windows_blur: get("ui.glassWindowsBlur")?.as_bool().unwrap_or(true),
            terminal_windows_blur: get("ui.terminalWindowsBlur")?.as_bool().unwrap_or(true),
            mini_glass: one_of(text(get("ui.glassEffect")?), MINI_GLASS),
            glass_palette: text(get("ui.glassPalette")?),
            terminal_palette: text(get("ui.terminalPalette")?),
            glass_custom: custom_colors(get("ui.glassCustom")?),
            terminal_custom: custom_colors(get("ui.terminalCustom")?),
            terminal_shell: one_of(text(get("ui.terminalShell")?), SHELLS),
            terminal_crt: get("ui.terminalCrt")?.as_bool().unwrap_or(false),
            terminal_ascii: get("ui.terminalAscii")?.as_bool().unwrap_or(false),
            terminal_crt_sound: get("ui.terminalCrtSound")?.as_bool().unwrap_or(false),
            terminal_style: one_of(text(get("ui.terminalStyle")?), TERMINAL_STYLES),
            terminal_glow: one_of(text(get("ui.terminalGlow")?), TERMINAL_GLOW),
            new_dashboard: get("ui.nowDashboard")?.as_bool().unwrap_or(true),
            notes_grain: one_of(text(get("ui.notesGrain")?), NOTES_GRAIN),
            glass_text: one_of(text(get("ui.glassText")?), GLASS_TEXT),
            glass_edge_glow: get("ui.edgeGlowOn")?.as_bool().unwrap_or(true),
            key_sound: one_of(text(get("ui.keySound")?), KEY_SOUNDS),
            key_volume: percent(get("ui.keyVolume")?),
        })
    })
}

/// Saves one appearance setting. Only known keys and values are accepted.
#[tauri::command]
pub fn set_ui_setting(app: AppHandle, state: tauri::State<'_, StoreState>, key: String, value: serde_json::Value) -> Result<(), String> {
    let valid = match key.as_str() {
        "ui.theme" => value.as_str().is_some_and(|v| THEMES.contains(&v)),
        "ui.backdrop" => value.as_str().is_some_and(|v| BACKDROPS.contains(&v)),
        "ui.titleBar" => value.as_str().is_some_and(|v| TITLE_BARS.contains(&v)),
        "ui.sidebarMode" => value.as_str().is_some_and(|v| SIDEBAR_MODES.contains(&v)),
        "ui.terminalShell" => value.as_str().is_some_and(|v| SHELLS.contains(&v)),
        "ui.terminalStyle" => value.as_str().is_some_and(|v| TERMINAL_STYLES.contains(&v)),
        "ui.keySound" => value.as_str().is_some_and(|v| KEY_SOUNDS.contains(&v)),
        "ui.miniGlass" | "ui.glassEffect" => value.as_str().is_some_and(|v| MINI_GLASS.contains(&v)),
        "ui.notesGrain" => value.as_str().is_some_and(|v| NOTES_GRAIN.contains(&v)),
        "ui.glassText" => value.as_str().is_some_and(|v| GLASS_TEXT.contains(&v)),
        "ui.terminalGlow" => value.as_str().is_some_and(|v| TERMINAL_GLOW.contains(&v)),
        "ui.keyVolume" => value.as_i64().is_some_and(|v| (0..=100).contains(&v)),
        "ui.sidebarCollapsed" | "ui.glassWindowsBlur" | "ui.terminalWindowsBlur" | "ui.terminalCrt" | "ui.terminalAscii" | "ui.terminalCrtSound" | "ui.glassEdgeGlow" | "ui.edgeGlowOn" | "ui.newDashboard" | "ui.nowDashboard" => value.is_boolean(),
        k if LOOK_KEYS.contains(&k) => value.as_i64().is_some_and(|v| (0..=100).contains(&v)),
        // The app's colours for the browser extension's pages (checked again there).
        "ui.extColors" => value.as_object().is_some_and(|o| {
            o.len() <= 16 && o.values().all(|v| v.as_str().is_some_and(|s| s.len() <= 600 && !s.contains(['"', '\\', ';', '{', '}', '<', '>'])))
        }),
        "ui.glassCustom" | "ui.terminalCustom" => {
            !custom_colors(value.clone()).is_null()
        }
        "ui.glassPalette" | "ui.terminalPalette" => {
            value.as_str().is_some_and(|v| (1..=32).contains(&v.len()) && v.chars().all(|c| c.is_ascii_lowercase() || c == '-'))
        }
        _ => false,
    };
    if !valid {
        return Err(format!("{value} is not a valid value for {key:?}"));
    }
    state.with(|store| settings::set(store, &key, &value).map_err(|e| e.to_string()))?;
    if key == "ui.theme" || key == "ui.extColors" {
        // The browsers' blocked page follows the app's theme.
        crate::bridge::publish_blocking(&app);
    }
    Ok(())
}

/// Sets the Windows backdrop behind the calling window (main or mini timer), from lightest to
/// strongest blur: "none" (see-through, sharp), "blur" (light blur of the windows behind),
/// "acrylic" (frosted blur of the windows behind) or "mica" (only the wallpaper, very soft).
/// Windows offers these few kinds rather than a blur strength, so the Blur slider steps through them.
/// Returns whether the effect is now showing.
/// Kept sync: Tauri runs sync commands on the main thread, which owns the window.
#[tauri::command]
pub fn set_window_effect(window: tauri::WebviewWindow, effect: String, tint: Option<u8>) -> Result<bool, String> {
    // Clear everything first; only one backdrop can be active.
    #[cfg(windows)]
    keep_backdrop_when_inactive(&window);
    let _ = window_vibrancy::clear_mica(&window);
    let _ = window_vibrancy::clear_acrylic(&window);
    let _ = window_vibrancy::clear_blur(&window);
    let applied = match effect.as_str() {
        // Some(true) = dark Mica, which both themes are designed over.
        "mica" => window_vibrancy::apply_mica(&window, Some(true)).is_ok(),
        // On Windows 11 22H2+ this is the system Acrylic backdrop (the tint is then decided by Windows).
        "acrylic" => window_vibrancy::apply_acrylic(&window, Some((12, 17, 32, tint.unwrap_or(120)))).is_ok(),
        "blur" => window_vibrancy::apply_blur(&window, Some((12, 17, 32, tint.unwrap_or(60)))).is_ok(),
        "none" => false,
        other => return Err(format!("unknown window effect {other:?}")),
    };
    Ok(applied)
}

/// Windows switches the Acrylic / Mica backdrop off while a window is inactive, so the mini timer
/// went opaque as soon as another window was clicked. Windows decides "inactive" from the
/// WM_NCACTIVATE message, so this always lets it through as "active". Focus's windows have no
/// title bar, so nothing else changes; keyboard focus still moves normally.
/// Safe to call again: the same subclass id just replaces itself.
#[cfg(windows)]
fn keep_backdrop_when_inactive(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::WM_NCACTIVATE;

    unsafe extern "system" fn always_active(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        let wparam = if msg == WM_NCACTIVATE { 1 } else { wparam };
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            SetWindowSubclass(hwnd.0 as HWND, Some(always_active), 0xF0C5, 0);
        }
    }
}

/// Real-glass mini timer, step 1: hides the window from screen capture (Windows 10 2004+), so it
/// can copy what is behind it without seeing itself. It also stays out of screenshots and screen
/// shares while this is on, except for a few seconds after a screenshot key (see glass_shot.rs).
/// Returns whether Windows accepted it.
/// Real glass through the Magnifier (glass_mag.rs), which keeps Focus in screenshots. Off: see below.
#[cfg(windows)]
const USE_MAGNIFIER: bool = false;

#[tauri::command]
pub async fn glass_capture(window: tauri::WebviewWindow, on: bool) -> Result<bool, String> {
    // Async: the Magnifier test below waits for a picture, and that wait must not hold the UI
    // thread (popping out the mini timer while it did froze and closed Focus).
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let app = window.app_handle().clone();
        crate::glass_shot::init(&app);
        if on {
            // First choice: the Magnifier copies the screen and skips the glass windows, so Focus
            // stays in screenshots (glass_mag.rs). Only if that fails, hide the window from capture.
            on_ui(&window, move |app| crate::glass_shot::set_hidden(app, hwnd, false)).await;
            // Off since 0.21.75.B: on Ps's PC the Magnifier did not leave Focus out of its picture
            // (the glass showed a blurred copy of Focus itself) and popping out then crashed.
            let mag = USE_MAGNIFIER && tauri::async_runtime::spawn_blocking(move || crate::glass_mag::begin(hwnd)).await.unwrap_or(false);
            if mag {
                return Ok(true);
            }
            return Ok(on_ui(&window, move |app| crate::glass_shot::set_hidden(app, hwnd, true)).await);
        }
        crate::glass_mag::end(hwnd);
        Ok(on_ui(&window, move |app| crate::glass_shot::set_hidden(app, hwnd, false)).await)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, on);
        Ok(false)
    }
}

/// Runs `f` on the UI thread (window display affinity must be set there) and waits for its answer.
#[cfg(windows)]
async fn on_ui(window: &tauri::WebviewWindow, f: impl FnOnce(&AppHandle) -> bool + Send + 'static) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    let app = window.app_handle().clone();
    if window.run_on_main_thread(move || {
        let _ = tx.send(f(&app));
    }).is_err() {
        return false;
    }
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(false)).await.unwrap_or(false)
}

/// The window is minimized or hidden (e.g. the big window right after "pop out"): there is nothing
/// behind it to copy, and its position is off screen, so the glass keeps its last picture.
#[cfg(windows)]
fn glass_hidden(hwnd: isize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowVisible};
    unsafe { IsIconic(hwnd as _) != 0 || IsWindowVisible(hwnd as _) == 0 }
}

/// The part of `r` that is on a screen, or None when it is off every screen.
#[cfg(windows)]
pub fn on_screen(r: windows_sys::Win32::Foundation::RECT) -> Option<windows_sys::Win32::Foundation::RECT> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };
    let (vx, vy, vw, vh) = unsafe {
        (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN))
    };
    let out = windows_sys::Win32::Foundation::RECT {
        left: r.left.max(vx),
        top: r.top.max(vy),
        right: r.right.min(vx + vw),
        bottom: r.bottom.min(vy + vh),
    };
    (out.right - out.left >= 1 && out.bottom - out.top >= 1).then_some(out)
}

/// Real-glass mini timer, step 2: one picture of the screen behind the window's inside area.
/// Raw bytes: width and height (u32 little endian), then BGRA pixels, top row first.
/// Async so the copy runs off the main thread.
#[tauri::command]
pub async fn glass_frame(window: tauri::WebviewWindow, scale: Option<f64>) -> Result<tauri::ipc::Response, String> {
    // The big window copies a smaller picture (it is frosted anyway), so each frame stays cheap.
    let scale = scale.unwrap_or(1.0).clamp(0.1, 1.0);
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        if glass_hidden(hwnd) {
            return Err("paused".into());
        }
        if crate::glass_mag::active(hwnd) {
            let copied = tauri::async_runtime::spawn_blocking(move || crate::glass_mag::frame(hwnd, scale))
                .await
                .unwrap_or_else(|_| Err("the Magnifier stopped".into()));
            match copied {
                Ok(bytes) => return Ok(tauri::ipc::Response::new(bytes)),
                Err(e) if e == "paused" => return Err(e),
                Err(e) => {
                    // The Magnifier stopped giving pictures: switch this window to the old way.
                    crate::glass_mag::end(hwnd);
                    crate::glass_shot::note(&format!("window {hwnd:#x}: Magnifier copy stopped ({e}), hiding from capture instead"));
                    let app = window.app_handle().clone();
                    let _ = window.run_on_main_thread(move || {
                        crate::glass_shot::set_hidden(&app, hwnd, true);
                    });
                    return Err("paused".into());
                }
            }
        }
        // "paused": a screenshot is being taken, so the glass keeps its last picture.
        crate::glass_shot::frame_allowed(hwnd)?;
        tauri::async_runtime::spawn_blocking(move || capture_behind(hwnd, scale))
            .await
            .unwrap_or_else(|_| Err("could not copy the screen".into()))
            .map(tauri::ipc::Response::new)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, scale);
        Err("real glass needs Windows".into())
    }
}

#[cfg(windows)]
fn capture_behind(hwnd: isize, scale: f64) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, ClientToScreen, CreateCompatibleBitmap,
        CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, HALFTONE, ReleaseDC, SRCCOPY,
        SelectObject, SetBrushOrgEx, SetStretchBltMode, StretchBlt,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect;
    let hwnd = hwnd as HWND;
    unsafe {
        let mut rect: RECT = std::mem::zeroed();
        if GetClientRect(hwnd, &mut rect) == 0 {
            return Err("could not read the window size".into());
        }
        let mut origin = POINT { x: 0, y: 0 };
        ClientToScreen(hwnd, &mut origin);
        let (sw, sh) = (rect.right - rect.left, rect.bottom - rect.top);
        if sw <= 0 || sh <= 0 || sw > 8192 || sh > 8192 {
            return Err("the window has no usable size".into());
        }
        if on_screen(RECT { left: origin.x, top: origin.y, right: origin.x + sw, bottom: origin.y + sh }).is_none() {
            return Err("paused".into());
        }
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("could not read the screen".into());
        }
        let w = ((sw as f64 * scale).round() as i32).max(1);
        let h = ((sh as f64 * scale).round() as i32).max(1);
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp);
        // No CAPTUREBLT: with it Windows hides and re-shows the mouse cursor on every copy, so the
        // cursor blinked ~30 times a second. Windows' compositor already includes every window without it.
        let copied = if w == sw && h == sh {
            BitBlt(mem, 0, 0, w, h, screen, origin.x, origin.y, SRCCOPY) != 0
        } else {
            SetStretchBltMode(mem, HALFTONE);
            SetBrushOrgEx(mem, 0, 0, std::ptr::null_mut());
            StretchBlt(mem, 0, 0, w, h, screen, origin.x, origin.y, sw, sh, SRCCOPY) != 0
        };
        SelectObject(mem, old);
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w;
        info.bmiHeader.biHeight = -h; // top row first
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut out = vec![0u8; 8 + (w * h * 4) as usize];
        out[0..4].copy_from_slice(&(w as u32).to_le_bytes());
        out[4..8].copy_from_slice(&(h as u32).to_le_bytes());
        let rows = if copied { GetDIBits(mem, bmp, 0, h as u32, out[8..].as_mut_ptr().cast(), &mut info, DIB_RGB_COLORS) } else { 0 };
        DeleteObject(bmp);
        DeleteDC(mem);
        ReleaseDC(std::ptr::null_mut(), screen);
        if rows == 0 {
            return Err("could not copy the screen".into());
        }
        Ok(out)
    }
}

#[tauri::command]
pub fn create_preset(state: tauri::State<'_, StoreState>, input: PresetInput) -> Result<Preset, String> {
    state.with(|store| presets::create(store, input).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn update_preset(state: tauri::State<'_, StoreState>, id: String, input: PresetInput) -> Result<Preset, String> {
    state.with(|store| presets::update(store, &id, input).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn delete_preset(
    state: tauri::State<'_, StoreState>,
    timer_state: tauri::State<'_, TimerState>,
    id: String,
) -> Result<(), String> {
    // The running preset's settings were copied when it started, but deleting it mid-run is confusing.
    let running = timer_state.0.lock().map(|t| t.snapshot(timer::now_ms())).map_err(|_| "the timer is unavailable")?;
    if running.preset_id.as_deref() == Some(id.as_str())
        && !matches!(running.status, focus_timer::Status::Idle | focus_timer::Status::Finished)
    {
        return Err("this preset is in use by the timer; stop the timer first".into());
    }
    state.with(|store| presets::delete(store, &id).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn last_preset_id(state: tauri::State<'_, StoreState>) -> Result<Option<String>, String> {
    state.with(|store| settings::get(store, "timer.lastPresetId").map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn timer_state(timer_state: tauri::State<'_, TimerState>) -> Result<Snapshot, String> {
    let timer = timer_state.0.lock().map_err(|_| "the timer is unavailable after an internal error")?;
    Ok(timer.snapshot(timer::now_ms()))
}

#[tauri::command]
pub fn timer_start(app: AppHandle, preset_id: String) -> Result<Snapshot, String> {
    let plan = timer::plan_for(&app, &preset_id)?;
    if let Ok(mut rec) = app.state::<crate::history::RecordState>().0.lock() {
        if rec.cycle_id.is_none() {
            rec.deadline_id = None;
        }
    }
    timer::act(&app, |t, now| t.start(plan, now).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn timer_pause(app: AppHandle) -> Result<Snapshot, String> {
    timer::act(&app, |t, now| t.pause(now).map(|()| Vec::new()).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn timer_resume(app: AppHandle) -> Result<Snapshot, String> {
    timer::act(&app, |t, now| t.resume(now).map(|()| Vec::new()).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn timer_skip(app: AppHandle) -> Result<Snapshot, String> {
    timer::act(&app, |t, now| t.skip(now).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn timer_stop(app: AppHandle) -> Result<Snapshot, String> {
    timer::act(&app, |t, now| t.stop(now).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn timer_continue(app: AppHandle) -> Result<Snapshot, String> {
    timer::act(&app, |t, now| t.continue_next(now).map_err(|e| e.to_string()))
}

/// Mirrored by `SoundSettings` in src/ipc/sound.ts.
#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundSettings {
    on: bool,
    volume: u8,
}

#[tauri::command]
pub fn get_sound_settings(app: AppHandle) -> SoundSettings {
    let (on, volume) = timer::sound_settings(&app);
    SoundSettings { on, volume }
}

#[tauri::command]
pub fn set_sound_settings(state: tauri::State<'_, StoreState>, settings: SoundSettings) -> Result<(), String> {
    state.with(|store| {
        settings::set(store, "timer.soundOn", &settings.on).map_err(|e| e.to_string())?;
        settings::set(store, "timer.volume", &(settings.volume.min(100) as i64)).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn preview_sound(chime: crate::sound::Chime, volume: u8) -> Result<(), String> {
    crate::sound::play(chime, volume)
}

const MINI_W: f64 = 220.0;
const MINI_H: f64 = 124.0;
const MINI_MIN: (f64, f64) = (170.0, 100.0);
const MINI_MAX: (f64, f64) = (480.0, 280.0);

/// Where the mini timer's last size is kept on this PC ("width height" in logical pixels).
fn mini_size_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("mini-size.txt"))
}

/// The size you last gave the mini timer, or the default.
fn mini_size(app: &AppHandle) -> (f64, f64) {
    let read = mini_size_file(app).and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| {
        let mut it = t.split_whitespace().map(|n| n.parse::<f64>().ok());
        Some((it.next()??, it.next()??))
    });
    match read {
        Some((w, h)) if w.is_finite() && h.is_finite() => (w.clamp(MINI_MIN.0, MINI_MAX.0), h.clamp(MINI_MIN.1, MINI_MAX.1)),
        _ => (MINI_W, MINI_H),
    }
}

/// Called when the mini timer is resized: remembers its size for next time.
pub fn remember_mini_size(window: &tauri::Window, size: tauri::PhysicalSize<u32>) {
    // Minimizing reports a zero size; that is not a size you chose.
    if size.width == 0 || size.height == 0 || window.is_minimized().unwrap_or(false) {
        return;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let logical = size.to_logical::<f64>(scale);
    if let Some(f) = mini_size_file(window.app_handle()) {
        let _ = std::fs::write(f, format!("{:.0} {:.0}", logical.width, logical.height));
    }
}

/// Opens the small always-on-top timer (like the compact view in Windows Clock).
/// Async on purpose: creating a window from a sync command can deadlock on Windows.
#[tauri::command]
pub async fn open_mini_timer(app: AppHandle, mode: Option<String>) -> Result<(), String> {
    // "countdown": the same small window shows the countdown instead of the focus timer.
    let countdown = mode.as_deref() == Some("countdown");
    if let Some(mini) = app.get_webview_window("mini") {
        let _ = mini.emit("mini-mode", if countdown { "countdown" } else { "focus" });
        let _ = mini.show();
        let _ = mini.set_focus();
        minimize_main(&app);
        return Ok(());
    }
    let (mini_w, mini_h) = mini_size(&app);
    let mut builder = tauri::WebviewWindowBuilder::new(&app, "mini", tauri::WebviewUrl::App(if countdown { "index.html#mini-countdown" } else { "index.html#mini" }.into()))
        .title(if countdown { "Countdown" } else { "Focus timer" })
        .inner_size(mini_w, mini_h)
        .min_inner_size(MINI_MIN.0, MINI_MIN.1)
        .max_inner_size(MINI_MAX.0, MINI_MAX.1)
        .always_on_top(true)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .skip_taskbar(true);
    // Top-right corner of the screen the main window is on, clear of the edges.
    if let Some(monitor) = app.get_webview_window("main").and_then(|w| w.current_monitor().ok().flatten()) {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let pos = area.position.to_logical::<f64>(scale);
        let size = area.size.to_logical::<f64>(scale);
        builder = builder.position(pos.x + size.width - mini_w - 24.0, pos.y + 24.0);
    }
    builder.build().map_err(|e| format!("could not open the mini timer: {e}"))?;
    minimize_main(&app);
    Ok(())
}

/// Popping out the timer gets the big window out of the way (the mini timer can bring it back).
fn minimize_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.minimize();
    }
}

#[tauri::command]
pub fn close_mini_timer(app: AppHandle) {
    if let Some(mini) = app.get_webview_window("mini") {
        let _ = mini.close();
    }
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    crate::tray::show_main_window(&app);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Focus sessions (and breaks, if asked) that started in `from_ms..to_ms`, newest first.
/// Time per program between two moments (App tracking), most used first. History's day ring.
#[tauri::command]
pub fn app_totals(state: tauri::State<'_, StoreState>, from_ms: i64, to_ms: i64) -> Result<Vec<focus_store::activity::AppTime>, String> {
    state.with(|store| focus_store::activity::totals(store, from_ms, to_ms, 50).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn list_history(
    state: tauri::State<'_, StoreState>,
    from_ms: i64,
    to_ms: i64,
    include_breaks: bool,
) -> Result<Vec<SessionRow>, String> {
    state.with(|store| sessions::list(store, from_ms, to_ms, include_breaks).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn delete_history_session(app: AppHandle, state: tauri::State<'_, StoreState>, id: String) -> Result<(), String> {
    let open = app.state::<crate::history::RecordState>().0.lock().map(|r| r.open_row.clone()).unwrap_or(None);
    if open.as_deref() == Some(id.as_str()) {
        return Err("this session is still running; stop it first".into());
    }
    state.with(|store| sessions::delete(store, &id).map_err(|e| e.to_string()))?;
    let _ = app.emit("history-changed", ());
    Ok(())
}

/// The Blocking page: the lists every browser on this PC follows.
#[tauri::command]
pub fn get_blocking(state: tauri::State<'_, StoreState>) -> Result<focus_store::blocking::Blocking, String> {
    state.with(|store| focus_store::blocking::get(store).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn save_blocking(app: AppHandle, state: tauri::State<'_, StoreState>, lists: focus_store::blocking::BlockingLists) -> Result<(), String> {
    state.with(|store| focus_store::blocking::save(store, &lists).map_err(|e| e.to_string()))?;
    crate::bridge::publish_blocking(&app);
    let _ = app.emit("blocking-changed", ());
    Ok(())
}

/// The Statistics page: `bounds` are the edges of its days (or months), oldest first.
#[tauri::command]
pub fn load_stats(state: tauri::State<'_, StoreState>, bounds: Vec<i64>, streak_from_ms: i64) -> Result<focus_store::stats::StatsData, String> {
    if bounds.len() > 400 {
        return Err("too many days asked for".into());
    }
    state.with(|store| focus_store::stats::load(store, &bounds, streak_from_ms).map_err(|e| e.to_string()))
}

/// "Start focus" on a pinned deadline: one focus session of `minutes`, no breaks, named after the
/// deadline. Blocking is on while it runs (as for any focus phase), and its time is logged
/// against the deadline.
#[tauri::command]
pub fn deadline_focus_start(app: AppHandle, deadline_id: String, minutes: u32, today: String) -> Result<(), String> {
    let title = app
        .state::<StoreState>()
        .with(|s| deadlines::get(s.conn(), &deadline_id, &today).map_err(|e| e.to_string()))?
        .ok_or("that deadline no longer exists")?
        .title;
    if app.state::<TimerState>().0.lock().map(|t| t.is_active()).unwrap_or(true) {
        return Err("a focus session is already running; stop it first".into());
    }
    let plan = focus_timer::Plan {
        preset_id: None,
        preset_name: title,
        focus_ms: u64::from(minutes.clamp(1, 600)) * 60_000,
        short_break_ms: 0,
        long_break_ms: 0,
        sessions: 1,
        long_break_every: 0,
        auto_start_break: false,
        auto_start_focus: false,
    };
    app.state::<crate::history::RecordState>().0.lock().map_err(|_| "the timer is unavailable")?.deadline_id = Some(deadline_id);
    let started = timer::act(&app, |t, now| t.start(plan, now).map_err(|e| e.to_string()));
    if started.is_err() {
        if let Ok(mut rec) = app.state::<crate::history::RecordState>().0.lock() {
            rec.deadline_id = None;
        }
    }
    started.map(|_| ())
}

#[tauri::command]
pub fn deadline_focus_stop(app: AppHandle) -> Result<(), String> {
    timer::act(&app, |t, now| t.stop(now).map_err(|e| e.to_string())).map(|_| ())
}

/// Mirrored by `DeadlineFocusState` in src/ipc/review.ts.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadlineFocusState {
    /// All focus logged against each deadline.
    totals: Vec<focus_store::review::DeadlineFocus>,
    /// The deadline whose focus session is running now, if any.
    active: Option<ActiveDeadlineFocus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveDeadlineFocus {
    deadline_id: String,
    left_ms: u64,
    paused: bool,
}

#[tauri::command]
pub fn deadline_focus_state(app: AppHandle) -> Result<DeadlineFocusState, String> {
    let totals = app.state::<StoreState>().with(|s| focus_store::review::deadline_focus(s, 0, i64::MAX).map_err(|e| e.to_string()))?;
    let deadline = app.state::<crate::history::RecordState>().0.lock().ok().and_then(|r| r.deadline_id.clone());
    let snap = app.state::<TimerState>().0.lock().map_err(|_| "the timer is unavailable")?.snapshot(timer::now_ms());
    let focusing = snap.phase == focus_timer::Phase::Focus && matches!(snap.status, focus_timer::Status::Running | focus_timer::Status::Paused);
    let active = deadline.filter(|_| focusing).map(|deadline_id| ActiveDeadlineFocus {
        deadline_id,
        left_ms: snap.remaining_ms,
        paused: snap.status == focus_timer::Status::Paused,
    });
    Ok(DeadlineFocusState { totals, active })
}

/// The weekly review: `bounds` are the edges of the week's days, oldest first.
#[tauri::command]
pub fn weekly_review(state: tauri::State<'_, StoreState>, bounds: Vec<i64>) -> Result<focus_store::review::WeekReview, String> {
    if bounds.len() > 32 {
        return Err("too many days asked for".into());
    }
    state.with(|store| focus_store::review::week(store, &bounds, timer::now_ms() as i64).map_err(|e| e.to_string()))
}

/// App tracking: "off", "focus" or "always".
#[tauri::command]
pub fn get_tracking_mode(state: tauri::State<'_, StoreState>) -> Result<String, String> {
    state.with(|store| settings::get(store, "tracking.mode").map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn set_tracking_mode(state: tauri::State<'_, StoreState>, mode: String) -> Result<(), String> {
    if !["off", "focus", "always"].contains(&mode.as_str()) {
        return Err(format!("{mode:?} is not a tracking mode"));
    }
    state.with(|store| settings::set(store, "tracking.mode", &mode).map_err(|e| e.to_string()))
}

/// Deletes all tracked app activity on this PC.
#[tauri::command]
pub fn clear_activity(app: AppHandle, state: tauri::State<'_, StoreState>) -> Result<(), String> {
    state.with(|store| focus_store::activity::clear_all(store).map_err(|e| e.to_string()))?;
    let _ = app.emit("activity-changed", ());
    let _ = app.emit("history-changed", ());
    Ok(())
}

// ---------------------------------------------------------------- to-do list
// `today` is the local date (YYYY-MM-DD) from the UI. Every change emits "tasks-changed" so the
// dashboard and the To-do page stay in step.

fn tasks_changed<T>(app: &AppHandle, result: Result<T, String>) -> Result<T, String> {
    if result.is_ok() {
        let _ = app.emit("tasks-changed", ());
        // A deadline's checklist is made of tasks.
        let _ = app.emit("deadlines-changed", ());
    }
    result
}

#[tauri::command]
pub fn list_tasks(state: tauri::State<'_, StoreState>, today: String) -> Result<Vec<Task>, String> {
    state.with(|store| tasks::list(store.conn(), &today).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn create_task(app: AppHandle, state: tauri::State<'_, StoreState>, input: TaskInput, today: String) -> Result<Task, String> {
    tasks_changed(&app, state.with(|store| tasks::create(store, input, &today).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn update_task(
    app: AppHandle,
    state: tauri::State<'_, StoreState>,
    id: String,
    input: TaskInput,
    today: String,
) -> Result<Task, String> {
    tasks_changed(&app, state.with(|store| tasks::update(store, &id, input, &today).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn set_task_done(
    app: AppHandle,
    state: tauri::State<'_, StoreState>,
    id: String,
    done: bool,
    today: String,
) -> Result<Task, String> {
    tasks_changed(&app, state.with(|store| tasks::set_done(store, &id, done, &today).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn delete_tasks(app: AppHandle, state: tauri::State<'_, StoreState>, ids: Vec<String>) -> Result<(), String> {
    tasks_changed(&app, state.with(|store| tasks::delete(store, &ids).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn restore_tasks(app: AppHandle, state: tauri::State<'_, StoreState>, ids: Vec<String>) -> Result<(), String> {
    tasks_changed(&app, state.with(|store| tasks::restore(store, &ids).map_err(|e| e.to_string())))
}

/// Deletes every ticked one-off task in one space (None = Everyday); returns their IDs so the UI can offer Undo.
#[tauri::command]
pub fn clear_done_tasks(app: AppHandle, state: tauri::State<'_, StoreState>, space_id: Option<String>) -> Result<Vec<String>, String> {
    tasks_changed(&app, state.with(|store| tasks::clear_done(store, space_id.as_deref()).map_err(|e| e.to_string())))
}

/// Sets or clears (None) the colour dot of one task.
#[tauri::command]
pub fn set_task_color(
    app: AppHandle,
    state: tauri::State<'_, StoreState>,
    id: String,
    color: Option<String>,
    today: String,
) -> Result<Task, String> {
    tasks_changed(&app, state.with(|store| tasks::set_color(store, &id, color.as_deref(), &today).map_err(|e| e.to_string())))
}

/// Colours used last on tasks, newest first (up to 5).
#[tauri::command]
pub fn recent_task_colors(state: tauri::State<'_, StoreState>) -> Result<Vec<String>, String> {
    state.with(|store| tasks::recent_colors(store).map_err(|e| e.to_string()))
}

// ---------------------------------------------------------------- to-do spaces
// Changes emit "tasks-changed": a space's name, dates and deletion change what the To-do page and
// the dashboard show.

#[tauri::command]
pub fn list_spaces(state: tauri::State<'_, StoreState>) -> Result<Vec<Space>, String> {
    state.with(|store| spaces::list(store.conn()).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn create_space(app: AppHandle, state: tauri::State<'_, StoreState>, input: SpaceInput) -> Result<Space, String> {
    tasks_changed(&app, state.with(|store| spaces::create(store, input).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn update_space(app: AppHandle, state: tauri::State<'_, StoreState>, id: String, input: SpaceInput) -> Result<Space, String> {
    tasks_changed(&app, state.with(|store| spaces::update(store, &id, input).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn delete_space(app: AppHandle, state: tauri::State<'_, StoreState>, id: String) -> Result<(), String> {
    tasks_changed(&app, state.with(|store| spaces::delete(store, &id).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn restore_space(app: AppHandle, state: tauri::State<'_, StoreState>, id: String) -> Result<(), String> {
    tasks_changed(&app, state.with(|store| spaces::restore(store, &id).map_err(|e| e.to_string())))
}

// ---------------------------------------------------------------- free boards and case boards
// Changes emit "boards-changed" (not "tasks-changed": moving a card should not reload every task).

fn boards_changed<T>(app: &AppHandle, result: Result<T, String>) -> Result<T, String> {
    if result.is_ok() {
        let _ = app.emit("boards-changed", ());
    }
    result
}

#[tauri::command]
pub fn list_board_items(state: tauri::State<'_, StoreState>, space_id: String) -> Result<Vec<BoardItem>, String> {
    state.with(|store| boards::list(store.conn(), &space_id).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn save_board_items(app: AppHandle, state: tauri::State<'_, StoreState>, items: Vec<BoardItemInput>) -> Result<Vec<BoardItem>, String> {
    boards_changed(&app, state.with(|store| boards::save(store, items).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn delete_board_items(app: AppHandle, state: tauri::State<'_, StoreState>, ids: Vec<String>) -> Result<Vec<String>, String> {
    boards_changed(&app, state.with(|store| boards::delete(store, &ids).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn restore_board_items(app: AppHandle, state: tauri::State<'_, StoreState>, ids: Vec<String>) -> Result<(), String> {
    boards_changed(&app, state.with(|store| boards::restore(store, &ids).map_err(|e| e.to_string())))
}

// ---------------------------------------------------------------- notes
// Every change emits "notes-changed" so the list, the editor and the dashboard's pinned notes agree.

fn notes_changed<T>(app: &AppHandle, result: Result<T, String>) -> Result<T, String> {
    if result.is_ok() {
        let _ = app.emit("notes-changed", ());
    }
    result
}

#[tauri::command]
pub fn list_notes(state: tauri::State<'_, StoreState>, search: Option<String>) -> Result<Vec<NoteSummary>, String> {
    state.with(|store| notes::list(store.conn(), search.as_deref()).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn get_note(state: tauri::State<'_, StoreState>, id: String) -> Result<Option<Note>, String> {
    state.with(|store| notes::get(store.conn(), &id).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn create_note(app: AppHandle, state: tauri::State<'_, StoreState>, kind: Option<String>) -> Result<Note, String> {
    let kind = kind.unwrap_or_else(|| "text".into());
    notes_changed(&app, state.with(|store| notes::create_kind(store, &kind).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn save_note(
    app: AppHandle,
    state: tauri::State<'_, StoreState>,
    id: String,
    title: String,
    body: String,
    plain_text: String,
) -> Result<Note, String> {
    notes_changed(&app, state.with(|store| notes::save(store, &id, &title, &body, &plain_text).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn set_note_pinned(app: AppHandle, state: tauri::State<'_, StoreState>, id: String, pinned: bool) -> Result<(), String> {
    notes_changed(&app, state.with(|store| notes::set_pinned(store, &id, pinned).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn list_note_folders(state: tauri::State<'_, StoreState>) -> Result<Vec<String>, String> {
    state.with(|store| notes::folders(store).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn add_note_folder(app: AppHandle, state: tauri::State<'_, StoreState>, path: String) -> Result<String, String> {
    notes_changed(&app, state.with(|store| notes::add_folder(store, &path).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn set_note_folder(app: AppHandle, state: tauri::State<'_, StoreState>, id: String, folder: Option<String>) -> Result<(), String> {
    notes_changed(&app, state.with(|store| notes::set_folder(store, &id, folder.as_deref()).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn move_note_folder(app: AppHandle, state: tauri::State<'_, StoreState>, from: String, to: Option<String>) -> Result<(), String> {
    notes_changed(&app, state.with(|store| notes::move_folder(store, &from, to.as_deref()).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn remove_note_folder(app: AppHandle, state: tauri::State<'_, StoreState>, path: String) -> Result<(), String> {
    notes_changed(&app, state.with(|store| notes::remove_folder(store, &path).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn delete_notes(app: AppHandle, state: tauri::State<'_, StoreState>, ids: Vec<String>) -> Result<(), String> {
    notes_changed(&app, state.with(|store| notes::delete(store, &ids).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn restore_notes(app: AppHandle, state: tauri::State<'_, StoreState>, ids: Vec<String>) -> Result<(), String> {
    notes_changed(&app, state.with(|store| notes::restore(store, &ids).map_err(|e| e.to_string())))
}

// ---------------------------------------------------------------- deadlines
// Every change emits "deadlines-changed" (and checklist changes "tasks-changed" too).

fn deadlines_changed<T>(app: &AppHandle, result: Result<T, String>) -> Result<T, String> {
    if result.is_ok() {
        let _ = app.emit("deadlines-changed", ());
    }
    result
}

#[tauri::command]
pub fn list_deadlines(state: tauri::State<'_, StoreState>, today: String) -> Result<Vec<Deadline>, String> {
    state.with(|store| deadlines::list(store.conn(), &today).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn create_deadline(
    app: AppHandle,
    state: tauri::State<'_, StoreState>,
    input: DeadlineInput,
    today: String,
) -> Result<Deadline, String> {
    deadlines_changed(&app, state.with(|store| deadlines::create(store, input, &today).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn update_deadline(
    app: AppHandle,
    state: tauri::State<'_, StoreState>,
    id: String,
    input: DeadlineInput,
    today: String,
) -> Result<Deadline, String> {
    deadlines_changed(&app, state.with(|store| deadlines::update(store, &id, input, &today).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn set_deadline_completed(
    app: AppHandle,
    state: tauri::State<'_, StoreState>,
    id: String,
    completed: bool,
    today: String,
) -> Result<Deadline, String> {
    deadlines_changed(&app, state.with(|store| deadlines::set_completed(store, &id, completed, &today).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn mark_deadline_day(
    app: AppHandle,
    state: tauri::State<'_, StoreState>,
    id: String,
    day_index: i64,
    done: bool,
    today: String,
) -> Result<Deadline, String> {
    deadlines_changed(&app, state.with(|store| deadlines::mark_day(store, &id, day_index, done, &today).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn delete_deadlines(app: AppHandle, state: tauri::State<'_, StoreState>, ids: Vec<String>) -> Result<(), String> {
    deadlines_changed(&app, state.with(|store| deadlines::delete(store, &ids).map_err(|e| e.to_string())))
}

#[tauri::command]
pub fn restore_deadlines(app: AppHandle, state: tauri::State<'_, StoreState>, ids: Vec<String>) -> Result<(), String> {
    deadlines_changed(&app, state.with(|store| deadlines::restore(store, &ids).map_err(|e| e.to_string())))
}

/// The main window's taskbar icon in the theme's colours. The page draws it (PNG bytes as the raw
/// request body); the installed exe icon, used for pinned shortcuts, stays as it is.
#[tauri::command]
pub fn set_app_icon(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("no icon sent".into());
    };
    let image = tauri::image::Image::from_bytes(bytes).map_err(|e| format!("not a PNG icon: {e}"))?;
    if let Some(main) = app.get_webview_window("main") {
        main.set_icon(image).map_err(|e| e.to_string())?;
    }
    Ok(())
}
