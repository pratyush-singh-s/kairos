//! App tracking (opt-in, Settings → App tracking). Once a second, notes which program is in
//! front and adds it to the activity history. Only the program's file name is read, never
//! window titles. Time while you are away from the keyboard (2 minutes without input) or while
//! the screen is locked is not counted.

use std::time::Duration;

use focus_store::activity::{self, Sample};
use focus_store::settings;
use focus_timer::{Phase, Status};
use tauri::{AppHandle, Emitter, Manager};

use crate::history::RecordState;
use crate::winapps;
use crate::state::StoreState;
use crate::timer::{TimerState, now_ms};

const TICK_MS: u64 = 1_000;
/// How often time in the current program is written to the database.
const FLUSH_MS: i64 = 15_000;
/// No keyboard or mouse input for this long counts as away.
const IDLE_MS: u64 = 120_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Off,
    /// Only while a focus session is running.
    Focus,
    Always,
}

impl Mode {
    pub fn parse(s: &str) -> Mode {
        match s {
            "focus" => Mode::Focus,
            "always" => Mode::Always,
            _ => Mode::Off,
        }
    }
}

/// One piece of time ready to be written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Piece {
    pub exe: String,
    pub from_ms: i64,
    pub to_ms: i64,
    pub span: Option<i64>,
    pub session: Option<String>,
}

struct Current {
    exe: String,
    session: Option<String>,
    span: Option<i64>,
    flushed_to: i64,
    last_seen: i64,
}

/// Turns once-a-second observations into pieces of time. Kept free of Windows calls so it can
/// be tested anywhere; `write` stores a piece and returns its span id.
#[derive(Default)]
pub struct Tracker {
    current: Option<Current>,
}

impl Tracker {
    /// `seen` is the program in front right now (None = nothing to count: off, away, locked).
    pub fn step(&mut self, now: i64, seen: Option<&str>, session: Option<&str>, write: &mut dyn FnMut(&Piece) -> Option<i64>) {
        let same = matches!((&self.current, seen), (Some(c), Some(exe))
            if c.exe == exe && c.session.as_deref() == session && now - c.last_seen <= 3 * TICK_MS as i64);
        if same {
            let c = self.current.as_mut().expect("checked above");
            c.last_seen = now;
            if now - c.flushed_to >= FLUSH_MS {
                Self::flush(c, now, write);
            }
            return;
        }
        // Something changed: close what was running, then start on the new program.
        if let Some(mut c) = self.current.take() {
            // Each sighting stands for the second after it, but never past now.
            let end = (c.last_seen + TICK_MS as i64).min(now).max(c.flushed_to);
            Self::flush(&mut c, end, write);
        }
        if let Some(exe) = seen {
            self.current = Some(Current { exe: exe.to_string(), session: session.map(str::to_string), span: None, flushed_to: now, last_seen: now });
        }
    }

    fn flush(c: &mut Current, to: i64, write: &mut dyn FnMut(&Piece) -> Option<i64>) {
        if to <= c.flushed_to && c.span.is_some() {
            return;
        }
        let piece = Piece { exe: c.exe.clone(), from_ms: c.flushed_to, to_ms: to, span: c.span, session: c.session.clone() };
        if let Some(span) = write(&piece) {
            c.span = Some(span);
        }
        c.flushed_to = to;
    }
}

/// A readable name for common programs; otherwise the file name without ".exe".
pub fn display_name(exe: &str) -> String {
    let stem = exe.strip_suffix(".exe").or_else(|| exe.strip_suffix(".EXE")).unwrap_or(exe);
    let known = match stem.to_ascii_lowercase().as_str() {
        "code" => "VS Code",
        "firefox" => "Firefox",
        "chrome" => "Google Chrome",
        "msedge" => "Microsoft Edge",
        "brave" => "Brave",
        "opera" => "Opera",
        "explorer" => "File Explorer",
        "windowsterminal" => "Windows Terminal",
        "cmd" => "Command Prompt",
        "powershell" | "pwsh" => "PowerShell",
        "winword" => "Word",
        "excel" => "Excel",
        "powerpnt" => "PowerPoint",
        "onenote" => "OneNote",
        "outlook" | "olk" => "Outlook",
        "ms-teams" | "teams" => "Teams",
        "notepad" => "Notepad",
        "spotify" => "Spotify",
        "discord" => "Discord",
        "slack" => "Slack",
        "whatsapp" => "WhatsApp",
        "telegram" => "Telegram",
        "obsidian" => "Obsidian",
        "notion" => "Notion",
        "steam" => "Steam",
        "vlc" => "VLC",
        "acrord32" | "acrobat" => "Acrobat Reader",
        "devenv" => "Visual Studio",
        "idea64" => "IntelliJ IDEA",
        "pycharm64" => "PyCharm",
        "focus" => "Focus",
        "applicationframehost" => "Windows app",
        _ => "",
    };
    if !known.is_empty() {
        return known.to_string();
    }
    let mut chars = stem.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => exe.to_string(),
    }
}

/// Starts the tracker thread. It reads the setting every few seconds, so turning tracking on
/// or off in Settings takes effect straight away.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut tracker = Tracker::default();
        let mut mode = Mode::Off;
        let mut checked_at = 0u64;
        let mut wrote = false;
        loop {
            std::thread::sleep(Duration::from_millis(TICK_MS));
            let now = now_ms();
            if now.saturating_sub(checked_at) >= 3_000 {
                mode = read_mode(&app);
                checked_at = now;
            }
            let (focusing, session) = focus_state(&app, now);
            let counting = match mode {
                Mode::Off => false,
                Mode::Focus => focusing,
                Mode::Always => true,
            };
            let seen = if counting && winapps::idle_ms() < IDLE_MS { winapps::foreground_exe() } else { None };
            let session = if focusing { session } else { None };
            tracker.step(now as i64, seen.as_deref(), session.as_deref(), &mut |p| {
                wrote = true;
                write(&app, p)
            });
            if std::mem::take(&mut wrote) {
                let _ = app.emit("activity-changed", ());
            }
        }
    });
}

pub fn read_mode(app: &AppHandle) -> Mode {
    app.state::<StoreState>()
        .with(|s| settings::get::<String>(s, "tracking.mode").map_err(|e| e.to_string()))
        .map(|m| Mode::parse(&m))
        .unwrap_or(Mode::Off)
}

/// Whether a focus phase is running now, and its history row.
fn focus_state(app: &AppHandle, now: u64) -> (bool, Option<String>) {
    let running = app
        .state::<TimerState>()
        .0
        .lock()
        .map(|t| {
            let s = t.snapshot(now);
            s.status == Status::Running && s.phase == Phase::Focus
        })
        .unwrap_or(false);
    let row = app.state::<RecordState>().0.lock().ok().and_then(|r| r.open_row.clone());
    (running, if running { row } else { None })
}

fn write(app: &AppHandle, p: &Piece) -> Option<i64> {
    let name = display_name(&p.exe);
    let result = app.state::<StoreState>().with(|store| {
        activity::add(
            store,
            Sample {
                exe: &p.exe,
                display_name: &name,
                from_ms: p.from_ms,
                to_ms: p.to_ms,
                span: p.span,
                session_id: p.session.as_deref(),
            },
        )
        .map_err(|e| e.to_string())
    });
    match result {
        Ok(id) => Some(id),
        Err(e) => {
            eprintln!("focus: could not save app activity: {e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(steps: &[(i64, Option<&str>, Option<&str>)]) -> Vec<Piece> {
        let mut t = Tracker::default();
        let mut out = Vec::new();
        let mut next_span = 0;
        for &(now, seen, session) in steps {
            t.step(now, seen, session, &mut |p| {
                out.push(p.clone());
                Some(p.span.unwrap_or_else(|| {
                    next_span += 1;
                    next_span
                }))
            });
        }
        out
    }

    #[test]
    fn a_long_stretch_is_written_every_15_seconds_as_one_span() {
        let steps: Vec<_> = (0..=31).map(|s| (s * 1000, Some("Code.exe"), None)).collect();
        let pieces = run(&steps);
        assert_eq!(pieces.len(), 2);
        assert_eq!((pieces[0].from_ms, pieces[0].to_ms, pieces[0].span), (0, 15_000, None));
        assert_eq!((pieces[1].from_ms, pieces[1].to_ms, pieces[1].span), (15_000, 30_000, Some(1)));
    }

    #[test]
    fn switching_programs_closes_the_previous_one() {
        let pieces = run(&[(0, Some("Code.exe"), None), (1000, Some("Code.exe"), None), (2000, Some("firefox.exe"), None), (3000, None, None)]);
        assert_eq!(pieces[0], Piece { exe: "Code.exe".into(), from_ms: 0, to_ms: 2000, span: None, session: None });
        assert_eq!(pieces[1].exe, "firefox.exe");
        assert_eq!((pieces[1].from_ms, pieces[1].to_ms), (2000, 3000));
    }

    #[test]
    fn a_new_session_starts_a_new_piece_and_gaps_are_not_counted() {
        let pieces = run(&[(0, Some("Code.exe"), None), (1000, Some("Code.exe"), Some("s1")), (60_000, Some("Code.exe"), Some("s1"))]);
        assert_eq!(pieces[0].session, None);
        assert_eq!((pieces[0].from_ms, pieces[0].to_ms), (0, 1000));
        assert_eq!(pieces[1].session.as_deref(), Some("s1"));
        // The 59-second gap (e.g. the PC was asleep) closes the piece one second after the last tick seen.
        assert_eq!((pieces[1].from_ms, pieces[1].to_ms), (1000, 2000));
    }

    #[test]
    fn friendly_names() {
        assert_eq!(display_name("Code.exe"), "VS Code");
        assert_eq!(display_name("firefox.exe"), "Firefox");
        assert_eq!(display_name("blender.exe"), "Blender");
    }
}
