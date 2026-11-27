//! Real glass that still shows up in screenshots.
//!
//! Real glass needs a copy of the screen behind its window. A plain screen copy contains the window
//! itself, so until 0.21.59.B Focus hid its glass windows from all screen capture
//! (WDA_EXCLUDEFROMCAPTURE), and that hid them from screenshots too.
//!
//! The Windows Magnifier can copy the screen while leaving chosen windows out (a filter list), the
//! same trick screen-sharing apps used. So the glass now asks an invisible Magnifier for the picture
//! behind the Focus windows, and the windows themselves stay visible to Print Screen, Snipping Tool,
//! OBS and the rest. If the Magnifier gives no picture on this PC, glass_capture falls back to the
//! old way (glass_shot.rs).
//!
//! All Magnifier calls run on one worker thread, which owns its (never shown) windows.

#[cfg(windows)]
mod imp {
    use std::cell::RefCell;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};

    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::{ClientToScreen, HRGN};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Magnification::{
        MagInitialize, MagSetImageScalingCallback, MagSetWindowFilterList, MagSetWindowSource, MAGIMAGEHEADER,
        MW_FILTERMODE_EXCLUDE, WC_MAGNIFIER,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, GetClientRect, IsIconic, IsWindow, RegisterClassExW, SetWindowPos, SWP_NOACTIVATE,
        SWP_NOZORDER, WNDCLASSEXW, WS_CHILD, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
        WS_POPUP, WS_VISIBLE,
    };

    struct Request {
        target: isize,
        scale: f64,
        reply: Sender<Result<Vec<u8>, String>>,
    }

    /// The worker, or None when the Magnifier could not start on this PC.
    static WORKER: OnceLock<Option<Mutex<Sender<Request>>>> = OnceLock::new();
    /// Glass windows that get their picture from the Magnifier. Each one is left out of every copy.
    static USING: Mutex<Vec<isize>> = Mutex::new(Vec::new());

    struct Shot {
        width: usize,
        height: usize,
        stride: usize,
        pixels: Vec<u8>,
    }

    thread_local! {
        static SHOT: RefCell<Option<Shot>> = const { RefCell::new(None) };
    }

    /// The Magnifier hands over its picture here, during MagSetWindowSource, on the worker thread.
    unsafe extern "system" fn on_picture(
        _hwnd: HWND,
        src: *mut core::ffi::c_void,
        head: MAGIMAGEHEADER,
        _dest: *mut core::ffi::c_void,
        _dest_head: MAGIMAGEHEADER,
        _unclipped: RECT,
        _clipped: RECT,
        _dirty: HRGN,
    ) -> BOOL {
        let (width, height, stride) = (head.width as usize, head.height as usize, head.stride as usize);
        if src.is_null() || width == 0 || height == 0 || stride < width * 4 || head.cbSize < stride * (height - 1) + width * 4 {
            return 0;
        }
        // 32 bits a pixel, blue first: the same layout as the old screen copy.
        let need = stride * (height - 1) + width * 4;
        // Copy only what is used; a panic here would close Focus, so it is caught.
        let ok = std::panic::catch_unwind(|| {
            let bytes = unsafe { std::slice::from_raw_parts(src as *const u8, need) };
            SHOT.with(|s| *s.borrow_mut() = Some(Shot { width, height, stride, pixels: bytes.to_vec() }));
        });
        ok.is_ok() as BOOL
    }

    unsafe extern "system" fn host_proc(hwnd: HWND, msg: u32, w: usize, l: isize) -> isize {
        unsafe { DefWindowProcW(hwnd, msg, w, l) }
    }

    fn worker() -> Option<&'static Mutex<Sender<Request>>> {
        WORKER
            .get_or_init(|| {
                let (ready_tx, ready_rx) = channel::<Result<(), String>>();
                let (tx, rx) = channel::<Request>();
                std::thread::Builder::new()
                    .name("glass-magnifier".into())
                    .spawn(move || {
                        let mag = match unsafe { start() } {
                            Ok(m) => {
                                let _ = ready_tx.send(Ok(()));
                                m
                            }
                            Err(e) => {
                                let _ = ready_tx.send(Err(e));
                                return;
                            }
                        };
                        for req in rx {
                            let _ = req.reply.send(unsafe { copy(mag, req.target, req.scale) });
                        }
                    })
                    .ok()?;
                match ready_rx.recv() {
                    Ok(Ok(())) => Some(Mutex::new(tx)),
                    Ok(Err(e)) => {
                        crate::glass_shot::note(&format!("Magnifier could not start: {e}"));
                        None
                    }
                    Err(_) => None,
                }
            })
            .as_ref()
    }

    /// Makes the hidden host window and the Magnifier inside it. Runs on the worker thread.
    unsafe fn start() -> Result<HWND, String> {
        unsafe {
            if MagInitialize() == 0 {
                return Err("MagInitialize failed".into());
            }
            let inst = GetModuleHandleW(std::ptr::null());
            let class = windows_sys::core::w!("FocusGlassMagnifierHost");
            let mut wc: WNDCLASSEXW = std::mem::zeroed();
            wc.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
            wc.lpfnWndProc = Some(host_proc);
            wc.hInstance = inst;
            wc.lpszClassName = class;
            RegisterClassExW(&wc);
            // Never shown: the Magnifier only has to draw into memory.
            let host = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
                class,
                windows_sys::core::w!("Focus glass"),
                WS_POPUP,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                inst,
                std::ptr::null(),
            );
            if host.is_null() {
                return Err("could not make the host window".into());
            }
            let mag = CreateWindowExW(
                0,
                WC_MAGNIFIER,
                windows_sys::core::w!("Focus glass magnifier"),
                WS_CHILD | WS_VISIBLE,
                0,
                0,
                0,
                0,
                host,
                std::ptr::null_mut(),
                inst,
                std::ptr::null(),
            );
            if mag.is_null() {
                return Err("could not make the Magnifier window".into());
            }
            if MagSetImageScalingCallback(mag, Some(on_picture)) == 0 {
                return Err("MagSetImageScalingCallback failed".into());
            }
            Ok(mag)
        }
    }

    /// One picture of the screen behind `target`'s inside area, with every glass window left out,
    /// shrunk by `scale`. Same bytes as commands::capture_behind: width, height, then BGRA rows.
    unsafe fn copy(mag: HWND, target: isize, scale: f64) -> Result<Vec<u8>, String> {
        unsafe {
            let hwnd = target as HWND;
            let mut rect: RECT = std::mem::zeroed();
            if IsWindow(hwnd) == 0 || GetClientRect(hwnd, &mut rect) == 0 {
                return Err("could not read the window size".into());
            }
            let mut origin = POINT { x: 0, y: 0 };
            ClientToScreen(hwnd, &mut origin);
            let (sw, sh) = (rect.right - rect.left, rect.bottom - rect.top);
            if sw <= 0 || sh <= 0 || sw > 8192 || sh > 8192 {
                return Err("the window has no usable size".into());
            }
            // Never point the Magnifier off screen (a minimized window sits at -32000, -32000).
            if IsIconic(hwnd) != 0
                || crate::commands::on_screen(RECT { left: origin.x, top: origin.y, right: origin.x + sw, bottom: origin.y + sh }).is_none()
            {
                return Err("paused".into());
            }
            SetWindowPos(mag, std::ptr::null_mut(), 0, 0, sw, sh, SWP_NOZORDER | SWP_NOACTIVATE);
            let mut skip: Vec<HWND> = {
                let list = USING.lock().unwrap_or_else(|e| e.into_inner());
                list.iter().map(|&h| h as HWND).collect()
            };
            if !skip.contains(&hwnd) {
                skip.push(hwnd);
            }
            if MagSetWindowFilterList(mag, MW_FILTERMODE_EXCLUDE, skip.len() as i32, skip.as_mut_ptr()) == 0 {
                return Err("MagSetWindowFilterList failed".into());
            }
            SHOT.with(|s| *s.borrow_mut() = None);
            let source = RECT { left: origin.x, top: origin.y, right: origin.x + sw, bottom: origin.y + sh };
            if MagSetWindowSource(mag, source) == 0 {
                return Err("MagSetWindowSource failed".into());
            }
            let Some(shot) = SHOT.with(|s| s.borrow_mut().take()) else {
                return Err("the Magnifier sent no picture".into());
            };
            Ok(shrink(&shot, scale))
        }
    }

    /// Box-filters the picture down (each output pixel is the average of the pixels it covers).
    fn shrink(shot: &Shot, scale: f64) -> Vec<u8> {
        let (sw, sh) = (shot.width, shot.height);
        let w = ((sw as f64 * scale).round() as usize).clamp(1, sw);
        let h = ((sh as f64 * scale).round() as usize).clamp(1, sh);
        let mut out = vec![0u8; 8 + w * h * 4];
        out[0..4].copy_from_slice(&(w as u32).to_le_bytes());
        out[4..8].copy_from_slice(&(h as u32).to_le_bytes());
        let px = &shot.pixels;
        for y in 0..h {
            let (y0, y1) = (y * sh / h, ((y + 1) * sh / h).max(y * sh / h + 1));
            for x in 0..w {
                let (x0, x1) = (x * sw / w, ((x + 1) * sw / w).max(x * sw / w + 1));
                let mut sum = [0u32; 3];
                for sy in y0..y1 {
                    let row = sy * shot.stride;
                    for sx in x0..x1 {
                        let i = row + sx * 4;
                        sum[0] += px[i] as u32;
                        sum[1] += px[i + 1] as u32;
                        sum[2] += px[i + 2] as u32;
                    }
                }
                let n = ((y1 - y0) * (x1 - x0)) as u32;
                let o = 8 + (y * w + x) * 4;
                out[o] = (sum[0] / n) as u8;
                out[o + 1] = (sum[1] / n) as u8;
                out[o + 2] = (sum[2] / n) as u8;
                out[o + 3] = 255;
            }
        }
        out
    }

    fn ask(target: isize, scale: f64) -> Result<Vec<u8>, String> {
        let Some(worker) = worker() else { return Err("the Magnifier is not available".into()) };
        let (reply, answer) = channel();
        worker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .send(Request { target, scale, reply })
            .map_err(|_| "the Magnifier stopped".to_string())?;
        answer.recv().map_err(|_| "the Magnifier stopped".to_string())?
    }

    /// Starts Magnifier glass for one window, after checking that a test picture really arrives.
    /// false: this PC's Magnifier can't do it, so the caller uses the old way.
    pub fn begin(target: isize) -> bool {
        USING.lock().unwrap_or_else(|e| e.into_inner()).retain(|&h| h != target);
        USING.lock().unwrap_or_else(|e| e.into_inner()).push(target);
        match ask(target, 0.25) {
            // Minimized or off screen right now: try the Magnifier again when it is back.
            Err(e) if e == "paused" => true,
            Ok(_) => {
                crate::glass_shot::note(&format!("window {target:#x}: glass copies through the Magnifier, so it stays in screenshots"));
                true
            }
            Err(e) => {
                end(target);
                crate::glass_shot::note(&format!("window {target:#x}: Magnifier copy failed ({e}), using hide-from-capture instead"));
                false
            }
        }
    }

    pub fn end(target: isize) {
        USING.lock().unwrap_or_else(|e| e.into_inner()).retain(|&h| h != target);
    }

    pub fn active(target: isize) -> bool {
        USING.lock().unwrap_or_else(|e| e.into_inner()).contains(&target)
    }

    pub fn frame(target: isize, scale: f64) -> Result<Vec<u8>, String> {
        ask(target, scale)
    }
}

#[cfg(windows)]
pub use imp::{active, begin, end, frame};
