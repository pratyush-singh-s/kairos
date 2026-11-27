//! Files attached to notes: picking them, opening them in their own app, saving a copy and
//! taking them off. The files live in the "attachments" folder next to the database (see
//! focus_store::attachments) and travel to the other devices with sync.

use std::path::{Path, PathBuf};

use focus_store::attachments::{self, Attachment};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::state::StoreState;

fn changed(app: &AppHandle) {
    let _ = app.emit("notes-changed", ());
}

fn files_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.state::<StoreState>()
        .with(|s| s.files_dir().map(Path::to_path_buf).ok_or_else(|| "there is no folder for attached files".to_string()))
}

/// Copies the files into the attachments folder (outside the database lock: a big file takes
/// a moment) and puts them on the note.
pub(crate) fn attach_paths(app: &AppHandle, note_id: &str, paths: &[PathBuf]) -> Result<Vec<Attachment>, String> {
    let dir = files_dir(app)?;
    let mut added = Vec::new();
    let mut failed = Vec::new();
    for path in paths {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        let result = attachments::ingest(&dir, path).map_err(|e| e.to_string()).and_then(|(sha, size)| {
            app.state::<StoreState>().with(|s| attachments::add(s, note_id, &name, &sha, size).map_err(|e| e.to_string()))
        });
        match result {
            Ok(a) => added.push(a),
            Err(e) => failed.push(format!("{name}: {e}")),
        }
    }
    if !added.is_empty() {
        changed(app);
    }
    if added.is_empty() && !failed.is_empty() {
        return Err(failed.join("\n"));
    }
    Ok(added)
}

#[tauri::command]
pub fn list_note_attachments(state: tauri::State<'_, StoreState>, note_id: String) -> Result<Vec<Attachment>, String> {
    state.with(|s| attachments::list(s, &note_id).map_err(|e| e.to_string()))
}

/// Asks which files to attach (any type, several at once). Empty when the dialog is closed.
#[tauri::command]
pub async fn attach_files(app: AppHandle, note_id: String) -> Result<Vec<Attachment>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app.dialog().file().set_title("Attach files to the note").blocking_pick_files();
        let paths: Vec<PathBuf> = picked.unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect();
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        attach_paths(&app, &note_id, &paths)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens the file in the app Windows uses for its type (a copy under its real name in the
/// temp folder, so the stored file can't be changed by accident).
#[tauri::command]
pub async fn open_attachment(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (a, stored) = app.state::<StoreState>().with(|s| attachments::file_of(s, &id).map_err(|e| e.to_string()))?;
        let folder = std::env::temp_dir().join("Focus attachments").join(&a.id);
        std::fs::create_dir_all(&folder).map_err(|e| format!("could not open \"{}\": {e}", a.name))?;
        let copy = folder.join(&a.name);
        let fresh = std::fs::metadata(&copy).is_ok_and(|m| m.len() == a.size);
        if !fresh {
            std::fs::copy(&stored, &copy).map_err(|e| format!("could not open \"{}\": {e}", a.name))?;
        }
        shell_open(&copy).map_err(|e| format!("could not open \"{}\": {e}", a.name))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves a copy where you choose. Returns where it went, or None if the dialog was closed.
#[tauri::command]
pub async fn save_attachment(app: AppHandle, id: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (a, stored) = app.state::<StoreState>().with(|s| attachments::file_of(s, &id).map_err(|e| e.to_string()))?;
        let mut dialog = app.dialog().file().set_title("Save a copy").set_file_name(&a.name);
        if let Some(ext) = Path::new(&a.name).extension().and_then(|e| e.to_str()) {
            dialog = dialog.add_filter(ext.to_uppercase(), &[ext]);
        }
        let Some(target) = dialog.blocking_save_file().and_then(|p| p.into_path().ok()) else {
            return Ok(None);
        };
        std::fs::copy(&stored, &target).map_err(|e| format!("could not save \"{}\": {e}", a.name))?;
        Ok(Some(target.display().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The file name sent with a made file, as `encodeURIComponent` wrote it.
fn file_name_of(request: &tauri::ipc::Request<'_>) -> String {
    let raw = request.headers().get("x-file-name").and_then(|v| v.to_str().ok()).unwrap_or("Note.pdf");
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    let name: String = String::from_utf8_lossy(&out).chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control()).collect();
    let name = name.trim();
    if name.is_empty() { "Note.pdf".into() } else { name.to_string() }
}

fn body_of(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        _ => Err("nothing to save".into()),
    }
}

/// Saves a file made in the app (a note as PDF) where you choose. Returns where it went, or None if the dialog was closed.
#[tauri::command]
pub async fn save_export(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    let name = file_name_of(&request);
    let bytes = body_of(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title("Save as PDF").set_file_name(&name);
        if let Some(ext) = Path::new(&name).extension().and_then(|e| e.to_str()) {
            dialog = dialog.add_filter(ext.to_uppercase(), &[ext]);
        }
        let Some(target) = dialog.blocking_save_file().and_then(|p| p.into_path().ok()) else {
            return Ok(None);
        };
        std::fs::write(&target, &bytes).map_err(|e| format!("could not save \"{name}\": {e}"))?;
        Ok(Some(target.display().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn remove_attachment(app: AppHandle, state: tauri::State<'_, StoreState>, id: String) -> Result<(), String> {
    state.with(|s| attachments::remove(s, &id).map_err(|e| e.to_string()))?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn restore_attachment(app: AppHandle, state: tauri::State<'_, StoreState>, id: String) -> Result<(), String> {
    state.with(|s| attachments::restore(s, &id).map_err(|e| e.to_string()))?;
    changed(&app);
    Ok(())
}

/// Clears out files no note uses any more (at start, so Undo of a removal still worked before).
pub fn prune(app: &AppHandle) {
    let _ = app.state::<StoreState>().with(|s| attachments::prune(s).map_err(|e| e.to_string()));
    std::fs::remove_dir_all(std::env::temp_dir().join("Focus attachments")).ok();
}

#[cfg(windows)]
fn shell_open(path: &Path) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let target = wide(&path.display().to_string());
    let run = |verb: &str| {
        let verb = wide(verb);
        // SAFETY: both strings are NUL-terminated UTF-16 that live until the call returns.
        unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), target.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) as isize }
    };
    let mut result = run("open");
    if result == 31 {
        // SE_ERR_NOASSOC: no app is set for this type, so let Windows ask which one to use.
        result = run("openas");
    }
    if result <= 32 {
        return Err("Windows has no app to open this type of file".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn shell_open(path: &Path) -> Result<(), String> {
    std::process::Command::new("xdg-open").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}
