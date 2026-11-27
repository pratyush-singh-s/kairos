//! How long this PC was on (Statistics compares focus with it). The desktop app notes the time
//! every few seconds while it runs; a gap longer than `GAP_MS` (the PC was asleep, off, or Focus
//! was closed) starts a new span. Locked or idle time still counts: the PC was on.
//!
//! The table belongs to this PC only and is never synced. It is created here rather than in a
//! migration so the schema version, which phone and laptop must share to sync, stays the same.

use rusqlite::{Connection, params};

use crate::Store;
use crate::error::Result;

/// A longer break between two notes means the PC was not on in between.
pub const GAP_MS: i64 = 90_000;

pub(crate) fn ensure_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS pc_on_spans (
             id         INTEGER PRIMARY KEY,
             started_at INTEGER NOT NULL,
             ended_at   INTEGER NOT NULL
         ) STRICT;
         CREATE INDEX IF NOT EXISTS idx_pc_on_spans_ended ON pc_on_spans (ended_at);",
    )?;
    Ok(())
}

/// The PC is on at `now`: stretches the latest span to it, or starts a new one after a gap.
pub fn note(store: &Store, now: i64) -> Result<()> {
    let extended = store.conn().execute(
        "UPDATE pc_on_spans SET ended_at = ?1
         WHERE id = (SELECT max(id) FROM pc_on_spans) AND ended_at >= ?1 - ?2 AND ended_at <= ?1",
        params![now, GAP_MS],
    )?;
    if extended == 0 {
        store.conn().execute("INSERT INTO pc_on_spans (started_at, ended_at) VALUES (?1, ?1)", params![now])?;
    }
    Ok(())
}

pub fn prune(store: &Store, now: i64, keep_days: i64) -> Result<usize> {
    Ok(store.conn().execute("DELETE FROM pc_on_spans WHERE ended_at < ?1", params![now - keep_days * 86_400_000])?)
}

/// Time ranges the PC was on that overlap `from..to`, clipped to it, sorted and merged. Besides
/// the noted spans, this PC's own focus sessions and tracked app time count as on: they can only
/// happen with the PC on, and they cover days from before spans were noted.
pub fn on_ranges(store: &Store, from: i64, to: i64) -> Result<Vec<(i64, i64)>> {
    let mut stmt = store.conn().prepare(
        "SELECT max(started_at, ?1), min(ended_at, ?2) FROM pc_on_spans WHERE ended_at > ?1 AND started_at < ?2
         UNION ALL
         SELECT max(started_at, ?1), min(ended_at, ?2) FROM focus_sessions
         WHERE device_id = ?3 AND deleted_at IS NULL AND ended_at IS NOT NULL AND ended_at > ?1 AND started_at < ?2
         UNION ALL
         SELECT max(started_at, ?1), min(ended_at, ?2) FROM activity_spans WHERE ended_at > ?1 AND started_at < ?2",
    )?;
    let rows = stmt.query_map(params![from, to, store.device_id()], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?;
    let mut ranges: Vec<(i64, i64)> = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(merge(&mut ranges))
}

fn merge(ranges: &mut [(i64, i64)]) -> Vec<(i64, i64)> {
    ranges.sort_unstable();
    let mut out: Vec<(i64, i64)> = Vec::new();
    for &(a, b) in ranges.iter().filter(|(a, b)| b > a) {
        match out.last_mut() {
            Some(last) if a <= last.1 => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

/// Seconds of `ranges` (sorted, merged) inside `from..to`.
pub fn seconds_within(ranges: &[(i64, i64)], from: i64, to: i64) -> i64 {
    ranges.iter().map(|&(a, b)| (b.min(to) - a.max(from)).max(0)).sum::<i64>() / 1000
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: i64 = 1000;

    #[test]
    fn notes_join_until_a_gap() {
        let store = Store::open_in_memory().unwrap();
        for t in [0, 15, 30, 45] {
            note(&store, t * S).unwrap();
        }
        // Asleep for ten minutes.
        note(&store, 645 * S).unwrap();
        note(&store, 660 * S).unwrap();
        let r = on_ranges(&store, 0, 1000 * S).unwrap();
        assert_eq!(r, vec![(0, 45 * S), (645 * S, 660 * S)]);
        assert_eq!(seconds_within(&r, 0, 1000 * S), 60);
        assert_eq!(seconds_within(&r, 30 * S, 650 * S), 20);
    }

    #[test]
    fn a_clock_set_back_starts_a_new_span() {
        let store = Store::open_in_memory().unwrap();
        note(&store, 100 * S).unwrap();
        note(&store, 50 * S).unwrap();
        let n: i64 = store.conn().query_row("SELECT count(*) FROM pc_on_spans", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn overlaps_are_merged() {
        assert_eq!(merge(&mut [(5, 9), (0, 3), (2, 6), (12, 12), (10, 11)]), vec![(0, 9), (10, 11)]);
    }
}
