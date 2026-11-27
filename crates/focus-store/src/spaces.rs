//! To-do workspaces. Tasks with no space are on the "Everyday" week board; a space is either
//! another week board ("board", e.g. College) or a day-by-day plan ("plan": Day 1 write the code,
//! Day 2 fix bugs ...). A plan can be given a start date, which turns Day 1, Day 2 ... into dates.
//! Two more kinds hold no tasks but things of their own (src/boards.rs): a free board ("free",
//! lists of cards) and a case board ("case", cards and sticky notes joined by strings).

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::ids::new_id;
use crate::store::now_ms;
use crate::tasks::{normalize_color, weekday};

/// A space as shown in the app. Mirrored by `Space` in src/ipc/spaces.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    pub id: String,
    pub name: String,
    /// "board", "plan", "free" or "case".
    pub kind: String,
    pub color: Option<String>,
    /// A plan's Day 1 (YYYY-MM-DD); None = not dated.
    pub start_date: Option<String>,
    /// How many days a plan has.
    pub days: i64,
    pub created_at: i64,
}

/// What the user can edit. Mirrored by `SpaceInput` in src/ipc/spaces.ts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceInput {
    pub name: String,
    /// Only read when creating; a space keeps its kind.
    pub kind: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default = "default_days")]
    pub days: i64,
}

fn default_days() -> i64 {
    7
}

pub const KINDS: &[&str] = &["board", "plan", "free", "case"];
/// The longest plan.
pub const MAX_DAYS: i64 = 365;

impl SpaceInput {
    fn validated(mut self) -> Result<Self> {
        let bad = |m: &str| Err(StoreError::Invalid(m.to_string()));
        self.name = self.name.trim().to_string();
        if self.name.is_empty() {
            return bad("the space needs a name");
        }
        if self.name.chars().count() > 60 {
            return bad("the name can be at most 60 characters");
        }
        if !KINDS.contains(&self.kind.as_str()) {
            return bad("a space is a week board, a day-by-day plan, a free board or a case board");
        }
        if !(1..=MAX_DAYS).contains(&self.days) {
            return bad("a plan has between 1 and 365 days");
        }
        self.color = match self.color.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(c) => Some(normalize_color(c).ok_or_else(|| StoreError::Invalid(format!("{c:?} is not a colour like #4f8cff")))?),
        };
        self.start_date = self.start_date.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
        if self.start_date.as_deref().is_some_and(|d| weekday(d).is_none()) {
            return bad("the start date must look like 2026-10-23");
        }
        if self.kind != "plan" {
            self.start_date = None;
            self.days = default_days();
        }
        Ok(self)
    }
}

const COLUMNS: &str = "id, name, kind, color, start_date, days, created_at";

fn read_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Space> {
    Ok(Space {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: r.get(2)?,
        color: r.get(3)?,
        start_date: r.get(4)?,
        days: r.get(5)?,
        created_at: r.get(6)?,
    })
}

/// Every space, in the order they were made (the tabs on the To-do page).
pub fn list(conn: &Connection) -> Result<Vec<Space>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM spaces WHERE deleted_at IS NULL ORDER BY sort_order, created_at"))?;
    let rows = stmt.query_map([], read_row)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Space>> {
    Ok(conn
        .query_row(&format!("SELECT {COLUMNS} FROM spaces WHERE id = ?1 AND deleted_at IS NULL"), params![id], read_row)
        .optional()?)
}

fn gone() -> StoreError {
    StoreError::Invalid("that space no longer exists".into())
}

pub fn create(store: &mut Store, input: SpaceInput) -> Result<Space> {
    let input = input.validated()?;
    let id = new_id();
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    let order: i64 = tx.query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM spaces", [], |r| r.get(0))?;
    tx.execute(
        "INSERT INTO spaces (id, name, kind, color, start_date, days, sort_order, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, input.name, input.kind, input.color, input.start_date, input.days, order, now_ms() as i64, stamp, device],
    )?;
    let fields = serde_json::json!({
        "name": input.name, "kind": input.kind, "color": input.color, "start_date": input.start_date, "days": input.days,
    });
    log_change(&tx, &id, &fields.to_string(), &stamp, &device)?;
    tx.commit()?;
    get(store.conn(), &id)?.ok_or_else(gone)
}

/// Renames, recolours or re-dates a space. A plan cannot be made shorter than its last planned day.
pub fn update(store: &mut Store, id: &str, input: SpaceInput) -> Result<Space> {
    let current = get(store.conn(), id)?.ok_or_else(gone)?;
    let input = SpaceInput { kind: current.kind, ..input }.validated()?;
    let last_used: Option<i64> = store.conn().query_row(
        "SELECT MAX(plan_day) FROM tasks WHERE space_id = ?1 AND deleted_at IS NULL",
        params![id],
        |r| r.get(0),
    )?;
    if let Some(last) = last_used
        && input.days < last
    {
        return Err(StoreError::Invalid(format!("Day {last} still has steps; move them before removing that day")));
    }
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    tx.execute(
        "UPDATE spaces SET name = ?2, color = ?3, start_date = ?4, days = ?5, updated_at = ?6, device_id = ?7
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id, input.name, input.color, input.start_date, input.days, stamp, device],
    )?;
    let fields = serde_json::json!({ "name": input.name, "color": input.color, "start_date": input.start_date, "days": input.days });
    log_change(&tx, id, &fields.to_string(), &stamp, &device)?;
    tx.commit()?;
    get(store.conn(), id)?.ok_or_else(gone)
}

/// Deletes a space; its tasks are hidden with it (kept, so Undo brings everything back).
pub fn delete(store: &mut Store, id: &str) -> Result<()> {
    set_deleted(store, id, Some(now_ms() as i64))
}

pub fn restore(store: &mut Store, id: &str) -> Result<()> {
    set_deleted(store, id, None)
}

fn set_deleted(store: &mut Store, id: &str, deleted_at: Option<i64>) -> Result<()> {
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    let changed = tx.execute(
        "UPDATE spaces SET deleted_at = ?2, updated_at = ?3, device_id = ?4 WHERE id = ?1",
        params![id, deleted_at, stamp, device],
    )?;
    if changed == 0 {
        return Err(gone());
    }
    log_change(&tx, id, &serde_json::json!({ "deleted_at": deleted_at }).to_string(), &stamp, &device)?;
    tx.commit()?;
    Ok(())
}

fn log_change(conn: &Connection, id: &str, fields: &str, stamp: &str, device: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO change_log (entity, entity_id, fields, hlc, device_id) VALUES ('spaces', ?1, ?2, ?3, ?4)",
        params![id, fields, stamp, device],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(name: &str, start: Option<&str>, days: i64) -> SpaceInput {
        SpaceInput { name: name.into(), kind: "plan".into(), color: None, start_date: start.map(String::from), days }
    }

    #[test]
    fn create_edit_delete_round_trip() {
        let mut store = Store::open_in_memory().unwrap();
        let s = create(&mut store, plan("  Focus v2 ", Some("2026-10-26"), 3)).unwrap();
        assert_eq!((s.name.as_str(), s.kind.as_str(), s.start_date.as_deref(), s.days), ("Focus v2", "plan", Some("2026-10-26"), 3));

        let mut changed = plan("Focus v2.1", None, 5);
        changed.kind = "board".into(); // ignored: a space keeps its kind
        let s = update(&mut store, &s.id, changed).unwrap();
        assert_eq!((s.name.as_str(), s.kind.as_str(), s.start_date, s.days), ("Focus v2.1", "plan", None, 5));

        delete(&mut store, &s.id).unwrap();
        assert!(list(store.conn()).unwrap().is_empty());
        restore(&mut store, &s.id).unwrap();
        assert_eq!(list(store.conn()).unwrap().len(), 1);
    }

    #[test]
    fn bad_values_are_refused() {
        let mut store = Store::open_in_memory().unwrap();
        assert!(create(&mut store, plan(" ", None, 3)).is_err());
        assert!(create(&mut store, plan("x", None, 0)).is_err());
        assert!(create(&mut store, plan("x", None, 366)).is_err());
        assert!(create(&mut store, plan("x", Some("monday"), 3)).is_err());
        let mut odd = plan("x", None, 3);
        odd.kind = "list".into();
        assert!(create(&mut store, odd).is_err());
    }

    #[test]
    fn a_board_has_no_dates() {
        let mut store = Store::open_in_memory().unwrap();
        let mut b = plan("College", Some("2026-10-26"), 30);
        b.kind = "board".into();
        let b = create(&mut store, b).unwrap();
        assert_eq!((b.start_date, b.days), (None, 7));
    }
}
