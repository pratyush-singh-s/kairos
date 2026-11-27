//! The link to the Focus Blocker extension (Phase 13). The browser asks a tiny HTTP server on
//! 127.0.0.1 whether a focus phase is on, and blocks while it is.
//!
//! Native messaging was the plan, but Zen (the browser Ps uses) currently fails to start native
//! hosts on Windows, so the extension polls this loopback port instead; any Firefox-based
//! browser can reach it. Requests wait up to 25 s for a change (long polling), so the browser
//! hears about a new phase at once without asking every second.
//!
//! Since the app's Blocking page, the answer also carries the blocking lists (and the app's theme),
//! so every browser on this PC blocks the same things. A browser that had lists of its own before
//! hands them over once with `POST /v1/blocking/import` (JSON body), while the app has none.
//! YouTube tag groups can also be changed from a browser: `POST /v1/blocking/groups` with
//! `{"groups":[…]}` replaces only the groups (0.21.4).
//!
//! The extension also reports distractions here (Phase 20): `POST /v1/distraction?kind=…&domain=…`
//! when a blocked page opens or "Continue anyway" is pressed. Only the site name is sent.
//!
//! Only this PC can connect (loopback). A web page could send a request but cannot read the
//! answer (no CORS headers), and requests carrying a web page's Origin are refused outright ("null" may only read).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use focus_store::blocking::{self, BlockingLists};
use focus_store::phone_block;
use focus_store::stats::{self, DistractionKind};
use focus_timer::{Phase, Snapshot, Status};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::StoreState;

/// What requests may change in the app. Separate from the server so tests can watch them.
pub struct Hooks<'a> {
    /// Saves a distraction the extension reported (kind and cleaned site name).
    pub report: &'a dyn Fn(DistractionKind, Option<String>),
    /// A browser's own lists, offered once; returns whether the app took them.
    pub import: &'a dyn Fn(BlockingLists) -> bool,
    /// New YouTube tag groups from a browser; returns whether the app saved them.
    pub groups: &'a dyn Fn(serde_json::Value) -> bool,
    /// "Why are you here?": the reason given before continuing to a site (and the site).
    pub reason: &'a dyn Fn(String, Option<String>),
}

/// The port the extension asks. Fixed, so nothing has to be configured on either side.
pub const PORT: u16 = 47811;

/// How long a request may wait for a change before answering with the same state.
const LONG_POLL: Duration = Duration::from_secs(25);

/// How long after a request ends the browser still counts as linked (it asks again at once).
const LINK_GRACE: Duration = Duration::from_secs(5);

/// What the extension needs to know. Mirrored by `AppFocus` in apps/extension/src/link.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FocusState {
    /// Block now: a focus phase is running or paused. Breaks and an idle timer don't block.
    pub active: bool,
    pub paused: bool,
    /// When the running focus phase ends (ms since epoch), rounded to the second; None while paused.
    pub ends_at_ms: Option<u64>,
    pub preset_name: Option<String>,
}

impl FocusState {
    pub fn from_snapshot(s: &Snapshot) -> Self {
        let focus = s.phase == Phase::Focus && matches!(s.status, Status::Running | Status::Paused);
        let paused = focus && s.status == Status::Paused;
        Self {
            active: focus,
            paused,
            ends_at_ms: if focus && !paused { s.ends_at_ms.map(|t| t.div_ceil(1000) * 1000) } else { None },
            preset_name: if focus { s.preset_name.clone() } else { None },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reply<'a> {
    /// Goes up by one on every change; the extension sends it back as `since`.
    version: u64,
    app_version: &'a str,
    #[serde(flatten)]
    state: &'a FocusState,
    /// False until the app has lists of its own; a browser may then hand over its lists.
    blocking_configured: bool,
    /// `{ rules, youtube, defaultWait, theme }` once configured. Mirrors `AppBlocking` in link.ts.
    #[serde(skip_serializing_if = "Option::is_none")]
    blocking: Option<&'a serde_json::Value>,
}

struct Shared {
    version: u64,
    state: FocusState,
    blocking_configured: bool,
    blocking: Option<serde_json::Value>,
    /// Requests from the extension waiting for a change right now. While the browser runs one
    /// is almost always open; it closes the moment the browser does.
    waiting: u32,
    /// When the last request started or ended, to cover the gap between two of them.
    last_seen: Option<Instant>,
    /// False when the port could not be opened.
    listening: bool,
    /// Per browser (named from its User-Agent): requests waiting now, and when it was last seen.
    browsers: std::collections::BTreeMap<String, (u32, Option<Instant>)>,
}

/// Mirrors `BrowserLink` in src/ipc/browserLink.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    /// The extension has a request open, or had one in the last few seconds.
    pub linked: bool,
    /// Linked and a focus phase is on, so the browser is blocking.
    pub blocking: bool,
    /// The app could open its port.
    pub listening: bool,
    /// Which browsers are linked right now, e.g. ["Firefox", "Chrome"].
    pub browsers: Vec<String>,
}

pub struct BridgeState {
    shared: Mutex<Shared>,
    changed: Condvar,
}

impl BridgeState {
    pub fn new() -> Self {
        Self {
            shared: Mutex::new(Shared {
                version: 1,
                state: FocusState { active: false, paused: false, ends_at_ms: None, preset_name: None },
                blocking_configured: false,
                blocking: None,
                waiting: 0,
                last_seen: None,
                listening: true,
                browsers: Default::default(),
            }),
            changed: Condvar::new(),
        }
    }

    /// Called with the focus state on every timer tick; wakes waiting requests only when something changed.
    pub fn publish(&self, next: FocusState) {
        let Ok(mut s) = self.shared.lock() else { return };
        if s.state != next {
            s.state = next;
            s.version += 1;
            self.changed.notify_all();
        }
    }

    /// A focus (or anything else that turns site blocking on) is running.
    pub fn focus_active(&self) -> bool {
        self.shared.lock().map(|s| s.state.active).unwrap_or(false)
    }

    /// New blocking lists for the browsers; wakes waiting requests only when something changed.
    pub fn set_blocking(&self, configured: bool, payload: Option<serde_json::Value>) {
        let Ok(mut s) = self.shared.lock() else { return };
        if s.blocking_configured != configured || s.blocking != payload {
            s.blocking_configured = configured;
            s.blocking = payload;
            s.version += 1;
            self.changed.notify_all();
        }
    }

    /// What the dashboard shows. The extension keeps a request open while the browser runs
    /// (asking again at once after each answer), so none open for 5 s means it is gone.
    pub fn status(&self) -> LinkStatus {
        let Ok(s) = self.shared.lock() else { return LinkStatus { linked: false, blocking: false, listening: false, browsers: vec![] } };
        let linked = s.waiting > 0 || s.last_seen.is_some_and(|t| t.elapsed() < LINK_GRACE);
        let browsers = s
            .browsers
            .iter()
            .filter(|(_, (waiting, seen))| *waiting > 0 || seen.is_some_and(|t| t.elapsed() < LINK_GRACE))
            .map(|(name, _)| name.clone())
            .collect();
        LinkStatus { linked, blocking: linked && s.state.active, listening: s.listening, browsers }
    }

    /// The state as JSON once it differs from `since`, or after the long-poll wait. Checks
    /// `gone` every second and gives up (None) as soon as the browser has hung up.
    fn wait_reply(&self, since: Option<u64>, gone: &dyn Fn() -> bool) -> Option<String> {
        self.wait_reply_from(since, gone, None)
    }

    /// `wait_reply`, remembering which browser asked (for "Connected: Firefox").
    fn wait_reply_from(&self, since: Option<u64>, gone: &dyn Fn() -> bool, browser: Option<&str>) -> Option<String> {
        let started = Instant::now();
        let mut s = self.shared.lock().ok()?;
        s.waiting += 1;
        s.last_seen = Some(started);
        if let Some(b) = browser {
            let e = s.browsers.entry(b.to_string()).or_insert((0, None));
            e.0 += 1;
            e.1 = Some(started);
        }
        let mut hung_up = false;
        while since == Some(s.version) && started.elapsed() < LONG_POLL {
            s = match self.changed.wait_timeout(s, Duration::from_secs(1)) {
                Ok((guard, _)) => guard,
                Err(_) => return None,
            };
            if since == Some(s.version) {
                drop(s);
                hung_up = gone();
                s = self.shared.lock().ok()?;
                if hung_up {
                    break;
                }
            }
        }
        s.waiting -= 1;
        s.last_seen = Some(Instant::now());
        if let Some(e) = browser.and_then(|b| s.browsers.get_mut(b)) {
            e.0 = e.0.saturating_sub(1);
            e.1 = if hung_up { None } else { Some(Instant::now()) };
        }
        if hung_up {
            // Closed browser: drop the "seen" grace too, so the dashboard updates at once.
            s.last_seen = None;
            return None;
        }
        serde_json::to_string(&Reply {
            version: s.version,
            app_version: env!("CARGO_PKG_VERSION"),
            state: &s.state,
            blocking_configured: s.blocking_configured,
            blocking: s.blocking.as_ref(),
        })
        .ok()
    }
}

/// Starts the server. If the port is taken (another Focus, or another program), the link is
/// simply off; the rest of the app is unaffected.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("focus: browser link is off, port {PORT} is busy: {e}");
                if let Ok(mut s) = app.state::<BridgeState>().shared.lock() {
                    s.listening = false;
                }
                return;
            }
        };
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                let report = |kind, domain| record_distraction(&app, kind, domain);
                let import = |lists| import_lists(&app, lists);
                let groups = |groups| save_tag_groups(&app, groups);
                let reason = |text: String, domain: Option<String>| record_reason(&app, &text, domain.as_deref().unwrap_or("a site"));
                let hooks = Hooks { report: &report, import: &import, groups: &groups, reason: &reason };
                let _ = serve(&app.state::<BridgeState>(), stream, &hooks);
            });
        }
    });
}

/// "a+b%20c" → "a b c" (a query value from URLSearchParams). Bad escapes are kept as they are.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => match (hex(b[i + 1]), hex(b[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Saves a "Why are you here?" answer (any time; it is only asked during focus).
pub(crate) fn record_reason(app: &AppHandle, text: &str, what: &str) {
    let saved = app
        .state::<StoreState>()
        .with(|s| focus_store::reasons::add(s, text, what, crate::timer::now_ms() as i64).map_err(|e| e.to_string()));
    match saved {
        Ok(()) => {
            let _ = app.emit("stats-changed", ());
        }
        Err(e) => eprintln!("focus: could not save a reason: {e}"),
    }
}

/// Counts a distraction only while a focus phase is on, against the session running now.
pub(crate) fn record_distraction(app: &AppHandle, kind: DistractionKind, domain: Option<String>) {
    let active = app.state::<BridgeState>().shared.lock().map(|s| s.state.active).unwrap_or(false);
    if !active {
        return;
    }
    let session = app.state::<crate::history::RecordState>().0.lock().ok().and_then(|r| r.open_row.clone());
    let saved = app.state::<StoreState>().with(|s| {
        stats::add_distraction(s, session.as_deref(), kind, domain.as_deref(), crate::timer::now_ms() as i64).map_err(|e| e.to_string())
    });
    match saved {
        Ok(()) => {
            let _ = app.emit("stats-changed", ());
        }
        Err(e) => eprintln!("focus: could not save a distraction: {e}"),
    }
}

/// Takes a browser's own lists while the app has none, then sends them back out to every browser.
fn import_lists(app: &AppHandle, lists: BlockingLists) -> bool {
    let taken = app.state::<StoreState>().with(|s| blocking::import(s, &lists).map_err(|e| e.to_string()));
    match taken {
        Ok(true) => {
            publish_blocking(app);
            let _ = app.emit("blocking-changed", ());
            true
        }
        Ok(false) => false,
        Err(e) => {
            eprintln!("focus: could not take the browser's lists: {e}");
            false
        }
    }
}

/// Saves tag groups a browser made, then sends the lists back out (to the Blocking page too).
fn save_tag_groups(app: &AppHandle, groups: serde_json::Value) -> bool {
    let saved = app.state::<StoreState>().with(|s| blocking::set_tag_groups(s, &groups).map_err(|e| e.to_string()));
    match saved {
        Ok(true) => {
            publish_blocking(app);
            let _ = app.emit("blocking-changed", ());
            true
        }
        Ok(false) => false,
        Err(e) => {
            eprintln!("focus: could not save the browser's tag groups: {e}");
            false
        }
    }
}

/// What the phone is told: whether a focus phase is on (so it blocks its apps too) and the
/// whole timer, breaks included, so it can show it and send Pause or Stop back.
pub fn live_for_phone(s: &FocusState, snap: &Snapshot, device_id: &str, now: u64) -> phone_block::FocusLive {
    let running = matches!(snap.status, Status::Running | Status::Paused);
    let paused = snap.status == Status::Paused;
    let clock = running.then(|| phone_block::LiveClock {
        device_id: device_id.to_string(),
        phase: if snap.phase == Phase::Focus { "focus" } else { "break" }.into(),
        round: snap.session,
        // A run that repeats until stopped reports 24 (old apps show "x/24").
        rounds: if snap.sessions == u32::MAX { focus_timer::REPEAT_SESSIONS } else { snap.sessions },
        paused,
        left_ms: paused.then_some(snap.remaining_ms.div_ceil(1000) * 1000),
        ends_at_ms: if paused { None } else { snap.ends_at_ms.map(|t| t.div_ceil(1000) * 1000) },
    });
    phone_block::FocusLive {
        active: s.active,
        paused: s.paused,
        ends_at_ms: s.ends_at_ms,
        preset_name: if running { snap.preset_name.clone() } else { None },
        updated_at_ms: now,
        clock,
    }
}

/// Saves `live` for the phone (through sync). Returns false if it could not be saved (the
/// caller tries again on the next tick).
pub fn share_with_phone(app: &AppHandle, live: &phone_block::FocusLive) -> bool {
    match app.state::<StoreState>().with(|st| phone_block::publish_live(st, live).map_err(|e| e.to_string())) {
        Ok(_) => true,
        Err(e) => {
            eprintln!("focus: could not share the focus state with the phone: {e}");
            false
        }
    }
}

/// Sends the saved lists and the app's theme to the browsers. Call after any change to them.
pub fn publish_blocking(app: &AppHandle) {
    let read = app.state::<StoreState>().with(|s| {
        let b = blocking::get(s).map_err(|e| e.to_string())?;
        let theme: String = focus_store::settings::get(s, "ui.theme").map_err(|e| e.to_string())?;
        let colors: Option<serde_json::Value> = focus_store::settings::get(s, "ui.extColors").ok().flatten();
        Ok((b, theme, colors))
    });
    let Ok((b, theme, colors)) = read else { return };
    let payload = b.configured.then(|| {
        serde_json::json!({ "rules": b.lists.rules, "youtube": b.lists.youtube, "defaultWait": b.lists.default_wait, "theme": theme, "colors": colors })
    });
    app.state::<BridgeState>().set_blocking(b.configured, payload);
}

/// The browser's name from its User-Agent. Brave and other Chrome-based browsers say "Chrome".
pub fn browser_name(agent: &str) -> Option<&'static str> {
    if agent.is_empty() {
        None
    } else if agent.contains("Edg/") {
        Some("Edge")
    } else if agent.contains("OPR/") {
        Some("Opera")
    } else if agent.contains("Zen/") || agent.contains("Zen ") {
        Some("Zen")
    } else if agent.contains("Firefox/") {
        Some("Firefox")
    } else if agent.contains("Chrome/") {
        Some("Chrome")
    } else {
        Some("Browser")
    }
}

/// The browser name for a program file, e.g. "zen.exe" → "Zen".
pub fn browser_from_exe(exe: &str) -> Option<&'static str> {
    Some(match exe.to_ascii_lowercase().as_str() {
        "zen.exe" => "Zen",
        "firefox.exe" => "Firefox",
        "librewolf.exe" => "LibreWolf",
        "floorp.exe" => "Floorp",
        "waterfox.exe" => "Waterfox",
        "chrome.exe" => "Chrome",
        "msedge.exe" => "Edge",
        "brave.exe" => "Brave",
        "helium.exe" => "Helium",
        "vivaldi.exe" => "Vivaldi",
        "opera.exe" => "Opera",
        "chromium.exe" => "Chromium",
        "arc.exe" => "Arc",
        "thorium.exe" => "Thorium",
        _ => return None,
    })
}

/// Which browser owns the local connection coming from `port` (Windows only).
#[cfg(windows)]
fn peer_browser(port: u16) -> Option<&'static str> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_ALL};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW};
    const AF_INET: u32 = 2;
    let pid = unsafe {
        let mut size = 0u32;
        GetExtendedTcpTable(std::ptr::null_mut(), &mut size, 0, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
        if size == 0 {
            return None;
        }
        // u32 words keep the table aligned.
        let mut buf = vec![0u32; (size as usize).div_ceil(4) + 8];
        size = (buf.len() * 4) as u32;
        if GetExtendedTcpTable(buf.as_mut_ptr().cast(), &mut size, 0, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) != 0 {
            return None;
        }
        let n = buf[0] as usize;
        let rows = std::slice::from_raw_parts(buf.as_ptr().add(1) as *const MIB_TCPROW_OWNER_PID, n);
        rows.iter()
            .find(|r| u16::from_be(r.dwLocalPort as u16) == port && u16::from_be(r.dwRemotePort as u16) == PORT)
            .map(|r| r.dwOwningPid)?
    };
    unsafe {
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
        path.rsplit(['\\', '/']).next().and_then(browser_from_exe)
    }
}

#[cfg(not(windows))]
fn peer_browser(_port: u16) -> Option<&'static str> {
    None
}

fn serve(bridge: &BridgeState, stream: TcpStream, hooks: &Hooks) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.by_ref().take(2048).read_line(&mut request_line)?;
    let mut origin = None;
    let mut agent = String::new();
    let mut length = 0usize;
    // Headers, up to a blank line; anything huge is cut off by `take`.
    let mut headers = reader.by_ref().take(16 * 1024);
    loop {
        let mut line = String::new();
        if headers.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("origin") {
                origin = Some(value.trim().to_string());
            } else if name.trim().eq_ignore_ascii_case("user-agent") {
                agent = value.trim().to_string();
            } else if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    // A body only for the lists a browser hands over; too big is refused unread.
    let mut body = String::new();
    if length > blocking::MAX_BYTES {
        request_line = "TOO-BIG / HTTP/1.1".into();
    } else if length > 0 {
        reader.take(length as u64).read_to_string(&mut body)?;
    }
    let mut out = stream;
    // The browser closing (or the extension being turned off) closes the connection: a peek
    // then reads 0 bytes or fails, instead of "nothing to read yet".
    let gone = || {
        if out.set_nonblocking(true).is_err() {
            return true;
        }
        let mut byte = [0u8; 1];
        let closed = match out.peek(&mut byte) {
            Ok(0) => true,
            Ok(_) => false,
            Err(e) => e.kind() != std::io::ErrorKind::WouldBlock,
        };
        let _ = out.set_nonblocking(false);
        closed
    };
    // The program on the other end names the browser best (Zen looks like Firefox, Helium like Chrome).
    let browser = out.peer_addr().ok().and_then(|a| peer_browser(a.port())).or_else(|| browser_name(&agent));
    let Some((status, body)) = route(bridge, &request_line, origin.as_deref(), &body, &gone, hooks, browser) else { return Ok(()) };
    write!(
        out,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    out.flush()
}

/// `GET /v1/focus?since=N` → the focus state (and lists); `POST /v1/distraction?kind=K&domain=D`
/// `POST /v1/blocking/import` (JSON lists) and `POST /v1/blocking/groups` (tag groups) → saved.
/// Requests from web pages are refused; the extension and local tools such as curl get an answer.
fn route(
    bridge: &BridgeState,
    request_line: &str,
    origin: Option<&str>,
    body: &str,
    gone: &dyn Fn() -> bool,
    hooks: &Hooks,
    browser: Option<&str>,
) -> Option<(&'static str, String)> {
    let mut parts = request_line.split_whitespace();
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return Some(("400 Bad Request", r#"{"error":"bad request"}"#.into()));
    };
    // The extension sends moz-extension://… or chrome-extension://… (or nothing). Web pages send
    // their http(s) address and are always refused. "null" (a sandboxed frame or a file) may only
    // read, never change anything: the answer can't be read without CORS headers anyway.
    let from_extension = origin.is_none_or(|o| o.starts_with("moz-extension://") || o.starts_with("chrome-extension://"));
    let refused = match origin {
        Some(o) if o.starts_with("http://") || o.starts_with("https://") => true,
        _ => !from_extension && method != "GET",
    };
    if refused {
        return Some(("403 Forbidden", r#"{"error":"only the Focus Blocker extension may ask"}"#.into()));
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let param = |name: &str| query.split('&').find_map(|kv| kv.strip_prefix(name)?.strip_prefix('='));
    if method == "POST" && path == "/v1/distraction" {
        let Some(kind) = param("kind").and_then(DistractionKind::parse) else {
            return Some(("400 Bad Request", r#"{"error":"unknown kind"}"#.into()));
        };
        let domain = param("domain").and_then(stats::clean_domain);
        if let Some(text) = param("reason").map(percent_decode).filter(|t| !t.trim().is_empty()) {
            (hooks.reason)(text, domain.clone());
        }
        (hooks.report)(kind, domain);
        return Some(("200 OK", "{}".into()));
    }
    if method == "POST" && path == "/v1/blocking/import" {
        let Ok(lists) = serde_json::from_str::<BlockingLists>(body) else {
            return Some(("400 Bad Request", r#"{"error":"bad lists"}"#.into()));
        };
        if blocking::check(&lists).is_err() {
            return Some(("400 Bad Request", r#"{"error":"bad lists"}"#.into()));
        }
        let taken = (hooks.import)(lists);
        return Some(("200 OK", format!(r#"{{"taken":{taken}}}"#)));
    }
    if method == "POST" && path == "/v1/blocking/groups" {
        let groups = serde_json::from_str::<serde_json::Value>(body).ok().and_then(|mut v| v.get_mut("groups").map(serde_json::Value::take));
        let Some(groups) = groups.filter(serde_json::Value::is_array) else {
            return Some(("400 Bad Request", r#"{"error":"bad groups"}"#.into()));
        };
        let saved = (hooks.groups)(groups);
        return Some(("200 OK", format!(r#"{{"saved":{saved}}}"#)));
    }
    if method != "GET" {
        return Some(("400 Bad Request", r#"{"error":"bad request"}"#.into()));
    }
    if path != "/v1/focus" {
        return Some(("404 Not Found", r#"{"error":"not found"}"#.into()));
    }
    let since = param("since").and_then(|v| v.parse().ok());
    bridge.wait_reply_from(since, gone, browser).map(|body| ("200 OK", body))
}

#[tauri::command]
pub fn browser_link_status(bridge: tauri::State<'_, BridgeState>) -> LinkStatus {
    bridge.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(status: Status, phase: Phase) -> Snapshot {
        Snapshot {
            status,
            phase,
            session: 1,
            sessions: 4,
            duration_ms: 1_500_000,
            remaining_ms: 600_000,
            ends_at_ms: if status == Status::Running { Some(1_000_000_400) } else { None },
            preset_id: None,
            preset_name: Some("Classic".into()),
        }
    }

    #[test]
    fn only_focus_phases_block() {
        let s = FocusState::from_snapshot(&snap(Status::Running, Phase::Focus));
        assert!(s.active && !s.paused);
        assert_eq!(s.ends_at_ms, Some(1_000_001_000), "rounded up to the second");
        let p = FocusState::from_snapshot(&snap(Status::Paused, Phase::Focus));
        assert!(p.active && p.paused && p.ends_at_ms.is_none());
        for (status, phase) in [(Status::Running, Phase::ShortBreak), (Status::Running, Phase::LongBreak), (Status::Waiting, Phase::Focus), (Status::Idle, Phase::Focus), (Status::Finished, Phase::Focus)] {
            assert!(!FocusState::from_snapshot(&snap(status, phase)).active, "{status:?} {phase:?}");
        }
    }

    #[test]
    fn version_moves_only_on_change() {
        let b = BridgeState::new();
        b.publish(FocusState::from_snapshot(&snap(Status::Running, Phase::Focus)));
        let v = b.shared.lock().unwrap().version;
        b.publish(FocusState::from_snapshot(&snap(Status::Running, Phase::Focus)));
        assert_eq!(b.shared.lock().unwrap().version, v);
        b.publish(FocusState::from_snapshot(&snap(Status::Running, Phase::ShortBreak)));
        assert_eq!(b.shared.lock().unwrap().version, v + 1);
        // An out-of-date `since` answers at once.
        let reply: serde_json::Value = serde_json::from_str(&b.wait_reply(Some(v), &|| false).unwrap()).unwrap();
        assert_eq!(reply["active"], false);
    }

    /// Sends one raw HTTP request to a server running `serve` and returns the whole answer.
    fn http(bridge: &'static BridgeState, request: &str) -> String {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            serve(bridge, stream, &Hooks { report: &|_, _| {}, import: &|_| true, groups: &|_| true, reason: &|_, _| {} }).unwrap();
        });
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.write_all(request.as_bytes()).unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        server.join().unwrap();
        out
    }

    #[test]
    fn answers_the_extension_and_refuses_web_pages() {
        let b: &'static BridgeState = Box::leak(Box::new(BridgeState::new()));
        b.publish(FocusState::from_snapshot(&snap(Status::Running, Phase::Focus)));
        let ok = http(b, "GET /v1/focus HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: moz-extension://abc\r\n\r\n");
        assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
        assert!(ok.contains(r#""active":true"#) && ok.contains(r#""endsAtMs":1000001000"#), "{ok}");
        assert!(!ok.to_ascii_lowercase().contains("access-control-allow-origin"));
        let sandboxed = http(b, "POST /v1/blocking/import HTTP/1.1\r\nOrigin: null\r\nContent-Length: 2\r\n\r\n{}");
        assert!(sandboxed.starts_with("HTTP/1.1 403"), "{sandboxed}");
        let read = http(b, "GET /v1/focus HTTP/1.1\r\nOrigin: null\r\n\r\n");
        assert!(read.starts_with("HTTP/1.1 200"), "{read}");
        let web = http(b, "GET /v1/focus HTTP/1.1\r\nOrigin: https://evil.example\r\n\r\n");
        assert!(web.starts_with("HTTP/1.1 403"), "{web}");
        let other = http(b, "GET /secret HTTP/1.1\r\n\r\n");
        assert!(other.starts_with("HTTP/1.1 404"), "{other}");
    }

    #[test]
    fn distractions_are_reported_with_the_site_only() {
        let b = BridgeState::new();
        let got = std::cell::RefCell::new(Vec::new());
        let report = |k: DistractionKind, d: Option<String>| got.borrow_mut().push((k, d));
        let hooks = Hooks { report: &report, import: &|_| true, groups: &|_| true, reason: &|_, _| {} };
        let post = |line: &str, origin: Option<&str>| route(&b, line, origin, "", &|| false, &hooks, None).unwrap().0;
        assert_eq!(post("POST /v1/distraction?kind=blocked_hit&domain=www.YouTube.com HTTP/1.1", Some("moz-extension://a")), "200 OK");
        assert_eq!(post("POST /v1/distraction?kind=spam HTTP/1.1", None), "400 Bad Request");
        assert_eq!(post("POST /v1/distraction?kind=continued HTTP/1.1", Some("https://evil.example")), "403 Forbidden");
        assert_eq!(percent_decode("Need+it%20for%20work%E2%9C%93%2"), "Need it for work✓%2");
        let odd = route(&b, "POST /v1/distraction?kind=continued&domain=a/b HTTP/1.1", None, "", &|| false, &hooks, None);
        assert_eq!(odd.unwrap().0, "200 OK");
        assert_eq!(*got.borrow(), vec![(DistractionKind::BlockedHit, Some("youtube.com".into())), (DistractionKind::Continued, None)]);
    }

    #[test]
    fn a_browser_can_regroup_the_tags() {
        let b = BridgeState::new();
        let got = std::cell::RefCell::new(Vec::new());
        let groups = |g: serde_json::Value| {
            got.borrow_mut().push(g);
            true
        };
        let hooks = Hooks { report: &|_, _| {}, import: &|_| true, groups: &groups, reason: &|_, _| {} };
        let post = |body: &str, origin: Option<&str>| route(&b, "POST /v1/blocking/groups HTTP/1.1", origin, body, &|| false, &hooks, None).unwrap();
        let ok = post(r#"{"groups":[{"name":"Gaming","tags":["gaming","sologaming"]}]}"#, Some("moz-extension://a"));
        assert_eq!(ok, ("200 OK", r#"{"saved":true}"#.into()));
        assert_eq!(post(r#"{"groups":{}}"#, None).0, "400 Bad Request");
        assert_eq!(post("nope", None).0, "400 Bad Request");
        assert_eq!(post(r#"{"groups":[]}"#, Some("https://evil.example")).0, "403 Forbidden");
        assert_eq!(*got.borrow(), vec![serde_json::json!([{ "name": "Gaming", "tags": ["gaming", "sologaming"] }])]);
    }

    #[test]
    fn blocking_lists_go_out_and_a_browser_can_hand_over_its_own() {
        let b: &'static BridgeState = Box::leak(Box::new(BridgeState::new()));
        let first = http(b, "GET /v1/focus HTTP/1.1\r\nOrigin: moz-extension://abc\r\n\r\n");
        assert!(first.contains(r#""blockingConfigured":false"#) && !first.contains(r#""blocking":"#), "{first}");
        let lists = r#"{"rules":[{"domain":"reddit.com","mode":"wait","waitSeconds":20}],"youtube":null,"defaultWait":20}"#;
        let taken = http(b, &format!("POST /v1/blocking/import HTTP/1.1\r\nContent-Length: {}\r\n\r\n{lists}", lists.len()));
        assert!(taken.starts_with("HTTP/1.1 200") && taken.ends_with(r#"{"taken":true}"#), "{taken}");
        let bad = http(b, "POST /v1/blocking/import HTTP/1.1\r\nContent-Length: 9\r\n\r\n{\"rules\":1");
        assert!(bad.starts_with("HTTP/1.1 400"), "{bad}");
        let huge = http(b, &format!("POST /v1/blocking/import HTTP/1.1\r\nContent-Length: {}\r\n\r\n", blocking::MAX_BYTES + 1));
        assert!(huge.starts_with("HTTP/1.1 400"), "{huge}");
        let v = b.shared.lock().unwrap().version;
        b.set_blocking(true, Some(serde_json::json!({ "rules": [], "theme": "terminal" })));
        b.set_blocking(true, Some(serde_json::json!({ "rules": [], "theme": "terminal" })));
        assert_eq!(b.shared.lock().unwrap().version, v + 1, "same lists don't wake the browsers again");
        let now = http(b, "GET /v1/focus HTTP/1.1\r\n\r\n");
        assert!(now.contains(r#""blockingConfigured":true"#) && now.contains(r#""theme":"terminal""#), "{now}");
    }

    #[test]
    fn a_waiting_request_wakes_on_change() {
        let b: &'static BridgeState = Box::leak(Box::new(BridgeState::new()));
        let v = b.shared.lock().unwrap().version;
        let started = Instant::now();
        let waiter = std::thread::spawn(move || b.wait_reply(Some(v), &|| false).unwrap());
        std::thread::sleep(Duration::from_millis(200));
        b.publish(FocusState::from_snapshot(&snap(Status::Running, Phase::Focus)));
        let reply: serde_json::Value = serde_json::from_str(&waiter.join().unwrap()).unwrap();
        assert_eq!(reply["active"], true);
        assert!(started.elapsed() < Duration::from_secs(5), "woke on the change, not the timeout");
    }

    #[test]
    fn closing_the_browser_unlinks_at_once() {
        let b: &'static BridgeState = Box::leak(Box::new(BridgeState::new()));
        let v = b.shared.lock().unwrap().version;
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            serve(b, stream, &Hooks { report: &|_, _| {}, import: &|_| true, groups: &|_| true, reason: &|_, _| {} }).unwrap();
        });
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(c, "GET /v1/focus?since={v} HTTP/1.1\r\nOrigin: moz-extension://abc\r\n\r\n").unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        assert!(b.status().linked, "a waiting request counts as linked");
        drop(c);
        let started = Instant::now();
        server.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(3), "noticed the hang-up quickly");
        assert!(!b.status().linked);
    }

    #[test]
    fn browsers_are_named_from_the_user_agent() {
        assert_eq!(browser_name("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0"), Some("Firefox"));
        assert_eq!(browser_name("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"), Some("Chrome"));
        assert_eq!(browser_name("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"), Some("Edge"));
        assert_eq!(browser_name(""), None);
    }
}
