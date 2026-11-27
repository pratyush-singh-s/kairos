//! Notes every few seconds that this PC is on, for "PC on time" in Statistics
//! (`focus_store::pc_time`). While the PC sleeps this thread doesn't run, so the gap shows.

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::state::StoreState;
use crate::timer::now_ms;

const EVERY: Duration = Duration::from_secs(15);

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            let _ = app.state::<StoreState>().with(|s| focus_store::pc_time::note(s, now_ms() as i64).map_err(|e| e.to_string()));
            std::thread::sleep(EVERY);
        }
    });
}
