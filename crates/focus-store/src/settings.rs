//! App settings: one row per key, value stored as JSON. Each change is stamped with the
//! sync clock and written to the change log so the other PC can pick it up later.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::Store;
use crate::error::{Result, StoreError};
use crate::store::now_ms;

/// Known setting keys and their defaults. Unknown keys are refused, which catches typos.
pub const DEFAULTS: &[(&str, &str)] = &[
    // Private windows (Incognito / InPrivate): "off" = allowed, "focus" = blocked during focus, "always". This PC only.
    ("blocking.privateWindows", "\"off\""),
    // Closing the window keeps Focus running in the tray (timer keeps going).
    ("window.closeToTray", "true"),
    // Set once the "still running in the tray" notice has been shown.
    ("window.trayNoticeShown", "false"),
    // Start (hidden, in the tray) when you sign in to Windows, so "PC on" in Statistics counts the whole day.
    ("window.startWithWindows", "true"),
    // "glass" or "terminal". Synced, so both PCs look the same.
    ("ui.theme", "\"glass\""),
    // Glass window backdrop: "acrylic" (blurred view of windows behind), "mica" (wallpaper tint), "solid".
    ("ui.backdrop", "\"acrylic\""),
    // Sidebar shows icons only (0.4–0.20), the menu is hidden (0.21.0). Replaced by ui.sidebarMode.
    ("ui.sidebarCollapsed", "false"),
    // The menu: "full", "icons" (icons only) or "hidden" (slides out on a swipe or at the left edge);
    // "" = not chosen yet (then taken from ui.sidebarCollapsed).
    ("ui.sidebarMode", "\"\""),
    // "auto" = title bar slides in when the cursor reaches the top edge; "always" = always visible.
    ("ui.titleBar", "\"always\""),
    // Look per theme, 0–100. Blur values are from 0.9.0 and no longer used;
    // transparency 0 = solid background. 90 by default from 0.22.6.B (Ps asked).
    ("ui.glassBlur", "60"),
    ("ui.glassTransparency", "90"),
    ("ui.terminalBlur", "40"),
    ("ui.terminalTransparency", "90"),
    // true = Windows blurs the windows behind Focus; false = they show through sharp. On by default from 0.22.6.B (Ps asked).
    ("ui.glassWindowsBlur", "true"),
    ("ui.terminalWindowsBlur", "true"),
    // Mini timer background: "lens" (real glass: bends the screen behind it at the edges) or "blur".
    // No longer read from 0.21.90.B on: see ui.glassEffect.
    ("ui.miniGlass", "\"lens\""),
    // Same choice from 0.21.90.B on, with Blur as the default (Ps asked).
    ("ui.glassEffect", "\"blur\""),
    // Colour palette id per theme ("" = the theme's own colours; "custom" = the colours below).
    ("ui.glassPalette", "\"\""),
    ("ui.terminalPalette", "\"\""),
    // Your own colours per theme: {"bg", "text", "accent"} as "#rrggbb"; null = not made yet.
    ("ui.glassCustom", "null"),
    // The app's colours for the browser extension's pages (bridge.rs). Made on this PC, not synced.
    ("ui.extColors", "null"),
    ("ui.terminalCustom", "null"),
    // Terminal theme: the shell whose prompt is drawn ("powershell", "bash" or "cmd"),
    // and an old CRT screen look (scan lines and glow).
    ("ui.terminalShell", "\"powershell\""),
    ("ui.terminalCrt", "false"),
    // Terminal theme: rings, bars and charts drawn with text characters (braille dots and blocks).
    ("ui.terminalAscii", "false"),
    // With the CRT look: its sound too (power-on thump, quiet hum and whine).
    ("ui.terminalCrtSound", "false"),
    // Glass theme: a glow on the window edge that follows the mouse.
    ("ui.glassEdgeGlow", "false"),
    // Replaces ui.glassEdgeGlow from 0.22.4.B so the edge glow is on by default for everyone.
    ("ui.edgeGlowOn", "true"),
    // Terminal theme layout: "classic" (the original look), "app" (full-screen TUI app), "shell" or "nvim".
    ("ui.terminalStyle", "\"classic\""),
    // Terminal theme: glowing text, glitchy distortion and a moving character background
    // ("soft", "strong" or "off").
    ("ui.terminalGlow", "\"soft\""),
    // The dashboard's new layout (Now band, Today, Coming up). Opt-in until 0.21.90.B; no longer read.
    ("ui.newDashboard", "false"),
    // Same choice from 0.21.90.B on, where the new layout is the main one (Ps asked), so it is on by default.
    ("ui.nowDashboard", "true"),
    // Fine film grain on the Notes page: "black" (near-black with grey grain, like ryoku.dev),
    // "theme" (grain over the theme's own colours) or "off".
    ("ui.notesGrain", "\"black\""),
    // Note folders made before anything was put in them (paths like "School/Physics"); synced.
    ("notes.folders", "[]"),
    // Keyboard sound while typing: "off", "creamy", "thock" or "creamy-thock"; volume 0–100.
    ("ui.keySound", "\"creamy-thock\""),
    ("ui.keyVolume", "50"),
    // App tracking (opt-in): "off", "focus" (only during focus sessions) or "always".
    ("tracking.mode", "\"off\""),
    // The preset picked last on the timer page (null = the first one).
    ("timer.lastPresetId", "null"),
    // A soft chime when a focus session or break ends.
    ("timer.soundOn", "true"),
    // Chime volume, 0–100.
    ("timer.volume", "60"),
    // Colours last given to to-dos, newest first, at most 5 ("#rrggbb").
    ("tasks.recentColors", "[]"),
    // Google sign-in (Phase 10): your own client from Google Cloud (GOOGLE-SETUP.md), and who is
    // signed in. The sign-in itself is in Windows Credential Manager, never in the database.
    ("google.clientId", "\"\""),
    ("google.clientSecret", "\"\""),
    ("google.email", "null"),
    // First name from the Google sign-in, for the dashboard greeting.
    ("google.name", "\"\""),
    ("google.scopes", "\"\""),
    // Kairos users (users.rs): count this install and the signed-in email for the app's maker;
    // this install's random id; the day it last reported.
    ("users.share", "true"),
    // Kairos account with email + password (email_account.rs). The password stays with Firebase.
    ("account.email", "null"),
    ("account.name", "\"\""),
    ("account.verified", "false"),
    ("users.installId", "\"\""),
    ("users.lastPing", "\"\""),
    // Google Calendar (Phase 19): the calendar Focus writes to-dos and deadlines into (made on
    // first sync), and your time zone and first day of the week (0 = Sunday, 1 = Monday, 6 =
    // Saturday) as set in Google Calendar.
    ("google.focusCalendarId", "\"\""),
    ("google.timeZone", "\"\""),
    ("google.weekStart", "1"),
    // Put dated to-dos, plan steps and deadlines in the Focus calendar.
    ("calendar.pushFocus", "true"),
    // Sync Google Calendar by itself (start, every 5 minutes, after changes). Off = Sync now only.
    ("calendar.autoSync", "true"),
    // The PC's shown Google events for the phone (`calendar::Mirror`); synced. null = none yet.
    ("calendar.mirror", "null"),
    // The phone's own Glass colours (palette id, and custom colours); "" / null = the laptop's.
    // Never synced, so the laptop keeps its own look.
    ("phone.glassPalette", "\"\""),
    ("phone.glassCustom", "null"),
    // The phone's own look ("" / null = follow the laptop).
    ("phone.theme", "\"\""),
    ("phone.terminalPalette", "\"\""),
    ("phone.terminalCustom", "null"),
    ("phone.terminalAscii", "null"),
    ("phone.terminalCrt", "null"),
    // Blocking (Phase 12 in the app): the browsers' lists, kept here so both browsers (and later
    // both PCs) share them. Shapes are `BlockRule[]` and `YoutubeRules` in packages/core.
    // "configured" turns true on the first save (or when a browser hands over its lists).
    ("blocking.configured", "false"),
    ("blocking.rules", "[]"),
    ("blocking.youtube", "null"),
    ("blocking.defaultWait", "20"),
    // Windows programs blocked during focus (`blocking::AppRule[]`), e.g. Discord or a game.
    ("blocking.apps", "[]"),
    // The laptop's focus state for the phone (`phone_block::FocusLive`); synced. null = none yet.
    ("focus.live", "null"),
    // Phone blocking: the phone apps blocked during focus (`phone_block::PhoneAppRule[]`), and
    // whether the laptop's sites and YouTube Shorts are blocked on the phone too. Never synced.
    ("phone.blockApps", "[]"),
    ("phone.blockSites", "true"),
    ("phone.blockShorts", "true"),
    // The phone's own focus timer (`phone_focus::PhoneTimer`), null = not running; and the
    // browsers linked to the phone (`[{ token, addedAtMs }]`, see browser_link.rs). Never synced.
    ("phone.timer", "null"),
    ("phone.browserLinks", "[]"),
    // The phone's own focus timer as the laptop sees it (`phone_block::FocusLive`), so the laptop
    // and its browsers block while the phone (or the Focus launcher) runs focus. Synced.
    ("focus.livePhone", "null"),
    // Pause/Resume/Skip/Stop sent to the timer on another device (`remote::RemoteCommand`), synced;
    // and the last one this device applied (local).
    ("focus.remote", "null"),
    ("focus.remoteDone", "\"\""),
    // Scheduled focus (`schedule::Schedule[]`) and the windows stopped early ("id@YYYY-MM-DD").
    // Both synced, so every device follows the same schedule.
    ("focus.schedules", "[]"),
    ("focus.scheduleSkips", "[]"),
    // Daily focus goal in minutes (0 = none), for the streak on the dashboards. Synced.
    ("goal.dailyMinutes", "120"),
    // Morning plan / evening review (`day_plan::DayPlan`), and the hour the review shows from. Synced.
    ("plan.today", "null"),
    ("plan.reviewHour", "20"),
    // "Why are you here?" answers from block screens (`reasons::Reason[]`, newest last). Synced.
    ("distraction.reasons", "[]"),
];

/// Keys that only make sense on this PC and are never synced.
pub(crate) const LOCAL_ONLY: &[&str] = &[
    "window.trayNoticeShown",
    "window.startWithWindows",
    "blocking.privateWindows",
    "tracking.mode",
    // Each PC signs in to Google for itself.
    "google.clientId",
    "google.clientSecret",
    "google.email",
    "google.name",
    "google.scopes",
    "users.share",
    "account.email",
    "account.name",
    "account.verified",
    "users.installId",
    "users.lastPing",
    "google.focusCalendarId",
    "google.timeZone",
    "google.weekStart",
    "calendar.pushFocus",
    "calendar.autoSync",
    "phone.glassPalette",
    "phone.glassCustom",
    "phone.theme",
    "phone.terminalPalette",
    "phone.terminalCustom",
    "phone.terminalAscii",
    "phone.terminalCrt",
    "phone.blockApps",
    "phone.blockSites",
    "phone.blockShorts",
    "phone.timer",
    "phone.browserLinks",
    "focus.remoteDone",
    "ui.extColors",
];

fn default_for(key: &str) -> Result<&'static str> {
    DEFAULTS
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| *v)
        .ok_or_else(|| StoreError::Invalid(format!("unknown setting {key:?}")))
}

pub fn get<T: DeserializeOwned>(store: &Store, key: &str) -> Result<T> {
    let default = default_for(key)?;
    let stored: Option<String> = store
        .conn()
        .query_row("SELECT value FROM settings WHERE key = ?1 AND deleted_at IS NULL", params![key], |r| r.get(0))
        .optional()?;
    let raw = stored.as_deref().unwrap_or(default);
    serde_json::from_str(raw).map_err(|e| StoreError::Invalid(format!("setting {key:?} holds bad data: {e}")))
}

pub fn set<T: Serialize>(store: &mut Store, key: &str, value: &T) -> Result<()> {
    default_for(key)?;
    let json = serde_json::to_string(value).map_err(|e| StoreError::Invalid(e.to_string()))?;
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let now = now_ms() as i64;
    let tx = store.conn_mut().transaction()?;
    tx.execute(
        "INSERT INTO settings (key, value, created_at, updated_at, device_id) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
                                         device_id = excluded.device_id, deleted_at = NULL",
        params![key, json, now, stamp, device],
    )?;
    if !LOCAL_ONLY.contains(&key) {
        let fields = serde_json::json!({ "value": json }).to_string();
        tx.execute(
            "INSERT INTO change_log (entity, entity_id, fields, hlc, device_id) VALUES ('settings', ?1, ?2, ?3, ?4)",
            params![key, fields, stamp, device],
        )?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_default_until_set() {
        let mut store = Store::open_in_memory().unwrap();
        assert!(get::<bool>(&store, "window.closeToTray").unwrap());
        set(&mut store, "window.closeToTray", &false).unwrap();
        assert!(!get::<bool>(&store, "window.closeToTray").unwrap());
    }

    #[test]
    fn colour_settings_have_defaults() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(get::<String>(&store, "ui.glassPalette").unwrap(), "");
        assert_eq!(get::<serde_json::Value>(&store, "ui.terminalCustom").unwrap(), serde_json::Value::Null);
    }

    #[test]
    fn unknown_keys_are_refused() {
        let mut store = Store::open_in_memory().unwrap();
        assert!(get::<bool>(&store, "window.closeToTrey").is_err());
        assert!(set(&mut store, "nope", &1).is_err());
    }

    #[test]
    fn synced_changes_are_logged_and_local_ones_are_not() {
        let mut store = Store::open_in_memory().unwrap();
        set(&mut store, "window.closeToTray", &false).unwrap();
        set(&mut store, "window.trayNoticeShown", &true).unwrap();
        let logged: Vec<String> = store
            .conn()
            .prepare("SELECT entity_id FROM change_log WHERE entity = 'settings'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(logged, ["window.closeToTray"]);
    }

    #[test]
    fn theme_defaults_to_glass() {
        let mut store = Store::open_in_memory().unwrap();
        assert_eq!(get::<String>(&store, "ui.theme").unwrap(), "glass");
        set(&mut store, "ui.theme", &"terminal").unwrap();
        assert_eq!(get::<String>(&store, "ui.theme").unwrap(), "terminal");
    }

    #[test]
    fn later_changes_get_later_stamps() {
        let mut store = Store::open_in_memory().unwrap();
        set(&mut store, "window.closeToTray", &false).unwrap();
        let first: String =
            store.conn().query_row("SELECT updated_at FROM settings", [], |r| r.get(0)).unwrap();
        set(&mut store, "window.closeToTray", &true).unwrap();
        let second: String =
            store.conn().query_row("SELECT updated_at FROM settings", [], |r| r.get(0)).unwrap();
        assert!(second > first);
    }
}
