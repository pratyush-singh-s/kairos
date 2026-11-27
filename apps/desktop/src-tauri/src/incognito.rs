//! "Private windows": switches off Incognito / InPrivate / Private Browsing so blocked sites
//! can't be opened there. Done with each browser's own Windows policy under
//! HKCU\Software\Policies (Chrome, Edge, Brave, Chromium, Helium, Vivaldi, Firefox, Zen), so no extension is needed.
//! Turning it off deletes only the values Kairos set, which gives the browsers their private
//! windows back. Chromium browsers pick the change up within seconds; Firefox on its next start.
//!
//! Windows lets only administrators write under Software\Policies. The first time a write is
//! refused, Kairos asks Windows once (UAC) to let this user change just these browser keys,
//! and from then on it can switch them by itself (e.g. at the start and end of every focus).

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::bridge::BridgeState;
use crate::state::StoreState;
use focus_store::settings;

const KEY: &str = "blocking.privateWindows";

/// (policy key under HKCU, value name). Each one set to DWORD 1 = private windows off.
#[cfg_attr(not(windows), allow(dead_code))]
const POLICIES: &[(&str, &str)] = &[
    (r"Software\Policies\Google\Chrome", "IncognitoModeAvailability"),
    (r"Software\Policies\Microsoft\Edge", "InPrivateModeAvailability"),
    (r"Software\Policies\BraveSoftware\Brave", "IncognitoModeAvailability"),
    (r"Software\Policies\Chromium", "IncognitoModeAvailability"),
    (r"Software\Policies\Helium", "IncognitoModeAvailability"),
    (r"Software\Policies\imput\Helium", "IncognitoModeAvailability"),
    (r"Software\Policies\Vivaldi", "IncognitoModeAvailability"),
    (r"Software\Policies\Mozilla\Firefox", "DisablePrivateBrowsing"),
    // Zen reads Software\Policies\Mozilla\<app name>.
    (r"Software\Policies\Mozilla\Zen", "DisablePrivateBrowsing"),
    (r"Software\Policies\Mozilla\Zen Browser", "DisablePrivateBrowsing"),
    (r"Software\Policies\Mozilla\Twilight", "DisablePrivateBrowsing"),
];

/// Firefox-based browsers also read <install folder>\distribution\policies.json; Kairos writes
/// exactly this file there (and deletes it again), for Zen, which ignores the registry.
#[cfg_attr(not(windows), allow(dead_code))]
const ZEN_POLICIES_JSON: &str = r#"{"policies":{"DisablePrivateBrowsing":true}}"#;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Private windows work as normal.
    Off,
    /// Blocked while a focus (or anything that turns site blocking on) is running.
    Focus,
    /// Blocked all the time.
    Always,
}

#[derive(Default)]
pub struct IncognitoState {
    /// What the registry was last set to by Kairos (None = not yet this run).
    applied: Mutex<Option<bool>>,
    /// The last problem, shown under the setting.
    error: Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    mode: Mode,
    /// Private windows are switched off right now.
    blocked: bool,
    error: Option<String>,
}

fn mode(app: &AppHandle) -> Mode {
    app.state::<StoreState>().with(|s| settings::get::<Mode>(s, KEY).map_err(|e| e.to_string())).unwrap_or(Mode::Off)
}

fn wanted(app: &AppHandle) -> bool {
    match mode(app) {
        Mode::Off => false,
        Mode::Always => true,
        Mode::Focus => app.state::<BridgeState>().focus_active(),
    }
}

/// Sets the registry to `block` unless it already is. `ask` = may show the UAC prompt.
fn ensure(app: &AppHandle, block: bool, ask: bool) -> Result<(), String> {
    let st = app.state::<IncognitoState>();
    // Also re-applied when someone removed the values by hand.
    if *st.applied.lock().unwrap() == Some(block) && sys::is_blocked() == block {
        return Ok(());
    }
    let mut result = sys::apply(block);
    if matches!(result, Err(sys::Error::Denied)) && ask {
        result = sys::grant().and_then(|()| sys::apply(block));
    }
    let result = result.map_err(|e| e.to_string());
    // A failure isn't remembered as applied, so the next check tries again.
    if result.is_ok() {
        *st.applied.lock().unwrap() = Some(block);
    }
    *st.error.lock().unwrap() = result.as_ref().err().cloned();
    result
}

/// Keeps the browsers' policy in line with the setting and the focus state.
pub fn spawn(app: AppHandle) {
    app.manage(IncognitoState::default());
    spawn_nope_watch(app.clone());
    std::thread::spawn(move || {
        let mut last_try: Option<(bool, std::time::Instant)> = None;
        loop {
            let want = wanted(&app);
            // After a failure, try the same thing again only now and then (no prompt from here).
            let retry_ok = last_try.is_none_or(|(w, t)| w != want || t.elapsed() > Duration::from_secs(60));
            if retry_ok && ensure(&app, want, false).is_err() {
                last_try = Some((want, std::time::Instant::now()));
            } else if retry_ok {
                last_try = None;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

const NOPE: &str = "nope";

/// While private windows are off: someone pressing the private-window shortcut in a browser
/// (Ctrl+Shift+N in Chrome, Edge, Brave; Ctrl+Shift+P in Firefox) gets the wagging "no" hand
/// over the browser for 2 s. The browser itself just ignores the shortcut.
fn spawn_nope_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut was_down = false;
        loop {
            let blocked = *app.state::<IncognitoState>().applied.lock().unwrap() == Some(true);
            if !blocked {
                was_down = false;
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
            let hit = sys::private_shortcut();
            if let Some(rect) = hit.filter(|_| !was_down) {
                show_nope(&app, rect);
            }
            was_down = hit.is_some();
            std::thread::sleep(Duration::from_millis(30));
        }
    });
}

/// `rect` = the browser window (left, top, right, bottom) in screen pixels.
fn show_nope(app: &AppHandle, rect: (i32, i32, i32, i32)) {
    const SIZE: f64 = 200.0;
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = a.get_webview_window(NOPE) {
            let _ = w.close();
        }
        let scale = a.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
        let x = ((rect.0 + rect.2) as f64 / 2.0) / scale - SIZE / 2.0;
        let y = ((rect.1 + rect.3) as f64 / 2.0) / scale - SIZE / 2.0;
        // White hand on a dark page, black on a light one.
        let page = if sys::dark_behind(rect) { "no.html#dark" } else { "no.html" };
        let built = tauri::WebviewWindowBuilder::new(&a, NOPE, tauri::WebviewUrl::App(page.into()))
            .title("No private windows")
            .inner_size(SIZE, SIZE)
            .position(x, y)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .build();
        match built {
            Ok(w) => {
                let _ = w.set_ignore_cursor_events(true);
                let a2 = a.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(2000));
                    let a3 = a2.clone();
                    let _ = a2.run_on_main_thread(move || {
                        if let Some(w) = a3.get_webview_window(NOPE) {
                            let _ = w.close();
                        }
                    });
                });
            }
            Err(e) => eprintln!("kairos: could not show the no hand: {e}"),
        }
    });
}

/// On quit: in "during focus" mode, give private windows back.
pub fn on_exit(app: &AppHandle) {
    if app.try_state::<IncognitoState>().is_some() && mode(app) != Mode::Always {
        let _ = ensure(app, false, false);
    }
}

#[tauri::command]
pub fn get_private_windows(app: AppHandle) -> Status {
    let st = app.state::<IncognitoState>();
    Status { mode: mode(&app), blocked: sys::is_blocked(), error: st.error.lock().unwrap().clone() }
}

#[tauri::command]
pub async fn set_private_windows(app: AppHandle, mode: Mode) -> Result<Status, String> {
    app.state::<StoreState>().with(|s| settings::set(s, KEY, &mode).map_err(|e| e.to_string()))?;
    let a = app.clone();
    // The UAC prompt blocks, so not on the main thread.
    let res = tauri::async_runtime::spawn_blocking(move || {
        let want = wanted(&a);
        // When blocking is wanted at some point, set up permission now while the person is here.
        if mode != Mode::Off && !want {
            ensure(&a, true, true)?;
        }
        *a.state::<IncognitoState>().applied.lock().unwrap() = None;
        ensure(&a, want, true)
    })
    .await
    .map_err(|e| e.to_string())?;
    let status = get_private_windows(app);
    res.map(|()| status)
}

#[cfg(windows)]
mod sys {
    use super::POLICIES;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, ERROR_CANCELLED, ERROR_FILE_NOT_FOUND, GetLastError, HANDLE, HLOCAL, LocalFree};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser};
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_DWORD, REG_OPTION_NON_VOLATILE, RRF_RT_REG_DWORD, RegCloseKey,
        RegCreateKeyExW, RegDeleteValueW, RegGetValueW, RegSetValueExW,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetExitCodeProcess, OpenProcessToken, WaitForSingleObject};
    use windows_sys::Win32::UI::Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    pub enum Error {
        Denied,
        Other(String),
    }

    /// The screen around the middle of `rect` is mostly dark (average brightness under half).
    pub fn dark_behind(rect: (i32, i32, i32, i32)) -> bool {
        use windows_sys::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC};
        let (cx, cy) = ((rect.0 + rect.2) / 2, (rect.1 + rect.3) / 2);
        unsafe {
            let dc = GetDC(std::ptr::null_mut());
            if dc.is_null() {
                return false;
            }
            let (mut sum, mut n) = (0u32, 0u32);
            for dy in [-80, -40, 0, 40, 80] {
                for dx in [-80, -40, 0, 40, 80] {
                    let c = GetPixel(dc, cx + dx, cy + dy);
                    if c == 0xFFFF_FFFF {
                        continue; // CLR_INVALID: off screen
                    }
                    let (r, g, b) = (c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF);
                    sum += (r * 299 + g * 587 + b * 114) / 1000;
                    n += 1;
                }
            }
            ReleaseDC(std::ptr::null_mut(), dc);
            n > 0 && sum / n < 128
        }
    }

    /// The private-window shortcut is held in a browser that's in front: its window rectangle.
    pub fn private_shortcut() -> Option<(i32, i32, i32, i32)> {
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_SHIFT};
        use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;
        let down = |vk: u16| unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000 != 0;
        if !down(VK_CONTROL) || !down(VK_SHIFT) {
            return None;
        }
        let (n, p) = (down(b'N' as u16), down(b'P' as u16));
        if !n && !p {
            return None;
        }
        let w = crate::winapps::foreground()?;
        let exe = w.exe.to_ascii_lowercase();
        let chromium = ["chrome.exe", "msedge.exe", "brave.exe", "chromium.exe", "helium.exe", "vivaldi.exe"].contains(&exe.as_str());
        let firefox = exe == "firefox.exe" || exe == "zen.exe";
        if !((chromium && n) || (firefox && p)) {
            return None;
        }
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe { GetWindowRect(w.hwnd as _, &mut r) };
        Some((r.left, r.top, r.right, r.bottom))
    }

    impl std::fmt::Display for Error {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Error::Denied => f.write_str("Windows needs your OK for some browsers."),
                Error::Other(s) => f.write_str(s),
            }
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn read(path: &str, name: &str) -> Option<u32> {
        let (p, n) = (wide(path), wide(name));
        let mut v: u32 = 0;
        let mut size = 4u32;
        let r = unsafe {
            RegGetValueW(HKEY_CURRENT_USER, p.as_ptr(), n.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), (&mut v as *mut u32).cast(), &mut size)
        };
        (r == 0).then_some(v)
    }

    pub fn is_blocked() -> bool {
        POLICIES.iter().any(|(p, n)| read(p, n) == Some(1))
    }

    fn set(path: &str, name: &str) -> Result<(), Error> {
        let (p, n) = (wide(path), wide(name));
        let mut key: HKEY = std::ptr::null_mut();
        let r = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                p.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE | KEY_QUERY_VALUE,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        };
        if r == ERROR_ACCESS_DENIED {
            return Err(Error::Denied);
        }
        if r != 0 {
            return Err(Error::Other(format!("Couldn't open {path} (error {r}).")));
        }
        let one: u32 = 1;
        let r = unsafe { RegSetValueExW(key, n.as_ptr(), 0, REG_DWORD, (&one as *const u32).cast(), 4) };
        unsafe { RegCloseKey(key) };
        match r {
            0 => Ok(()),
            ERROR_ACCESS_DENIED => Err(Error::Denied),
            r => Err(Error::Other(format!("Couldn't set {name} (error {r})."))),
        }
    }

    fn clear(path: &str, name: &str) -> Result<(), Error> {
        // Only our value (1); something else set by an admin is left alone.
        if read(path, name) != Some(1) {
            return Ok(());
        }
        let (p, n) = (wide(path), wide(name));
        let mut key: HKEY = std::ptr::null_mut();
        let r = unsafe {
            RegCreateKeyExW(HKEY_CURRENT_USER, p.as_ptr(), 0, std::ptr::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, std::ptr::null(), &mut key, std::ptr::null_mut())
        };
        if r == ERROR_ACCESS_DENIED {
            return Err(Error::Denied);
        }
        if r != 0 {
            return Err(Error::Other(format!("Couldn't open {path} (error {r}).")));
        }
        let r = unsafe { RegDeleteValueW(key, n.as_ptr()) };
        unsafe { RegCloseKey(key) };
        match r {
            0 | ERROR_FILE_NOT_FOUND => Ok(()),
            ERROR_ACCESS_DENIED => Err(Error::Denied),
            r => Err(Error::Other(format!("Couldn't remove {name} (error {r})."))),
        }
    }

    pub fn apply(block: bool) -> Result<(), Error> {
        let mut first: Option<Error> = None;
        for (p, n) in POLICIES {
            let r = if block { set(p, n) } else { clear(p, n) };
            if let Err(e) = r {
                first.get_or_insert(e);
            }
        }
        for dir in zen_dirs() {
            if let Err(e) = zen_json(&dir, block) {
                first.get_or_insert(e);
            }
        }
        first.map_or(Ok(()), Err)
    }

    /// Install folders of Zen (where zen.exe is).
    fn zen_dirs() -> Vec<std::path::PathBuf> {
        use std::path::PathBuf;
        let mut out: Vec<PathBuf> = Vec::new();
        let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
        for (base, sub) in [
            (env("ProgramFiles"), "Zen Browser"),
            (env("ProgramFiles"), "Zen Twilight"),
            (env("LOCALAPPDATA"), "Zen Browser"),
            (env("LOCALAPPDATA"), r"Programs\Zen Browser"),
        ] {
            if let Some(b) = base {
                out.push(b.join(sub));
            }
        }
        // Wherever it is installed, Windows' App Paths entry points at zen.exe.
        use windows_sys::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
        for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
            let p = wide(r"Software\Microsoft\Windows\CurrentVersion\App Paths\zen.exe");
            let mut buf = [0u16; 1024];
            let mut size = (buf.len() * 2) as u32;
            let r = unsafe { RegGetValueW(root, p.as_ptr(), std::ptr::null(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size) };
            if r == 0 {
                let n = buf.iter().position(|&c| c == 0).unwrap_or(0);
                let exe = PathBuf::from(String::from_utf16_lossy(&buf[..n]).trim_matches('"'));
                if let Some(d) = exe.parent() {
                    out.push(d.to_path_buf());
                }
            }
        }
        out.sort();
        out.dedup();
        out.retain(|d| d.join("zen.exe").is_file());
        out
    }

    fn zen_json(dir: &std::path::Path, block: bool) -> Result<(), Error> {
        let file = dir.join("distribution").join("policies.json");
        let ours = std::fs::read_to_string(&file).is_ok_and(|t| t.trim() == super::ZEN_POLICIES_JSON);
        let r = if block {
            if file.exists() {
                return Ok(()); // ours already, or someone else's file: left alone
            }
            std::fs::create_dir_all(file.parent().unwrap()).and_then(|()| std::fs::write(&file, super::ZEN_POLICIES_JSON))
        } else if ours {
            std::fs::remove_file(&file)
        } else {
            return Ok(());
        };
        r.map_err(|e| if e.kind() == std::io::ErrorKind::PermissionDenied { Error::Denied } else { Error::Other(format!("Couldn't change Zen's settings: {e}")) })
    }

    /// This user's SID, e.g. "S-1-5-21-…". Used so the elevated helper changes this user's keys
    /// even when a different admin account clicks Yes.
    fn user_sid() -> Option<String> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return None;
            }
            let mut buf = vec![0u8; 256];
            let mut len = 0u32;
            let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), buf.len() as u32, &mut len);
            CloseHandle(token);
            if ok == 0 {
                return None;
            }
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut s: *mut u16 = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut s) == 0 {
                return None;
            }
            let n = (0..).take_while(|&i| *s.add(i) != 0).count();
            let out = String::from_utf16_lossy(std::slice::from_raw_parts(s, n));
            LocalFree(s as HLOCAL);
            Some(out)
        }
    }

    /// One UAC prompt: lets this user change the browser policy keys from now on.
    pub fn grant() -> Result<(), Error> {
        let sid = user_sid().ok_or_else(|| Error::Other("Couldn't read your Windows account.".into()))?;
        if !sid.starts_with("S-1-") || !sid.chars().all(|c| c.is_ascii_digit() || c == '-' || c == 'S') {
            return Err(Error::Other("Couldn't read your Windows account.".into()));
        }
        let keys = POLICIES.iter().map(|(p, _)| format!("'{p}'")).collect::<Vec<_>>().join(",");
        let dirs = zen_dirs().iter().map(|d| format!("'{}'", d.display().to_string().replace('\'', "''"))).collect::<Vec<_>>().join(",");
        let script = format!(
            "$ErrorActionPreference='Stop';$sid='{sid}';$id=New-Object System.Security.Principal.SecurityIdentifier($sid);\
             foreach($p in @({keys})){{$k=[Microsoft.Win32.Registry]::Users.CreateSubKey(\"$sid\\$p\");\
             $a=$k.GetAccessControl();$a.AddAccessRule((New-Object System.Security.AccessControl.RegistryAccessRule($id,'FullControl','ContainerInherit','None','Allow')));\
             $k.SetAccessControl($a);$k.Close()}};\
             foreach($d in @({dirs})){{$t=Join-Path $d 'distribution';New-Item -ItemType Directory -Force -Path $t|Out-Null;\
             $a=Get-Acl $t;$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($id,'Modify','ContainerInherit,ObjectInherit','None','Allow')));Set-Acl $t $a}}"
        );
        let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
        let verb = wide("runas");
        let file = wide("powershell.exe");
        let params = wide(&format!("-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand {encoded}"));
        unsafe {
            let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
            info.fMask = SEE_MASK_NOCLOSEPROCESS;
            info.lpVerb = verb.as_ptr();
            info.lpFile = file.as_ptr();
            info.lpParameters = params.as_ptr();
            info.nShow = SW_HIDE;
            if ShellExecuteExW(&mut info) == 0 {
                return Err(if GetLastError() == ERROR_CANCELLED {
                    Error::Other("Not allowed. Click Yes when Windows asks.".into())
                } else {
                    Error::Other("Couldn't ask Windows for permission.".into())
                });
            }
            if info.hProcess.is_null() {
                return Ok(());
            }
            WaitForSingleObject(info.hProcess, 60_000);
            let mut code = 1u32;
            GetExitCodeProcess(info.hProcess, &mut code);
            CloseHandle(info.hProcess);
            if code != 0 {
                return Err(Error::Other(format!("Windows couldn't change the browser settings (code {code}).")));
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod sys {
    pub enum Error {
        Denied,
        #[allow(dead_code)]
        Other(String),
    }
    impl std::fmt::Display for Error {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Error::Denied => f.write_str("Not allowed."),
                Error::Other(s) => f.write_str(s),
            }
        }
    }
    pub fn is_blocked() -> bool {
        false
    }
    pub fn private_shortcut() -> Option<(i32, i32, i32, i32)> {
        None
    }
    pub fn dark_behind(_rect: (i32, i32, i32, i32)) -> bool {
        false
    }
    pub fn apply(_block: bool) -> Result<(), Error> {
        Ok(())
    }
    pub fn grant() -> Result<(), Error> {
        Err(Error::Other("Windows only.".into()))
    }
}
