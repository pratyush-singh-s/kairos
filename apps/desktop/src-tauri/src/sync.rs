//! Syncing with your other devices (Phase 9). The work is in the `focus-sync` crate; this file
//! starts it, hands the Sync page its commands, and refreshes the other pages after a sync
//! brings in changes.

use std::sync::{Arc, OnceLock};

use focus_store::Store;
use focus_sync::{Event, PairOffer, PeerInfo, Service, StoreAccess};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::StoreState;

/// The database as the sync code reaches it.
pub struct AppStore(AppHandle);

impl StoreAccess for AppStore {
    fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
        self.0.state::<StoreState>().with(f)
    }
}

pub struct SyncState(OnceLock<Service<AppStore>>);

impl SyncState {
    pub fn new() -> Self {
        Self(OnceLock::new())
    }
}

fn service(app: &AppHandle) -> Result<Service<AppStore>, String> {
    app.state::<SyncState>().0.get().cloned().ok_or_else(|| "Sync isn't running (the database could not be opened).".into())
}

/// The PC's own name, for other devices to show until you name it.
pub(crate) fn computer_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "This PC".into())
}

pub fn spawn(app: AppHandle) {
    let me = app.state::<StoreState>().with(|s| focus_sync::load_me(s, &computer_name(), "pc", env!("CARGO_PKG_VERSION")));
    let Ok(me) = me else { return };
    let events = app.clone();
    let service = Service::start(Arc::new(AppStore(app.clone())), me, move |e| on_event(&events, e), true);
    start_account(&app, &service);
    let _ = app.state::<SyncState>().0.set(service);
}

/// Pairing by Google account: when this PC is signed in with Google, it lists itself under that
/// Gmail in Kairos's Firebase project and pairs with the phone signed in with the same Gmail
/// (focus-sync account.rs). Only in releases built with the Firebase project (users.rs).
fn start_account(app: &AppHandle, service: &Service<AppStore>) {
    let Some((project, key)) = crate::users::config() else { return };
    let firebase = focus_sync::Firebase { project: project.into(), key: key.into() };
    let app = app.clone();
    // A Firebase sign-in lasts an hour; keep it for 50 minutes.
    let cached: std::sync::Mutex<Option<(std::time::Instant, focus_sync::Session)>> = std::sync::Mutex::new(None);
    service.start_account(firebase, move || {
        // Google, else a confirmed Kairos email account (email_account.rs).
        let email = crate::email_account::current_email(&app).unwrap_or_default();
        let mut cache = cached.lock().unwrap_or_else(|e| e.into_inner());
        if email.is_empty() {
            *cache = None;
            return Ok(None);
        }
        if let Some((at, s)) = cache.as_ref() {
            if at.elapsed() < std::time::Duration::from_secs(50 * 60) && s.email.eq_ignore_ascii_case(&email) {
                return Ok(Some(s.clone()));
            }
        }
        let Some(session) = crate::email_account::firebase_session(&app)? else { return Ok(None) };
        *cache = Some((std::time::Instant::now(), session.clone()));
        Ok(Some(session))
    });
}

/// Check this Gmail's devices now (just signed in, or the Sync page opened).
pub fn account_poke(app: &AppHandle) {
    if let Ok(service) = service(app) {
        service.account_poke();
    }
}

/// Signing out of Google: this PC leaves the account's device list.
pub fn account_leave(app: &AppHandle) {
    if let Ok(service) = service(app) {
        service.account_leave();
    }
}

#[tauri::command]
pub fn sync_account_check(app: AppHandle) {
    account_poke(&app);
}

#[tauri::command]
pub fn sync_account_allow(app: AppHandle, device_id: String) -> Result<(), String> {
    service(&app)?.account_allow(&device_id)
}

fn on_event(app: &AppHandle, event: Event) {
    match event {
        Event::Status => {
            let _ = app.emit("sync-changed", ());
        }
        Event::Progress(p) => {
            let _ = app.emit("sync-progress", p);
        }
        Event::Paired(_) => {
            let _ = app.emit("sync-changed", ());
        }
        Event::Synced(outcome) => {
            let tables = &outcome.received.tables;
            let has = |names: &[&str]| names.iter().any(|n| tables.contains(*n));
            if has(&["tasks", "spaces"]) {
                let _ = app.emit("tasks-changed", ());
            }
            if has(&["board_items"]) {
                let _ = app.emit("boards-changed", ());
            }
            if has(&["deadlines", "deadline_day_marks", "tasks"]) {
                let _ = app.emit("deadlines-changed", ());
            }
            if has(&["notes", "tags", "note_tags", "note_links", "note_attachments"]) || outcome.files_received > 0 {
                let _ = app.emit("notes-changed", ());
            }
            if has(&["focus_sessions", "apps", "app_usage"]) {
                let _ = app.emit("history-changed", ());
                let _ = app.emit("activity-changed", ());
            }
            if has(&["focus_sessions", "apps", "app_usage", "distraction_events"]) {
                let _ = app.emit("stats-changed", ());
            }
            if has(&["settings"]) {
                if let Ok(ui) = crate::commands::get_ui_settings(app.state()) {
                    let _ = app.emit("ui-changed", ui);
                }
                crate::bridge::publish_blocking(app);
                let _ = app.emit("blocking-changed", ());
            }
            if has(&["focus_presets"]) {
                let _ = app.emit("presets-changed", ());
            }
            if has(&["tasks", "deadlines", "spaces"]) {
                // Dated to-dos and deadlines from the other device go into Google Calendar too.
                crate::gcal::wake(app);
            }
            let _ = app.emit("sync-changed", ());
        }
    }
}

/// Syncs with every paired device as soon as possible (after a change the other side should
/// see at once).
pub fn sync_soon(app: &AppHandle) {
    if let Ok(service) = service(app) {
        service.sync_now(None);
    }
}

#[tauri::command]
pub fn sync_status(app: AppHandle) -> Result<focus_sync::Status, String> {
    Ok(service(&app)?.status())
}

#[tauri::command]
pub fn sync_show_code(app: AppHandle) -> Result<PairOffer, String> {
    Ok(service(&app)?.show_code())
}

#[tauri::command]
pub fn sync_cancel_code(app: AppHandle) -> Result<(), String> {
    service(&app)?.cancel_code();
    Ok(())
}

/// Pairs with the device at `address` that shows `code`. Async: it waits on the network.
#[tauri::command]
pub async fn sync_pair(app: AppHandle, address: String, code: String) -> Result<PeerInfo, String> {
    let service = service(&app)?;
    tauri::async_runtime::spawn_blocking(move || service.pair(&address, &code)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn sync_now(app: AppHandle, device_id: Option<String>) -> Result<(), String> {
    service(&app)?.sync_now(device_id.as_deref());
    Ok(())
}

#[tauri::command]
pub fn sync_forget(app: AppHandle, device_id: String) -> Result<(), String> {
    service(&app)?.forget(&device_id)
}

#[tauri::command]
pub fn sync_set_name(app: AppHandle, name: String) -> Result<(), String> {
    service(&app)?.set_name(&name)
}
