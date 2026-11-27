//! What syncing moves between devices (Phase 9): rows out of this database and rows from
//! another device into it. The network side (finding devices, pairing, encryption) is in the
//! `focus-sync` crate; this module only reads and writes the database.
//!
//! - Every synced row is numbered in `sync_rowlog` each time it is written (triggers in
//!   migration 0011). Another device asks for "everything after number N" and remembers the
//!   highest number it got, so nothing is sent twice and changes pass on between three devices.
//! - A row from another device replaces ours only if its `updated_at` clock stamp is later
//!   (last write wins, per row). Deletes travel as tombstones (`deleted_at`).
//! - A row that is the same thing as one here under another ID (the same program in `apps`, a
//!   tag of the same name, a day mark of the same deadline and day) is matched by its UNIQUE key;
//!   its ID is remembered in `sync_alias` and rows pointing at it are pointed at ours.
//! - A note changed on both devices since they last synced is not lost: the device whose own
//!   version loses keeps it as a "(conflict copy)" note, which then syncs too.

use std::collections::{BTreeSet, HashMap, HashSet};

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::ids::new_id;
use crate::store::now_ms;
use crate::{clock, local, settings};

/// Synced tables, parents before children (so IDs are matched before rows that point at them).
pub const TABLES: &[&str] = &[
    "settings",
    "blocking_profiles",
    "blocking_rules",
    "focus_presets",
    "deadlines",
    "deadline_day_marks",
    "spaces",
    "board_items",
    "tasks",
    "focus_sessions",
    "apps",
    "app_usage",
    "distraction_events",
    "notes",
    "tags",
    "note_tags",
    "note_links",
    "note_attachments",
];

/// Rows of one table. Each row is `column -> value`; blobs are `{"$hex": "..."}`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Batch {
    pub table: String,
    pub rows: Vec<Map<String, Value>>,
}

/// Everything another device has not had yet.
#[derive(Debug, Clone, Default)]
pub struct Export {
    pub batches: Vec<Batch>,
    /// The highest row number here; the other device asks for rows after it next time.
    pub upto: i64,
    pub rows: usize,
    /// Rough size of the rows as JSON.
    pub bytes: usize,
}

/// What applying another device's rows did.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub inserted: usize,
    pub updated: usize,
    /// Rows we already had (or had a later version of).
    pub skipped: usize,
    /// Rows the database would not take (bad data); the rest still apply.
    pub rejected: usize,
    /// Notes changed on both devices, kept here as a "(conflict copy)".
    pub conflicts: usize,
    /// Tables that changed, so the app can refresh those pages.
    pub tables: BTreeSet<String>,
}

struct TableInfo {
    pk: String,
    columns: HashSet<String>,
    nullable: HashSet<String>,
    /// (column, parent table)
    fks: Vec<(String, String)>,
    /// Column sets of UNIQUE constraints, besides the primary key.
    uniques: Vec<Vec<String>>,
}

fn table_info(conn: &Connection, table: &str) -> Result<TableInfo> {
    let mut pk = String::new();
    let mut columns = HashSet::new();
    let mut nullable = HashSet::new();
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let name: String = r.get(1)?;
        let notnull: i64 = r.get(3)?;
        let is_pk: i64 = r.get(5)?;
        if is_pk == 1 {
            pk = name.clone();
        }
        if notnull == 0 && is_pk == 0 {
            nullable.insert(name.clone());
        }
        columns.insert(name);
    }
    let mut fks = Vec::new();
    let mut stmt = conn.prepare(&format!("PRAGMA foreign_key_list(\"{table}\")"))?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        fks.push((r.get::<_, String>(3)?, r.get::<_, String>(2)?));
    }
    let mut uniques = Vec::new();
    let names: Vec<String> = {
        let mut stmt = conn.prepare(&format!("PRAGMA index_list(\"{table}\")"))?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?)))?;
        rows.filter_map(|r| r.ok()).filter(|(_, unique, origin)| *unique == 1 && origin == "u").map(|(n, _, _)| n).collect()
    };
    for name in names {
        let mut stmt = conn.prepare(&format!("PRAGMA index_info(\"{name}\")"))?;
        let cols: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(2))?.collect::<std::result::Result<_, _>>()?;
        uniques.push(cols);
    }
    if pk.is_empty() {
        return Err(StoreError::Invalid(format!("table {table} has no primary key")));
    }
    Ok(TableInfo { pk, columns, nullable, fks, uniques })
}

// ---------------------------------------------------------------- values

fn to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => serde_json::json!({ "$hex": hex(b) }),
    }
}

fn to_sql(v: &Value) -> Result<SqlValue> {
    Ok(match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Object(o) => match o.get("$hex").and_then(Value::as_str).and_then(unhex) {
            Some(bytes) => SqlValue::Blob(bytes),
            None => return Err(StoreError::Invalid("unexpected object in a synced row".into())),
        },
        Value::Array(_) => return Err(StoreError::Invalid("unexpected list in a synced row".into())),
    })
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn read_row(row: &rusqlite::Row<'_>, names: &[String], skip: usize) -> Result<Map<String, Value>> {
    let mut map = Map::new();
    for (i, name) in names.iter().enumerate().skip(skip) {
        map.insert(name.clone(), to_json(row.get_ref(i)?));
    }
    Ok(map)
}

// ---------------------------------------------------------------- export

/// The latest clock stamp saved in any synced table.
pub fn latest_stamp(conn: &Connection) -> Result<Option<String>> {
    let sql = TABLES.iter().map(|t| format!("SELECT max(updated_at) AS m FROM {t}")).collect::<Vec<_>>().join(" UNION ALL ");
    Ok(conn.query_row(&format!("SELECT max(m) FROM ({sql})"), [], |r| r.get(0))?)
}

/// The highest row number here (0 = nothing yet).
pub fn local_upto(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT coalesce(max(seq), 0) FROM sync_rowlog", [], |r| r.get(0))?)
}

/// Rows written here after `since` (a number from this database), leaving out rows whose last
/// change came from `skip_device` (it has them). Settings that belong to this PC stay here.
/// Rows are grouped into batches of about `batch_bytes`.
pub fn export(conn: &Connection, since: i64, skip_device: &str, batch_bytes: usize) -> Result<Export> {
    let mut out = Export { upto: local_upto(conn)?, ..Default::default() };
    for table in TABLES {
        let info = table_info(conn, table)?;
        let mut stmt = conn.prepare(&format!(
            "SELECT r.seq, t.* FROM sync_rowlog r JOIN {table} t ON t.\"{pk}\" = r.row_id
             WHERE r.entity = ?1 AND r.seq > ?2 AND t.device_id <> ?3 ORDER BY r.seq",
            pk = info.pk
        ))?;
        let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
        let mut rows = stmt.query(params![table, since, skip_device])?;
        let mut batch = Batch { table: table.to_string(), rows: Vec::new() };
        let mut size = 0;
        while let Some(r) = rows.next()? {
            let row = read_row(r, &names, 1)?;
            if *table == "settings" && is_local_setting(&row) {
                continue;
            }
            let len = Value::Object(row.clone()).to_string().len();
            out.rows += 1;
            out.bytes += len;
            size += len;
            batch.rows.push(row);
            if size >= batch_bytes {
                out.batches.push(std::mem::replace(&mut batch, Batch { table: table.to_string(), rows: Vec::new() }));
                size = 0;
            }
        }
        if !batch.rows.is_empty() {
            out.batches.push(batch);
        }
    }
    Ok(out)
}

fn is_local_setting(row: &Map<String, Value>) -> bool {
    row.get("key").and_then(Value::as_str).is_none_or(|k| settings::LOCAL_ONLY.contains(&k))
}

// ---------------------------------------------------------------- apply

/// Applies rows from another device in one transaction. `peer_has_mine` is the highest row
/// number of ours that device already had before this sync (to spot notes edited on both).
pub fn apply(store: &mut Store, batches: &[Batch], peer_has_mine: i64) -> Result<ApplyReport> {
    let me = store.device_id().to_string();
    let mut report = ApplyReport::default();
    let mut latest: Option<String> = None;
    let mut infos: HashMap<String, TableInfo> = HashMap::new();
    for t in TABLES {
        infos.insert(t.to_string(), table_info(&store.conn, t)?);
    }

    // Apply tables in parent-first order whatever order the batches came in.
    let mut ordered: Vec<&Batch> = batches.iter().filter(|b| TABLES.contains(&b.table.as_str())).collect();
    ordered.sort_by_key(|b| TABLES.iter().position(|t| *t == b.table));

    let tx = store.conn.transaction()?;
    for batch in ordered {
        let table = batch.table.as_str();
        let info = &infos[table];
        for incoming in &batch.rows {
            let Some(stamp) = incoming.get("updated_at").and_then(Value::as_str).map(str::to_string) else {
                report.rejected += 1;
                continue;
            };
            if clock::parse(&stamp).is_err() || incoming.get(&info.pk).and_then(Value::as_str).is_none() {
                report.rejected += 1;
                continue;
            }
            if table == "settings" && is_local_setting(incoming) {
                continue;
            }
            // Only columns this database knows.
            let mut row: Map<String, Value> =
                incoming.iter().filter(|(k, _)| info.columns.contains(k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
            // Point references at our IDs.
            for (col, parent) in &info.fks {
                if let Some(Value::String(id)) = row.get(col) {
                    if let Some(local_id) = alias(&tx, parent, id)? {
                        row.insert(col.clone(), Value::String(local_id));
                    }
                }
            }
            let remote_id = row[&info.pk].as_str().unwrap_or_default().to_string();
            let mut id = alias(&tx, table, &remote_id)?.unwrap_or_else(|| remote_id.clone());
            let mut local = local_row(&tx, table, &info.pk, &id)?;
            if local.is_none() {
                if let Some(found) = same_thing(&tx, table, info, &row)? {
                    tx.execute(
                        "INSERT OR REPLACE INTO sync_alias (entity, remote_id, local_id) VALUES (?1, ?2, ?3)",
                        params![table, remote_id, found],
                    )?;
                    id = found;
                    local = local_row(&tx, table, &info.pk, &id)?;
                }
            }
            row.insert(info.pk.clone(), Value::String(id.clone()));
            if latest.as_deref().is_none_or(|l| stamp.as_str() > l) {
                latest = Some(stamp.clone());
            }

            match local {
                None => match insert(&tx, table, &row) {
                    Ok(()) => {
                        report.inserted += 1;
                        report.tables.insert(table.to_string());
                    }
                    Err(_) => report.rejected += 1,
                },
                Some(here) => {
                    let here_stamp = here.get("updated_at").and_then(Value::as_str).unwrap_or_default();
                    if stamp.as_str() <= here_stamp {
                        report.skipped += 1;
                        continue;
                    }
                    if table == "notes" && edited_on_both(&tx, &here, &row, &me, peer_has_mine)? {
                        let copy_stamp = store.clock.tick(now_ms());
                        keep_conflict_copy(&tx, &here, &copy_stamp, &me)?;
                        report.conflicts += 1;
                    }
                    match update(&tx, table, &info.pk, &id, &row) {
                        Ok(()) => {
                            report.updated += 1;
                            report.tables.insert(table.to_string());
                        }
                        Err(_) => report.rejected += 1,
                    }
                }
            }
        }
    }
    report.rejected += drop_dangling(&tx, &infos)?;
    tx.commit()?;
    if let Some(l) = latest {
        store.observe_stamp(&l);
    }
    Ok(report)
}

fn alias(conn: &Connection, table: &str, remote_id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT local_id FROM sync_alias WHERE entity = ?1 AND remote_id = ?2",
            params![table, remote_id],
            |r| r.get(0),
        )
        .optional()?)
}

fn local_row(conn: &Connection, table: &str, pk: &str, id: &str) -> Result<Option<Map<String, Value>>> {
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table} WHERE \"{pk}\" = ?1"))?;
    let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(r) => Ok(Some(read_row(r, &names, 0)?)),
        None => Ok(None),
    }
}

/// A row here with the same UNIQUE key as `row` (under another ID).
fn same_thing(conn: &Connection, table: &str, info: &TableInfo, row: &Map<String, Value>) -> Result<Option<String>> {
    for cols in &info.uniques {
        let values: Vec<SqlValue> = cols.iter().map(|c| row.get(c).map(to_sql).unwrap_or(Ok(SqlValue::Null))).collect::<Result<_>>()?;
        if values.iter().any(|v| matches!(v, SqlValue::Null)) {
            continue; // NULLs never clash in a UNIQUE constraint
        }
        let filter = cols.iter().enumerate().map(|(i, c)| format!("\"{c}\" = ?{}", i + 1)).collect::<Vec<_>>().join(" AND ");
        let found: Option<String> = conn
            .query_row(&format!("SELECT \"{}\" FROM {table} WHERE {filter}", info.pk), params_from_iter(values), |r| r.get(0))
            .optional()?;
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

fn insert(conn: &Connection, table: &str, row: &Map<String, Value>) -> Result<()> {
    let cols: Vec<&String> = row.keys().collect();
    let names = cols.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
    let marks = (1..=cols.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
    let values: Vec<SqlValue> = cols.iter().map(|c| to_sql(&row[*c])).collect::<Result<_>>()?;
    conn.execute(&format!("INSERT INTO {table} ({names}) VALUES ({marks})"), params_from_iter(values))?;
    Ok(())
}

fn update(conn: &Connection, table: &str, pk: &str, id: &str, row: &Map<String, Value>) -> Result<()> {
    let cols: Vec<&String> = row.keys().filter(|c| c.as_str() != pk && c.as_str() != "created_at").collect();
    if cols.is_empty() {
        return Ok(());
    }
    let sets = cols.iter().enumerate().map(|(i, c)| format!("\"{c}\" = ?{}", i + 1)).collect::<Vec<_>>().join(", ");
    let mut values: Vec<SqlValue> = cols.iter().map(|c| to_sql(&row[*c])).collect::<Result<_>>()?;
    values.push(SqlValue::Text(id.to_string()));
    conn.execute(&format!("UPDATE {table} SET {sets} WHERE \"{pk}\" = ?{}", cols.len() + 1), params_from_iter(values))?;
    Ok(())
}

/// Our version of a note was changed here after the other device last had it, and theirs differs.
fn edited_on_both(conn: &Connection, here: &Map<String, Value>, theirs: &Map<String, Value>, me: &str, peer_has_mine: i64) -> Result<bool> {
    let str_of = |m: &Map<String, Value>, k: &str| m.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    if str_of(here, "device_id") != me || !here.get("deleted_at").is_none_or(Value::is_null) {
        return Ok(false);
    }
    if !theirs.get("deleted_at").is_none_or(Value::is_null) {
        return Ok(false);
    }
    if str_of(here, "body") == str_of(theirs, "body") && str_of(here, "title") == str_of(theirs, "title") {
        return Ok(false);
    }
    let seq: Option<i64> = conn
        .query_row(
            "SELECT seq FROM sync_rowlog WHERE entity = 'notes' AND row_id = ?1",
            params![str_of(here, "id")],
            |r| r.get(0),
        )
        .optional()?;
    Ok(seq.is_some_and(|s| s > peer_has_mine))
}

fn keep_conflict_copy(conn: &Connection, here: &Map<String, Value>, stamp: &str, me: &str) -> Result<()> {
    let mut copy = here.clone();
    let title = here.get("title").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let title = if title.is_empty() { "Untitled".to_string() } else { title };
    copy.insert("id".into(), Value::String(new_id()));
    copy.insert("title".into(), Value::String(format!("{title} (conflict copy)")));
    copy.insert("pinned".into(), Value::from(0));
    copy.insert("created_at".into(), Value::from(now_ms() as i64));
    copy.insert("updated_at".into(), Value::String(stamp.to_string()));
    copy.insert("device_id".into(), Value::String(me.to_string()));
    insert(conn, "notes", &copy)
}

/// Rows that point at something neither device has (it was removed for good on one of them):
/// the reference is cleared, or the row dropped when it can't exist without it.
fn drop_dangling(conn: &Connection, infos: &HashMap<String, TableInfo>) -> Result<usize> {
    let mut fixed = 0;
    for _ in 0..5 {
        let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
        let bad: Vec<(String, i64, i64)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(3)?)))?
            .collect::<std::result::Result<_, _>>()?;
        let bad: Vec<_> = bad.into_iter().filter(|(t, _, _)| infos.contains_key(t)).collect();
        if bad.is_empty() {
            break;
        }
        for (table, rowid, fk_id) in bad {
            let col: Option<String> = conn
                .query_row(&format!("SELECT \"from\" FROM pragma_foreign_key_list('{table}') WHERE id = ?1"), params![fk_id], |r| r.get(0))
                .optional()?;
            match col {
                Some(c) if infos[&table].nullable.contains(&c) => {
                    conn.execute(&format!("UPDATE {table} SET \"{c}\" = NULL WHERE rowid = ?1"), params![rowid])?;
                }
                _ => {
                    conn.execute(&format!("DELETE FROM {table} WHERE rowid = ?1"), params![rowid])?;
                }
            }
            fixed += 1;
        }
    }
    Ok(fixed)
}

// ---------------------------------------------------------------- paired devices

/// A device paired with this one. Mirrored by `SyncPeer` in src/ipc/sync.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub device_id: String,
    pub name: String,
    /// "pc" or "phone".
    pub kind: String,
    #[serde(skip)]
    pub public_key: Vec<u8>,
    pub paired_at: i64,
    pub last_synced_at: Option<i64>,
    /// The other device's highest row number we have.
    #[serde(skip)]
    pub received_upto: i64,
    /// Where it was last reached ("192.168.1.20:47813").
    pub address: Option<String>,
}

const PEER_COLS: &str = "device_id, name, kind, public_key, paired_at, last_synced_at, received_upto, address";

fn peer_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<Peer> {
    Ok(Peer {
        device_id: r.get(0)?,
        name: r.get(1)?,
        kind: r.get(2)?,
        public_key: r.get(3)?,
        paired_at: r.get(4)?,
        last_synced_at: r.get(5)?,
        received_upto: r.get(6)?,
        address: r.get(7)?,
    })
}

pub fn peers(conn: &Connection) -> Result<Vec<Peer>> {
    let mut stmt = conn.prepare(&format!("SELECT {PEER_COLS} FROM peers ORDER BY paired_at"))?;
    Ok(stmt.query_map([], peer_from)?.collect::<std::result::Result<_, _>>()?)
}

pub fn peer(conn: &Connection, device_id: &str) -> Result<Option<Peer>> {
    Ok(conn.query_row(&format!("SELECT {PEER_COLS} FROM peers WHERE device_id = ?1"), params![device_id], peer_from).optional()?)
}

/// Saves a newly paired device. Pairing again with a known device keeps what was synced only
/// if its key is unchanged (a reinstalled device starts over).
pub fn save_peer(conn: &Connection, device_id: &str, name: &str, kind: &str, public_key: &[u8], address: Option<&str>) -> Result<()> {
    let same_key = peer(conn, device_id)?.is_some_and(|p| p.public_key == public_key);
    conn.execute(
        "INSERT INTO peers (device_id, name, kind, public_key, paired_at, address) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (device_id) DO UPDATE SET name = excluded.name, kind = excluded.kind, public_key = excluded.public_key,
             address = excluded.address, paired_at = excluded.paired_at",
        params![device_id, name, kind, public_key, now_ms() as i64, address],
    )?;
    if !same_key {
        conn.execute("UPDATE peers SET received_upto = 0, last_synced_at = NULL WHERE device_id = ?1", params![device_id])?;
    }
    Ok(())
}

/// After a finished sync: what we now have of theirs, and where they were.
pub fn mark_synced(conn: &Connection, device_id: &str, name: &str, received_upto: i64, address: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE peers SET received_upto = max(received_upto, ?2), last_synced_at = ?3, name = ?4,
             address = coalesce(?5, address) WHERE device_id = ?1",
        params![device_id, received_upto, now_ms() as i64, name, address],
    )?;
    Ok(())
}

pub fn set_peer_address(conn: &Connection, device_id: &str, address: &str) -> Result<()> {
    conn.execute("UPDATE peers SET address = ?2 WHERE device_id = ?1", params![device_id, address])?;
    Ok(())
}

pub fn forget_peer(conn: &Connection, device_id: &str) -> Result<()> {
    conn.execute("DELETE FROM peers WHERE device_id = ?1", params![device_id])?;
    Ok(())
}

// ---------------------------------------------------------------- this device

/// This device's long-term key pair for encrypted syncing (made by focus-sync on first use).
pub fn identity(store: &Store) -> Result<Option<(Vec<u8>, Vec<u8>)>> {
    let private = local::get(store, "sync.private_key")?.and_then(|h| unhex(&h));
    let public = local::get(store, "sync.public_key")?.and_then(|h| unhex(&h));
    Ok(private.zip(public))
}

pub fn save_identity(store: &Store, private: &[u8], public: &[u8]) -> Result<()> {
    local::set(store, "sync.private_key", &hex(private))?;
    local::set(store, "sync.public_key", &hex(public))
}

/// The name other devices see for this one ("" = not set; the app then uses the PC's name).
pub fn device_name(store: &Store) -> Result<String> {
    Ok(local::get(store, "sync.device_name")?.unwrap_or_default())
}

pub fn set_device_name(store: &Store, name: &str) -> Result<()> {
    let name: String = name.trim().chars().take(60).collect();
    local::set(store, "sync.device_name", &name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{notes, tasks};

    fn sync_once(from: &mut Store, to: &mut Store, since: i64) -> (i64, ApplyReport) {
        let to_id = to.device_id().to_string();
        let exp = export(from.conn(), since, &to_id, 64 * 1024).unwrap();
        let report = apply(to, &exp.batches, 0).unwrap();
        (exp.upto, report)
    }

    fn titles(store: &Store) -> Vec<String> {
        let mut stmt = store.conn().prepare("SELECT title FROM tasks WHERE deleted_at IS NULL ORDER BY title").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    fn add_task(store: &mut Store, title: &str) -> String {
        let stamp = store.next_stamp();
        let device = store.device_id().to_string();
        let id = new_id();
        store
            .conn()
            .execute(
                "INSERT INTO tasks (id, title, created_at, updated_at, device_id) VALUES (?1, ?2, 0, ?3, ?4)",
                params![id, title, stamp, device],
            )
            .unwrap();
        id
    }

    fn rename_task(store: &mut Store, id: &str, title: &str) {
        let stamp = store.next_stamp();
        let device = store.device_id().to_string();
        store
            .conn()
            .execute("UPDATE tasks SET title = ?2, updated_at = ?3, device_id = ?4 WHERE id = ?1", params![id, title, stamp, device])
            .unwrap();
    }

    #[test]
    fn new_rows_travel_and_are_not_sent_twice() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        add_task(&mut a, "Gym");
        let (upto, report) = sync_once(&mut a, &mut b, 0);
        assert_eq!(titles(&b), ["Gym"]);
        assert!(report.tables.contains("tasks"));
        // Asking again from where we got to sends nothing.
        let again = export(a.conn(), upto, b.device_id(), 1024).unwrap();
        assert_eq!(again.rows, 0);
        // And what B got from A is not sent back to A.
        let back = export(b.conn(), 0, a.device_id(), 1024).unwrap();
        assert!(back.batches.iter().all(|batch| batch.table != "tasks"));
    }

    #[test]
    fn later_change_wins_both_ways() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        let id = add_task(&mut a, "Gym");
        sync_once(&mut a, &mut b, 0);
        rename_task(&mut a, &id, "Gym (A)");
        std::thread::sleep(std::time::Duration::from_millis(3));
        rename_task(&mut b, &id, "Gym (B)");
        // B's change is later: it wins on A, and A's older change doesn't overwrite B.
        sync_once(&mut b, &mut a, 0);
        let (_, report) = sync_once(&mut a, &mut b, 0);
        assert_eq!(titles(&a), ["Gym (B)"]);
        assert_eq!(titles(&b), ["Gym (B)"]);
        assert_eq!(report.updated, 0);
    }

    #[test]
    fn deletes_travel_as_tombstones() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        let id = add_task(&mut a, "Gym");
        sync_once(&mut a, &mut b, 0);
        tasks::delete(&mut a, &[id]).unwrap();
        sync_once(&mut a, &mut b, 0);
        assert!(titles(&b).is_empty());
    }

    #[test]
    fn this_pcs_settings_stay_here() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        settings::set(&mut a, "ui.theme", &"terminal").unwrap();
        settings::set(&mut a, "tracking.mode", &"always").unwrap();
        sync_once(&mut a, &mut b, 0);
        assert_eq!(settings::get::<String>(&b, "ui.theme").unwrap(), "terminal");
        assert_eq!(settings::get::<String>(&b, "tracking.mode").unwrap(), "off");
    }

    #[test]
    fn same_program_under_two_ids_is_matched() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        for s in [&mut a, &mut b] {
            let stamp = s.next_stamp();
            let device = s.device_id().to_string();
            s.conn()
                .execute(
                    "INSERT INTO apps (id, exe_name, display_name, created_at, updated_at, device_id) VALUES (?1, 'code.exe', 'Code', 0, ?2, ?3)",
                    params![new_id(), stamp, device],
                )
                .unwrap();
        }
        // A session on A that used the program.
        let stamp = a.next_stamp();
        let device = a.device_id().to_string();
        let (session, app): (String, String) =
            (new_id(), a.conn().query_row("SELECT id FROM apps", [], |r| r.get(0)).unwrap());
        a.conn()
            .execute(
                "INSERT INTO focus_sessions (id, cycle_id, session_number, phase, started_at, planned_s, created_at, updated_at, device_id)
                 VALUES (?1, 'c', 1, 'focus', 0, 60, 0, ?2, ?3)",
                params![session, stamp, device],
            )
            .unwrap();
        a.conn()
            .execute(
                "INSERT INTO app_usage (id, session_id, app_id, active_s, activations, first_active_at, last_active_at, created_at, updated_at, device_id)
                 VALUES (?1, ?2, ?3, 30, 1, 0, 0, 0, ?4, ?5)",
                params![new_id(), session, app, stamp, device],
            )
            .unwrap();
        let (_, report) = sync_once(&mut a, &mut b, 0);
        assert_eq!(report.rejected, 0);
        let apps: i64 = b.conn().query_row("SELECT count(*) FROM apps", [], |r| r.get(0)).unwrap();
        assert_eq!(apps, 1);
        let linked: i64 = b
            .conn()
            .query_row("SELECT count(*) FROM app_usage u JOIN apps p ON p.id = u.app_id", [], |r| r.get(0))
            .unwrap();
        assert_eq!(linked, 1);
    }

    #[test]
    fn note_edited_on_both_keeps_a_copy_once() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        let id = notes::create(&mut a).unwrap().id;
        let a_dev = a.device_id().to_string();
        let b_dev = b.device_id().to_string();
        let first = export(a.conn(), 0, &b_dev, 1 << 20).unwrap();
        apply(&mut b, &first.batches, 0).unwrap();
        let b_has_a = first.upto;
        let a_has_b = local_upto(b.conn()).unwrap(); // B's rows A will treat as already had
        notes::save(&mut a, &id, "Plan", "{\"a\":1}", "from A").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        notes::save(&mut b, &id, "Plan", "{\"b\":1}", "from B").unwrap();

        // Both send at the same time.
        let from_a = export(a.conn(), b_has_a, &b_dev, 1 << 20).unwrap();
        let from_b = export(b.conn(), a_has_b, &a_dev, 1 << 20).unwrap();
        let on_b = apply(&mut b, &from_a.batches, a_has_b).unwrap();
        let on_a = apply(&mut a, &from_b.batches, b_has_a).unwrap();
        // B's later version wins; only A (whose own version lost) keeps a copy.
        assert_eq!(on_b.conflicts, 0);
        assert_eq!(on_a.conflicts, 1);
        assert_eq!(notes::get(a.conn(), &id).unwrap().unwrap().plain_text, "from B");
        let copy: String = a
            .conn()
            .query_row("SELECT plain_text FROM notes WHERE title = 'Plan (conflict copy)'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(copy, "from A");
        // The copy reaches B next time.
        let next = export(a.conn(), from_a.upto, &b_dev, 1 << 20).unwrap();
        apply(&mut b, &next.batches, from_b.upto).unwrap();
        let on_b_copies: i64 =
            b.conn().query_row("SELECT count(*) FROM notes WHERE title LIKE '%conflict copy%'", [], |r| r.get(0)).unwrap();
        assert_eq!(on_b_copies, 1);
    }

    #[test]
    fn changes_pass_on_through_a_third_device() {
        let mut phone = Store::open_in_memory().unwrap();
        let mut pc1 = Store::open_in_memory().unwrap();
        let mut pc2 = Store::open_in_memory().unwrap();
        // pc2 and pc1 synced earlier.
        add_task(&mut pc1, "Old");
        let (pc2_has_pc1, _) = sync_once(&mut pc1, &mut pc2, 0);
        // Then the phone tells pc1 something; pc2 hears it from pc1.
        add_task(&mut phone, "Call mum");
        sync_once(&mut phone, &mut pc1, 0);
        sync_once(&mut pc1, &mut pc2, pc2_has_pc1);
        assert_eq!(titles(&pc2), ["Call mum", "Old"]);
    }

    #[test]
    fn rows_pointing_at_missing_parents_are_cleaned() {
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        let stamp = a.next_stamp();
        let device = a.device_id().to_string();
        let row: Map<String, Value> = serde_json::from_value(serde_json::json!({
            "id": new_id(), "title": "Orphan", "deadline_id": "gone", "created_at": 0, "updated_at": stamp, "device_id": device,
        }))
        .unwrap();
        let report = apply(&mut b, &[Batch { table: "tasks".into(), rows: vec![row] }], 0).unwrap();
        assert_eq!(report.inserted, 1);
        let deadline: Option<String> = b.conn().query_row("SELECT deadline_id FROM tasks", [], |r| r.get(0)).unwrap();
        assert_eq!(deadline, None);
    }

    #[test]
    fn clock_moves_past_received_stamps() {
        let a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        let device = a.device_id().to_string();
        let future = format!("{:013}-00000-{device}", now_ms() + 3_600_000);
        let row: Map<String, Value> = serde_json::from_value(serde_json::json!({
            "id": new_id(), "title": "Ahead", "created_at": 0, "updated_at": future, "device_id": device,
        }))
        .unwrap();
        apply(&mut b, &[Batch { table: "tasks".into(), rows: vec![row] }], 0).unwrap();
        assert!(b.next_stamp() > future);
    }

    #[test]
    fn peers_are_saved_and_forgotten() {
        let store = Store::open_in_memory().unwrap();
        save_peer(store.conn(), "p1", "Laptop", "pc", &[1, 2], Some("10.0.0.2:47813")).unwrap();
        mark_synced(store.conn(), "p1", "Laptop", 42, None).unwrap();
        let p = peer(store.conn(), "p1").unwrap().unwrap();
        assert_eq!((p.received_upto, p.address.as_deref()), (42, Some("10.0.0.2:47813")));
        // Same key again keeps progress; a new key starts over.
        save_peer(store.conn(), "p1", "Laptop", "pc", &[1, 2], None).unwrap();
        assert_eq!(peer(store.conn(), "p1").unwrap().unwrap().received_upto, 42);
        save_peer(store.conn(), "p1", "Laptop", "pc", &[9], None).unwrap();
        assert_eq!(peer(store.conn(), "p1").unwrap().unwrap().received_upto, 0);
        forget_peer(store.conn(), "p1").unwrap();
        assert!(peers(store.conn()).unwrap().is_empty());
    }

    #[test]
    fn hex_round_trip() {
        assert_eq!(unhex(&hex(&[0, 15, 255])).unwrap(), vec![0, 15, 255]);
        assert!(unhex("abc").is_none());
    }

    #[test]
    fn board_items_follow_their_space_and_move_one_by_one() {
        use crate::{boards, spaces};
        let mut a = Store::open_in_memory().unwrap();
        let mut b = Store::open_in_memory().unwrap();
        let space = spaces::create(&mut a, spaces::SpaceInput { name: "Case".into(), kind: "case".into(), color: None, start_date: None, days: 7 }).unwrap();
        let pin = |id: &str, x: i64| boards::BoardItemInput { id: Some(id.into()), space_id: space.id.clone(), kind: "pin".into(), data: serde_json::json!({ "x": x, "y": 0, "title": id }) };
        boards::save(&mut a, vec![pin("p1", 0), pin("p2", 200)]).unwrap();
        let (_, report) = sync_once(&mut a, &mut b, 0);
        assert_eq!(report.rejected, 0);
        assert!(report.tables.contains("board_items"));
        assert_eq!(boards::list(b.conn(), &space.id).unwrap().len(), 2);

        // A pin moved on b comes back to a; the other pin stays as it was.
        boards::save(&mut b, vec![pin("p2", 340)]).unwrap();
        let (_, back) = sync_once(&mut b, &mut a, 0);
        assert_eq!(back.rejected, 0);
        assert_eq!(boards::get(a.conn(), "p2").unwrap().unwrap().data["x"], serde_json::json!(340));
        assert_eq!(boards::get(a.conn(), "p1").unwrap().unwrap().data["x"], serde_json::json!(0));
    }
}
