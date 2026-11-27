//! Deadlines: "finish X by a date", with a start, a due time, the 360° ring and the day grid
//! (drawn by the UI from `start_at`/`due_at`), days the user marked as done, and an optional
//! checklist (tasks whose `deadline_id` points here).

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::ids::new_id;
use crate::store::now_ms;
use crate::tasks::{self, Task, normalize_color};

/// A deadline as shown in the app. Mirrored by `Deadline` in src/ipc/deadlines.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deadline {
    pub id: String,
    pub title: String,
    pub description: String,
    /// UTC milliseconds.
    pub start_at: i64,
    pub due_at: i64,
    pub all_day: bool,
    /// "ring", "grid" or "both".
    pub viz: String,
    pub color: Option<String>,
    /// How the day progress is drawn: "grid" or "bars".
    pub progress_style: String,
    /// "rounded", "circle" or "square".
    pub cell_shape: String,
    /// Cells per row; None = automatic.
    pub grid_cols: Option<i64>,
    pub completed_at: Option<i64>,
    /// Day-grid cells the user marked done, as 0-based day numbers from the start day.
    pub marked_days: Vec<i64>,
    pub tasks: Vec<Task>,
}

/// What the user can edit. Mirrored by `DeadlineInput` in src/ipc/deadlines.ts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadlineInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// None = now (when creating) or unchanged start (when editing).
    pub start_at: Option<i64>,
    pub due_at: i64,
    #[serde(default)]
    pub all_day: bool,
    pub viz: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default = "default_style")]
    pub progress_style: String,
    #[serde(default = "default_shape")]
    pub cell_shape: String,
    #[serde(default)]
    pub grid_cols: Option<i64>,
}

fn default_style() -> String {
    "grid".into()
}
fn default_shape() -> String {
    "rounded".into()
}

const STYLES: &[&str] = &["grid", "bars"];
const SHAPES: &[&str] = &["rounded", "circle", "square"];

const VIZ: &[&str] = &["ring", "grid", "both"];

impl DeadlineInput {
    fn validated(mut self, start_default: i64) -> Result<(Self, i64)> {
        let bad = |m: &str| Err(StoreError::Invalid(m.to_string()));
        self.title = self.title.trim().to_string();
        self.description = self.description.trim().to_string();
        if self.title.is_empty() {
            return bad("the deadline needs a name");
        }
        if self.title.chars().count() > 200 {
            return bad("the name can be at most 200 characters");
        }
        if self.description.chars().count() > 2000 {
            return bad("the description can be at most 2000 characters");
        }
        if !VIZ.contains(&self.viz.as_str()) {
            return bad("show must be ring, grid or both");
        }
        if !STYLES.contains(&self.progress_style.as_str()) {
            return bad("the progress style must be grid or bars");
        }
        if !SHAPES.contains(&self.cell_shape.as_str()) {
            return bad("the shape must be rounded, circle or square");
        }
        if self.grid_cols.is_some_and(|c| !(1..=60).contains(&c)) {
            return bad("columns must be between 1 and 60");
        }
        self.color = match self.color.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(c) => Some(normalize_color(c).ok_or_else(|| StoreError::Invalid(format!("{c:?} is not a colour like #4f8cff")))?),
        };
        let start = self.start_at.unwrap_or(start_default);
        if self.due_at <= start {
            return bad("the due time must be after the start time");
        }
        Ok((self, start))
    }

    fn change_fields(&self, start: i64) -> String {
        serde_json::json!({
            "title": self.title,
            "description": self.description,
            "start_at": start,
            "due_at": self.due_at,
            "all_day": self.all_day,
            "viz": self.viz,
            "color": self.color,
            "progress_style": self.progress_style,
            "cell_shape": self.cell_shape,
            "grid_cols": self.grid_cols,
        })
        .to_string()
    }
}

const COLUMNS: &str =
    "id, title, description, start_at, due_at, all_day, viz, color, completed_at, progress_style, cell_shape, grid_cols";

fn read_rows(conn: &Connection, filter: &str, args: impl rusqlite::Params, today: &str) -> Result<Vec<Deadline>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM deadlines WHERE deleted_at IS NULL {filter}"))?;
    let rows = stmt
        .query_map(args, |r| {
            Ok(Deadline {
                id: r.get(0)?,
                title: r.get(1)?,
                description: r.get(2)?,
                start_at: r.get(3)?,
                due_at: r.get(4)?,
                all_day: r.get::<_, i64>(5)? == 1,
                viz: r.get(6)?,
                color: r.get(7)?,
                completed_at: r.get(8)?,
                progress_style: r.get(9)?,
                cell_shape: r.get(10)?,
                grid_cols: r.get(11)?,
                marked_days: Vec::new(),
                tasks: Vec::new(),
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut marks = conn.prepare(
        "SELECT day_index FROM deadline_day_marks WHERE deadline_id = ?1 AND done = 1 AND deleted_at IS NULL ORDER BY day_index",
    )?;
    let mut out = Vec::with_capacity(rows.len());
    for mut d in rows {
        d.marked_days = marks.query_map(params![d.id], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
        d.tasks = tasks::for_deadline(conn, &d.id, today)?;
        out.push(d);
    }
    Ok(out)
}

/// Every deadline: open ones by due time first, then finished ones, most recently finished first.
/// `today` (local YYYY-MM-DD) is for the checklist items' ticks.
pub fn list(conn: &Connection, today: &str) -> Result<Vec<Deadline>> {
    read_rows(conn, "ORDER BY completed_at IS NOT NULL, CASE WHEN completed_at IS NULL THEN due_at ELSE -completed_at END", [], today)
}

/// Open deadlines, soonest first (overdue ones included), for the dashboard.
pub fn upcoming(conn: &Connection, today: &str, limit: i64) -> Result<Vec<Deadline>> {
    read_rows(conn, "AND completed_at IS NULL ORDER BY due_at LIMIT ?1", params![limit], today)
}

pub fn get(conn: &Connection, id: &str, today: &str) -> Result<Option<Deadline>> {
    Ok(read_rows(conn, "AND id = ?1", params![id], today)?.into_iter().next())
}

fn read_back(store: &Store, id: &str, today: &str) -> Result<Deadline> {
    get(store.conn(), id, today)?.ok_or_else(|| gone())
}

fn gone() -> StoreError {
    StoreError::Invalid("that deadline no longer exists".into())
}

pub fn create(store: &mut Store, input: DeadlineInput, today: &str) -> Result<Deadline> {
    let now = now_ms() as i64;
    let (input, start) = input.validated(now)?;
    let id = new_id();
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    tx.execute(
        "INSERT INTO deadlines (id, title, description, start_at, due_at, all_day, viz, color, progress_style, cell_shape,
                                grid_cols, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            id, input.title, input.description, start, input.due_at, input.all_day as i64, input.viz, input.color,
            input.progress_style, input.cell_shape, input.grid_cols, now, stamp, device
        ],
    )?;
    log_change(&tx, "deadlines", &id, &input.change_fields(start), &stamp, &device)?;
    tx.commit()?;
    tasks::remember_color(store, input.color.as_deref())?;
    read_back(store, &id, today)
}

pub fn update(store: &mut Store, id: &str, input: DeadlineInput, today: &str) -> Result<Deadline> {
    let current: i64 = store
        .conn()
        .query_row("SELECT start_at FROM deadlines WHERE id = ?1 AND deleted_at IS NULL", params![id], |r| r.get(0))
        .optional()?
        .ok_or_else(gone)?;
    let (input, start) = input.validated(current)?;
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    tx.execute(
        "UPDATE deadlines SET title = ?2, description = ?3, start_at = ?4, due_at = ?5, all_day = ?6, viz = ?7, color = ?8,
                progress_style = ?9, cell_shape = ?10, grid_cols = ?11, updated_at = ?12, device_id = ?13
         WHERE id = ?1 AND deleted_at IS NULL",
        params![
            id, input.title, input.description, start, input.due_at, input.all_day as i64, input.viz, input.color,
            input.progress_style, input.cell_shape, input.grid_cols, stamp, device
        ],
    )?;
    log_change(&tx, "deadlines", id, &input.change_fields(start), &stamp, &device)?;
    tx.commit()?;
    tasks::remember_color(store, input.color.as_deref())?;
    read_back(store, id, today)
}

/// Marks the whole deadline finished (or open again).
pub fn set_completed(store: &mut Store, id: &str, completed: bool, today: &str) -> Result<Deadline> {
    let at = completed.then(|| now_ms() as i64);
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    let changed = tx.execute(
        "UPDATE deadlines SET completed_at = ?2, updated_at = ?3, device_id = ?4 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, at, stamp, device],
    )?;
    if changed == 0 {
        return Err(gone());
    }
    log_change(&tx, "deadlines", id, &serde_json::json!({ "completed_at": at }).to_string(), &stamp, &device)?;
    tx.commit()?;
    read_back(store, id, today)
}

/// Marks one day of the grid done or not. Only changes the cell's look; the ring stays time-based.
pub fn mark_day(store: &mut Store, id: &str, day_index: i64, done: bool, today: &str) -> Result<Deadline> {
    let (start, due): (i64, i64) = store
        .conn()
        .query_row("SELECT start_at, due_at FROM deadlines WHERE id = ?1 AND deleted_at IS NULL", params![id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?
        .ok_or_else(gone)?;
    // Generous bound: the UI counts local calendar days, which can be one more than whole 24 h periods.
    if day_index < 0 || day_index > (due - start) / 86_400_000 + 2 {
        return Err(StoreError::Invalid("that day is outside the deadline".into()));
    }
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let now = now_ms() as i64;
    let tx = store.conn_mut().transaction()?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT id FROM deadline_day_marks WHERE deadline_id = ?1 AND day_index = ?2",
            params![id, day_index],
            |r| r.get(0),
        )
        .optional()?;
    let mark_id = match existing {
        Some(mark_id) => {
            tx.execute(
                "UPDATE deadline_day_marks SET done = ?2, deleted_at = NULL, updated_at = ?3, device_id = ?4 WHERE id = ?1",
                params![mark_id, done as i64, stamp, device],
            )?;
            mark_id
        }
        None => {
            let mark_id = new_id();
            tx.execute(
                "INSERT INTO deadline_day_marks (id, deadline_id, day_index, done, created_at, updated_at, device_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![mark_id, id, day_index, done as i64, now, stamp, device],
            )?;
            mark_id
        }
    };
    let fields = serde_json::json!({ "deadline_id": id, "day_index": day_index, "done": done }).to_string();
    log_change(&tx, "deadline_day_marks", &mark_id, &fields, &stamp, &device)?;
    tx.commit()?;
    read_back(store, id, today)
}

/// Deletes deadlines (tombstones, so Undo and the other PC both work). Their checklists go with them.
pub fn delete(store: &mut Store, ids: &[String]) -> Result<()> {
    set_deleted(store, ids, Some(now_ms() as i64))
}

pub fn restore(store: &mut Store, ids: &[String]) -> Result<()> {
    set_deleted(store, ids, None)
}

fn set_deleted(store: &mut Store, ids: &[String], deleted_at: Option<i64>) -> Result<()> {
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    for id in ids {
        let changed = tx.execute(
            "UPDATE deadlines SET deleted_at = ?2, updated_at = ?3, device_id = ?4 WHERE id = ?1",
            params![id, deleted_at, stamp, device],
        )?;
        if changed == 0 {
            return Err(gone());
        }
        log_change(&tx, "deadlines", id, &serde_json::json!({ "deleted_at": deleted_at }).to_string(), &stamp, &device)?;
    }
    tx.commit()?;
    Ok(())
}

fn log_change(conn: &Connection, entity: &str, id: &str, fields: &str, stamp: &str, device: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO change_log (entity, entity_id, fields, hlc, device_id) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![entity, id, fields, stamp, device],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::TaskInput;

    const DAY: i64 = 86_400_000;
    const FRI: &str = "2026-10-23";

    fn input(title: &str, start: Option<i64>, due: i64) -> DeadlineInput {
        DeadlineInput {
            title: title.into(),
            description: String::new(),
            start_at: start,
            due_at: due,
            all_day: false,
            viz: "both".into(),
            color: None,
            progress_style: "grid".into(),
            cell_shape: "rounded".into(),
            grid_cols: None,
        }
    }

    #[test]
    fn progress_look_is_saved_and_checked() {
        let mut store = Store::open_in_memory().unwrap();
        let start = 1_000 * DAY;
        let mut i = input("Christmas", Some(start), start + 72 * DAY);
        let d = create(&mut store, i.clone(), FRI).unwrap();
        assert_eq!((d.progress_style.as_str(), d.cell_shape.as_str(), d.grid_cols), ("grid", "rounded", None));
        i.progress_style = "bars".into();
        i.cell_shape = "circle".into();
        i.grid_cols = Some(10);
        let d = update(&mut store, &d.id, i.clone(), FRI).unwrap();
        assert_eq!((d.progress_style.as_str(), d.cell_shape.as_str(), d.grid_cols), ("bars", "circle", Some(10)));
        for (style, shape, cols) in [("pie", "circle", None), ("grid", "star", None), ("grid", "circle", Some(0)), ("grid", "circle", Some(61))] {
            let mut bad = i.clone();
            bad.progress_style = style.into();
            bad.cell_shape = shape.into();
            bad.grid_cols = cols;
            assert!(update(&mut store, &d.id, bad, FRI).is_err(), "{style} {shape} {cols:?}");
        }
    }

    #[test]
    fn create_edit_complete_delete_round_trip() {
        let mut store = Store::open_in_memory().unwrap();
        let start = 1_000 * DAY;
        let d = create(&mut store, input("  Physics project ", Some(start), start + 10 * DAY), FRI).unwrap();
        assert_eq!((d.title.as_str(), d.start_at, d.completed_at), ("Physics project", start, None));

        let mut changed = input("Physics project", None, start + 12 * DAY);
        changed.viz = "ring".into();
        changed.color = Some("#ABC".into());
        let d = update(&mut store, &d.id, changed, FRI).unwrap();
        assert_eq!((d.start_at, d.due_at, d.viz.as_str()), (start, start + 12 * DAY, "ring"), "start kept when left out");
        assert_eq!(d.color.as_deref(), Some("#aabbcc"));

        assert!(set_completed(&mut store, &d.id, true, FRI).unwrap().completed_at.is_some());
        assert!(upcoming(store.conn(), FRI, 5).unwrap().is_empty(), "finished deadlines leave the dashboard");
        assert!(set_completed(&mut store, &d.id, false, FRI).unwrap().completed_at.is_none());

        delete(&mut store, std::slice::from_ref(&d.id)).unwrap();
        assert!(list(store.conn(), FRI).unwrap().is_empty());
        restore(&mut store, std::slice::from_ref(&d.id)).unwrap();
        assert_eq!(list(store.conn(), FRI).unwrap().len(), 1);
    }

    #[test]
    fn due_must_be_after_start() {
        let mut store = Store::open_in_memory().unwrap();
        let err = create(&mut store, input("Exam", Some(5 * DAY), 5 * DAY), FRI).unwrap_err();
        assert!(err.to_string().contains("after the start"));
        assert!(create(&mut store, input(" ", None, i64::MAX), FRI).is_err());
        let mut bad = input("Exam", None, i64::MAX);
        bad.viz = "pie".into();
        assert!(create(&mut store, bad, FRI).is_err());
    }

    #[test]
    fn days_can_be_marked_and_unmarked() {
        let mut store = Store::open_in_memory().unwrap();
        let d = create(&mut store, input("Essay", Some(0), 5 * DAY), FRI).unwrap();
        mark_day(&mut store, &d.id, 0, true, FRI).unwrap();
        mark_day(&mut store, &d.id, 2, true, FRI).unwrap();
        let d2 = mark_day(&mut store, &d.id, 0, false, FRI).unwrap();
        assert_eq!(d2.marked_days, [2]);
        assert!(mark_day(&mut store, &d.id, 40, true, FRI).is_err());
        assert!(mark_day(&mut store, &d.id, -1, true, FRI).is_err());
    }

    #[test]
    fn checklist_belongs_to_the_deadline_not_the_todo_list() {
        let mut store = Store::open_in_memory().unwrap();
        let d = create(&mut store, input("Essay", Some(0), 5 * DAY), FRI).unwrap();
        let mut item = TaskInput {
            title: "outline".into(),
            due_date: None,
            priority: "normal".into(),
            repeat_days: 0,
            color: None,
            deadline_id: Some(d.id.clone()),
            start_time: None,
            end_time: None,
            duration_min: None,
            category: None,
            description: String::new(),
            space_id: None,
            plan_day: None,
        };
        tasks::create(&mut store, item.clone(), FRI).unwrap();
        item.deadline_id = Some("missing".into());
        assert!(tasks::create(&mut store, item, FRI).is_err());

        assert_eq!(get(store.conn(), &d.id, FRI).unwrap().unwrap().tasks[0].title, "outline");
        assert!(tasks::list(store.conn(), FRI).unwrap().is_empty());
        assert!(tasks::for_day(store.conn(), FRI, 10).unwrap().is_empty());
    }

    #[test]
    fn upcoming_is_soonest_first_and_list_puts_finished_last() {
        let mut store = Store::open_in_memory().unwrap();
        let later = create(&mut store, input("later", Some(0), 9 * DAY), FRI).unwrap();
        let soon = create(&mut store, input("soon", Some(0), 2 * DAY), FRI).unwrap();
        let done = create(&mut store, input("done", Some(0), DAY), FRI).unwrap();
        set_completed(&mut store, &done.id, true, FRI).unwrap();
        let ids = |v: Vec<Deadline>| v.into_iter().map(|d| d.id).collect::<Vec<_>>();
        assert_eq!(ids(upcoming(store.conn(), FRI, 5).unwrap()), [soon.id.clone(), later.id.clone()]);
        assert_eq!(ids(list(store.conn(), FRI).unwrap()), [soon.id, later.id, done.id]);
    }
}
