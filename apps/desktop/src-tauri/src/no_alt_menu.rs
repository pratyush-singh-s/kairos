//! Pressing and letting go of Alt on its own puts a Windows window into "menu mode", even with no
//! menu bar. The next click or pen touch then only ends that mode, so the pen acts like a plain
//! pointer for a moment instead of writing. Focus has no menu bar, so the main window ignores that
//! Alt press. Alt + Space (the window's own menu) and Alt + F4 still work.

#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{SC_KEYMENU, WM_SYSCOMMAND};

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM, _id: usize, _data: usize) -> LRESULT {
        // l == 0: Alt alone (Alt + a letter carries the letter, Alt + Space carries ' ').
        if msg == WM_SYSCOMMAND && (w & 0xFFF0) == SC_KEYMENU as usize && l == 0 {
            return 0;
        }
        unsafe { DefSubclassProc(hwnd, msg, w, l) }
    }

    if let Ok(hwnd) = window.hwnd() {
        unsafe { SetWindowSubclass(hwnd.0 as HWND, Some(proc), 0x466f_6375, 0) };
    }
}

#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow) {}
