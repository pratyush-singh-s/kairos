//! In-app updates: asks the update server whether a newer Kairos exists, then downloads the
//! signed installer and runs it (passive: just a progress bar), which restarts Kairos.
//!
//! The server URL comes from tauri.conf.json (plugins.updater.endpoints), or from the
//! KAIROS_UPDATE_URL build variable when set. latest.json's "notes" starts with the version
//! label (e.g. "0.21.120.B"), then a line break and a short "what's new".

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct UpdateState(Mutex<Option<Update>>);

#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    /// What to show, e.g. "0.21.120.B".
    pub label: String,
    /// Short "what's new" text, may be empty.
    pub notes: String,
}

#[derive(Serialize, Clone)]
struct Progress {
    done: u64,
    total: Option<u64>,
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder();
    if let Some(url) = option_env!("KAIROS_UPDATE_URL").filter(|u| !u.is_empty())
        && let Ok(url) = url.parse()
    {
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    builder.build().map_err(|e| e.to_string())
}

/// Looks for a newer version. None when Kairos is up to date (or offline).
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, UpdateState>) -> Result<Option<UpdateInfo>, String> {
    let found = match updater(&app)?.check().await {
        Ok(found) => found,
        // Nothing published yet (404): same as up to date.
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => None,
        Err(e) => return Err(e.to_string()),
    };
    let info = found.as_ref().map(|u| {
        let body = u.body.clone().unwrap_or_default();
        let mut lines = body.splitn(2, '\n');
        let first = lines.next().unwrap_or("").trim().to_string();
        let (label, notes) = if first.ends_with(".B") || first.ends_with(".b") {
            (first, lines.next().unwrap_or("").trim().to_string())
        } else {
            (u.version.clone(), body.trim().to_string())
        };
        UpdateInfo { label, notes }
    });
    *state.0.lock().unwrap() = found;
    Ok(info)
}

/// Downloads and installs the update found by update_check. Sends "update-progress" events.
/// On Windows the installer closes Kairos, updates it and opens it again.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let update = state.0.lock().unwrap().take().ok_or("No update found. Check again.")?;
    let mut done = 0u64;
    let events = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                done += chunk as u64;
                let _ = events.emit("update-progress", Progress { done, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    update.install(bytes).map_err(|e| e.to_string())?;
    // Windows exits inside install(); elsewhere just restart.
    app.restart();
}
