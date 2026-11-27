//! Encrypted backup and restore (Settings → Backup). A backup is one file holding the whole
//! database (a clean copy made with VACUUM INTO) and every note attachment, encrypted with a
//! password the user picks. Restoring unpacks it next to the database and swaps it in when
//! Focus restarts (`apply_pending_restore`, before the database is opened).
//!
//! File layout: "FOCUSBK1", argon2id parameters (m KiB, t, p as u32 LE), a 16-byte salt and an
//! 8-byte nonce prefix, then the archive in 1 MiB chunks, each sealed with ChaCha20-Poly1305
//! (nonce = prefix + chunk number; the last chunk is marked in its associated data, so a cut-off
//! file can't pass as whole). Each chunk is its length (u32 LE) then the sealed bytes.
//! The archive inside: for each file, the name length (u32 LE), the name ("focus.db" or
//! "attachments/<sha256>"), the size (u64 LE) and the bytes.

use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::state::StoreState;

const MAGIC: &[u8; 8] = b"FOCUSBK1";
const CHUNK: usize = 1 << 20;
/// argon2id cost: 64 MiB, 3 passes. A second or so on a PC, slow to guess passwords against.
const KDF: (u32, u32, u32) = (64 * 1024, 3, 1);
/// The restored files wait here until the next start.
const STAGING: &str = "restore-pending";

fn bad(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn key_for(password: &str, salt: &[u8], (m, t, p): (u32, u32, u32)) -> Result<Key, String> {
    let params = argon2::Params::new(m, t, p, Some(32)).map_err(bad)?;
    let mut key = [0u8; 32];
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(bad)?;
    Ok(key.into())
}

fn nonce(prefix: &[u8; 8], n: u32) -> Nonce {
    let mut b = [0u8; 12];
    b[..8].copy_from_slice(prefix);
    b[8..].copy_from_slice(&n.to_le_bytes());
    b.into()
}

/// Encrypts what is written to it, a chunk at a time.
struct SealWriter<W: Write> {
    out: W,
    cipher: ChaCha20Poly1305,
    prefix: [u8; 8],
    n: u32,
    buf: Vec<u8>,
}

impl<W: Write> SealWriter<W> {
    fn new(mut out: W, password: &str, kdf: (u32, u32, u32)) -> Result<Self, String> {
        let mut salt = [0u8; 16];
        let mut prefix = [0u8; 8];
        getrandom::fill(&mut salt).map_err(bad)?;
        getrandom::fill(&mut prefix).map_err(bad)?;
        let key = key_for(password, &salt, kdf)?;
        out.write_all(MAGIC).map_err(bad)?;
        for v in [kdf.0, kdf.1, kdf.2] {
            out.write_all(&v.to_le_bytes()).map_err(bad)?;
        }
        out.write_all(&salt).map_err(bad)?;
        out.write_all(&prefix).map_err(bad)?;
        Ok(Self { out, cipher: ChaCha20Poly1305::new(&key), prefix, n: 0, buf: Vec::with_capacity(CHUNK) })
    }

    fn seal(&mut self, last: bool) -> io::Result<()> {
        let aad: &[u8] = if last { b"last" } else { b"more" };
        let sealed = self
            .cipher
            .encrypt(&nonce(&self.prefix, self.n), Payload { msg: &self.buf, aad })
            .map_err(|_| io::Error::other("encryption failed"))?;
        self.n = self.n.checked_add(1).ok_or_else(|| io::Error::other("backup too large"))?;
        self.out.write_all(&(sealed.len() as u32).to_le_bytes())?;
        self.out.write_all(&sealed)?;
        self.buf.clear();
        Ok(())
    }

    fn finish(mut self) -> io::Result<W> {
        self.seal(true)?;
        self.out.flush()?;
        Ok(self.out)
    }
}

impl<W: Write> Write for SealWriter<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let room = CHUNK - self.buf.len();
        let take = room.min(data.len());
        self.buf.extend_from_slice(&data[..take]);
        if self.buf.len() == CHUNK {
            self.seal(false)?;
        }
        Ok(take)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Decrypts a backup as it is read; fails on a wrong password, a changed byte or a cut-off file.
struct OpenReader<R: Read> {
    inp: R,
    cipher: ChaCha20Poly1305,
    prefix: [u8; 8],
    n: u32,
    buf: Vec<u8>,
    pos: usize,
    done: bool,
}

const WRONG: &str = "Wrong password, or the backup file is damaged.";

impl<R: Read> OpenReader<R> {
    fn new(mut inp: R, password: &str) -> Result<Self, String> {
        let mut head = [0u8; 8 + 12 + 16 + 8];
        inp.read_exact(&mut head).map_err(|_| "This isn't a Kairos backup file.".to_string())?;
        if &head[..8] != MAGIC {
            return Err("This isn't a Kairos backup file.".into());
        }
        let u = |i: usize| u32::from_le_bytes(head[i..i + 4].try_into().unwrap());
        let kdf = (u(8), u(12), u(16));
        if kdf.0 > 1024 * 1024 || kdf.1 > 20 || kdf.2 > 16 {
            return Err("This backup file is damaged.".into());
        }
        let key = key_for(password, &head[20..36], kdf)?;
        let prefix: [u8; 8] = head[36..44].try_into().unwrap();
        Ok(Self { inp, cipher: ChaCha20Poly1305::new(&key), prefix, n: 0, buf: Vec::new(), pos: 0, done: false })
    }

    fn next_chunk(&mut self) -> io::Result<()> {
        let mut len = [0u8; 4];
        self.inp.read_exact(&mut len).map_err(|_| io::Error::other(WRONG))?;
        let len = u32::from_le_bytes(len) as usize;
        if len > CHUNK + 16 {
            return Err(io::Error::other(WRONG));
        }
        let mut sealed = vec![0u8; len];
        self.inp.read_exact(&mut sealed).map_err(|_| io::Error::other(WRONG))?;
        let n = nonce(&self.prefix, self.n);
        let (plain, last) = match self.cipher.decrypt(&n, Payload { msg: &sealed, aad: b"more" }) {
            Ok(p) => (p, false),
            Err(_) => (self.cipher.decrypt(&n, Payload { msg: &sealed, aad: b"last" }).map_err(|_| io::Error::other(WRONG))?, true),
        };
        self.n += 1;
        self.buf = plain;
        self.pos = 0;
        self.done = last;
        Ok(())
    }
}

impl<R: Read> Read for OpenReader<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        while self.pos == self.buf.len() {
            if self.done {
                return Ok(0);
            }
            self.next_chunk()?;
        }
        let take = out.len().min(self.buf.len() - self.pos);
        out[..take].copy_from_slice(&self.buf[self.pos..self.pos + take]);
        self.pos += take;
        Ok(take)
    }
}

fn put_file(w: &mut impl Write, name: &str, path: &Path) -> Result<(), String> {
    let size = fs::metadata(path).map_err(bad)?.len();
    w.write_all(&(name.len() as u32).to_le_bytes()).map_err(bad)?;
    w.write_all(name.as_bytes()).map_err(bad)?;
    w.write_all(&size.to_le_bytes()).map_err(bad)?;
    let copied = io::copy(&mut File::open(path).map_err(bad)?.take(size), w).map_err(bad)?;
    if copied != size {
        return Err(format!("{name} changed while it was being backed up"));
    }
    Ok(())
}

/// Only names the backup itself writes; anything else (e.g. "../x") is refused.
fn safe_name(name: &str) -> bool {
    name == "focus.db"
        || name.strip_prefix("attachments/").is_some_and(|h| !h.is_empty() && h.len() <= 128 && h.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// Writes the backup of `db` (a finished copy) and the files in `files_dir` to `out`.
fn write_backup(out: &Path, password: &str, db: &Path, files_dir: Option<&Path>, kdf: (u32, u32, u32)) -> Result<BackupInfo, String> {
    let tmp = out.with_extension("partial");
    let mut w = SealWriter::new(BufWriter::new(File::create(&tmp).map_err(bad)?), password, kdf)?;
    put_file(&mut w, "focus.db", db)?;
    let mut files = 0;
    if let Some(dir) = files_dir.filter(|d| d.is_dir()) {
        for entry in fs::read_dir(dir).map_err(bad)? {
            let entry = entry.map_err(bad)?;
            let name = entry.file_name().to_string_lossy().to_string();
            let archived = format!("attachments/{name}");
            if entry.file_type().map_err(bad)?.is_file() && safe_name(&archived) {
                put_file(&mut w, &archived, &entry.path())?;
                files += 1;
            }
        }
    }
    w.finish().map_err(bad)?.into_inner().map_err(|e| e.to_string())?.sync_all().map_err(bad)?;
    fs::rename(&tmp, out).map_err(bad)?;
    Ok(BackupInfo { path: out.display().to_string(), bytes: fs::metadata(out).map_err(bad)?.len(), attachments: files })
}

/// Unpacks a backup into `dest` (focus.db + attachments/); checks every byte before returning.
fn read_backup(file: &Path, password: &str, dest: &Path) -> Result<u32, String> {
    let _ = fs::remove_dir_all(dest);
    fs::create_dir_all(dest.join("attachments")).map_err(bad)?;
    let mut r = OpenReader::new(BufReader::new(File::open(file).map_err(bad)?), password)?;
    let (mut has_db, mut files) = (false, 0);
    loop {
        let mut len = [0u8; 4];
        match r.read(&mut len[..1]).map_err(bad)? {
            0 => break,
            _ => r.read_exact(&mut len[1..]).map_err(bad)?,
        }
        let len = u32::from_le_bytes(len) as usize;
        if len > 200 {
            return Err("This backup file is damaged.".into());
        }
        let mut name = vec![0u8; len];
        r.read_exact(&mut name).map_err(bad)?;
        let name = String::from_utf8(name).map_err(|_| "This backup file is damaged.".to_string())?;
        if !safe_name(&name) {
            return Err("This backup file is damaged.".into());
        }
        let mut size = [0u8; 8];
        r.read_exact(&mut size).map_err(bad)?;
        let size = u64::from_le_bytes(size);
        let mut out = BufWriter::new(File::create(dest.join(&name)).map_err(bad)?);
        if io::copy(&mut (&mut r).take(size), &mut out).map_err(bad)? != size {
            return Err("This backup file is cut off.".into());
        }
        out.flush().map_err(bad)?;
        if name == "focus.db" {
            has_db = true;
        } else {
            files += 1;
        }
    }
    if !has_db {
        return Err("This backup has no database in it.".into());
    }
    focus_store::Store::open(&dest.join("focus.db")).map_err(|e| format!("The backup's database can't be opened: {e}"))?;
    Ok(files)
}

/// Before the database is opened: swaps in a restore unpacked last time. The database it
/// replaces is kept as "focus.db.before-restore" (one copy).
pub fn apply_pending_restore(data_dir: &Path) {
    let staged = data_dir.join(STAGING);
    let ready = staged.join("ready");
    if !ready.exists() {
        let _ = fs::remove_dir_all(&staged);
        return;
    }
    let db = data_dir.join("focus.db");
    let keep = data_dir.join("focus.db.before-restore");
    let _ = fs::remove_file(&keep);
    if db.exists() && fs::rename(&db, &keep).is_err() {
        return;
    }
    // The old database's write-ahead log must not be replayed onto the restored one.
    for ext in ["-wal", "-shm"] {
        let _ = fs::remove_file(data_dir.join(format!("focus.db{ext}")));
    }
    if fs::rename(staged.join("focus.db"), &db).is_err() {
        let _ = fs::rename(&keep, &db);
        return;
    }
    // Attachments are named by their content, so adding the backup's files never clashes.
    let files = data_dir.join("attachments");
    let _ = fs::create_dir_all(&files);
    if let Ok(list) = fs::read_dir(staged.join("attachments")) {
        for e in list.flatten() {
            let to = files.join(e.file_name());
            if !to.exists() {
                let _ = fs::rename(e.path(), to);
            }
        }
    }
    let _ = fs::remove_dir_all(&staged);
}

/// Mirrored by `BackupInfo` in src/ipc/backup.ts.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    path: String,
    bytes: u64,
    attachments: u32,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(bad)
}

fn check_password(p: &str) -> Result<(), String> {
    if p.chars().count() < 8 {
        return Err("Use a password of at least 8 characters.".into());
    }
    Ok(())
}

/// Asks where to save, then writes the backup. None when the dialog is closed.
#[tauri::command]
pub async fn make_backup(app: AppHandle, password: String) -> Result<Option<BackupInfo>, String> {
    check_password(&password)?;
    tauri::async_runtime::spawn_blocking(move || {
        let name = format!("Kairos backup {}.focusbackup", chrono::Local::now().format("%Y-%m-%d"));
        let Some(out) = app
            .dialog()
            .file()
            .set_title("Save a Kairos backup")
            .set_file_name(&name)
            .add_filter("Kairos backup", &["focusbackup"])
            .blocking_save_file()
            .and_then(|p| p.into_path().ok())
        else {
            return Ok(None);
        };
        let dir = data_dir(&app)?;
        let copy = dir.join("backup-copy.db");
        let _ = fs::remove_file(&copy);
        let files_dir = app.state::<StoreState>().with(|s| {
            s.conn().execute("VACUUM INTO ?1", [copy.to_string_lossy().as_ref()]).map_err(bad)?;
            Ok(s.files_dir().map(Path::to_path_buf))
        })?;
        let done = write_backup(&out, &password, &copy, files_dir.as_deref(), KDF);
        let _ = fs::remove_file(&copy);
        done.map(Some)
    })
    .await
    .map_err(bad)?
}

/// Asks for a backup file, checks it with the password and unpacks it; Focus then restarts and
/// uses it. None when the dialog is closed.
#[tauri::command]
pub async fn restore_backup(app: AppHandle, password: String) -> Result<Option<u32>, String> {
    let picked = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || -> Result<Option<u32>, String> {
            let Some(file) = app
                .dialog()
                .file()
                .set_title("Restore a Kairos backup")
                .add_filter("Kairos backup", &["focusbackup"])
                .blocking_pick_file()
                .and_then(|p| p.into_path().ok())
            else {
                return Ok(None);
            };
            let staged = data_dir(&app)?.join(STAGING);
            let files = read_backup(&file, &password, &staged).inspect_err(|_| {
                let _ = fs::remove_dir_all(&staged);
            })?;
            fs::write(staged.join("ready"), b"").map_err(bad)?;
            Ok(Some(files))
        }
    })
    .await
    .map_err(bad)??;
    if picked.is_some() {
        app.restart();
    }
    Ok(picked)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAST: (u32, u32, u32) = (64, 1, 1);

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("focus-backup-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_backup_restores_byte_for_byte() {
        let d = temp("roundtrip");
        let db = d.join("focus.db");
        focus_store::Store::open(&db).unwrap();
        let files = d.join("attachments");
        fs::create_dir_all(&files).unwrap();
        let big: Vec<u8> = (0..(CHUNK * 2 + 77)).map(|i| (i % 251) as u8).collect();
        fs::write(files.join("abc123"), &big).unwrap();
        fs::write(files.join("bad name.txt"), b"skipped").unwrap();
        let out = d.join("b.focusbackup");
        let info = write_backup(&out, "correct horse", &db, Some(&files), FAST).unwrap();
        assert_eq!(info.attachments, 1);

        let dest = d.join("restore");
        assert_eq!(read_backup(&out, "correct horse", &dest).unwrap(), 1);
        assert_eq!(fs::read(dest.join("attachments/abc123")).unwrap(), big);
        assert_eq!(fs::read(dest.join("focus.db")).unwrap(), fs::read(&db).unwrap());
        assert!(read_backup(&out, "wrong password", &dest).unwrap_err().contains("Wrong password"));
    }

    #[test]
    fn a_cut_off_or_changed_backup_is_refused() {
        let d = temp("damaged");
        let db = d.join("focus.db");
        focus_store::Store::open(&db).unwrap();
        let out = d.join("b.focusbackup");
        write_backup(&out, "password1", &db, None, FAST).unwrap();
        let bytes = fs::read(&out).unwrap();
        fs::write(&out, &bytes[..bytes.len() - 5]).unwrap();
        assert!(read_backup(&out, "password1", &d.join("r")).is_err());
        let mut flipped = bytes.clone();
        let mid = flipped.len() / 2;
        flipped[mid] ^= 1;
        fs::write(&out, &flipped).unwrap();
        assert!(read_backup(&out, "password1", &d.join("r")).is_err());
        fs::write(&out, b"not a backup at all, just text").unwrap();
        assert!(read_backup(&out, "password1", &d.join("r")).unwrap_err().contains("isn't a Kairos backup"));
    }

    #[test]
    fn a_pending_restore_is_swapped_in_at_start() {
        let d = temp("apply");
        fs::write(d.join("focus.db"), b"old").unwrap();
        fs::write(d.join("focus.db-wal"), b"old log").unwrap();
        let staged = d.join(STAGING);
        fs::create_dir_all(staged.join("attachments")).unwrap();
        fs::write(staged.join("focus.db"), b"new").unwrap();
        fs::write(staged.join("attachments/f1"), b"file").unwrap();
        apply_pending_restore(&d);
        assert_eq!(fs::read(d.join("focus.db")).unwrap(), b"old", "not ready yet: nothing swapped");
        fs::create_dir_all(staged.join("attachments")).unwrap();
        fs::write(staged.join("focus.db"), b"new").unwrap();
        fs::write(staged.join("attachments/f1"), b"file").unwrap();
        fs::write(staged.join("ready"), b"").unwrap();
        apply_pending_restore(&d);
        assert_eq!(fs::read(d.join("focus.db")).unwrap(), b"new");
        assert_eq!(fs::read(d.join("focus.db.before-restore")).unwrap(), b"old");
        assert!(!d.join("focus.db-wal").exists());
        assert_eq!(fs::read(d.join("attachments/f1")).unwrap(), b"file");
        assert!(!staged.exists());
    }
}
