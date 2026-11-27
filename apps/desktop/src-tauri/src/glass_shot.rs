//! Screenshots with real glass on.
//!
//! Real glass has to hide its window from screen capture (WDA_EXCLUDEFROMCAPTURE), or the copy of
//! the screen behind it would contain the window itself. That also hid Focus from screenshots.
//! So while a glass window is hidden, a keyboard hook watches for the screenshot keys (Print Screen
//! in any combination, and Win+Shift+S). It holds the key back, makes every glass window visible to
//! capture (on the UI thread, which owns the windows), waits a few frames so Windows has really
//! shown them, and only then sends the key on, so the screenshot always includes Focus. The glass
//! keeps its last picture of what is behind it for a few seconds, then hides again.
//! The hook only looks at those two keys and ignores everything else, and does nothing at all while
//! no glass window is on. Screen sharing and recording apps (OBS, Teams, Game Bar) still do not see the glass.

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use tauri::AppHandle;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
        MAPVK_VK_TO_VSC, VK_LSHIFT, VK_LWIN, VK_RWIN, VK_SHIFT, VK_SNAPSHOT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, KBDLLHOOKSTRUCT, MSG, SetWindowDisplayAffinity, SetWindowsHookExW,
        TranslateMessage, UnhookWindowsHookEx, HC_ACTION, WDA_EXCLUDEFROMCAPTURE, WDA_NONE, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
        WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    /// How long glass windows stay visible to capture after a screenshot key.
    const SHOW_FOR_MS: u64 = 5000;
    /// How long to wait, after showing the windows, before the screenshot key goes on.
    const SETTLE_MS: u64 = 250;
    /// Marks the keys this file sends itself, so the hook lets them through.
    const OURS: usize = 0x466f_6375; // "Focu"

    struct Glass {
        hwnd: isize,
        /// Visible to capture right now because of a screenshot key.
        shown: bool,
        /// When it was asked to hide again (0: not yet).
        rehide_at: u64,
    }

    static WINDOWS: Mutex<Vec<Glass>> = Mutex::new(Vec::new());
    static SHOWN_UNTIL: AtomicU64 = AtomicU64::new(0);
    /// Some glass window is hidden from capture.
    static ANY: AtomicBool = AtomicBool::new(false);
    static HOOKED: AtomicBool = AtomicBool::new(false);
    /// A screenshot key is held back and waiting to be sent on (its key-up is held back too).
    static HELD: AtomicBool = AtomicBool::new(false);
    static APP: OnceLock<AppHandle> = OnceLock::new();
    static LOG: OnceLock<std::path::PathBuf> = OnceLock::new();

    /// A short diary of what happened, in <app data>/glass-shot.log, so a screenshot that still
    /// misses Focus can be looked into. Kept small.
    fn log(msg: &str) {
        let Some(path) = LOG.get() else { return };
        if std::fs::metadata(path).map(|m| m.len() > 200_000).unwrap_or(false) {
            let _ = std::fs::remove_file(path);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            use std::io::Write;
            let _ = writeln!(f, "{} {}", now_ms(), msg);
        }
    }

    fn now_ms() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }

    /// Runs `f` on the UI thread (the thread that owns the windows), where window affinity changes
    /// are sure to work. Falls back to calling it here when there is no app yet.
    fn on_ui(f: impl FnOnce() + Send + 'static) {
        match APP.get() {
            Some(app) => {
                let _ = app.run_on_main_thread(f);
            }
            None => f(),
        }
    }

    /// Hides (or shows) one window from capture and remembers it. Returns whether Windows accepted it.
    /// Called on the UI thread (a plain Tauri command).
    /// Remembers the app and where the diary goes (glass-shot.log).
    pub fn init(app: &AppHandle) {
        let _ = APP.set(app.clone());
        if LOG.get().is_none() {
            use tauri::Manager;
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                let _ = LOG.set(dir.join("glass-shot.log"));
            }
        }
    }

    /// A line in the diary, for the Magnifier glass (glass_mag.rs).
    pub fn note(msg: &str) {
        log(msg);
    }

    pub fn set_hidden(app: &AppHandle, hwnd: isize, on: bool) -> bool {
        init(app);
        let mut list = WINDOWS.lock().unwrap_or_else(|e| e.into_inner());
        list.retain(|g| g.hwnd != hwnd);
        let affinity = if on { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
        let ok = unsafe { SetWindowDisplayAffinity(hwnd as HWND, affinity) } != 0;
        log(&format!("window {hwnd:#x} hidden from capture: {on} (accepted: {ok})"));
        if on && ok {
            list.push(Glass { hwnd, shown: false, rehide_at: 0 });
        }
        let any = !list.is_empty();
        drop(list);
        set_hook(any);
        ok
    }

    /// Called before each glass picture. Err while the window is showing for a screenshot (the glass
    /// keeps its last picture), and for a few frames after it hides again, so Windows has time to
    /// take it out of capture before the next copy.
    pub fn frame_allowed(hwnd: isize) -> Result<(), String> {
        let mut list = WINDOWS.lock().unwrap_or_else(|e| e.into_inner());
        let Some(g) = list.iter_mut().find(|g| g.hwnd == hwnd) else { return Ok(()) };
        if !g.shown {
            return Ok(());
        }
        let now = now_ms();
        if now < SHOWN_UNTIL.load(Ordering::Relaxed) {
            return Err("paused".into());
        }
        if g.rehide_at == 0 {
            // Time is up: hide it again (on the UI thread), then give Windows a moment.
            g.rehide_at = now;
            on_ui(move || {
                let ok = unsafe { SetWindowDisplayAffinity(hwnd as HWND, WDA_EXCLUDEFROMCAPTURE) } != 0;
                log(&format!("window {hwnd:#x} hidden from capture again (accepted: {ok})"));
            });
            return Err("paused".into());
        }
        if now < g.rehide_at + 150 {
            return Err("paused".into());
        }
        g.shown = false;
        g.rehide_at = 0;
        Ok(())
    }

    /// Lets capture see every glass window (on the UI thread).
    fn show_all() {
        show_for(SHOW_FOR_MS);
    }

    /// Lets capture see every glass window for `ms` (also from the tray menu, for a screenshot
    /// tool the keyboard keys do not reach).
    pub fn show_for(ms: u64) {
        SHOWN_UNTIL.store(now_ms() + ms, Ordering::Relaxed);
        let hwnds: Vec<isize> = {
            let mut list = WINDOWS.lock().unwrap_or_else(|e| e.into_inner());
            list.iter_mut()
                .map(|g| {
                    g.shown = true;
                    g.rehide_at = 0;
                    g.hwnd
                })
                .collect()
        };
        on_ui(move || {
            for h in hwnds {
                let ok = unsafe { SetWindowDisplayAffinity(h as HWND, WDA_NONE) } != 0;
                let now = unsafe { affinity(h) };
                // Make Windows draw the window again at once, so captures pick up the change.
                unsafe { redraw(h) };
                log(&format!("screenshot: window {h:#x} shown to capture (accepted: {ok}, affinity now {now:#x})"));
            }
        });
    }

    unsafe fn affinity(h: isize) -> u32 {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowDisplayAffinity;
        let mut a: u32 = 0xffff;
        unsafe { GetWindowDisplayAffinity(h as HWND, &mut a) };
        a
    }

    unsafe fn redraw(h: isize) {
        use windows_sys::Win32::Graphics::Gdi::{RedrawWindow, RDW_ALLCHILDREN, RDW_FRAME, RDW_INVALIDATE, RDW_UPDATENOW};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
        };
        unsafe {
            SetWindowPos(h as HWND, std::ptr::null_mut(), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
            RedrawWindow(h as HWND, std::ptr::null(), std::ptr::null_mut(), RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN | RDW_UPDATENOW);
        }
    }

    fn down(vk: u16) -> bool {
        (unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000) != 0
    }

    fn key(vk: u16, up: bool, extended: bool) -> INPUT {
        let mut flags = if up { KEYEVENTF_KEYUP } else { 0 };
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: vk, wScan: unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16, dwFlags: flags, time: 0, dwExtraInfo: OURS },
            },
        }
    }

    /// Sends the held-back screenshot key on, once the windows show. For Win+Shift+S, Win and Shift
    /// are pressed again only if they were let go in the meantime.
    fn send_on(snip: bool) {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(SETTLE_MS));
            let mut inputs = Vec::new();
            if snip {
                let win = down(VK_LWIN) || down(VK_RWIN);
                let shift = down(VK_SHIFT);
                if !win {
                    inputs.push(key(VK_LWIN, false, true));
                }
                if !shift {
                    inputs.push(key(VK_LSHIFT, false, false));
                }
                inputs.push(key(b'S' as u16, false, false));
                inputs.push(key(b'S' as u16, true, false));
                if !shift {
                    inputs.push(key(VK_LSHIFT, true, false));
                }
                if !win {
                    inputs.push(key(VK_LWIN, true, true));
                }
            } else {
                inputs.push(key(VK_SNAPSHOT, false, true));
                inputs.push(key(VK_SNAPSHOT, true, true));
            }
            HELD.store(false, Ordering::SeqCst);
            let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
            log(&format!("screenshot key sent on ({} of {} key events)", sent, inputs.len()));
        });
    }

    /// The keyboard hook has been called at least once (logged once, to see that it works).
    static HOOK_ALIVE: AtomicBool = AtomicBool::new(false);
    static RAW_ALIVE: AtomicBool = AtomicBool::new(false);

    unsafe extern "system" fn keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 && !HOOK_ALIVE.swap(true, Ordering::Relaxed) {
            log("keyboard hook is receiving keys");
        }
        if code == HC_ACTION as i32 {
            // Only the screenshot keys are ever written down: Print Screen, and any key pressed
            // while Win and Shift are both held (some keyboards send their own screenshot key).
            let k = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
            let is_down = wparam == WM_KEYDOWN as WPARAM || wparam == WM_SYSKEYDOWN as WPARAM;
            if k.dwExtraInfo != OURS && is_down {
                let vk = k.vkCode as u16;
                let win_shift = down(VK_SHIFT) && (down(VK_LWIN) || down(VK_RWIN));
                if vk == VK_SNAPSHOT || (win_shift && vk != VK_SHIFT && vk != VK_LSHIFT && vk != 0xA1 && vk != VK_LWIN && vk != VK_RWIN) {
                    log(&format!("key {vk:#x} down (win+shift: {win_shift}, glass on: {})", ANY.load(Ordering::Relaxed)));
                }
            }
        }
        if ANY.load(Ordering::Relaxed) && code == HC_ACTION as i32 {
            let k = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
            let vk = k.vkCode as u16;
            let is_down = wparam == WM_KEYDOWN as WPARAM || wparam == WM_SYSKEYDOWN as WPARAM;
            let is_up = wparam == WM_KEYUP as WPARAM || wparam == WM_SYSKEYUP as WPARAM;
            if k.dwExtraInfo != OURS && (vk == VK_SNAPSHOT || vk == b'S' as u16) {
                let snip = vk == b'S' as u16;
                let combo = !snip || (down(VK_SHIFT) && (down(VK_LWIN) || down(VK_RWIN)));
                if is_down && combo {
                    // Hold the key back until Focus shows in captures.
                    if !HELD.swap(true, Ordering::SeqCst) {
                        log(if snip { "Win+Shift+S pressed" } else { "Print Screen pressed" });
                        show_all();
                        send_on(snip);
                    }
                    return 1;
                }
                // Its key-up is held back too (the key is sent on as a whole, down and up).
                if is_up && combo_up(vk) {
                    return 1;
                }
            }
        }
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
    }

    /// Whether this key-up belongs to a held-back screenshot key: Print Screen always (its down was
    /// held back), S only while the snip is waiting.
    fn combo_up(vk: u16) -> bool {
        vk == VK_SNAPSHOT || HELD.load(Ordering::SeqCst)
    }

    /// A hidden message window that receives raw keyboard input from the whole system.
    unsafe fn start_raw_input() {
        use windows_sys::Win32::UI::Input::{RegisterRawInputDevices, RAWINPUTDEVICE, RIDEV_INPUTSINK};
        use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, RegisterClassW, HWND_MESSAGE, WNDCLASSW};
        let class: Vec<u16> = "FocusGlassShotRaw\0".encode_utf16().collect();
        let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(raw_window),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class.as_ptr(),
        };
        unsafe { RegisterClassW(&wc) };
        let hwnd = unsafe { CreateWindowExW(0, class.as_ptr(), std::ptr::null(), 0, 0, 0, 0, 0, HWND_MESSAGE, std::ptr::null_mut(), instance, std::ptr::null()) };
        if hwnd.is_null() {
            log("raw input window could not be made");
            return;
        }
        // Generic desktop page (1), keyboard (6); INPUTSINK: also while Focus is in the background.
        let dev = RAWINPUTDEVICE { usUsagePage: 1, usUsage: 6, dwFlags: RIDEV_INPUTSINK, hwndTarget: hwnd };
        let ok = unsafe { RegisterRawInputDevices(&dev, 1, std::mem::size_of::<RAWINPUTDEVICE>() as u32) } != 0;
        log(&format!("raw keyboard input started: {ok}"));
    }

    unsafe extern "system" fn raw_window(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        use windows_sys::Win32::UI::Input::{GetRawInputData, RAWINPUT, RAWINPUTHEADER, RID_INPUT, RIM_TYPEKEYBOARD};
        use windows_sys::Win32::UI::WindowsAndMessaging::{DefWindowProcW, WM_INPUT};
        if msg == WM_INPUT {
            let mut raw: RAWINPUT = unsafe { std::mem::zeroed() };
            let mut size = std::mem::size_of::<RAWINPUT>() as u32;
            let got = unsafe {
                GetRawInputData(lparam as _, RID_INPUT, &mut raw as *mut RAWINPUT as *mut _, &mut size, std::mem::size_of::<RAWINPUTHEADER>() as u32)
            };
            if got != u32::MAX && raw.header.dwType == RIM_TYPEKEYBOARD {
                if !RAW_ALIVE.swap(true, Ordering::Relaxed) {
                    log("raw keyboard input is arriving");
                }
                let kb = unsafe { raw.data.keyboard };
                let is_down = kb.Message == WM_KEYDOWN || kb.Message == WM_SYSKEYDOWN;
                let snip = kb.VKey == b'S' as u16 && down(VK_SHIFT) && (down(VK_LWIN) || down(VK_RWIN));
                // Only when the hook did not already take care of it.
                if ANY.load(Ordering::Relaxed)
                    && is_down
                    && (kb.VKey == VK_SNAPSHOT || snip)
                    && !HELD.load(Ordering::SeqCst)
                    && now_ms() > SHOWN_UNTIL.load(Ordering::Relaxed)
                {
                    log(if snip { "Win+Shift+S seen (raw input)" } else { "Print Screen seen (raw input)" });
                    show_all();
                }
            }
        }
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    /// Installs the hook the first time a glass window is hidden. While no glass window is on, the
    /// hook returns straight away for every key.
    fn set_hook(any: bool) {
        ANY.store(any, Ordering::SeqCst);
        if !any || HOOKED.swap(true, Ordering::SeqCst) {
            return;
        }
        // A low-level hook needs a thread with a message loop; its own keeps the UI thread free.
        std::thread::spawn(|| unsafe {
            let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), GetModuleHandleW(std::ptr::null()), 0);
            if hook.is_null() {
                log("keyboard hook could not be installed");
            } else {
                log("keyboard hook installed");
            }
            // Second way to notice the keys: raw keyboard input, which Windows gives to any app that
            // asks, even in the background. It cannot hold the key back, but it shows the glass
            // windows within a frame, before the snipping overlay has opened.
            start_raw_input();
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            UnhookWindowsHookEx(hook);
        });
    }
}

#[cfg(windows)]
pub use imp::{frame_allowed, init, note, set_hidden};
