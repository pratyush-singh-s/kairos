//! The few Windows calls App tracking and app blocking share: which program is in front, the
//! programs with windows open, and minimizing or bringing back a window. Elsewhere they do
//! nothing, so the rest of the app builds and tests on any system.

/// A top-level window and the file name of the program that owns it, e.g. "Discord.exe".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub hwnd: isize,
    pub exe: String,
}

pub use platform::*;

#[cfg(windows)]
mod platform {
    use super::Window;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GW_OWNER, GWL_EXSTYLE, GetForegroundWindow, GetWindow, GetWindowLongW, GetWindowTextLengthW,
        GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SW_MINIMIZE, SW_RESTORE, SetForegroundWindow, ShowWindow,
        WS_EX_TOOLWINDOW,
    };

    fn exe_of(hwnd: HWND) -> Option<String> {
        // SAFETY: plain Win32 calls with valid out-pointers; the process handle is closed below.
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 {
                return None;
            }
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
            CloseHandle(process);
            if ok == 0 {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit(['\\', '/']).next().map(str::to_string).filter(|s| !s.is_empty())
        }
    }

    /// The window in front and its program.
    pub fn foreground() -> Option<Window> {
        // SAFETY: GetForegroundWindow has no inputs.
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            return None; // e.g. the lock screen
        }
        exe_of(hwnd).map(|exe| Window { hwnd: hwnd as isize, exe })
    }

    /// File name of the program owning the foreground window, e.g. "Code.exe".
    pub fn foreground_exe() -> Option<String> {
        foreground().map(|w| w.exe)
    }

    unsafe extern "system" fn collect(hwnd: HWND, out: LPARAM) -> i32 {
        // SAFETY: `out` is the Vec passed to EnumWindows below, alive for the whole call.
        unsafe {
            let out = &mut *(out as *mut Vec<Window>);
            let tool = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW != 0;
            if IsWindowVisible(hwnd) != 0 && !tool && GetWindow(hwnd, GW_OWNER).is_null() && GetWindowTextLengthW(hwnd) > 0 {
                if let Some(exe) = exe_of(hwnd) {
                    out.push(Window { hwnd: hwnd as isize, exe });
                }
            }
        }
        1
    }

    /// The programs with a window on the taskbar right now.
    pub fn open_windows() -> Vec<Window> {
        let mut out: Vec<Window> = Vec::new();
        // SAFETY: the callback only touches `out`, which outlives the call.
        unsafe {
            EnumWindows(Some(collect), &mut out as *mut Vec<Window> as LPARAM);
        }
        out
    }

    /// Sends a window down to the taskbar.
    pub fn minimize(hwnd: isize) {
        // SAFETY: Windows checks the handle; a closed window is ignored.
        unsafe {
            let h = hwnd as HWND;
            if IsWindow(h) != 0 && IsIconic(h) == 0 {
                ShowWindow(h, SW_MINIMIZE);
            }
        }
    }

    /// Brings a minimized window back to the front.
    pub fn restore(hwnd: isize) {
        // SAFETY: as above.
        unsafe {
            let h = hwnd as HWND;
            if IsWindow(h) != 0 {
                ShowWindow(h, SW_RESTORE);
                SetForegroundWindow(h);
            }
        }
    }

    /// Milliseconds since the last keyboard or mouse input.
    pub fn idle_ms() -> u64 {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        // SAFETY: `info` is a valid LASTINPUTINFO with cbSize set.
        unsafe {
            if GetLastInputInfo(&mut info) == 0 {
                return 0;
            }
            GetTickCount().wrapping_sub(info.dwTime) as u64
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::Window;

    pub fn foreground() -> Option<Window> {
        None
    }
    pub fn foreground_exe() -> Option<String> {
        None
    }
    pub fn open_windows() -> Vec<Window> {
        Vec::new()
    }
    pub fn minimize(_hwnd: isize) {}
    pub fn restore(_hwnd: isize) {}
    pub fn idle_ms() -> u64 {
        0
    }
}
