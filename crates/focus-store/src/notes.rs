//! Notes: a title and rich text (bold, sizes, lists, x² superscript). The editor's document is
//! stored as JSON in `body`; `plain_text` is the same words without formatting, kept for search
//! (the `notes_fts` full-text index follows it through triggers) and for previews.
//!
//! A handwritten note (`kind` "ink") is drawn on a drawing board instead. Its `body` is
//! `{"v":1,"strokes":[{"t":"pen","c":"#ffffff","w":2,"p":[x,y,pressure, x,y,pressure, ...]}]}`
//! and its `plain_text` is empty, so it is found by its title.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::Store;
use crate::error::{Result, StoreError};
use crate::ids::new_id;
use crate::store::now_ms;

/// A whole note, for the editor. Mirrored by `Note` in src/ipc/notes.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub pinned: bool,
    /// The folder it is in, as a path ("School/Physics"); None = not in a folder.
    pub folder: Option<String>,
    /// "text" or "ink" (handwritten).
    pub kind: String,
    /// The editor's JSON document, or the strokes of a handwritten note; "" = empty.
    pub body: String,
    pub plain_text: String,
    /// UTC milliseconds.
    pub created_at: i64,
    pub edited_at: i64,
}

/// A row of the notes list. Mirrored by `NoteSummary` in src/ipc/notes.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub pinned: bool,
    pub folder: Option<String>,
    pub kind: String,
    /// The first words of the note.
    pub preview: String,
    pub edited_at: i64,
}

/// Longest title, in characters.
pub const MAX_TITLE: usize = 200;
/// Largest stored document (about a short book), so one note cannot bloat the database.
pub const MAX_BODY_BYTES: usize = 2_000_000;
/// Largest handwritten note: pen strokes take more room than words (about 40 full pages).
pub const MAX_INK_BYTES: usize = 8_000_000;

/// The kinds of note.
pub const KINDS: &[&str] = &["text", "ink"];

const PREVIEW_CHARS: i64 = 140;

fn gone() -> StoreError {
    StoreError::Invalid("that note no longer exists".into())
}

/// Turns what the user typed into a full-text query: every word must appear, as a prefix
/// ("phys" finds "physics"). Punctuation is dropped so it cannot break the query syntax.
fn fts_query(text: &str) -> Option<String> {
    let words: Vec<String> = text
        .split_whitespace()
        .map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{w}\"*"))
        .collect();
    (!words.is_empty()).then(|| words.join(" "))
}

/// Notes for the list: pinned first, then the most recently edited. With `search`, only notes
/// whose title or text has every word of it.
pub fn list(conn: &Connection, search: Option<&str>) -> Result<Vec<NoteSummary>> {
    let read = |r: &rusqlite::Row<'_>| {
        Ok(NoteSummary {
            id: r.get(0)?,
            title: r.get(1)?,
            pinned: r.get::<_, i64>(2)? == 1,
            preview: r.get(3)?,
            edited_at: r.get(4)?,
            kind: r.get(5)?,
            folder: r.get(6)?,
        })
    };
    let columns = format!("n.id, n.title, n.pinned, substr(n.plain_text, 1, {PREVIEW_CHARS}), n.edited_at, n.kind, n.folder");
    let rows = match search.and_then(fts_query) {
        Some(q) => {
            let mut stmt = conn.prepare(&format!(
                "SELECT {columns} FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
                 WHERE notes_fts MATCH ?1 AND n.deleted_at IS NULL
                 ORDER BY n.pinned DESC, n.edited_at DESC LIMIT 500"
            ))?;
            stmt.query_map(params![q], read)?.collect::<std::result::Result<Vec<_>, _>>()?
        }
        None => {
            let mut stmt = conn.prepare(&format!(
                "SELECT {columns} FROM notes n WHERE n.deleted_at IS NULL ORDER BY n.pinned DESC, n.edited_at DESC LIMIT 500"
            ))?;
            stmt.query_map([], read)?.collect::<std::result::Result<Vec<_>, _>>()?
        }
    };
    Ok(rows)
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Note>> {
    Ok(conn
        .query_row(
            "SELECT id, title, pinned, body, plain_text, created_at, edited_at, kind, folder FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |r| {
                Ok(Note {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    pinned: r.get::<_, i64>(2)? == 1,
                    body: r.get(3)?,
                    plain_text: r.get(4)?,
                    created_at: r.get(5)?,
                    edited_at: r.get(6)?,
                    kind: r.get(7)?,
                    folder: r.get(8)?,
                })
            },
        )
        .optional()?)
}

/// A new, empty text note.
pub fn create(store: &mut Store) -> Result<Note> {
    create_kind(store, "text")
}

/// A new, empty note of the given kind ("text" or "ink").
pub fn create_kind(store: &mut Store, kind: &str) -> Result<Note> {
    if !KINDS.contains(&kind) {
        return Err(StoreError::Invalid(format!("unknown kind of note: {kind}")));
    }
    let id = new_id();
    let now = now_ms() as i64;
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    tx.execute(
        "INSERT INTO notes (id, title, body, plain_text, created_at, edited_at, updated_at, device_id, kind)
         VALUES (?1, '', '', '', ?2, ?2, ?3, ?4, ?5)",
        params![id, now, stamp, device, kind],
    )?;
    let fields = serde_json::json!({ "title": "", "body": "", "edited_at": now, "kind": kind });
    log_change(&tx, &id, &fields.to_string(), &stamp, &device)?;
    tx.commit()?;
    get(store.conn(), &id)?.ok_or_else(gone)
}

/// Saves the title and text (the editor saves a moment after you stop typing).
pub fn save(store: &mut Store, id: &str, title: &str, body: &str, plain_text: &str) -> Result<Note> {
    let title = title.trim();
    if title.chars().count() > MAX_TITLE {
        return Err(StoreError::Invalid("the title can be at most 200 characters".into()));
    }
    let kind: Option<String> =
        store.conn().query_row("SELECT kind FROM notes WHERE id = ?1 AND deleted_at IS NULL", params![id], |r| r.get(0)).optional()?;
    let kind = kind.ok_or_else(gone)?;
    if body.len() > if kind == "ink" { MAX_INK_BYTES } else { MAX_BODY_BYTES } {
        if kind == "ink" {
            return Err(StoreError::Invalid("this page is too full to save; start a new handwritten note".into()));
        }
        return Err(StoreError::Invalid("this note is too long to save; split it into two notes".into()));
    }
    if !body.is_empty() && serde_json::from_str::<serde_json::Value>(body).is_err() {
        return Err(StoreError::Invalid("the note's text could not be read".into()));
    }
    let now = now_ms() as i64;
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    let changed = tx.execute(
        "UPDATE notes SET title = ?2, body = ?3, plain_text = ?4, edited_at = ?5, updated_at = ?6, device_id = ?7
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id, title, body, plain_text.trim(), now, stamp, device],
    )?;
    if changed == 0 {
        return Err(gone());
    }
    let fields = serde_json::json!({ "title": title, "body": body, "edited_at": now });
    log_change(&tx, id, &fields.to_string(), &stamp, &device)?;
    tx.commit()?;
    get(store.conn(), id)?.ok_or_else(gone)
}

/// Pins a note to the top of the list and the dashboard, or unpins it. Does not count as an edit.
pub fn set_pinned(store: &mut Store, id: &str, pinned: bool) -> Result<()> {
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    let changed = tx.execute(
        "UPDATE notes SET pinned = ?2, updated_at = ?3, device_id = ?4 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, pinned as i64, stamp, device],
    )?;
    if changed == 0 {
        return Err(gone());
    }
    log_change(&tx, id, &serde_json::json!({ "pinned": pinned }).to_string(), &stamp, &device)?;
    tx.commit()?;
    Ok(())
}

/// Deletes notes (tombstones, so Undo and the other PC both work).
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
            "UPDATE notes SET deleted_at = ?2, updated_at = ?3, device_id = ?4 WHERE id = ?1",
            params![id, deleted_at, stamp, device],
        )?;
        if changed == 0 {
            return Err(gone());
        }
        log_change(&tx, id, &serde_json::json!({ "deleted_at": deleted_at }).to_string(), &stamp, &device)?;
    }
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------- folders
// A note's folder is a path of names joined by "/" ("School/Physics"), so folders hold folders.
// A folder exists while a note is in it, or while it is in the setting "notes.folders" (folders
// made before anything is put in them). Removing a folder never deletes notes.

/// Deepest folder nesting, longest folder name and longest path.
pub const MAX_FOLDER_DEPTH: usize = 8;
pub const MAX_FOLDER_NAME: usize = 60;
const FOLDERS_KEY: &str = "notes.folders";

/// A tidy folder path: names trimmed, empty ones dropped. None = no folder.
pub fn clean_folder(path: &str) -> Result<Option<String>> {
    let parts: Vec<&str> = path.split('/').map(str::trim).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Ok(None);
    }
    if parts.len() > MAX_FOLDER_DEPTH {
        return Err(StoreError::Invalid(format!("folders go at most {MAX_FOLDER_DEPTH} deep")));
    }
    if parts.iter().any(|p| p.chars().count() > MAX_FOLDER_NAME) {
        return Err(StoreError::Invalid(format!("a folder name can be at most {MAX_FOLDER_NAME} characters")));
    }
    Ok(Some(parts.join("/")))
}

/// Whether `path` is `folder` or inside it.
fn within(path: &str, folder: &str) -> bool {
    path == folder || path.strip_prefix(folder).is_some_and(|rest| rest.starts_with('/'))
}

/// `path` with its `from` part swapped for `to` (None = the top level).
fn moved(path: &str, from: &str, to: Option<&str>) -> Option<String> {
    let rest = path[from.len()..].trim_start_matches('/');
    match (to, rest.is_empty()) {
        (None, true) => None,
        (None, false) => Some(rest.to_string()),
        (Some(t), true) => Some(t.to_string()),
        (Some(t), false) => Some(format!("{t}/{rest}")),
    }
}

fn saved_folders(store: &Store) -> Vec<String> {
    crate::settings::get::<Vec<String>>(store, FOLDERS_KEY).unwrap_or_default()
}

/// Every folder, parents included, in name order ("A", "A/B", "C").
pub fn folders(store: &Store) -> Result<Vec<String>> {
    let mut all = std::collections::BTreeSet::new();
    let mut stmt = store.conn().prepare("SELECT DISTINCT folder FROM notes WHERE folder IS NOT NULL AND deleted_at IS NULL")?;
    let used: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
    for path in used.into_iter().chain(saved_folders(store)) {
        let parts: Vec<&str> = path.split('/').collect();
        for i in 1..=parts.len() {
            all.insert(parts[..i].join("/"));
        }
    }
    Ok(all.into_iter().collect())
}

/// Makes an (empty) folder. Returns its tidy path.
pub fn add_folder(store: &mut Store, path: &str) -> Result<String> {
    let path = clean_folder(path)?.ok_or_else(|| StoreError::Invalid("the folder needs a name".into()))?;
    let mut list = saved_folders(store);
    if !list.contains(&path) {
        list.push(path.clone());
        list.sort();
        crate::settings::set(store, FOLDERS_KEY, &list)?;
    }
    Ok(path)
}

/// Puts a note in a folder (None or "" = no folder). Does not count as an edit.
pub fn set_folder(store: &mut Store, id: &str, folder: Option<&str>) -> Result<()> {
    let folder = match folder {
        Some(f) => clean_folder(f)?,
        None => None,
    };
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let tx = store.conn_mut().transaction()?;
    let changed = tx.execute(
        "UPDATE notes SET folder = ?2, updated_at = ?3, device_id = ?4 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, folder, stamp, device],
    )?;
    if changed == 0 {
        return Err(gone());
    }
    log_change(&tx, id, &serde_json::json!({ "folder": folder }).to_string(), &stamp, &device)?;
    tx.commit()?;
    Ok(())
}

/// Renames or moves a folder with everything in it: `to` = its new path (None = the top level,
/// so its notes and folders move up one). Moving a folder into itself is refused.
pub fn move_folder(store: &mut Store, from: &str, to: Option<&str>) -> Result<()> {
    let from = clean_folder(from)?.ok_or_else(|| StoreError::Invalid("which folder?".into()))?;
    let to = match to {
        Some(t) => clean_folder(t)?,
        None => None,
    };
    if let Some(t) = &to {
        if within(t, &from) && t != &from {
            return Err(StoreError::Invalid("a folder can't go inside itself".into()));
        }
    }
    if to.as_deref() == Some(from.as_str()) {
        return Ok(());
    }
    let notes: Vec<(String, String)> = {
        let mut stmt = store.conn().prepare("SELECT id, folder FROM notes WHERE folder IS NOT NULL AND deleted_at IS NULL")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?.into_iter().filter(|(_, f)| within(f, &from)).collect()
    };
    // Check every new path first, so a move that would go too deep changes nothing.
    let plan: Vec<(String, Option<String>)> = notes.into_iter().map(|(id, path)| (id, moved(&path, &from, to.as_deref()))).collect();
    for (_, next) in &plan {
        if let Some(n) = next {
            clean_folder(n)?;
        }
    }
    for (id, next) in plan {
        set_folder(store, &id, next.as_deref())?;
    }
    let list: std::collections::BTreeSet<String> = saved_folders(store)
        .into_iter()
        .filter_map(|p| if within(&p, &from) { moved(&p, &from, to.as_deref()) } else { Some(p) })
        .chain(to.clone())
        .collect();
    crate::settings::set(store, FOLDERS_KEY, &list.into_iter().collect::<Vec<_>>())?;
    Ok(())
}

/// Removes a folder but keeps what is in it: its notes and folders move up into its parent.
pub fn remove_folder(store: &mut Store, path: &str) -> Result<()> {
    let path = clean_folder(path)?.ok_or_else(|| StoreError::Invalid("which folder?".into()))?;
    let parent = path.rsplit_once('/').map(|(p, _)| p.to_string());
    // Moving "A/B" to "A" would keep the name B; instead lift B's contents straight into A.
    let notes: Vec<(String, String)> = {
        let mut stmt = store.conn().prepare("SELECT id, folder FROM notes WHERE folder IS NOT NULL AND deleted_at IS NULL")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?.into_iter().filter(|(_, f)| within(f, &path)).collect()
    };
    for (id, f) in notes {
        set_folder(store, &id, moved(&f, &path, parent.as_deref()).as_deref())?;
    }
    let list: std::collections::BTreeSet<String> = saved_folders(store)
        .into_iter()
        .filter_map(|p| if within(&p, &path) { moved(&p, &path, parent.as_deref()) } else { Some(p) })
        .collect();
    crate::settings::set(store, FOLDERS_KEY, &list.into_iter().collect::<Vec<_>>())?;
    Ok(())
}

fn log_change(conn: &Connection, id: &str, fields: &str, stamp: &str, device: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO change_log (entity, entity_id, fields, hlc, device_id) VALUES ('notes', ?1, ?2, ?3, ?4)",
        params![id, fields, stamp, device],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x"}]}]}"#;

    fn titles(list: Vec<NoteSummary>) -> Vec<String> {
        list.into_iter().map(|n| n.title).collect()
    }

    #[test]
    fn create_save_pin_delete_round_trip() {
        let mut store = Store::open_in_memory().unwrap();
        let n = create(&mut store).unwrap();
        assert_eq!((n.title.as_str(), n.body.as_str(), n.pinned), ("", "", false));

        let n = save(&mut store, &n.id, "  Physics  ", DOC, "Newton's laws, F = ma\n").unwrap();
        assert_eq!((n.title.as_str(), n.body.as_str(), n.plain_text.as_str()), ("Physics", DOC, "Newton's laws, F = ma"));

        set_pinned(&mut store, &n.id, true).unwrap();
        assert!(get(store.conn(), &n.id).unwrap().unwrap().pinned);

        delete(&mut store, std::slice::from_ref(&n.id)).unwrap();
        assert!(list(store.conn(), None).unwrap().is_empty());
        assert!(save(&mut store, &n.id, "x", DOC, "x").is_err(), "deleted notes cannot be edited");
        restore(&mut store, std::slice::from_ref(&n.id)).unwrap();
        assert_eq!(titles(list(store.conn(), None).unwrap()), ["Physics"]);
    }

    #[test]
    fn pinned_first_then_latest_edit() {
        let mut store = Store::open_in_memory().unwrap();
        let mut make = |title: &str| {
            let id = create(&mut store).unwrap().id;
            save(&mut store, &id, title, DOC, title).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(3));
            id
        };
        let old = make("old");
        make("newer");
        make("newest");
        set_pinned(&mut store, &old, true).unwrap();
        assert_eq!(titles(list(store.conn(), None).unwrap()), ["old", "newest", "newer"]);
    }

    #[test]
    fn search_finds_words_by_their_start() {
        let mut store = Store::open_in_memory().unwrap();
        for (title, text) in [("Physics", "Newton's second law"), ("Shopping", "milk, eggs"), ("Ideas", "a physics game")] {
            let id = create(&mut store).unwrap().id;
            save(&mut store, &id, title, DOC, text).unwrap();
        }
        let mut found = titles(list(store.conn(), Some("phys")).unwrap());
        found.sort();
        assert_eq!(found, ["Ideas", "Physics"]);
        assert_eq!(titles(list(store.conn(), Some("newton law")).unwrap()), ["Physics"]);
        assert_eq!(titles(list(store.conn(), Some("\"eggs\" (*")).unwrap()), ["Shopping"], "punctuation is ignored");
        assert_eq!(list(store.conn(), Some("   ")).unwrap().len(), 3, "an empty search lists everything");
    }

    #[test]
    fn bad_saves_are_refused() {
        let mut store = Store::open_in_memory().unwrap();
        let id = create(&mut store).unwrap().id;
        assert!(save(&mut store, &id, &"x".repeat(201), DOC, "").is_err());
        assert!(save(&mut store, &id, "x", "{not json", "").is_err());
        assert!(save(&mut store, "missing", "x", DOC, "").is_err());
    }

    #[test]
    fn handwritten_notes_keep_their_kind() {
        let mut store = Store::open_in_memory().unwrap();
        let text = create(&mut store).unwrap();
        assert_eq!(text.kind, "text");
        let ink = create_kind(&mut store, "ink").unwrap();
        assert_eq!(ink.kind, "ink");
        assert!(create_kind(&mut store, "video").is_err());

        let strokes = r##"{"v":1,"strokes":[{"t":"pen","c":"#ffffff","w":2,"p":[1,2,0.5,3,4,0.5]}]}"##;
        let n = save(&mut store, &ink.id, "Chemistry", strokes, "").unwrap();
        assert_eq!((n.kind.as_str(), n.body.as_str()), ("ink", strokes));
        let listed = list(store.conn(), None).unwrap();
        assert_eq!(listed.iter().find(|s| s.id == ink.id).unwrap().kind, "ink");
        assert_eq!(list(store.conn(), Some("chem")).unwrap().len(), 1, "found by its title");

        // Ink may be bigger than text, but not without end.
        let big = format!(r#"{{"v":1,"pad":"{}"}}"#, "x".repeat(MAX_BODY_BYTES + 10));
        assert!(save(&mut store, &text.id, "", &big, "").is_err());
        assert!(save(&mut store, &ink.id, "", &big, "").is_ok());
        let huge = format!(r#"{{"v":1,"pad":"{}"}}"#, "x".repeat(MAX_INK_BYTES + 10));
        assert!(save(&mut store, &ink.id, "", &huge, "").is_err());
    }

    #[test]
    fn pinned_notes_reach_the_dashboard() {
        let mut store = Store::open_in_memory().unwrap();
        let id = create(&mut store).unwrap().id;
        save(&mut store, &id, "Exam plan", DOC, "Chapter 1 to 4").unwrap();
        set_pinned(&mut store, &id, true).unwrap();
        let d = crate::dashboard::load(&store, 0, 0, 1, "2026-10-23").unwrap();
        assert_eq!(d.pinned_notes.len(), 1);
        assert_eq!(d.pinned_notes[0].preview, "Chapter 1 to 4");
    }

    #[test]
    fn folders_nest_move_and_go_without_losing_notes() {
        let mut store = Store::open_in_memory().unwrap();
        let a = create(&mut store).unwrap().id;
        let b = create(&mut store).unwrap().id;
        set_folder(&mut store, &a, Some(" School / Physics ")).unwrap();
        set_folder(&mut store, &b, Some("School")).unwrap();
        add_folder(&mut store, "Ideas").unwrap();
        assert_eq!(folders(&store).unwrap(), vec!["Ideas", "School", "School/Physics"]);
        assert_eq!(get(store.conn(), &a).unwrap().unwrap().folder.as_deref(), Some("School/Physics"));
        // Group a group: School goes inside Ideas, with everything in it.
        move_folder(&mut store, "School", Some("Ideas/School")).unwrap();
        assert_eq!(get(store.conn(), &a).unwrap().unwrap().folder.as_deref(), Some("Ideas/School/Physics"));
        assert!(move_folder(&mut store, "Ideas", Some("Ideas/School/X")).is_err());
        // Removing a folder lifts its contents into the parent.
        remove_folder(&mut store, "Ideas/School").unwrap();
        assert_eq!(get(store.conn(), &a).unwrap().unwrap().folder.as_deref(), Some("Ideas/Physics"));
        assert_eq!(get(store.conn(), &b).unwrap().unwrap().folder.as_deref(), Some("Ideas"));
        assert_eq!(folders(&store).unwrap(), vec!["Ideas", "Ideas/Physics"]);
        assert!(list(store.conn(), None).unwrap().iter().any(|n| n.folder.as_deref() == Some("Ideas")));
    }
}
