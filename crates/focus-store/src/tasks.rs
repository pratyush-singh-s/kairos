//! The to-do list: checklist tasks such as "gym" or "shop", optionally due on a date or
//! repeating on some weekdays. "Today" is always passed in by the caller as a local date
//! (YYYY-MM-DD), because only the UI knows the user's time zone.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::ids::new_id;
use crate::store::now_ms;

/// Every weekday bit set (Sunday = 1 ... Saturday = 64).
pub const EVERY_DAY: i64 = 127;

/// A task as shown in the app. Mirrored by `Task` in src/ipc/tasks.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    /// Ticked. A repeating task is only ticked on the day it was done.
    pub done: bool,
    /// Local date when it was last ticked.
    pub done_date: Option<String>,
    pub due_date: Option<String>,
    pub priority: String,
    /// Weekdays it repeats on as bits (Sunday = 1 ... Saturday = 64); 0 = one-off.
    pub repeat_days: i64,
    /// The dot before the name, "#rrggbb"; None = no colour.
    pub color: Option<String>,
    /// Set for an item of a deadline's own checklist; those stay off the To-do page.
    pub deadline_id: Option<String>,
    /// Local "HH:MM" on the task's day, for the week board.
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    /// Planned minutes.
    pub duration_min: Option<i64>,
    /// Small label under the name, e.g. "Website".
    pub category: Option<String>,
    /// Free text shown when the card is opened; "" = none.
    pub description: String,
    /// The workspace; None = Everyday.
    pub space_id: Option<String>,
    /// In a day-by-day plan, the day the step is on (1 = Day 1); None = no day yet.
    pub plan_day: Option<i64>,
    pub created_at: i64,
}

/// What the user can edit. Mirrored by `TaskInput` in src/ipc/tasks.ts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    pub title: String,
    pub due_date: Option<String>,
    pub priority: String,
    pub repeat_days: i64,
    #[serde(default)]
    pub color: Option<String>,
    /// Only read when creating: puts the task on that deadline's checklist.
    #[serde(default)]
    pub deadline_id: Option<String>,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub duration_min: Option<i64>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub space_id: Option<String>,
    #[serde(default)]
    pub plan_day: Option<i64>,
}

/// "9:05" or "09:05" → "09:05"; None if not a time of day.
fn normalize_time(t: &str) -> Option<String> {
    let (h, m) = t.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60 && t.trim().len() <= 5).then(|| format!("{h:02}:{m:02}"))
}

/// How many recent colours the picker offers.
pub const RECENT_COLORS: usize = 5;

/// Accepts "#abc", "abc", "#AABBCC" or "aabbcc"; returns lowercase "#aabbcc".
pub fn normalize_color(input: &str) -> Option<String> {
    let hex = input.trim().trim_start_matches('#').to_ascii_lowercase();
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        6 => Some(format!("#{hex}")),
        3 => Some(format!("#{}", hex.chars().flat_map(|c| [c, c]).collect::<String>())),
        _ => None,
    }
}

const PRIORITIES: &[&str] = &["low", "normal", "high"];

impl TaskInput {
    fn validated(mut self) -> Result<Self> {
        self.title = self.title.trim().to_string();
        let bad = |m: &str| Err(StoreError::Invalid(m.to_string()));
        if self.title.is_empty() {
            return bad("the task needs a name");
        }
        if self.title.chars().count() > 200 {
            return bad("the name can be at most 200 characters");
        }
        if !PRIORITIES.contains(&self.priority.as_str()) {
            return bad("priority must be low, normal or high");
        }
        if !(0..=EVERY_DAY).contains(&self.repeat_days) {
            return bad("unknown repeat days");
        }
        self.due_date = self.due_date.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
        if let Some(d) = &self.due_date
            && weekday(d).is_none()
        {
            return bad("the due date must look like 2026-10-23");
        }
        self.color = match self.color.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(c) => Some(normalize_color(c).ok_or_else(|| StoreError::Invalid(format!("{c:?} is not a colour like #4f8cff")))?),
        };
        let time = |v: Option<String>, what: &str| -> Result<Option<String>> {
            match v.as_deref().map(str::trim) {
                None | Some("") => Ok(None),
                Some(t) => normalize_time(t).map(Some).ok_or_else(|| StoreError::Invalid(format!("the {what} must look like 09:30"))),
            }
        };
        self.start_time = time(self.start_time.take(), "start time")?;
        self.end_time = time(self.end_time.take(), "end time")?;
        if self.end_time.is_some() && self.start_time.is_none() {
            return bad("an end time needs a start time");
        }
        // An end before the start is on the next day (23:00 to 00:30).
        if let (Some(a), Some(b)) = (&self.start_time, &self.end_time)
            && b == a
        {
            return bad("the end time can't be the same as the start time");
        }
        if let Some(m) = self.duration_min
            && !(1..=1440).contains(&m)
        {
            return bad("the length must be between 1 minute and 24 hours");
        }
        self.category = self.category.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
        if self.category.as_ref().is_some_and(|c| c.chars().count() > 60) {
            return bad("the label can be at most 60 characters");
        }
        self.description = self.description.trim_end().to_string();
        if self.description.chars().count() > 5000 {
            return bad("the description can be at most 5000 characters");
        }
        // A repeating task comes back on its weekdays; a single due date would contradict that.
        if self.repeat_days > 0 {
            self.due_date = None;
        }
        self.space_id = self.space_id.filter(|s| !s.trim().is_empty());
        if self.plan_day.is_some_and(|d| !(1..=crate::spaces::MAX_DAYS).contains(&d)) {
            return bad("a plan day is between 1 and 365");
        }
        Ok(self)
    }

    /// Fits the task to its space: a plan's steps sit on plan days (no dates or repeats),
    /// a board's tasks on dates.
    fn fitted_to_space(mut self, conn: &Connection) -> Result<Self> {
        let Some(id) = &self.space_id else {
            self.plan_day = None;
            return Ok(self);
        };
        let space = crate::spaces::get(conn, id)?.ok_or_else(|| StoreError::Invalid("that space no longer exists".into()))?;
        if space.kind == "plan" {
            self.due_date = None;
            self.repeat_days = 0;
            if self.plan_day.is_some_and(|d| d > space.days) {
                return Err(StoreError::Invalid(format!("this plan only has {} days", space.days)));
            }
        } else {
            self.plan_day = None;
        }
        Ok(self)
    }

    fn change_fields(&self) -> String {
        serde_json::json!({
            "title": self.title,
            "due_date": self.due_date,
            "priority": self.priority,
            "repeat_days": self.repeat_days,
            "color": self.color,
            "deadline_id": self.deadline_id,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "duration_min": self.duration_min,
            "category": self.category,
            "description": self.description,
            "space_id": self.space_id,
            "plan_day": self.plan_day,
        })
        .to_string()
    }
}

/// Day of the week for a `YYYY-MM-DD` date: 0 = Sunday ... 6 = Saturday. None if not a real date.
pub fn weekday(date: &str) -> Option<u32> {
    let b = date.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = date[0..4].parse().ok()?;
    let m: i64 = date[5..7].parse().ok()?;
    let d: i64 = date[8..10].parse().ok()?;
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days_in_month = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month[(m - 1) as usize] {
        return None;
    }
    // Days since 1970-01-01 (Howard Hinnant's days_from_civil), which was a Thursday.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days + 4).rem_euclid(7) as u32)
}

fn today_bit(today: &str) -> Result<i64> {
    weekday(today).map(|w| 1 << w).ok_or_else(|| StoreError::Invalid(format!("{today:?} is not a date")))
}

const COLUMNS: &str = "t.id, t.title,
    CASE WHEN t.repeat_days > 0 THEN coalesce(t.done_date = ?1, 0) ELSE t.done END,
    t.done_date, t.due_date, t.priority, t.repeat_days, t.color, t.deadline_id, t.start_time, t.end_time, t.duration_min,
    t.category, t.description, t.space_id, t.plan_day, t.created_at";

/// Tasks with their space (if any) as `s`. A deleted space hides its tasks.
const FROM: &str = "tasks t LEFT JOIN spaces s ON s.id = t.space_id
    WHERE t.deleted_at IS NULL AND (t.space_id IS NULL OR s.deleted_at IS NULL)";

const ORDER: &str = "CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.sort_order, t.title";

fn read_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        title: r.get(1)?,
        done: r.get::<_, i64>(2)? == 1,
        done_date: r.get(3)?,
        due_date: r.get(4)?,
        priority: r.get(5)?,
        repeat_days: r.get(6)?,
        color: r.get(7)?,
        deadline_id: r.get(8)?,
        start_time: r.get(9)?,
        end_time: r.get(10)?,
        duration_min: r.get(11)?,
        category: r.get(12)?,
        description: r.get(13)?,
        space_id: r.get(14)?,
        plan_day: r.get(15)?,
        created_at: r.get(16)?,
    })
}

/// Every task of every space (ticked one-offs included, up to 2000), for the To-do page to group.
pub fn list(conn: &Connection, today: &str) -> Result<Vec<Task>> {
    today_bit(today)?;
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM {FROM} AND t.deadline_id IS NULL ORDER BY {ORDER} LIMIT 2000"))?;
    let rows = stmt.query_map(params![today], read_row)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// What is on today's list, from every space: open tasks due today, overdue or undated; tasks
/// repeating today; steps of a dated plan whose day is today or already gone; and anything ticked
/// today. Open tasks first.
pub fn for_day(conn: &Connection, today: &str, limit: i64) -> Result<Vec<Task>> {
    let bit = today_bit(today)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM {FROM} AND t.deadline_id IS NULL AND (
               (coalesce(s.kind, 'board') = 'board' AND (
                     (t.repeat_days > 0 AND (t.repeat_days & ?2) != 0)
                  OR (t.repeat_days = 0 AND t.done = 0 AND (t.due_date IS NULL OR t.due_date <= ?1))
                  OR (t.repeat_days = 0 AND t.done = 1 AND t.done_date = ?1)))
            OR (s.kind = 'plan' AND s.start_date IS NOT NULL AND t.plan_day IS NOT NULL AND (
                     (t.done = 0 AND date(s.start_date, printf('+%d days', t.plan_day - 1)) <= ?1)
                  OR (t.done = 1 AND t.done_date = ?1))))
         ORDER BY 3, {ORDER} LIMIT ?3"
    ))?;
    let rows = stmt.query_map(params![today, bit, limit], read_row)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// A deadline's checklist, in the order it was written.
pub fn for_deadline(conn: &Connection, deadline_id: &str, today: &str) -> Result<Vec<Task>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM {FROM} AND t.deadline_id = ?2 ORDER BY t.sort_order"
    ))?;
    let rows = stmt.query_map(params![today, deadline_id], read_row)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: &str, today: &str) -> Result<Option<Task>> {
    Ok(conn
        .query_row(&format!("SELECT {COLUMNS} FROM {FROM} AND t.id = ?2"), params![today, id], read_row)
        .optional()?)
}

fn read_back(store: &Store, id: &str, today: &str) -> Result<Task> {
    get(store.conn(), id, today)?.ok_or_else(|| StoreError::Invalid("that task no longer exists".into()))
}

pub fn create(store: &mut Store, input: TaskInput, today: &str) -> Result<Task> {
    let input = input.validated()?.fitted_to_space(store.conn())?;
    let id = new_id();
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    if let Some(deadline) = &input.deadline_id {
        let live: Option<i64> = tx
            .query_row("SELECT 1 FROM deadlines WHERE id = ?1 AND deleted_at IS NULL", params![deadline], |r| r.get(0))
            .optional()?;
        if live.is_none() {
            return Err(StoreError::Invalid("that deadline no longer exists".into()));
        }
    }
    let order: i64 = tx.query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks", [], |r| r.get(0))?;
    tx.execute(
        "INSERT INTO tasks (id, title, due_date, priority, repeat_days, color, deadline_id, start_time, end_time, duration_min,
                            category, description, space_id, plan_day, sort_order, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![
            id, input.title, input.due_date, input.priority, input.repeat_days, input.color, input.deadline_id,
            input.start_time, input.end_time, input.duration_min, input.category, input.description, input.space_id,
            input.plan_day, order, now_ms() as i64, stamp, device
        ],
    )?;
    log_change(&tx, &id, &input.change_fields(), &stamp, &device)?;
    tx.commit()?;
    remember_color(store, input.color.as_deref())?;
    read_back(store, &id, today)
}

pub fn update(store: &mut Store, id: &str, input: TaskInput, today: &str) -> Result<Task> {
    let input = input.validated()?.fitted_to_space(store.conn())?;
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    let changed = tx.execute(
        "UPDATE tasks SET title = ?2, due_date = ?3, priority = ?4, repeat_days = ?5, color = ?6, start_time = ?7, end_time = ?8,
                duration_min = ?9, category = ?10, description = ?11, space_id = ?12, plan_day = ?13, updated_at = ?14,
                device_id = ?15
         WHERE id = ?1 AND deleted_at IS NULL",
        params![
            id, input.title, input.due_date, input.priority, input.repeat_days, input.color, input.start_time, input.end_time,
            input.duration_min, input.category, input.description, input.space_id, input.plan_day, stamp, device
        ],
    )?;
    if changed == 0 {
        return Err(StoreError::Invalid("that task no longer exists".into()));
    }
    log_change(&tx, id, &input.change_fields(), &stamp, &device)?;
    tx.commit()?;
    remember_color(store, input.color.as_deref())?;
    read_back(store, id, today)
}

/// Ticks or unticks a task. `today` is remembered so a repeating task is unticked again tomorrow.
pub fn set_done(store: &mut Store, id: &str, done: bool, today: &str) -> Result<Task> {
    today_bit(today)?;
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let (done_at, done_date) = if done { (Some(now_ms() as i64), Some(today)) } else { (None, None) };
    let tx = store.conn_mut().transaction()?;
    let changed = tx.execute(
        "UPDATE tasks SET done = ?2, done_at = ?3, done_date = ?4, updated_at = ?5, device_id = ?6
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id, done as i64, done_at, done_date, stamp, device],
    )?;
    if changed == 0 {
        return Err(StoreError::Invalid("that task no longer exists".into()));
    }
    let fields = serde_json::json!({ "done": done, "done_at": done_at, "done_date": done_date }).to_string();
    log_change(&tx, id, &fields, &stamp, &device)?;
    tx.commit()?;
    read_back(store, id, today)
}

/// Changes only the colour (the dot's picker). `None` or "" removes it.
pub fn set_color(store: &mut Store, id: &str, color: Option<&str>, today: &str) -> Result<Task> {
    let color = match color.map(str::trim) {
        None | Some("") => None,
        Some(c) => Some(normalize_color(c).ok_or_else(|| StoreError::Invalid(format!("{c:?} is not a colour like #4f8cff")))?),
    };
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    let changed = tx.execute(
        "UPDATE tasks SET color = ?2, updated_at = ?3, device_id = ?4 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, color, stamp, device],
    )?;
    if changed == 0 {
        return Err(StoreError::Invalid("that task no longer exists".into()));
    }
    log_change(&tx, id, &serde_json::json!({ "color": color }).to_string(), &stamp, &device)?;
    tx.commit()?;
    remember_color(store, color.as_deref())?;
    read_back(store, id, today)
}

/// The colours used last, newest first (at most 5).
pub fn recent_colors(store: &Store) -> Result<Vec<String>> {
    let list: Vec<String> = crate::settings::get(store, "tasks.recentColors")?;
    Ok(list.into_iter().filter_map(|c| normalize_color(&c)).take(RECENT_COLORS).collect())
}

/// Puts `color` first in the recent list (moving it if it was already there).
pub(crate) fn remember_color(store: &mut Store, color: Option<&str>) -> Result<()> {
    let Some(color) = color else { return Ok(()) };
    let mut list = recent_colors(store)?;
    if list.first().map(String::as_str) == Some(color) {
        return Ok(());
    }
    list.retain(|c| c != color);
    list.insert(0, color.to_string());
    list.truncate(RECENT_COLORS);
    crate::settings::set(store, "tasks.recentColors", &list)
}

/// Deletes tasks (kept as tombstones so the other PC learns about it, and so Undo can bring them back).
pub fn delete(store: &mut Store, ids: &[String]) -> Result<()> {
    set_deleted(store, ids, Some(now_ms() as i64))
}

/// Undo for `delete` and `clear_done`.
pub fn restore(store: &mut Store, ids: &[String]) -> Result<()> {
    set_deleted(store, ids, None)
}

fn set_deleted(store: &mut Store, ids: &[String], deleted_at: Option<i64>) -> Result<()> {
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    for id in ids {
        let changed = tx.execute(
            "UPDATE tasks SET deleted_at = ?2, updated_at = ?3, device_id = ?4 WHERE id = ?1",
            params![id, deleted_at, stamp, device],
        )?;
        if changed == 0 {
            return Err(StoreError::Invalid("that task no longer exists".into()));
        }
        log_change(&tx, id, &serde_json::json!({ "deleted_at": deleted_at }).to_string(), &stamp, &device)?;
    }
    tx.commit()?;
    Ok(())
}

/// Deletes every ticked one-off task in one space (None = Everyday). Repeating tasks and
/// deadline checklists stay. Returns the deleted IDs for Undo.
pub fn clear_done(store: &mut Store, space_id: Option<&str>) -> Result<Vec<String>> {
    let ids: Vec<String> = {
        let mut stmt = store.conn().prepare(
            "SELECT id FROM tasks WHERE deleted_at IS NULL AND repeat_days = 0 AND done = 1 AND deadline_id IS NULL
                AND space_id IS ?1",
        )?;
        stmt.query_map(params![space_id], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?
    };
    if !ids.is_empty() {
        delete(store, &ids)?;
    }
    Ok(ids)
}

fn log_change(conn: &Connection, id: &str, fields: &str, stamp: &str, device: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO change_log (entity, entity_id, fields, hlc, device_id) VALUES ('tasks', ?1, ?2, ?3, ?4)",
        params![id, fields, stamp, device],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-10-23 is a Friday.
    const FRI: &str = "2026-10-23";
    const SAT: &str = "2026-10-24";
    const MON: &str = "2026-10-26";

    fn input(title: &str) -> TaskInput {
        TaskInput { title: title.into(), due_date: None, priority: "normal".into(), repeat_days: 0, color: None, deadline_id: None, start_time: None, end_time: None, duration_min: None, category: None, description: String::new(), space_id: None, plan_day: None }
    }

    fn titles(tasks: Vec<Task>) -> Vec<String> {
        tasks.into_iter().map(|t| t.title).collect()
    }

    #[test]
    fn weekday_knows_real_dates() {
        assert_eq!(weekday("1970-01-01"), Some(4)); // Thursday
        assert_eq!(weekday(FRI), Some(5));
        assert_eq!(weekday("2024-02-29"), Some(4));
        assert_eq!(weekday("2000-03-01"), Some(3));
        assert_eq!(weekday("2025-02-29"), None, "not a leap year");
        assert_eq!(weekday("2026-13-01"), None);
        assert_eq!(weekday("23/10/2026"), None);
    }

    #[test]
    fn create_tick_edit_delete_round_trip() {
        let mut store = Store::open_in_memory().unwrap();
        let t = create(&mut store, input("  gym  "), FRI).unwrap();
        assert_eq!((t.title.as_str(), t.done), ("gym", false), "names are trimmed");

        let t = set_done(&mut store, &t.id, true, FRI).unwrap();
        assert!(t.done);
        assert_eq!(t.done_date.as_deref(), Some(FRI));
        assert!(!set_done(&mut store, &t.id, false, FRI).unwrap().done);

        let mut changed = input("gym, legs day");
        changed.priority = "high".into();
        changed.due_date = Some(SAT.into());
        let t = update(&mut store, &t.id, changed, FRI).unwrap();
        assert_eq!((t.title.as_str(), t.priority.as_str(), t.due_date.as_deref()), ("gym, legs day", "high", Some(SAT)));

        delete(&mut store, std::slice::from_ref(&t.id)).unwrap();
        assert!(list(store.conn(), FRI).unwrap().is_empty());
        assert!(set_done(&mut store, &t.id, true, FRI).is_err(), "deleted tasks cannot be ticked");
        restore(&mut store, std::slice::from_ref(&t.id)).unwrap();
        assert_eq!(titles(list(store.conn(), FRI).unwrap()), ["gym, legs day"], "undo brings it back");

        let logged: i64 = store
            .conn()
            .query_row("SELECT COUNT(*) FROM change_log WHERE entity = 'tasks' AND entity_id = ?1", [&t.id], |r| r.get(0))
            .unwrap();
        assert_eq!(logged, 6, "every change is logged for sync");
    }

    #[test]
    fn bad_values_are_refused_with_a_reason() {
        let mut store = Store::open_in_memory().unwrap();
        assert!(create(&mut store, input("  "), FRI).unwrap_err().to_string().contains("name"));
        let mut t = input("x");
        t.priority = "urgent".into();
        assert!(create(&mut store, t, FRI).is_err());
        let mut t = input("x");
        t.due_date = Some("tomorrow".into());
        assert!(create(&mut store, t, FRI).unwrap_err().to_string().contains("2026-10-23"));
        let mut t = input("x");
        t.repeat_days = 128;
        assert!(create(&mut store, t, FRI).is_err());
        assert!(list(store.conn(), "today").is_err());
    }

    #[test]
    fn repeating_task_is_unticked_the_next_day() {
        let mut store = Store::open_in_memory().unwrap();
        let mut gym = input("gym");
        gym.repeat_days = EVERY_DAY;
        gym.due_date = Some(FRI.into());
        let gym = create(&mut store, gym, FRI).unwrap();
        assert_eq!(gym.due_date, None, "repeating tasks have no single due date");

        set_done(&mut store, &gym.id, true, FRI).unwrap();
        assert!(for_day(store.conn(), FRI, 10).unwrap()[0].done, "done today");
        let tomorrow = for_day(store.conn(), SAT, 10).unwrap();
        assert_eq!(tomorrow.len(), 1);
        assert!(!tomorrow[0].done, "back on the list, unticked, tomorrow");
    }

    #[test]
    fn weekday_repeats_only_show_on_their_days() {
        let mut store = Store::open_in_memory().unwrap();
        let mut gym = input("gym");
        gym.repeat_days = (1 << 1) | (1 << 3) | (1 << 5); // Mon, Wed, Fri
        create(&mut store, gym, FRI).unwrap();
        assert_eq!(titles(for_day(store.conn(), FRI, 10).unwrap()), ["gym"]);
        assert!(for_day(store.conn(), SAT, 10).unwrap().is_empty());
        assert_eq!(titles(for_day(store.conn(), MON, 10).unwrap()), ["gym"]);
    }

    #[test]
    fn todays_list_has_due_overdue_undated_and_ticked_today() {
        let mut store = Store::open_in_memory().unwrap();
        let mut add = |title: &str, due: Option<&str>, priority: &str| {
            let mut t = input(title);
            t.due_date = due.map(String::from);
            t.priority = priority.into();
            create(&mut store, t, FRI).unwrap().id
        };
        add("shop", None, "normal");
        add("essay", Some("2026-10-20"), "high");
        add("next week", Some("2026-10-30"), "high");
        let call = add("call mum", Some(FRI), "normal");
        let yesterday = add("finished yesterday", Some("2026-10-22"), "normal");
        set_done(&mut store, &call, true, FRI).unwrap();
        set_done(&mut store, &yesterday, true, "2026-10-22").unwrap();

        // Open first (high priority on top), then what was ticked today.
        assert_eq!(titles(for_day(store.conn(), FRI, 10).unwrap()), ["essay", "shop", "call mum"]);
        assert_eq!(list(store.conn(), FRI).unwrap().len(), 5, "the full list keeps everything");
    }

    #[test]
    fn clear_done_removes_ticked_one_offs_only() {
        let mut store = Store::open_in_memory().unwrap();
        let shop = create(&mut store, input("shop"), FRI).unwrap();
        let mut gym = input("gym");
        gym.repeat_days = EVERY_DAY;
        let gym = create(&mut store, gym, FRI).unwrap();
        create(&mut store, input("read"), FRI).unwrap();
        set_done(&mut store, &shop.id, true, FRI).unwrap();
        set_done(&mut store, &gym.id, true, FRI).unwrap();

        let cleared = clear_done(&mut store, None).unwrap();
        assert_eq!(cleared, [shop.id.clone()]);
        assert_eq!(titles(list(store.conn(), FRI).unwrap()), ["gym", "read"]);
        restore(&mut store, &cleared).unwrap();
        assert_eq!(list(store.conn(), FRI).unwrap().len(), 3);
    }

    #[test]
    fn version_1_database_upgrades_and_keeps_its_tasks() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/0001_initial.sql")).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute("INSERT INTO tasks (id, title, created_at, updated_at, device_id) VALUES ('a', 'gym', 0, 's', 'd')", [])
            .unwrap();
        crate::migrations::migrate(&mut conn).unwrap();
        let tasks = list(&conn, FRI).unwrap();
        assert_eq!((tasks[0].title.as_str(), tasks[0].repeat_days, tasks[0].done), ("gym", 0, false));
    }

    #[test]
    fn colours_are_normalised_and_remembered_newest_first() {
        assert_eq!(normalize_color("#ABC").as_deref(), Some("#aabbcc"));
        assert_eq!(normalize_color(" 4F8CFF ").as_deref(), Some("#4f8cff"));
        assert_eq!(normalize_color("#12345"), None);
        assert_eq!(normalize_color("red"), None);

        let mut store = Store::open_in_memory().unwrap();
        let mut gym = input("gym");
        gym.color = Some("#F00".into());
        let gym = create(&mut store, gym, FRI).unwrap();
        assert_eq!(gym.color.as_deref(), Some("#ff0000"));

        for c in ["#111111", "#222222", "#333333", "#444444", "#555555", "#222222"] {
            set_color(&mut store, &gym.id, Some(c), FRI).unwrap();
        }
        assert_eq!(recent_colors(&store).unwrap(), ["#222222", "#555555", "#444444", "#333333", "#111111"]);

        assert_eq!(set_color(&mut store, &gym.id, None, FRI).unwrap().color, None);
        assert!(set_color(&mut store, &gym.id, Some("blue"), FRI).is_err());
        let mut bad = input("x");
        bad.color = Some("#zzzzzz".into());
        assert!(create(&mut store, bad, FRI).is_err());
    }

    #[test]
    fn times_length_and_label_are_checked() {
        let mut store = Store::open_in_memory().unwrap();
        let mut t = input("Executive meeting");
        t.due_date = Some(FRI.into());
        t.start_time = Some("9:30".into());
        t.end_time = Some("10:00".into());
        t.duration_min = Some(30);
        t.category = Some("  Website ".into());
        let t = create(&mut store, t, FRI).unwrap();
        assert_eq!(
            (t.start_time.as_deref(), t.end_time.as_deref(), t.duration_min, t.category.as_deref()),
            (Some("09:30"), Some("10:00"), Some(30), Some("Website"))
        );
        for (start, end, minutes, why) in [
            (Some("25:00"), None, None, "09:30"),
            (Some("10:00"), Some("10:00"), None, "same as the start"),
            (None, Some("09:00"), None, "needs a start"),
            (None, None, Some(0), "between 1 minute"),
        ] {
            let mut bad = input("x");
            bad.start_time = start.map(String::from);
            bad.end_time = end.map(String::from);
            bad.duration_min = minutes;
            assert!(create(&mut store, bad, FRI).unwrap_err().to_string().contains(why), "{why}");
        }
        let mut late = input("Calls");
        late.start_time = Some("23:00".into());
        late.end_time = Some("00:00".into());
        let late = create(&mut store, late, FRI).expect("an end past midnight is the next day");
        assert_eq!(late.end_time.as_deref(), Some("00:00"));
    }

    #[test]
    fn description_is_kept_and_edited() {
        let mut store = Store::open_in_memory().unwrap();
        let mut t = input("Gym");
        t.description = "Legs day\n- squats  \n".into();
        let made = create(&mut store, t.clone(), FRI).unwrap();
        assert_eq!(made.description, "Legs day\n- squats");
        t.description = String::new();
        assert_eq!(update(&mut store, &made.id, t.clone(), FRI).unwrap().description, "");
        t.description = "x".repeat(5001);
        assert!(create(&mut store, t, FRI).is_err());
    }

    fn space(store: &mut Store, kind: &str, start: Option<&str>, days: i64) -> String {
        let input = crate::spaces::SpaceInput { name: "Space".into(), kind: kind.into(), color: None, start_date: start.map(String::from), days };
        crate::spaces::create(store, input).unwrap().id
    }

    #[test]
    fn plan_steps_sit_on_days_not_dates() {
        let mut store = Store::open_in_memory().unwrap();
        let plan = space(&mut store, "plan", None, 3);
        let mut step = input("write the code");
        step.space_id = Some(plan.clone());
        step.plan_day = Some(1);
        step.due_date = Some(FRI.into());
        step.repeat_days = EVERY_DAY;
        let t = create(&mut store, step.clone(), FRI).unwrap();
        assert_eq!((t.space_id.as_deref(), t.plan_day, t.due_date, t.repeat_days), (Some(plan.as_str()), Some(1), None, 0));

        step.plan_day = Some(4);
        assert!(create(&mut store, step, FRI).unwrap_err().to_string().contains("only has 3 days"));

        let board = space(&mut store, "board", None, 7);
        let mut errand = input("print notes");
        errand.space_id = Some(board);
        errand.plan_day = Some(2);
        assert_eq!(create(&mut store, errand, FRI).unwrap().plan_day, None, "boards have no plan days");

        let mut nowhere = input("x");
        nowhere.space_id = Some("missing".into());
        assert!(create(&mut store, nowhere, FRI).is_err());
    }

    #[test]
    fn todays_list_has_todays_plan_steps_from_dated_plans_only() {
        let mut store = Store::open_in_memory().unwrap();
        let dated = space(&mut store, "plan", Some("2026-10-22"), 5); // Day 2 is Friday
        let undated = space(&mut store, "plan", None, 5);
        let mut add = |title: &str, space: &str, day: Option<i64>| {
            let mut t = input(title);
            t.space_id = Some(space.into());
            t.plan_day = day;
            create(&mut store, t, FRI).unwrap().id
        };
        add("day 1 code", &dated, Some(1));
        add("day 2 debug", &dated, Some(2));
        add("day 3 release", &dated, Some(3));
        add("someday", &dated, None);
        add("undated plan", &undated, Some(1));
        create(&mut store, input("shop"), FRI).unwrap();
        assert_eq!(titles(for_day(store.conn(), FRI, 10).unwrap()), ["day 1 code", "day 2 debug", "shop"]);
    }

    #[test]
    fn deleting_a_space_hides_its_tasks_until_undone() {
        let mut store = Store::open_in_memory().unwrap();
        let board = space(&mut store, "board", None, 7);
        let mut t = input("essay");
        t.space_id = Some(board.clone());
        let done = create(&mut store, t, FRI).unwrap();
        set_done(&mut store, &done.id, true, FRI).unwrap();
        create(&mut store, input("shop"), FRI).unwrap();
        assert_eq!(list(store.conn(), FRI).unwrap().len(), 2);
        assert!(clear_done(&mut store, None).unwrap().is_empty(), "Everyday's Clear done leaves other spaces alone");

        crate::spaces::delete(&mut store, &board).unwrap();
        assert_eq!(titles(list(store.conn(), FRI).unwrap()), ["shop"]);
        crate::spaces::restore(&mut store, &board).unwrap();
        assert_eq!(list(store.conn(), FRI).unwrap().len(), 2);
        assert_eq!(clear_done(&mut store, Some(&board)).unwrap(), [done.id]);
    }

    #[test]
    fn a_plan_cannot_shrink_below_its_last_used_day() {
        let mut store = Store::open_in_memory().unwrap();
        let plan = space(&mut store, "plan", None, 5);
        let mut t = input("ship");
        t.space_id = Some(plan.clone());
        t.plan_day = Some(4);
        create(&mut store, t, FRI).unwrap();
        let shrink = |days| crate::spaces::SpaceInput { name: "P".into(), kind: "plan".into(), color: None, start_date: None, days };
        assert!(crate::spaces::update(&mut store, &plan, shrink(3)).unwrap_err().to_string().contains("Day 4"));
        assert_eq!(crate::spaces::update(&mut store, &plan, shrink(4)).unwrap().days, 4);
    }
}
