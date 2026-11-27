//! Values that belong to this PC only and are never synced (the `local_meta` table),
//! such as the state of a running timer.

use rusqlite::{OptionalExtension, params};

use crate::Store;
use crate::error::Result;

pub fn get(store: &Store, key: &str) -> Result<Option<String>> {
    Ok(store.conn().query_row("SELECT value FROM local_meta WHERE key = ?1", params![key], |r| r.get(0)).optional()?)
}

pub fn set(store: &Store, key: &str, value: &str) -> Result<()> {
    store.conn().execute(
        "INSERT INTO local_meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn remove(store: &Store, key: &str) -> Result<()> {
    store.conn().execute("DELETE FROM local_meta WHERE key = ?1", params![key])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_get_overwrite_remove() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(get(&store, "timer.saved").unwrap(), None);
        set(&store, "timer.saved", "a").unwrap();
        set(&store, "timer.saved", "b").unwrap();
        assert_eq!(get(&store, "timer.saved").unwrap().as_deref(), Some("b"));
        remove(&store, "timer.saved").unwrap();
        assert_eq!(get(&store, "timer.saved").unwrap(), None);
    }
}
