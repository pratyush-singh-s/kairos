use rusqlite::Connection;

use crate::error::{Result, StoreError};

/// Ordered list of schema migrations. Never edit a shipped migration; add a new one.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_initial.sql"),
    include_str!("../migrations/0002_task_repeat.sql"),
    include_str!("../migrations/0003_task_color.sql"),
    include_str!("../migrations/0004_deadline_color.sql"),
    include_str!("../migrations/0005_task_times.sql"),
    include_str!("../migrations/0006_task_description.sql"),
    include_str!("../migrations/0007_deadline_progress_look.sql"),
    include_str!("../migrations/0008_spaces.sql"),
    include_str!("../migrations/0009_notes_body.sql"),
    include_str!("../migrations/0010_calendar.sql"),
    include_str!("../migrations/0011_sync.sql"),
    include_str!("../migrations/0012_note_attachments.sql"),
    include_str!("../migrations/0013_board_spaces.sql"),
    include_str!("../migrations/0014_note_kind.sql"),
];

/// Migrations that rebuild a table other tables point at. They run with foreign keys off (which
/// SQLite only allows outside a transaction), as SQLite's docs say to.
const WITHOUT_FOREIGN_KEYS: &[i64] = &[13];

pub const LATEST_VERSION: i64 = MIGRATIONS.len() as i64;

/// Brings the database up to the latest schema. Each migration runs in its own transaction
/// together with the `user_version` bump, so a failure leaves the previous version intact.
pub fn migrate(conn: &mut Connection) -> Result<i64> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if current > LATEST_VERSION {
        return Err(StoreError::NewerSchema { found: current, supported: LATEST_VERSION });
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let version = index as i64 + 1;
        let rebuild = WITHOUT_FOREIGN_KEYS.contains(&version);
        if rebuild {
            conn.pragma_update(None, "foreign_keys", "OFF")?;
        }
        let result = run(conn, sql, version);
        if rebuild {
            conn.pragma_update(None, "foreign_keys", "ON")?;
        }
        result?;
    }
    Ok(LATEST_VERSION)
}

fn run(conn: &mut Connection, sql: &str, version: i64) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(sql)?;
    tx.pragma_update(None, "user_version", version)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A database made by 0.21.26 (schema 12) with a plan and a step in it moves to 13 intact.
    #[test]
    fn schema_13_keeps_spaces_and_their_tasks() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        for (i, sql) in MIGRATIONS[..12].iter().enumerate() {
            let tx = conn.transaction().unwrap();
            tx.execute_batch(sql).unwrap();
            tx.pragma_update(None, "user_version", i as i64 + 1).unwrap();
            tx.commit().unwrap();
        }
        conn.execute_batch(
            "INSERT INTO spaces (id, name, kind, created_at, updated_at, device_id) VALUES ('s', 'Focus v2', 'plan', 1, '1', 'd');
             INSERT INTO tasks (id, title, created_at, updated_at, device_id, space_id, plan_day) VALUES ('t', 'Write it', 1, '1', 'd', 's', 2);",
        )
        .unwrap();

        assert_eq!(migrate(&mut conn).unwrap(), LATEST_VERSION);
        let fk_on: i64 = conn.pragma_query_value(None, "foreign_keys", |r| r.get(0)).unwrap();
        assert_eq!(fk_on, 1);
        let (name, kind): (String, String) = conn.query_row("SELECT name, kind FROM spaces WHERE id = 's'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((name.as_str(), kind.as_str()), ("Focus v2", "plan"));
        let parent: String = conn.query_row("SELECT \"table\" FROM pragma_foreign_key_list('tasks') WHERE \"from\" = 'space_id'", [], |r| r.get(0)).unwrap();
        assert_eq!(parent, "spaces");
        let broken: i64 = conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!(broken, 0);
        // The new kinds are allowed, and changes to spaces still reach the sync log.
        conn.execute("INSERT INTO spaces (id, name, kind, created_at, updated_at, device_id) VALUES ('c', 'Case', 'case', 1, '2', 'd')", [])
            .unwrap();
        let logged: i64 = conn.query_row("SELECT count(*) FROM sync_rowlog WHERE entity = 'spaces' AND row_id = 'c'", [], |r| r.get(0)).unwrap();
        assert_eq!(logged, 1);
    }
}
