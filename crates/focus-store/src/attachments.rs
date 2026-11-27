//! Files attached to notes (a zip, a PDF, slides, anything). The row in `note_attachments`
//! holds the name, size and SHA-256 and syncs like any other row; the file itself is stored
//! once per content in the attachments folder (`Store::files_dir`), named by its SHA-256.
//! A device that has a row but not the file yet asks for it at the end of the next sync, so
//! a note shows its files straight away and each one becomes openable when it has arrived.

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::Store;
use crate::error::{Result, StoreError};
use crate::ids::new_id;
use crate::store::now_ms;
use crate::sync::hex;

/// Largest file that can be attached.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Longest file name kept, in characters.
const MAX_NAME: usize = 200;

/// A file on a note. Mirrored by `NoteAttachment` in src/ipc/notes.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub note_id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub sha256: String,
    pub created_at: i64,
    /// False while the file is still on another device (it comes with the next sync).
    pub available: bool,
}

fn files_dir(store: &Store) -> Result<PathBuf> {
    store.files_dir().map(Path::to_path_buf).ok_or_else(|| StoreError::Invalid("there is no folder for attached files".into()))
}

fn io(what: &str, e: std::io::Error) -> StoreError {
    StoreError::Invalid(format!("{what}: {e}"))
}

/// A SHA-256 as written in a row: 64 lowercase hex digits (anything else could name a path).
pub fn valid_sha(sha: &str) -> bool {
    sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Where the file with this content is (or would be) kept.
pub fn blob_path(dir: &Path, sha: &str) -> Option<PathBuf> {
    valid_sha(sha).then(|| dir.join(sha))
}

/// The stored file with this content, if it is here.
pub fn have(dir: &Path, sha: &str) -> Option<PathBuf> {
    blob_path(dir, sha).filter(|p| p.is_file())
}

/// A file name as shown and saved: no folders, no characters Windows refuses.
pub fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').trim();
    let cleaned: String = if cleaned.chars().count() > MAX_NAME {
        // Keep the extension when shortening.
        match cleaned.rfind('.') {
            Some(dot) if cleaned.len() - dot <= 12 => {
                let ext = &cleaned[dot..];
                let stem: String = cleaned[..dot].chars().take(MAX_NAME - ext.chars().count()).collect();
                format!("{stem}{ext}")
            }
            _ => cleaned.chars().take(MAX_NAME).collect(),
        }
    } else {
        cleaned.to_string()
    };
    if cleaned.is_empty() { "file".into() } else { cleaned }
}

/// A file type from the name, so the other device's apps know how to open it.
pub fn mime_for(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "csv" => "text/csv",
        "txt" | "log" | "md" => "text/plain",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "apk" => "application/vnd.android.package-archive",
        "exe" | "msi" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

/// A file being written into the attachments folder: hashed as it goes, and only given its
/// final name (its SHA-256) once complete and, when one was expected, matching it.
pub struct Incoming {
    dir: PathBuf,
    tmp: PathBuf,
    file: Option<File>,
    hasher: Sha256,
    size: u64,
}

impl Incoming {
    pub fn new(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).map_err(|e| io("could not make the attachments folder", e))?;
        let tmp = dir.join(format!(".incoming-{}", new_id()));
        let file = File::create(&tmp).map_err(|e| io("could not save the file", e))?;
        Ok(Self { dir: dir.to_path_buf(), tmp, file: Some(file), hasher: Sha256::new(), size: 0 })
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.size += bytes.len() as u64;
        if self.size > MAX_FILE_BYTES {
            return Err(StoreError::Invalid("files can be at most 2 GB".into()));
        }
        self.hasher.update(bytes);
        let file = self.file.as_mut().ok_or_else(|| StoreError::Invalid("the file was already saved".into()))?;
        file.write_all(bytes).map_err(|e| io("could not save the file", e))
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    /// Keeps the file and returns its SHA-256 and size. With `expect`, a file whose content
    /// differs (damaged on the way) is thrown away instead.
    pub fn finish(mut self, expect: Option<&str>) -> Result<(String, u64)> {
        if let Some(mut file) = self.file.take() {
            file.flush().map_err(|e| io("could not save the file", e))?;
        }
        let sha = hex(&std::mem::take(&mut self.hasher).finalize());
        if expect.is_some_and(|e| e != sha) {
            return Err(StoreError::Invalid("the file arrived damaged".into()));
        }
        let path = self.dir.join(&sha);
        if !path.is_file() {
            std::fs::rename(&self.tmp, &path).map_err(|e| io("could not save the file", e))?;
        }
        Ok((sha, self.size))
    }
}

impl Drop for Incoming {
    fn drop(&mut self) {
        // Only still there if `finish` didn't keep it (an error part-way, or damaged).
        self.file.take();
        std::fs::remove_file(&self.tmp).ok();
    }
}

/// Copies a file into the attachments folder. Done without the database (it can take a while
/// for a big file); `add` then records it on the note.
pub fn ingest(dir: &Path, src: &Path) -> Result<(String, u64)> {
    let mut input = File::open(src).map_err(|e| io("could not open the file", e))?;
    if input.metadata().map(|m| m.len()).unwrap_or(0) > MAX_FILE_BYTES {
        return Err(StoreError::Invalid("files can be at most 2 GB".into()));
    }
    let mut incoming = Incoming::new(dir)?;
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = input.read(&mut buf).map_err(|e| io("could not read the file", e))?;
        if n == 0 {
            break;
        }
        incoming.write(&buf[..n])?;
    }
    incoming.finish(None)
}

const COLS: &str = "id, note_id, name, mime, size, sha256, created_at";

fn read(dir: Option<&Path>) -> impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<Attachment> + '_ {
    move |r| {
        let sha: String = r.get(5)?;
        Ok(Attachment {
            id: r.get(0)?,
            note_id: r.get(1)?,
            name: r.get(2)?,
            mime: r.get(3)?,
            size: r.get::<_, i64>(4)?.max(0) as u64,
            available: dir.is_some_and(|d| have(d, &sha).is_some()),
            sha256: sha,
            created_at: r.get(6)?,
        })
    }
}

/// A note's files, oldest first.
pub fn list(store: &Store, note_id: &str) -> Result<Vec<Attachment>> {
    let mut stmt = store.conn().prepare(&format!(
        "SELECT {COLS} FROM note_attachments WHERE note_id = ?1 AND deleted_at IS NULL ORDER BY created_at, id"
    ))?;
    let rows = stmt.query_map(params![note_id], read(store.files_dir()))?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get(store: &Store, id: &str) -> Result<Option<Attachment>> {
    Ok(store
        .conn()
        .query_row(&format!("SELECT {COLS} FROM note_attachments WHERE id = ?1 AND deleted_at IS NULL"), params![id], read(store.files_dir()))
        .optional()?)
}

/// Records a file already in the attachments folder (see `ingest`) on a note.
pub fn add(store: &mut Store, note_id: &str, name: &str, sha: &str, size: u64) -> Result<Attachment> {
    if !valid_sha(sha) {
        return Err(StoreError::Invalid("that file could not be read".into()));
    }
    let live: Option<i64> =
        store.conn().query_row("SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NULL", params![note_id], |r| r.get(0)).optional()?;
    if live.is_none() {
        return Err(StoreError::Invalid("that note no longer exists".into()));
    }
    let name = clean_name(name);
    let id = new_id();
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    store.conn().execute(
        "INSERT INTO note_attachments (id, note_id, name, mime, size, sha256, created_at, updated_at, device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, note_id, name, mime_for(&name), size as i64, sha, now_ms() as i64, stamp, device],
    )?;
    get(store, &id)?.ok_or_else(|| StoreError::Invalid("the file was not saved".into()))
}

/// Takes a file off its note (a tombstone, so the other devices remove it too). The stored
/// copy stays until `prune` (next start), so Undo works.
pub fn remove(store: &mut Store, id: &str) -> Result<()> {
    set_deleted(store, id, Some(now_ms() as i64))
}

pub fn restore(store: &mut Store, id: &str) -> Result<()> {
    set_deleted(store, id, None)
}

fn set_deleted(store: &mut Store, id: &str, deleted_at: Option<i64>) -> Result<()> {
    let stamp = store.next_stamp();
    let device = store.device_id().to_string();
    let changed = store.conn().execute(
        "UPDATE note_attachments SET deleted_at = ?2, updated_at = ?3, device_id = ?4 WHERE id = ?1",
        params![id, deleted_at, stamp, device],
    )?;
    if changed == 0 {
        return Err(StoreError::Invalid("that file is no longer on the note".into()));
    }
    Ok(())
}

/// The stored file of an attachment, to open or save. Errors while it is still on another device.
pub fn file_of(store: &Store, id: &str) -> Result<(Attachment, PathBuf)> {
    let a = get(store, id)?.ok_or_else(|| StoreError::Invalid("that file is no longer on the note".into()))?;
    let dir = files_dir(store)?;
    match have(&dir, &a.sha256) {
        Some(p) => Ok((a, p)),
        None => Err(StoreError::Invalid(format!(
            "\"{}\" is still on your other device. It arrives with the next sync (open Kairos there, on the same Wi-Fi).",
            a.name
        ))),
    }
}

/// Contents (SHA-256, size) on some note here whose file isn't here yet, to ask the other device for.
pub fn wanted(conn: &Connection, dir: &Path) -> Result<Vec<(String, u64)>> {
    let mut stmt = conn.prepare("SELECT sha256, max(size) FROM note_attachments WHERE deleted_at IS NULL GROUP BY sha256 ORDER BY min(created_at)")?;
    let rows: Vec<(String, i64)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
    Ok(rows.into_iter().filter(|(sha, _)| valid_sha(sha) && have(dir, sha).is_none()).map(|(s, n)| (s, n.max(0) as u64)).collect())
}

/// Deletes stored files no note uses any more, and leftovers of transfers that broke off.
/// Returns how many files went.
pub fn prune(store: &Store) -> Result<usize> {
    let Some(dir) = store.files_dir() else { return Ok(0) };
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(0) };
    let mut stmt = store.conn().prepare("SELECT DISTINCT sha256 FROM note_attachments WHERE deleted_at IS NULL")?;
    let used: HashSet<String> = stmt.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let stale = name.starts_with(".incoming-") || (valid_sha(&name) && !used.contains(&name));
        if stale && entry.path().is_file() && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_dir() -> (Store, PathBuf) {
        let mut store = Store::open_in_memory().unwrap();
        let dir = std::env::temp_dir().join(format!("focus-attach-{}", new_id()));
        store.set_files_dir(dir.clone());
        (store, dir)
    }

    fn temp_file(bytes: &[u8]) -> PathBuf {
        let p = std::env::temp_dir().join(format!("focus-src-{}", new_id()));
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn attach_list_remove_restore_and_prune() {
        let (mut store, dir) = store_with_dir();
        let note = crate::notes::create(&mut store).unwrap().id;
        let src = temp_file(b"hello slides");
        let (sha, size) = ingest(&dir, &src).unwrap();
        assert_eq!(size, 12);
        let a = add(&mut store, &note, "C:\\Users\\Ps\\Week 3.pptx", &sha, size).unwrap();
        assert_eq!(a.name, "Week 3.pptx");
        assert!(a.mime.contains("presentationml"));
        assert!(a.available);
        assert_eq!(list(&store, &note).unwrap().len(), 1);
        let (_, path) = file_of(&store, &a.id).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"hello slides");

        remove(&mut store, &a.id).unwrap();
        assert!(list(&store, &note).unwrap().is_empty());
        restore(&mut store, &a.id).unwrap();
        assert_eq!(prune(&store).unwrap(), 0, "a file still on a note is kept");
        remove(&mut store, &a.id).unwrap();
        assert_eq!(prune(&store).unwrap(), 1);
        assert!(have(&dir, &sha).is_none());
        std::fs::remove_dir_all(dir).ok();
        std::fs::remove_file(src).ok();
    }

    #[test]
    fn same_content_is_stored_once_and_missing_files_are_wanted() {
        let (mut store, dir) = store_with_dir();
        let note = crate::notes::create(&mut store).unwrap().id;
        let src = temp_file(b"zip bytes");
        let (sha, size) = ingest(&dir, &src).unwrap();
        add(&mut store, &note, "a.zip", &sha, size).unwrap();
        add(&mut store, &note, "copy of a.zip", &sha, size).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        assert!(wanted(store.conn(), &dir).unwrap().is_empty());
        std::fs::remove_file(dir.join(&sha)).unwrap();
        assert_eq!(wanted(store.conn(), &dir).unwrap(), vec![(sha.clone(), 9)]);
        assert!(!list(&store, &note).unwrap()[0].available);
        assert!(file_of(&store, &list(&store, &note).unwrap()[0].id).unwrap_err().to_string().contains("other device"));
        std::fs::remove_dir_all(dir).ok();
        std::fs::remove_file(src).ok();
    }

    #[test]
    fn a_damaged_transfer_is_thrown_away() {
        let dir = std::env::temp_dir().join(format!("focus-attach-{}", new_id()));
        let mut inc = Incoming::new(&dir).unwrap();
        inc.write(b"abc").unwrap();
        assert!(inc.finish(Some(&"0".repeat(64))).is_err());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn names_and_hashes_are_checked() {
        assert_eq!(clean_name("../../evil?.pdf"), "evil_.pdf");
        assert_eq!(clean_name("   "), "file");
        assert!(clean_name(&format!("{}.pdf", "x".repeat(300))).ends_with(".pdf"));
        assert!(!valid_sha("../../etc/passwd"));
        assert!(!valid_sha(&"A".repeat(64)));
        assert!(valid_sha(&"a".repeat(64)));
    }
}
