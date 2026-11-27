//! Morning plan and evening review (`focus_store::day_plan`): today's top three to-dos, and the
//! evening look at what's left. The dashboard shows both; a Windows notification at the review
//! hour says it's time (`notify_review`).

use focus_store::day_plan::{self, DayPlan};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::state::StoreState;

/// Mirrored by `DayPlanView` in src/ipc/dayPlan.ts.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayPlanView {
    plan: DayPlan,
    review_hour: u32,
}

fn view(store: &focus_store::Store, today: &str) -> Result<DayPlanView, String> {
    Ok(DayPlanView {
        plan: day_plan::get(store, today).map_err(|e| e.to_string())?,
        review_hour: day_plan::review_hour(store).map_err(|e| e.to_string())?,
    })
}

#[tauri::command]
pub fn get_day_plan(state: tauri::State<'_, StoreState>, today: String) -> Result<DayPlanView, String> {
    state.with(|s| view(s, &today))
}

#[tauri::command]
pub fn save_day_plan(app: AppHandle, state: tauri::State<'_, StoreState>, plan: DayPlan) -> Result<DayPlanView, String> {
    let v = state.with(|s| {
        day_plan::save(s, &plan).map_err(|e| e.to_string())?;
        view(s, &plan.date)
    })?;
    let _ = app.emit("plan-changed", ());
    Ok(v)
}

#[tauri::command]
pub fn set_review_hour(state: tauri::State<'_, StoreState>, hour: u32, today: String) -> Result<DayPlanView, String> {
    state.with(|s| {
        day_plan::set_review_hour(s, hour).map_err(|e| e.to_string())?;
        view(s, &today)
    })
}

/// The day the review reminder was last shown (local "YYYY-MM-DD").
static REMINDED: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// Once a day at the review hour, if today's review isn't done: a Windows notification.
/// Called by the ticker every few seconds.
pub fn maybe_remind(app: &AppHandle) {
    use chrono::Timelike;
    use tauri::Manager;
    use tauri_plugin_notification::NotificationExt;
    let now = chrono::Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let Ok(mut last) = REMINDED.lock() else { return };
    if *last == today {
        return;
    }
    let due = app.state::<StoreState>().with(|s| {
        let hour = day_plan::review_hour(s).map_err(|e| e.to_string())?;
        let plan = day_plan::get(s, &today).map_err(|e| e.to_string())?;
        Ok(now.hour() >= hour && !plan.reviewed)
    });
    match due {
        Ok(true) => {
            *last = today;
            let _ = app
                .notification()
                .builder()
                .title("Time to review your day")
                .body("Open Kairos to move what's left to tomorrow, or let it go.")
                .show();
        }
        // Before the review hour: look again later today. Reviewed: nothing more today.
        Ok(false) if now.hour() < 23 => {}
        _ => *last = today,
    }
}
