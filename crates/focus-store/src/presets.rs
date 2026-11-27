use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::ids::new_id;
use crate::store::now_ms;

/// A focus preset as shown in the app.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub focus_s: i64,
    pub short_break_s: i64,
    pub long_break_s: i64,
    pub sessions_per_cycle: i64,
    pub long_break_every: i64,
    pub auto_start_break: bool,
    pub auto_start_focus: bool,
    pub blocking_profile_id: Option<String>,
}

/// Built-in presets. Their IDs are fixed so both PCs create the same rows and sync
/// never produces two "Pomodoro" presets.
const DEFAULTS: &[(&str, &str, i64, i64, i64, i64, i64)] = &[
    // id, name, focus, short break, long break, sessions, long break every
    ("00000000-0000-7000-8000-000000000001", "Pomodoro", 25 * 60, 5 * 60, 15 * 60, 4, 4),
    ("00000000-0000-7000-8000-000000000002", "Study", 50 * 60, 10 * 60, 20 * 60, 4, 4),
    ("00000000-0000-7000-8000-000000000003", "Deep Work", 90 * 60, 20 * 60, 30 * 60, 2, 0),
    ("00000000-0000-7000-8000-000000000004", "Exam", 50 * 60, 10 * 60, 20 * 60, 3, 0),
];

/// Adds any built-in preset that has never existed here. A preset the user deleted stays
/// deleted, because its tombstone row is still present.
pub fn seed_defaults(conn: &Connection, stamp: &str, device_id: &str, now_ms: i64) -> Result<()> {
    for (order, (id, name, focus, short, long, sessions, every)) in DEFAULTS.iter().enumerate() {
        conn.execute(
            "INSERT OR IGNORE INTO focus_presets
               (id, name, focus_s, short_break_s, long_break_s, sessions_per_cycle, long_break_every,
                auto_start_break, auto_start_focus, sort_order, created_at, updated_at, device_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 0, ?8, ?9, ?10, ?11)",
            params![id, name, focus, short, long, sessions, every, order as i64, now_ms, stamp, device_id],
        )?;
    }
    Ok(())
}

/// What the user can edit in a preset. Mirrored by `PresetInput` in src/ipc/presets.ts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetInput {
    pub name: String,
    pub focus_s: i64,
    pub short_break_s: i64,
    pub long_break_s: i64,
    pub sessions_per_cycle: i64,
    pub long_break_every: i64,
    pub auto_start_break: bool,
    pub auto_start_focus: bool,
}

impl PresetInput {
    /// Same limits as the database CHECKs, with messages a person can act on.
    fn validated(mut self) -> Result<Self> {
        self.name = self.name.trim().to_string();
        let bad = |m: &str| Err(StoreError::Invalid(m.to_string()));
        if self.name.is_empty() {
            return bad("the preset needs a name");
        }
        if self.name.chars().count() > 40 {
            return bad("the name can be at most 40 characters");
        }
        if !(60..=86_400).contains(&self.focus_s) {
            return bad("focus must be between 1 minute and 24 hours");
        }
        if !(0..=86_400).contains(&self.short_break_s) || !(0..=86_400).contains(&self.long_break_s) {
            return bad("breaks must be between 0 minutes and 24 hours");
        }
        if !(1..=24).contains(&self.sessions_per_cycle) {
            return bad("sessions must be between 1 and 24");
        }
        if !(0..=24).contains(&self.long_break_every) {
            return bad("\"long break every\" must be between 0 (never) and 24");
        }
        Ok(self)
    }

    fn change_fields(&self) -> String {
        serde_json::json!({
            "name": self.name,
            "focus_s": self.focus_s,
            "short_break_s": self.short_break_s,
            "long_break_s": self.long_break_s,
            "sessions_per_cycle": self.sessions_per_cycle,
            "long_break_every": self.long_break_every,
            "auto_start_break": self.auto_start_break,
            "auto_start_focus": self.auto_start_focus,
        })
        .to_string()
    }
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Preset>> {
    Ok(list_where(conn, "AND id = ?1", params![id])?.into_iter().next())
}

pub fn create(store: &mut Store, input: PresetInput) -> Result<Preset> {
    let input = input.validated()?;
    let id = new_id();
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    let order: i64 = tx.query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM focus_presets", [], |r| r.get(0))?;
    tx.execute(
        "INSERT INTO focus_presets
           (id, name, focus_s, short_break_s, long_break_s, sessions_per_cycle, long_break_every,
            auto_start_break, auto_start_focus, sort_order, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id, input.name, input.focus_s, input.short_break_s, input.long_break_s, input.sessions_per_cycle,
            input.long_break_every, input.auto_start_break as i64, input.auto_start_focus as i64, order,
            now_ms() as i64, stamp, device
        ],
    )?;
    log_change(&tx, &id, &input.change_fields(), &stamp, &device)?;
    tx.commit()?;
    get(store.conn(), &id)?.ok_or_else(|| StoreError::Invalid("the new preset could not be read back".into()))
}

pub fn update(store: &mut Store, id: &str, input: PresetInput) -> Result<Preset> {
    let input = input.validated()?;
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    let changed = tx.execute(
        "UPDATE focus_presets SET name = ?2, focus_s = ?3, short_break_s = ?4, long_break_s = ?5,
                sessions_per_cycle = ?6, long_break_every = ?7, auto_start_break = ?8, auto_start_focus = ?9,
                updated_at = ?10, device_id = ?11
         WHERE id = ?1 AND deleted_at IS NULL",
        params![
            id, input.name, input.focus_s, input.short_break_s, input.long_break_s, input.sessions_per_cycle,
            input.long_break_every, input.auto_start_break as i64, input.auto_start_focus as i64, stamp, device
        ],
    )?;
    if changed == 0 {
        return Err(StoreError::Invalid("that preset no longer exists".into()));
    }
    log_change(&tx, id, &input.change_fields(), &stamp, &device)?;
    tx.commit()?;
    get(store.conn(), id)?.ok_or_else(|| StoreError::Invalid("the preset could not be read back".into()))
}

/// Marks the preset deleted (kept as a tombstone so the other PC learns about it).
/// The last remaining preset cannot be deleted, so the timer always has something to run.
pub fn delete(store: &mut Store, id: &str) -> Result<()> {
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let now = now_ms() as i64;
    let tx = store.conn_mut().transaction()?;
    let remaining: i64 = tx.query_row("SELECT COUNT(*) FROM focus_presets WHERE deleted_at IS NULL", [], |r| r.get(0))?;
    let exists: Option<i64> = tx
        .query_row("SELECT 1 FROM focus_presets WHERE id = ?1 AND deleted_at IS NULL", params![id], |r| r.get(0))
        .optional()?;
    if exists.is_none() {
        return Err(StoreError::Invalid("that preset no longer exists".into()));
    }
    if remaining <= 1 {
        return Err(StoreError::Invalid("keep at least one preset".into()));
    }
    tx.execute(
        "UPDATE focus_presets SET deleted_at = ?2, updated_at = ?3, device_id = ?4 WHERE id = ?1",
        params![id, now, stamp, device],
    )?;
    log_change(&tx, id, &serde_json::json!({ "deleted_at": now }).to_string(), &stamp, &device)?;
    tx.commit()?;
    Ok(())
}

fn log_change(conn: &Connection, id: &str, fields: &str, stamp: &str, device: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO change_log (entity, entity_id, fields, hlc, device_id) VALUES ('focus_presets', ?1, ?2, ?3, ?4)",
        params![id, fields, stamp, device],
    )?;
    Ok(())
}

pub fn list(conn: &Connection) -> Result<Vec<Preset>> {
    list_where(conn, "", [])
}

fn list_where(conn: &Connection, extra: &str, args: impl rusqlite::Params) -> Result<Vec<Preset>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT id, name, focus_s, short_break_s, long_break_s, sessions_per_cycle, long_break_every,
                auto_start_break, auto_start_focus, blocking_profile_id
         FROM focus_presets WHERE deleted_at IS NULL {extra} ORDER BY sort_order, name"
    ))?;
    let rows = stmt.query_map(args, |r| {
        Ok(Preset {
            id: r.get(0)?,
            name: r.get(1)?,
            focus_s: r.get(2)?,
            short_break_s: r.get(3)?,
            long_break_s: r.get(4)?,
            sessions_per_cycle: r.get(5)?,
            long_break_every: r.get(6)?,
            auto_start_break: r.get::<_, i64>(7)? == 1,
            auto_start_focus: r.get::<_, i64>(8)? == 1,
            blocking_profile_id: r.get(9)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;

    #[test]
    fn default_presets_are_present_in_order() {
        let store = Store::open_in_memory().unwrap();
        let names: Vec<String> = list(store.conn()).unwrap().into_iter().map(|p| p.name).collect();
        assert_eq!(names, ["Pomodoro", "Study", "Deep Work", "Exam"]);
    }

    #[test]
    fn pomodoro_matches_the_brief() {
        let store = Store::open_in_memory().unwrap();
        let p = list(store.conn()).unwrap().into_iter().find(|p| p.name == "Pomodoro").unwrap();
        assert_eq!((p.focus_s, p.short_break_s, p.sessions_per_cycle), (25 * 60, 5 * 60, 4));
    }

    fn input(name: &str) -> PresetInput {
        PresetInput {
            name: name.into(),
            focus_s: 45 * 60,
            short_break_s: 15 * 60,
            long_break_s: 30 * 60,
            sessions_per_cycle: 3,
            long_break_every: 0,
            auto_start_break: true,
            auto_start_focus: false,
        }
    }

    #[test]
    fn create_edit_delete_round_trip() {
        let mut store = Store::open_in_memory().unwrap();
        let p = create(&mut store, input("  Reading  ")).unwrap();
        assert_eq!(p.name, "Reading", "names are trimmed");
        assert_eq!(list(store.conn()).unwrap().last().unwrap().id, p.id, "new presets go last");

        let mut changed = input("Reading");
        changed.focus_s = 30 * 60;
        assert_eq!(update(&mut store, &p.id, changed).unwrap().focus_s, 30 * 60);

        delete(&mut store, &p.id).unwrap();
        assert!(get(store.conn(), &p.id).unwrap().is_none());
        assert!(update(&mut store, &p.id, input("Reading")).is_err(), "deleted presets cannot be edited");

        let logged: i64 = store
            .conn()
            .query_row("SELECT COUNT(*) FROM change_log WHERE entity = 'focus_presets' AND entity_id = ?1", [&p.id], |r| r.get(0))
            .unwrap();
        assert_eq!(logged, 3, "create, edit and delete are each logged for sync");
    }

    #[test]
    fn bad_values_are_refused_with_a_reason() {
        let mut store = Store::open_in_memory().unwrap();
        let mut empty = input(" ");
        assert!(create(&mut store, empty.clone()).unwrap_err().to_string().contains("name"));
        empty.name = "x".into();
        empty.focus_s = 30;
        assert!(create(&mut store, empty.clone()).unwrap_err().to_string().contains("1 minute"));
        empty.focus_s = 60;
        empty.sessions_per_cycle = 0;
        assert!(create(&mut store, empty).is_err());
    }

    #[test]
    fn the_last_preset_cannot_be_deleted() {
        let mut store = Store::open_in_memory().unwrap();
        let ids: Vec<String> = list(store.conn()).unwrap().into_iter().map(|p| p.id).collect();
        for id in &ids[1..] {
            delete(&mut store, id).unwrap();
        }
        assert!(delete(&mut store, &ids[0]).unwrap_err().to_string().contains("at least one"));
    }

    #[test]
    fn deleted_default_preset_is_not_recreated() {
        let mut store = Store::open_in_memory().unwrap();
        store
            .conn()
            .execute("UPDATE focus_presets SET deleted_at = 1 WHERE name = 'Exam'", [])
            .unwrap();
        let stamp = store.next_stamp();
        let device = store.device_id().to_string();
        seed_defaults(store.conn(), &stamp, &device, 0).unwrap();
        assert!(list(store.conn()).unwrap().iter().all(|p| p.name != "Exam"));
    }
}
