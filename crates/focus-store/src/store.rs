use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::clock::HybridClock;
use crate::error::{Result, StoreError};
use crate::{ids, migrations, presets};

/// An open Focus database plus this PC's sync clock.
pub struct Store {
    pub(crate) conn: Connection,
    pub(crate) clock: HybridClock,
    path: Option<PathBuf>,
    /// Where attached files are kept (the "attachments" folder next to the database).
    files_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreStatus {
    pub path: String,
    pub schema_version: i64,
    pub table_count: i64,
    pub size_bytes: u64,
    pub device_id: String,
    pub preset_count: i64,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Store {
    /// Opens (or creates) the database file, upgrades its schema and adds the default presets.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|source| StoreError::CreateDir {
                path: dir.display().to_string(),
                source,
            })?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn, Some(path.to_path_buf()))
    }

    /// In-memory database for tests.
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?, None)
    }

    fn init(mut conn: Connection, path: Option<PathBuf>) -> Result<Self> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrations::migrate(&mut conn)?;
        crate::pc_time::ensure_table(&conn)?;
        let device_id = ensure_device_id(&conn)?;
        let files_dir = path.as_ref().and_then(|p| p.parent()).map(|d| d.join("attachments"));
        let mut store = Self { conn, clock: HybridClock::new(device_id), path, files_dir };
        // Start the clock after every stamp already saved, so a PC clock set back while Focus
        // was closed can't give new changes older stamps than ones the other devices have seen.
        if let Some(latest) = crate::sync::latest_stamp(&store.conn)? {
            store.observe_stamp(&latest);
        }
        store.seed_defaults()?;
        Ok(store)
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    /// The folder for attached files; None for an in-memory database until one is set.
    pub fn files_dir(&self) -> Option<&Path> {
        self.files_dir.as_deref()
    }

    /// Keeps attached files somewhere else (tests, or a database opened in memory).
    pub fn set_files_dir(&mut self, dir: PathBuf) {
        self.files_dir = Some(dir);
    }

    pub fn device_id(&self) -> &str {
        self.clock.device_id()
    }

    /// A clock stamp for a change made now.
    pub fn next_stamp(&mut self) -> String {
        self.clock.tick(now_ms())
    }

    /// Moves the clock past a stamp from another device (or an older one saved here).
    pub fn observe_stamp(&mut self, stamp: &str) {
        // A malformed stamp is ignored: it can only come from a damaged row, which LWW skips.
        let _ = self.clock.observe(stamp, now_ms());
    }

    fn seed_defaults(&mut self) -> Result<()> {
        let stamp = self.next_stamp();
        let device = self.device_id().to_string();
        let tx = self.conn.transaction()?;
        presets::seed_defaults(&tx, &stamp, &device, now_ms() as i64)?;
        tx.commit()?;
        Ok(())
    }

    pub fn status(&self) -> Result<StoreStatus> {
        let schema_version: i64 = self.conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        let table_count: i64 = self.conn.query_row(
            "SELECT count(*) FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'notes_fts_%'",
            [],
            |r| r.get(0),
        )?;
        let preset_count: i64 =
            self.conn.query_row("SELECT count(*) FROM focus_presets WHERE deleted_at IS NULL", [], |r| r.get(0))?;
        let (path, size_bytes) = match &self.path {
            Some(p) => (p.display().to_string(), std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)),
            None => (":memory:".to_string(), 0),
        };
        Ok(StoreStatus {
            path,
            schema_version,
            table_count,
            size_bytes,
            device_id: self.device_id().to_string(),
            preset_count,
        })
    }
}

/// Each PC gets a permanent random ID the first time Focus runs; it marks which PC made a change.
fn ensure_device_id(conn: &Connection) -> Result<String> {
    let existing: Option<String> = conn
        .query_row("SELECT value FROM local_meta WHERE key = 'device_id'", [], |r| r.get(0))
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = ids::new_id();
    conn.execute("INSERT INTO local_meta (key, value) VALUES ('device_id', ?1)", params![id])?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_database_reaches_latest_schema() {
        let store = Store::open_in_memory().unwrap();
        let status = store.status().unwrap();
        assert_eq!(status.schema_version, migrations::LATEST_VERSION);
        assert!(status.table_count >= 20, "expected all tables, got {}", status.table_count);
    }

    #[test]
    fn reopening_keeps_device_id_and_does_not_duplicate_presets() {
        let dir = std::env::temp_dir().join(format!("focus-store-test-{}", ids::new_id()));
        let path = dir.join("focus.db");
        let first = {
            let s = Store::open(&path).unwrap();
            s.status().unwrap()
        };
        let second = Store::open(&path).unwrap().status().unwrap();
        assert_eq!(first.device_id, second.device_id);
        assert_eq!(first.preset_count, second.preset_count);
        assert!(second.size_bytes > 0);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn newer_schema_is_refused_instead_of_damaged() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 999).unwrap();
        let err = migrations::migrate(&mut conn).unwrap_err();
        assert!(matches!(err, StoreError::NewerSchema { found: 999, .. }));
    }

    #[test]
    fn constraints_reject_bad_data() {
        let mut store = Store::open_in_memory().unwrap();
        let stamp = store.next_stamp();
        let device = store.device_id().to_string();
        // A deadline that ends before it starts.
        let bad_deadline = store.conn().execute(
            "INSERT INTO deadlines (id, title, start_at, due_at, created_at, updated_at, device_id)
             VALUES (?1, 'Exam', 2000, 1000, 0, ?2, ?3)",
            params![ids::new_id(), stamp, device],
        );
        assert!(bad_deadline.is_err());
        // A blocking rule with an unknown type.
        let bad_rule = store.conn().execute(
            "INSERT INTO blocking_rules (id, profile_id, action, type, value, normalized, created_at, updated_at, device_id)
             VALUES (?1, 'x', 'block', 'magic', 'a', 'a', 0, ?2, ?3)",
            params![ids::new_id(), stamp, device],
        );
        assert!(bad_rule.is_err());
    }

    #[test]
    fn foreign_keys_are_checked_at_commit() {
        let mut store = Store::open_in_memory().unwrap();
        let stamp = store.next_stamp();
        let device = store.device_id().to_string();
        let tx = store.conn.transaction().unwrap();
        // Child before parent inside one transaction is fine (deferred) ...
        let deadline_id = ids::new_id();
        tx.execute(
            "INSERT INTO tasks (id, title, deadline_id, created_at, updated_at, device_id) VALUES (?1, 'Gym', ?2, 0, ?3, ?4)",
            params![ids::new_id(), deadline_id, stamp, device],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO deadlines (id, title, start_at, due_at, created_at, updated_at, device_id) VALUES (?1, 'Project', 1, 2, 0, ?2, ?3)",
            params![deadline_id, stamp, device],
        )
        .unwrap();
        tx.commit().unwrap();

        // ... but a dangling reference fails when committed.
        let tx = store.conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO tasks (id, title, deadline_id, created_at, updated_at, device_id) VALUES (?1, 'Shop', 'missing', 0, ?2, ?3)",
            params![ids::new_id(), stamp, device],
        )
        .unwrap();
        assert!(tx.commit().is_err());
    }

    #[test]
    fn note_search_finds_words() {
        let mut store = Store::open_in_memory().unwrap();
        let stamp = store.next_stamp();
        let device = store.device_id().to_string();
        store
            .conn()
            .execute(
                "INSERT INTO notes (id, title, plain_text, created_at, updated_at, device_id)
                 VALUES (?1, 'Physics', 'Study thermodynamics chapter 3', 0, ?2, ?3)",
                params![ids::new_id(), stamp, device],
            )
            .unwrap();
        let hits: i64 = store
            .conn()
            .query_row("SELECT count(*) FROM notes_fts WHERE notes_fts MATCH 'thermodynamics'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hits, 1);
    }
}
