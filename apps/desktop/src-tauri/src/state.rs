use std::sync::Mutex;

use focus_store::Store;
use tauri::{AppHandle, Manager};

/// The database, or the reason it could not be opened. The app still starts on failure
/// so the error can be shown on screen instead of the window silently closing.
pub struct StoreState(pub Mutex<Result<Store, String>>);

pub fn open_store(app: &AppHandle) -> StoreState {
    let result = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not find the data folder: {e}"))
        .and_then(|dir| {
            // A backup restored last time (Settings → Backup) is swapped in first.
            crate::backup::apply_pending_restore(&dir);
            Store::open(&dir.join("focus.db")).map_err(|e| e.to_string())
        });
    StoreState(Mutex::new(result))
}

impl StoreState {
    /// Runs `f` with the open database, turning every failure into a readable message.
    pub fn with<T>(&self, f: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.0.lock().map_err(|_| "the database is unavailable after an internal error".to_string())?;
        match guard.as_mut() {
            Ok(store) => f(store),
            Err(reason) => Err(format!("the database could not be opened: {reason}")),
        }
    }
}
