//! What sits on a free board or a case board (see src/spaces.rs). Each thing is one row in
//! `board_items` with its fields as JSON, so moving one card or recolouring one string syncs
//! that row alone (last write wins per row, like everything else).
//!
//! - Free board ("free"): `list` {title, order} and `card` {list, title, text, color, due,
//!   done, order}.
//! - Case board ("case"): `pin` {x, y, title, text, icon, ref: {type, id}?} (a card pinned to
//!   the board, optionally showing one of your notes, tasks or deadlines), `sticky` {x, y, text,
//!   color} and `string` {from, to, color} joining two pins or sticky notes.
//!
//! The app owns the JSON fields; this module checks the kind fits the space, keeps the JSON an
//! object of a sane size, and takes cards with their list and strings with their ends when
//! those are deleted.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Store;
use crate::error::{Result, StoreError};
use crate::ids::new_id;
use crate::spaces;
use crate::store::now_ms;

/// One thing on a board. Mirrored by `BoardItem` in src/ipc/boards.ts.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardItem {
    pub id: String,
    pub space_id: String,
    pub kind: String,
    pub data: Value,
    pub created_at: i64,
}

/// A new or changed thing. With an `id` that exists, its data is replaced (its space and kind
/// stay); otherwise it is made, under `id` when given (so the app can point strings at a card
/// before it is saved). Mirrored by `BoardItemInput` in src/ipc/boards.ts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardItemInput {
    #[serde(default)]
    pub id: Option<String>,
    pub space_id: String,
    pub kind: String,
    pub data: Value,
}

/// The kinds each space kind holds.
fn kinds_for(space_kind: &str) -> &'static [&'static str] {
    match space_kind {
        "free" => &["list", "card"],
        "case" => &["pin", "sticky", "string"],
        _ => &[],
    }
}

/// The most JSON one thing may hold (a long card text is fine; a pasted book is not).
pub const MAX_DATA_BYTES: usize = 64 * 1024;

const COLUMNS: &str = "id, space_id, kind, data, created_at";

fn read_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(String, String, String, String, i64)> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
}

fn to_item((id, space_id, kind, data, created_at): (String, String, String, String, i64)) -> BoardItem {
    let data = serde_json::from_str(&data).unwrap_or_else(|_| Value::Object(Default::default()));
    BoardItem { id, space_id, kind, data, created_at }
}

/// Everything on one board, oldest first (so later things draw on top).
pub fn list(conn: &Connection, space_id: &str) -> Result<Vec<BoardItem>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM board_items WHERE space_id = ?1 AND deleted_at IS NULL ORDER BY created_at, id"
    ))?;
    let rows = stmt.query_map(params![space_id], read_row)?;
    Ok(rows.map(|r| r.map(to_item)).collect::<std::result::Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<BoardItem>> {
    Ok(conn
        .query_row(&format!("SELECT {COLUMNS} FROM board_items WHERE id = ?1 AND deleted_at IS NULL"), params![id], read_row)
        .optional()?
        .map(to_item))
}

fn invalid(m: impl Into<String>) -> StoreError {
    StoreError::Invalid(m.into())
}

/// Saves several things at once (one move can change many cards' order); all or none.
pub fn save(store: &mut Store, inputs: Vec<BoardItemInput>) -> Result<Vec<BoardItem>> {
    let mut checked = Vec::with_capacity(inputs.len());
    for input in inputs {
        let space = spaces::get(store.conn(), &input.space_id)?.ok_or_else(|| invalid("that board no longer exists"))?;
        if !input.data.is_object() {
            return Err(invalid("board data must be an object"));
        }
        let data = input.data.to_string();
        if data.len() > MAX_DATA_BYTES {
            return Err(invalid("that is too much text for one card"));
        }
        let id = input.id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if id.as_ref().is_some_and(|s| s.len() > 64) {
            return Err(invalid("bad board item id"));
        }
        let existing: Option<(String, String)> = match &id {
            Some(id) => store
                .conn()
                .query_row("SELECT space_id, kind FROM board_items WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?,
            None => None,
        };
        match &existing {
            Some((space_id, kind)) if *space_id != input.space_id || *kind != input.kind => {
                return Err(invalid("a board item keeps its board and kind"));
            }
            _ => {}
        }
        if !kinds_for(&space.kind).contains(&input.kind.as_str()) {
            return Err(invalid(format!("a {} space cannot hold a {:?}", space.kind, input.kind)));
        }
        checked.push((id.unwrap_or_else(new_id), existing.is_some(), input.space_id, input.kind, data));
    }

    let device = store.device_id().to_string();
    let stamps: Vec<String> = checked.iter().map(|_| store.next_stamp()).collect();
    let tx = store.conn_mut().transaction()?;
    let now = now_ms() as i64;
    for ((id, exists, space_id, kind, data), stamp) in checked.iter().zip(&stamps) {
        if *exists {
            tx.execute(
                "UPDATE board_items SET data = ?2, deleted_at = NULL, updated_at = ?3, device_id = ?4 WHERE id = ?1",
                params![id, data, stamp, device],
            )?;
        } else {
            tx.execute(
                "INSERT INTO board_items (id, space_id, kind, data, created_at, updated_at, device_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, space_id, kind, data, now, stamp, device],
            )?;
        }
        log_change(&tx, id, &serde_json::json!({ "kind": kind, "data": data }).to_string(), stamp, &device)?;
    }
    tx.commit()?;
    let conn = store.conn();
    checked.iter().map(|(id, ..)| get(conn, id)?.ok_or_else(|| invalid("could not save that"))).collect()
}

/// Deletes things; a list takes its cards with it, and a pin or sticky note the strings tied to
/// it. Returns every ID that went, so Undo can bring them all back.
pub fn delete(store: &mut Store, ids: &[String]) -> Result<Vec<String>> {
    let mut gone: Vec<String> = Vec::new();
    for id in ids {
        let Some(item) = get(store.conn(), id)? else { continue };
        if !gone.contains(&item.id) {
            gone.push(item.id.clone());
        }
        for other in list(store.conn(), &item.space_id)? {
            let tied = match (item.kind.as_str(), other.kind.as_str()) {
                ("list", "card") => other.data.get("list").and_then(Value::as_str) == Some(&item.id),
                ("pin" | "sticky", "string") => [other.data.get("from"), other.data.get("to")]
                    .into_iter()
                    .any(|end| end.and_then(Value::as_str) == Some(&item.id)),
                _ => false,
            };
            if tied && !gone.contains(&other.id) {
                gone.push(other.id);
            }
        }
    }
    set_deleted(store, &gone, Some(now_ms() as i64))?;
    Ok(gone)
}

pub fn restore(store: &mut Store, ids: &[String]) -> Result<()> {
    set_deleted(store, ids, None)
}

fn set_deleted(store: &mut Store, ids: &[String], deleted_at: Option<i64>) -> Result<()> {
    let device = store.device_id().to_string();
    let stamps: Vec<String> = ids.iter().map(|_| store.next_stamp()).collect();
    let tx = store.conn_mut().transaction()?;
    for (id, stamp) in ids.iter().zip(&stamps) {
        let changed = tx.execute(
            "UPDATE board_items SET deleted_at = ?2, updated_at = ?3, device_id = ?4 WHERE id = ?1",
            params![id, deleted_at, stamp, device],
        )?;
        if changed > 0 {
            log_change(&tx, id, &serde_json::json!({ "deleted_at": deleted_at }).to_string(), stamp, &device)?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn log_change(conn: &Connection, id: &str, fields: &str, stamp: &str, device: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO change_log (entity, entity_id, fields, hlc, device_id) VALUES ('board_items', ?1, ?2, ?3, ?4)",
        params![id, fields, stamp, device],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spaces::{SpaceInput, create as create_space};
    use serde_json::json;

    fn space(store: &mut Store, kind: &str) -> String {
        create_space(store, SpaceInput { name: kind.into(), kind: kind.into(), color: None, start_date: None, days: 7 }).unwrap().id
    }

    fn input(space_id: &str, kind: &str, id: Option<&str>, data: Value) -> BoardItemInput {
        BoardItemInput { id: id.map(String::from), space_id: space_id.into(), kind: kind.into(), data }
    }

    #[test]
    fn free_board_lists_and_cards() {
        let mut store = Store::open_in_memory().unwrap();
        let s = space(&mut store, "free");
        let list_id = save(&mut store, vec![input(&s, "list", None, json!({ "title": "Ideas", "order": 1.0 }))]).unwrap()[0].id.clone();
        let card = save(&mut store, vec![input(&s, "card", Some("c1"), json!({ "list": list_id, "title": "Dark mode", "order": 1.0 }))]).unwrap();
        assert_eq!(card[0].id, "c1");
        // Moving the card replaces its data.
        save(&mut store, vec![input(&s, "card", Some("c1"), json!({ "list": list_id, "title": "Dark mode", "order": 0.5, "done": true }))]).unwrap();
        assert_eq!(get(store.conn(), "c1").unwrap().unwrap().data["done"], json!(true));
        assert_eq!(list(store.conn(), &s).unwrap().len(), 2);

        // Deleting the list takes its card; Undo brings both back.
        let gone = delete(&mut store, std::slice::from_ref(&list_id)).unwrap();
        assert_eq!(gone.len(), 2);
        assert!(list(store.conn(), &s).unwrap().is_empty());
        restore(&mut store, &gone).unwrap();
        assert_eq!(list(store.conn(), &s).unwrap().len(), 2);
    }

    #[test]
    fn case_board_strings_go_with_their_pins() {
        let mut store = Store::open_in_memory().unwrap();
        let s = space(&mut store, "case");
        save(
            &mut store,
            vec![
                input(&s, "pin", Some("a"), json!({ "x": 0, "y": 0, "title": "Wallet" })),
                input(&s, "sticky", Some("b"), json!({ "x": 200, "y": 40, "text": "who?" })),
                input(&s, "pin", Some("c"), json!({ "x": 400, "y": 0, "title": "Note" })),
                input(&s, "string", Some("ab"), json!({ "from": "a", "to": "b", "color": "#d63a3a" })),
                input(&s, "string", Some("bc"), json!({ "from": "b", "to": "c" })),
            ],
        )
        .unwrap();
        let mut gone = delete(&mut store, &["b".to_string()]).unwrap();
        gone.sort();
        assert_eq!(gone, ["ab", "b", "bc"]);
        assert_eq!(list(store.conn(), &s).unwrap().len(), 2);
    }

    #[test]
    fn wrong_kinds_and_bad_data_are_refused() {
        let mut store = Store::open_in_memory().unwrap();
        let free = space(&mut store, "free");
        let case = space(&mut store, "case");
        let week = space(&mut store, "board");
        assert!(save(&mut store, vec![input(&free, "pin", None, json!({}))]).is_err());
        assert!(save(&mut store, vec![input(&case, "list", None, json!({}))]).is_err());
        assert!(save(&mut store, vec![input(&week, "card", None, json!({}))]).is_err());
        assert!(save(&mut store, vec![input(&free, "card", None, json!("text"))]).is_err());
        let big = "x".repeat(MAX_DATA_BYTES);
        assert!(save(&mut store, vec![input(&free, "card", None, json!({ "text": big }))]).is_err());
        // An item keeps its kind.
        save(&mut store, vec![input(&case, "pin", Some("p"), json!({}))]).unwrap();
        assert!(save(&mut store, vec![input(&case, "sticky", Some("p"), json!({}))]).is_err());
        // Nothing half-saved when one of several is bad.
        assert!(save(&mut store, vec![input(&free, "list", Some("ok"), json!({})), input(&free, "pin", None, json!({}))]).is_err());
        assert!(get(store.conn(), "ok").unwrap().is_none());
    }
}
