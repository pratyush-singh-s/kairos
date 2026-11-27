//! Morning plan and evening review. In the morning you pick up to three to-dos as today's top
//! three; in the evening (from `plan.reviewHour`) the dashboards ask what to do with what's left:
//! move it to tomorrow, take its date off, or delete it. Kept in the synced setting `plan.today`,
//! so the laptop, the phone and the Focus launcher show the same plan.

use serde::{Deserialize, Serialize};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::settings;

/// Mirrored by `DayPlan` in apps/desktop/src/ipc/dayPlan.ts.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DayPlan {
    /// The local day this plan is for, "YYYY-MM-DD".
    pub date: String,
    /// Up to three to-do ids, most important first.
    pub top: Vec<String>,
    /// The evening review was done (or skipped) for this day.
    pub reviewed: bool,
}

pub const MAX_TOP: usize = 3;

/// The plan for `today`; an empty one if the saved plan is for another day.
pub fn get(store: &Store, today: &str) -> Result<DayPlan> {
    let raw: serde_json::Value = settings::get(store, "plan.today")?;
    let plan: DayPlan = serde_json::from_value(raw).unwrap_or_default();
    Ok(if plan.date == today { plan } else { DayPlan { date: today.into(), ..DayPlan::default() } })
}

pub fn save(store: &mut Store, plan: &DayPlan) -> Result<DayPlan> {
    if plan.date.len() != 10 {
        return Err(StoreError::Invalid("the plan needs a date".into()));
    }
    let mut top: Vec<String> = Vec::new();
    for id in &plan.top {
        if !id.is_empty() && !top.contains(id) {
            top.push(id.clone());
        }
    }
    if top.len() > MAX_TOP {
        return Err(StoreError::Invalid(format!("pick up to {MAX_TOP}")));
    }
    let tidy = DayPlan { top, ..plan.clone() };
    settings::set(store, "plan.today", &tidy)?;
    Ok(tidy)
}

/// The hour (0–23, local) from which the evening review shows.
pub fn review_hour(store: &Store) -> Result<u32> {
    let h: i64 = settings::get(store, "plan.reviewHour")?;
    Ok(h.clamp(0, 23) as u32)
}

pub fn set_review_hour(store: &mut Store, hour: u32) -> Result<()> {
    settings::set(store, "plan.reviewHour", &hour.min(23))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plan_belongs_to_its_day() {
        let mut store = Store::open_in_memory().unwrap();
        assert_eq!(get(&store, "2026-10-27").unwrap().top, Vec::<String>::new());
        let plan = DayPlan { date: "2026-10-27".into(), top: vec!["a".into(), "a".into(), "b".into()], reviewed: false };
        assert_eq!(save(&mut store, &plan).unwrap().top, vec!["a", "b"]);
        assert_eq!(get(&store, "2026-10-27").unwrap().top, vec!["a", "b"]);
        assert!(get(&store, "2026-10-28").unwrap().top.is_empty(), "a new day starts empty");
        let four = DayPlan { top: vec!["a".into(), "b".into(), "c".into(), "d".into()], ..plan };
        assert!(save(&mut store, &four).is_err());
        assert_eq!(review_hour(&store).unwrap(), 20);
    }
}
