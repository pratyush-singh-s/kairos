//! One connection between two devices: pairing, or a sync.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

use focus_store::attachments::{self, Incoming};
use focus_store::sync::{self, ApplyReport, Batch, Peer};
use serde::{Deserialize, Serialize};
use spake2::{Ed25519Group, Identity, Password, Spake2};

use crate::wire::{self, Channel, Result, hs_read, hs_write, io_err, read_frame, write_frame};
use crate::{Me, NOISE_PAIR, NOISE_SYNC, PROTOCOL, StoreAccess};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Long enough for the other device to apply a big first sync before it answers.
const IO_TIMEOUT: Duration = Duration::from_secs(120);
/// Rows per message, by size, so progress moves smoothly.
const BATCH_BYTES: usize = 256 * 1024;
/// Bytes of an attached file per message.
const FILE_CHUNK: usize = 256 * 1024;

/// The other device is in the middle of another sync (maybe with us: both started at once).
pub const BUSY: &str = "The other device is busy syncing. Trying again shortly.";

const PAIR_PROLOGUE: &[u8] = b"focus-pair-1";
const SYNC_PROLOGUE: &[u8] = b"focus-sync-1";

/// Who a device is, swapped at the end of pairing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub device_id: String,
    pub name: String,
    pub kind: String,
}

/// How far a sync has got. Mirrored by `SyncProgress` in src/ipc/sync.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub peer_id: String,
    pub peer_name: String,
    /// "connecting", "sending", "receiving", "applying", "sending-files" or "receiving-files".
    /// For the file stages, rows are files.
    pub stage: String,
    pub rows_done: usize,
    pub rows_total: usize,
    pub bytes_done: usize,
    pub bytes_total: usize,
    /// The attached file on its way, during the file stages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
}

/// What a finished sync did.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub peer_id: String,
    pub peer_name: String,
    pub sent: usize,
    pub received: ApplyReport,
    /// The other device's clock minus ours (ms), roughly. Big = a clock is wrong.
    pub clock_skew_ms: i64,
    /// Attached files sent to and received from the other device.
    pub files_sent: usize,
    pub files_received: usize,
    /// Our highest row number when the sync ended.
    #[serde(skip)]
    pub local_upto: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum Msg {
    #[serde(rename_all = "camelCase")]
    Hello { proto: u32, schema: i64, app_version: String, device_id: String, name: String, kind: String, now_ms: u64, has_yours: i64 },
    Refuse { reason: String },
    Plan { rows: usize, bytes: usize, upto: i64 },
    Batch { batch: Batch },
    Done,
    Applied,
    /// After the rows: the attached files (by SHA-256) the asking side has rows for but not the file.
    Want { files: Vec<String> },
    /// One of those files; its bytes follow as plain messages of up to `FILE_CHUNK`.
    File { sha: String, size: u64, name: String },
    FilesDone,
}

fn prepare(stream: &TcpStream) -> Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT)).map_err(io_err)?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).map_err(io_err)?;
    stream.set_nodelay(true).ok();
    Ok(())
}

/// Connects and says what we want. Returns the stream once the other device agreed.
fn open(addr: SocketAddr, mode: u8) -> Result<TcpStream> {
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| match e.kind() {
        std::io::ErrorKind::TimedOut => format!("Couldn't reach {addr}. Is Kairos open there, on the same Wi-Fi?"),
        std::io::ErrorKind::ConnectionRefused => format!("{addr} isn't accepting syncs. Is Kairos open there?"),
        _ => format!("Couldn't reach {addr}: {e}"),
    })?;
    prepare(&stream)?;
    stream.write_all(wire::MAGIC).map_err(io_err)?;
    stream.write_all(&[PROTOCOL as u8, mode]).map_err(io_err)?;
    let mut reply = [0u8; 1];
    stream.read_exact(&mut reply).map_err(io_err)?;
    match reply[0] {
        wire::REPLY_OK => Ok(stream),
        wire::REPLY_BUSY => Err(BUSY.into()),
        wire::REPLY_NOT_PAIRING => Err("The other device isn't showing a pairing code. Press \"Show a code\" there first.".into()),
        _ => Err("The other device answered something unexpected. Update Kairos on both devices.".into()),
    }
}

/// Reads the greeting of a device that connected to us: Some(mode), or None if it isn't Focus.
pub fn read_greeting(stream: &mut TcpStream) -> Result<Option<u8>> {
    prepare(stream)?;
    stream.set_read_timeout(Some(Duration::from_secs(10))).map_err(io_err)?;
    let mut head = [0u8; 7];
    stream.read_exact(&mut head).map_err(io_err)?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).map_err(io_err)?;
    if &head[..5] != wire::MAGIC {
        return Ok(None);
    }
    if head[5] != PROTOCOL as u8 {
        // Tell it to update; the byte is the closest we can say before the handshake.
        stream.write_all(b"V").ok();
        return Ok(None);
    }
    Ok(Some(head[6]))
}

pub fn reply(stream: &mut TcpStream, byte: u8) -> Result<()> {
    stream.write_all(&[byte]).map_err(io_err)
}

// ---------------------------------------------------------------- pairing

fn spake_key(stream: &mut TcpStream, code: &str) -> Result<[u8; 32]> {
    let (spake, outbound) =
        Spake2::<Ed25519Group>::start_symmetric(&Password::new(code.as_bytes()), &Identity::new(PAIR_PROLOGUE));
    write_frame(stream, &outbound)?;
    let theirs = read_frame(stream)?;
    let key = spake.finish(&theirs).map_err(|_| "pairing message was damaged".to_string())?;
    key.get(..32).and_then(|k| k.try_into().ok()).ok_or_else(|| "pairing key too short".to_string())
}

fn pair_builder<'a>(me: &'a Me, psk: &'a [u8; 32]) -> Result<snow::Builder<'a>> {
    let params = NOISE_PAIR.parse().map_err(|e| format!("{e}"))?;
    snow::Builder::new(params)
        .local_private_key(&me.private)
        .and_then(|b| b.psk(3, psk))
        .and_then(|b| b.prologue(PAIR_PROLOGUE))
        .map_err(|e| format!("{e}"))
}

const WRONG_CODE: &str = "The code didn't match. Check the code on the other device and try again.";

/// Pairs with the device at `addr`, which is showing `code`. Returns who it is and its key.
pub fn pair_connect(addr: SocketAddr, code: &str, me: &Me) -> Result<(PeerInfo, Vec<u8>)> {
    let mut stream = open(addr, wire::MODE_PAIR)?;
    let psk = spake_key(&mut stream, code)?;
    let mut hs = pair_builder(me, &psk)?.build_initiator().map_err(|e| format!("{e}"))?;
    hs_write(&mut stream, &mut hs, &[])?;
    hs_read(&mut stream, &mut hs).map_err(|_| WRONG_CODE.to_string())?;
    hs_write(&mut stream, &mut hs, &[])?;
    let key = hs.get_remote_static().map(<[u8]>::to_vec).ok_or("no key from the other device")?;
    let mut ch = Channel::new(stream, hs.into_transport_mode().map_err(|e| format!("{e}"))?);
    // The other side only finds out the code was wrong when reading our last message, and
    // then hangs up instead of answering.
    let (theirs, _): (PeerInfo, _) = ch.recv().map_err(|_| WRONG_CODE.to_string())?;
    ch.send(&info(me))?;
    Ok((theirs, key))
}

/// The other half of `pair_connect`, after the greeting, while we show `code`.
pub fn pair_accept(mut stream: TcpStream, code: &str, me: &Me) -> Result<(PeerInfo, Vec<u8>)> {
    let psk = spake_key(&mut stream, code)?;
    let mut hs = pair_builder(me, &psk)?.build_responder().map_err(|e| format!("{e}"))?;
    hs_read(&mut stream, &mut hs)?;
    hs_write(&mut stream, &mut hs, &[])?;
    hs_read(&mut stream, &mut hs).map_err(|_| WRONG_CODE.to_string())?;
    let key = hs.get_remote_static().map(<[u8]>::to_vec).ok_or("no key from the other device")?;
    let mut ch = Channel::new(stream, hs.into_transport_mode().map_err(|e| format!("{e}"))?);
    ch.send(&info(me))?;
    let (theirs, _): (PeerInfo, _) = ch.recv()?;
    Ok((theirs, key))
}

fn info(me: &Me) -> PeerInfo {
    PeerInfo { device_id: me.device_id.clone(), name: me.name.clone(), kind: me.kind.clone() }
}

// ---------------------------------------------------------------- syncing

fn sync_builder(me: &Me) -> Result<snow::Builder<'_>> {
    let params = NOISE_SYNC.parse().map_err(|e| format!("{e}"))?;
    snow::Builder::new(params)
        .local_private_key(&me.private)
        .and_then(|b| b.prologue(SYNC_PROLOGUE))
        .map_err(|e| format!("{e}"))
}

/// Syncs with a paired device at `addr`.
pub fn sync_connect<S: StoreAccess>(addr: SocketAddr, peer: &Peer, me: &Me, store: &S, progress: &dyn Fn(Progress)) -> Result<Outcome> {
    let mut stream = open(addr, wire::MODE_SYNC)?;
    let mut hs = sync_builder(me)?.build_initiator().map_err(|e| format!("{e}"))?;
    hs_write(&mut stream, &mut hs, &[])?;
    hs_read(&mut stream, &mut hs).map_err(|_| "The other device didn't accept the connection.".to_string())?;
    hs_write(&mut stream, &mut hs, &[])?;
    if hs.get_remote_static() != Some(peer.public_key.as_slice()) {
        return Err(format!("The device at {addr} isn't the {} you paired with. Pair again if it was reinstalled.", peer.name));
    }
    let ch = Channel::new(stream, hs.into_transport_mode().map_err(|e| format!("{e}"))?);
    exchange(ch, true, peer.clone(), me, store, Some(addr.to_string()), progress)
}

/// The other half of `sync_connect`, after the greeting.
/// Why `sync_accept` turned a device away: it isn't paired here (yet).
pub const NOT_PAIRED: &str = "A device that isn't paired tried to sync.";

pub fn sync_accept<S: StoreAccess>(mut stream: TcpStream, me: &Me, store: &S, progress: &dyn Fn(Progress)) -> Result<Outcome> {
    let address = stream.peer_addr().ok().map(|a| std::net::SocketAddr::new(a.ip(), crate::TCP_PORT).to_string());
    let mut hs = sync_builder(me)?.build_responder().map_err(|e| format!("{e}"))?;
    hs_read(&mut stream, &mut hs)?;
    hs_write(&mut stream, &mut hs, &[])?;
    hs_read(&mut stream, &mut hs)?;
    let key = hs.get_remote_static().map(<[u8]>::to_vec).unwrap_or_default();
    let peers = store.with_store(|s| sync::peers(s.conn()).map_err(|e| e.to_string()))?;
    let Some(peer) = peers.into_iter().find(|p| p.public_key == key) else {
        return Err(NOT_PAIRED.into());
    };
    let ch = Channel::new(stream, hs.into_transport_mode().map_err(|e| format!("{e}"))?);
    exchange(ch, false, peer, me, store, address, progress)
}

fn exchange<S: StoreAccess>(
    mut ch: Channel,
    first: bool,
    peer: Peer,
    me: &Me,
    store: &S,
    address: Option<String>,
    progress: &dyn Fn(Progress),
) -> Result<Outcome> {
    let hello = Msg::Hello {
        proto: PROTOCOL,
        schema: me.schema,
        app_version: me.app_version.clone(),
        device_id: me.device_id.clone(),
        name: me.name.clone(),
        kind: me.kind.clone(),
        now_ms: now_ms(),
        has_yours: peer.received_upto,
    };
    let theirs = if first {
        ch.send(&hello)?;
        recv(&mut ch)?
    } else {
        let theirs = recv(&mut ch)?;
        ch.send(&hello)?;
        theirs
    };
    let Msg::Hello { proto, schema, app_version, device_id, name, now_ms: their_now, has_yours, .. } = theirs else {
        return Err("The other device didn't say hello.".into());
    };
    if device_id != peer.device_id {
        return Err("The other device's ID changed. Pair again.".into());
    }
    if proto != PROTOCOL || schema != me.schema {
        let reason = format!(
            "{name} has Kairos {app_version} and this device has Kairos {}. Install the same version on both to sync.",
            me.app_version
        );
        ch.send(&Msg::Refuse { reason: reason.clone() }).ok();
        return Err(reason);
    }
    let clock_skew_ms = their_now as i64 - now_ms() as i64;
    let tell = |stage: &str, rows_done, rows_total, bytes_done, bytes_total| {
        progress(Progress {
            peer_id: peer.device_id.clone(),
            peer_name: name.clone(),
            stage: stage.into(),
            rows_done,
            rows_total,
            bytes_done,
            bytes_total,
            file_name: None,
        })
    };

    let mut sent = 0;
    let mut received = ApplyReport::default();
    let mut their_upto = 0;
    for step in 0..2 {
        if (step == 0) == first {
            // Our turn to send.
            let export = store.with_store(|s| sync::export(s.conn(), has_yours, &peer.device_id, BATCH_BYTES).map_err(|e| e.to_string()))?;
            tell("sending", 0, export.rows, 0, export.bytes);
            ch.send(&Msg::Plan { rows: export.rows, bytes: export.bytes, upto: export.upto })?;
            let (mut rows, mut bytes) = (0, 0);
            for batch in export.batches {
                rows += batch.rows.len();
                bytes += ch.send(&Msg::Batch { batch })?;
                tell("sending", rows, export.rows, bytes.min(export.bytes), export.bytes);
            }
            ch.send(&Msg::Done)?;
            sent = export.rows;
            match recv(&mut ch)? {
                Msg::Applied => {}
                _ => return Err("The other device didn't confirm the changes.".into()),
            }
        } else {
            let Msg::Plan { rows: total_rows, bytes: total_bytes, upto } = recv(&mut ch)? else {
                return Err("The other device sent something unexpected.".into());
            };
            tell("receiving", 0, total_rows, 0, total_bytes);
            let mut batches = Vec::new();
            let (mut rows, mut bytes) = (0, 0);
            loop {
                let (msg, len) = ch.recv::<Msg>()?;
                match msg {
                    Msg::Batch { batch } => {
                        rows += batch.rows.len();
                        bytes += len;
                        batches.push(batch);
                        tell("receiving", rows, total_rows, bytes.min(total_bytes), total_bytes);
                    }
                    Msg::Done => break,
                    Msg::Refuse { reason } => return Err(reason),
                    _ => return Err("The other device sent something unexpected.".into()),
                }
            }
            tell("applying", rows, total_rows, bytes.min(total_bytes), total_bytes);
            received = store.with_store(|s| sync::apply(s, &batches, has_yours).map_err(|e| e.to_string()))?;
            ch.send(&Msg::Applied)?;
            their_upto = upto;
        }
    }
    // The rows are in: remember that now, so a file transfer that breaks off doesn't send
    // them again (the files are asked for again next time).
    let local_upto = store.with_store(|s| {
        sync::mark_synced(s.conn(), &peer.device_id, &name, their_upto, address.as_deref()).map_err(|e| e.to_string())?;
        sync::local_upto(s.conn()).map_err(|e| e.to_string())
    })?;

    let dir = store.with_store(|s| Ok(s.files_dir().map(std::path::Path::to_path_buf)))?;
    let tell_file = |stage: &str, files_done, files_total, bytes_done, bytes_total, file: &str| {
        progress(Progress {
            peer_id: peer.device_id.clone(),
            peer_name: name.clone(),
            stage: stage.into(),
            rows_done: files_done,
            rows_total: files_total,
            bytes_done,
            bytes_total,
            file_name: (!file.is_empty()).then(|| file.to_string()),
        })
    };
    let (mut files_sent, mut files_received) = (0, 0);
    for step in 0..2 {
        if (step == 0) == first {
            let want = match &dir {
                Some(d) => store.with_store(|s| attachments::wanted(s.conn(), d).map_err(|e| e.to_string()))?,
                None => Vec::new(),
            };
            ch.send(&Msg::Want { files: want.iter().map(|(sha, _)| sha.clone()).collect() })?;
            files_received = receive_files(&mut ch, dir.as_deref(), &want, &tell_file)?;
        } else {
            let Msg::Want { files } = recv(&mut ch)? else {
                return Err("The other device sent something unexpected.".into());
            };
            files_sent = send_files(&mut ch, dir.as_deref(), &files, store, &tell_file)?;
        }
    }
    Ok(Outcome { peer_id: peer.device_id, peer_name: name, sent, received, clock_skew_ms, files_sent, files_received, local_upto })
}

type TellFile<'a> = dyn Fn(&str, usize, usize, usize, usize, &str) + 'a;

/// Sends the files asked for that are here (the rest may come from a third device later).
fn send_files<S: StoreAccess>(ch: &mut Channel, dir: Option<&Path>, asked: &[String], store: &S, tell: &TellFile<'_>) -> Result<usize> {
    let mut plan = Vec::new();
    if let Some(dir) = dir {
        for sha in asked {
            let Some(path) = attachments::have(dir, sha) else { continue };
            let Ok(size) = std::fs::metadata(&path).map(|m| m.len()) else { continue };
            let name = store
                .with_store(|s| {
                    s.conn()
                        .query_row("SELECT name FROM note_attachments WHERE sha256 = ?1 ORDER BY deleted_at IS NOT NULL LIMIT 1", [sha], |r| r.get(0))
                        .map_err(|e| e.to_string())
                })
                .unwrap_or_else(|_| "file".to_string());
            plan.push((sha.clone(), path, size, name));
        }
    }
    let total_bytes: u64 = plan.iter().map(|p| p.2).sum();
    let count = plan.len();
    let (mut done_bytes, mut sent) = (0u64, 0);
    let mut buf = vec![0u8; FILE_CHUNK];
    for (sha, path, size, name) in plan {
        tell("sending-files", sent, count, done_bytes as usize, total_bytes as usize, &name);
        let mut file = std::fs::File::open(&path).map_err(|e| format!("Couldn't read \"{name}\": {e}"))?;
        ch.send(&Msg::File { sha, size, name: name.clone() })?;
        let mut left = size;
        while left > 0 {
            let want = buf.len().min(left as usize);
            file.read_exact(&mut buf[..want]).map_err(|e| format!("Couldn't read \"{name}\": {e}"))?;
            ch.send_bytes(&buf[..want])?;
            left -= want as u64;
            done_bytes += want as u64;
            tell("sending-files", sent, count, done_bytes as usize, total_bytes as usize, &name);
        }
        sent += 1;
    }
    ch.send(&Msg::FilesDone)?;
    Ok(sent)
}

/// Takes the files the other device sends for `want`. A file damaged on the way is dropped
/// (asked for again next sync); the others are kept.
fn receive_files(ch: &mut Channel, dir: Option<&Path>, want: &[(String, u64)], tell: &TellFile<'_>) -> Result<usize> {
    let total_bytes: u64 = want.iter().map(|w| w.1).sum();
    let (mut done_bytes, mut got) = (0u64, 0);
    if !want.is_empty() {
        tell("receiving-files", 0, want.len(), 0, total_bytes as usize, "");
    }
    loop {
        match recv(ch)? {
            Msg::FilesDone => break,
            Msg::File { sha, size, name } => {
                let (Some(dir), true) = (dir, want.iter().any(|w| w.0 == sha)) else {
                    return Err("The other device sent a file that wasn't asked for.".into());
                };
                if size > attachments::MAX_FILE_BYTES {
                    return Err("The other device sent a file that is too large.".into());
                }
                let mut incoming = Incoming::new(dir).map_err(|e| e.to_string())?;
                while incoming.size() < size {
                    let bytes = ch.recv_bytes()?;
                    if incoming.size() + bytes.len() as u64 > size {
                        return Err("The other device sent more of a file than it said.".into());
                    }
                    incoming.write(&bytes).map_err(|e| e.to_string())?;
                    done_bytes += bytes.len() as u64;
                    tell("receiving-files", got, want.len(), done_bytes.min(total_bytes) as usize, total_bytes as usize, &name);
                }
                if incoming.finish(Some(&sha)).is_ok() {
                    got += 1;
                }
                tell("receiving-files", got, want.len(), done_bytes.min(total_bytes) as usize, total_bytes as usize, &name);
            }
            _ => return Err("The other device sent something unexpected.".into()),
        }
    }
    Ok(got)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn recv(ch: &mut Channel) -> Result<Msg> {
    match ch.recv::<Msg>()?.0 {
        Msg::Refuse { reason } => Err(reason),
        m => Ok(m),
    }
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::sync::Mutex;

    use focus_store::Store;

    use super::*;
    use crate::load_me;

    fn device(name: &str) -> (Mutex<Store>, Me) {
        let mut store = Store::open_in_memory().unwrap();
        store.set_files_dir(std::env::temp_dir().join(format!("focus-sync-files-{}", focus_store::ids::new_id())));
        let me = load_me(&mut store, name, "pc", "0.21.0").unwrap();
        (Mutex::new(store), me)
    }

    /// Runs `answer` for one connection on a free local port; returns the port's address.
    fn serve(answer: impl FnOnce(TcpStream) + Send + 'static) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mode = read_greeting(&mut stream).unwrap();
            assert!(mode.is_some());
            reply(&mut stream, wire::REPLY_OK).unwrap();
            answer(stream);
        });
        addr
    }

    fn pair(a: &(Mutex<Store>, Me), b: &(Mutex<Store>, Me)) {
        let me_b = b.1.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let addr = serve(move |s| tx.send(pair_accept(s, "123456", &me_b)).unwrap());
        let (info_b, key_b) = pair_connect(addr, "123456", &a.1).unwrap();
        let (info_a, key_a) = rx.recv().unwrap().unwrap();
        assert_eq!(info_b.name, "Laptop B");
        assert_eq!(key_b, b.1.public);
        assert_eq!(key_a, a.1.public);
        a.0.with_store(|s| sync::save_peer(s.conn(), &info_b.device_id, &info_b.name, "pc", &key_b, None).map_err(|e| e.to_string())).unwrap();
        b.0.with_store(|s| sync::save_peer(s.conn(), &info_a.device_id, &info_a.name, "pc", &key_a, None).map_err(|e| e.to_string())).unwrap();
    }

    fn add_note(store: &Mutex<Store>, title: &str) {
        store
            .with_store(|s| {
                let id = focus_store::notes::create(s).map_err(|e| e.to_string())?.id;
                focus_store::notes::save(s, &id, title, "{}", title).map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();
    }

    fn note_titles(store: &Mutex<Store>) -> Vec<String> {
        store
            .with_store(|s| {
                let mut stmt = s.conn().prepare("SELECT title FROM notes ORDER BY title").unwrap();
                Ok(stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect())
            })
            .unwrap()
    }

    #[test]
    fn wrong_code_fails_on_both_sides() {
        let a = device("Laptop A");
        let b = device("Laptop B");
        let me_b = b.1.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let addr = serve(move |s| tx.send(pair_accept(s, "123456", &me_b)).unwrap());
        let err = pair_connect(addr, "654321", &a.1).unwrap_err();
        assert!(err.contains("didn't match"), "{err}");
        assert!(rx.recv().unwrap().is_err());
    }

    #[test]
    fn paired_devices_sync_both_ways_over_tcp() {
        let a = Arc::new(device("Laptop A"));
        let b = Arc::new(device("Laptop B"));
        pair(&a, &b);
        add_note(&a.0, "From A");
        add_note(&b.0, "From B");

        let b2 = b.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let addr = serve(move |s| tx.send(sync_accept(s, &b2.1, &b2.0, &|_| {})).unwrap());
        let peer_b = a.0.with_store(|s| Ok(sync::peers(s.conn()).unwrap().remove(0))).unwrap();
        let steps = Mutex::new(Vec::new());
        let out = sync_connect(addr, &peer_b, &a.1, &a.0, &|p| steps.lock().unwrap().push(p.stage)).unwrap();
        let out_b = rx.recv().unwrap().unwrap();
        assert_eq!(note_titles(&a.0), ["From A", "From B"]);
        assert_eq!(note_titles(&b.0), ["From A", "From B"]);
        assert!(out.sent > 0 && out.received.inserted > 0);
        assert_eq!(out_b.peer_name, "Laptop A");
        assert!(steps.lock().unwrap().contains(&"applying".to_string()));

        // A second sync has nothing to move.
        let b3 = b.clone();
        let addr = serve(move |s| {
            sync_accept(s, &b3.1, &b3.0, &|_| {}).unwrap();
        });
        let peer_b = a.0.with_store(|s| Ok(sync::peers(s.conn()).unwrap().remove(0))).unwrap();
        let again = sync_connect(addr, &peer_b, &a.1, &a.0, &|_| {}).unwrap();
        assert_eq!((again.sent, again.received.inserted + again.received.updated), (0, 0));
    }

    #[test]
    fn attached_files_follow_their_notes() {
        let a = Arc::new(device("Laptop A"));
        let b = Arc::new(device("Laptop B"));
        pair(&a, &b);
        // A file bigger than one message, so it goes in several pieces.
        let content: Vec<u8> = (0..(FILE_CHUNK * 2 + 1234)).map(|i| (i % 251) as u8).collect();
        let src = std::env::temp_dir().join(format!("focus-sync-src-{}", focus_store::ids::new_id()));
        std::fs::write(&src, &content).unwrap();
        let attachment = a
            .0
            .with_store(|s| {
                let note = focus_store::notes::create(s).map_err(|e| e.to_string())?.id;
                let dir = s.files_dir().unwrap().to_path_buf();
                let (sha, size) = attachments::ingest(&dir, &src).map_err(|e| e.to_string())?;
                attachments::add(s, &note, "slides.pptx", &sha, size).map_err(|e| e.to_string())
            })
            .unwrap();

        let b2 = b.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let addr = serve(move |s| tx.send(sync_accept(s, &b2.1, &b2.0, &|_| {})).unwrap());
        let peer_b = a.0.with_store(|s| Ok(sync::peers(s.conn()).unwrap().remove(0))).unwrap();
        let out = sync_connect(addr, &peer_b, &a.1, &a.0, &|_| {}).unwrap();
        let out_b = rx.recv().unwrap().unwrap();
        assert_eq!((out.files_sent, out_b.files_received), (1, 1));
        let (on_b, path) = b.0.with_store(|s| attachments::file_of(s, &attachment.id).map_err(|e| e.to_string())).unwrap();
        assert_eq!(on_b.name, "slides.pptx");
        assert_eq!(std::fs::read(path).unwrap(), content);
        std::fs::remove_file(src).ok();
    }

    #[test]
    fn a_stranger_cannot_sync() {
        let a = device("Laptop A");
        let b = Arc::new(device("Laptop B"));
        let stranger = device("Stranger");
        pair(&a, &b);
        let b2 = b.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let addr = serve(move |s| tx.send(sync_accept(s, &b2.1, &b2.0, &|_| {}).map(|_| ())).unwrap());
        // The stranger pretends to be A (it knows A's ID, not A's key).
        let peer_b = a.0.with_store(|s| Ok(sync::peers(s.conn()).unwrap().remove(0))).unwrap();
        assert!(sync_connect(addr, &peer_b, &stranger.1, &stranger.0, &|_| {}).is_err());
        assert!(rx.recv().unwrap().is_err());
    }

    use std::sync::Arc;
}
