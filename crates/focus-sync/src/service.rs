//! Sync running in the background while the app is open: answers other devices, finds them,
//! and syncs with paired ones a few seconds after something changes (and once a minute).

use std::collections::{HashMap, HashSet};
use std::net::{SocketAddr, TcpListener, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use focus_store::sync::{self, Peer};
use serde::Serialize;

use crate::account::{self, AccountPeer, AccountView, Firebase, Session};
use crate::discovery::{Discovery, Nearby, Packet};
use crate::session::{self, Outcome, PeerInfo, Progress};
use crate::wire;
use crate::{Me, StoreAccess, TCP_PORT, clean_code, new_code};

/// How long a pairing code works, and how many wrong tries it takes.
const CODE_LIFETIME_MS: u64 = 5 * 60 * 1000;
const CODE_TRIES: u32 = 3;
/// A device counts as nearby this long after its last "here".
const NEARBY_FOR: Duration = Duration::from_secs(20);
const ANNOUNCE_EVERY: Duration = Duration::from_secs(4);
/// Sync this soon after a change here, and at least this often while both are on.
const AFTER_CHANGE: Duration = Duration::from_secs(3);
const EVERY: Duration = Duration::from_secs(60);
const RETRY_AFTER: Duration = Duration::from_secs(20);
/// Retry a device that isn't heard on the network less often (it is probably switched off).
const RETRY_FAR: Duration = Duration::from_secs(60);

/// What the app is told about. It refreshes its Sync page on `Status`, shows `Progress`, and
/// reloads pages after `Synced` (whose report names the tables that changed).
#[derive(Debug, Clone)]
pub enum Event {
    Status,
    Progress(Progress),
    Synced(Outcome),
    Paired(PeerInfo),
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairOffer {
    /// Six digits.
    pub code: String,
    pub expires_at_ms: u64,
}

/// The last sync with a device. Mirrored by `SyncLast` in src/ipc/sync.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LastSync {
    pub at_ms: u64,
    pub ok: bool,
    /// The error, when it failed.
    pub message: String,
    pub sent: usize,
    pub received: usize,
    pub conflicts: usize,
    pub clock_skew_ms: i64,
    /// Attached files sent and received.
    pub files: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerView {
    #[serde(flatten)]
    pub peer: Peer,
    pub online: bool,
    pub last: Option<LastSync>,
}

/// Everything the Sync page shows. Mirrored by `SyncStatus` in src/ipc/sync.ts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub me: Me,
    pub addresses: Vec<String>,
    pub port: u16,
    pub peers: Vec<PeerView>,
    /// Devices nearby that aren't paired yet.
    pub nearby: Vec<Nearby>,
    pub offer: Option<PairOffer>,
    pub progress: Option<Progress>,
    /// Why other devices can't connect to this one (port taken ...); None = fine.
    pub listen_error: Option<String>,
    /// Pairing by Google account (None = not built into this release).
    pub account: Option<AccountView>,
}

struct Offer {
    code: String,
    expires_at_ms: u64,
    tries_left: u32,
}

#[derive(Default)]
struct State {
    nearby: HashMap<String, Nearby>,
    offer: Option<Offer>,
    busy: bool,
    progress: Option<Progress>,
    last: HashMap<String, LastSync>,
    /// Our highest row number after the last good sync with each device.
    sent_upto: HashMap<String, i64>,
    last_ok: HashMap<String, Instant>,
    next_try: HashMap<String, Instant>,
    want_now: HashSet<String>,
    listen_error: Option<String>,
}

/// Where pairing by Google account gets its Firebase sign-in (None = not signed in).
type SessionSource = Arc<dyn Fn() -> Result<Option<Session>, String> + Send + Sync>;

struct Account {
    firebase: Firebase,
    session: SessionSource,
    view: AccountView,
    /// Check again now (signed in, a stranger tried to sync, the Sync page opened ...).
    poke: bool,
    last_poke: Option<Instant>,
}

struct Shared<S> {
    store: Arc<S>,
    me: Mutex<Me>,
    events: Box<dyn Fn(Event) + Send + Sync>,
    state: Mutex<State>,
    account: Mutex<Option<Account>>,
}

pub struct Service<S: StoreAccess> {
    shared: Arc<Shared<S>>,
}

impl<S: StoreAccess> Clone for Service<S> {
    fn clone(&self) -> Self {
        Self { shared: self.shared.clone() }
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl<S: StoreAccess> Service<S> {
    /// Starts listening, finding devices and syncing. `listen` = false makes a device that only
    /// connects out (the tests use it to run two services on one machine).
    pub fn start(store: Arc<S>, me: Me, events: impl Fn(Event) + Send + Sync + 'static, listen: bool) -> Self {
        let shared = Arc::new(Shared {
            store,
            me: Mutex::new(me),
            events: Box::new(events),
            state: Mutex::new(State::default()),
            account: Mutex::new(None),
        });
        let service = Self { shared };
        if listen {
            let s = service.clone();
            thread::spawn(move || s.listen());
            let s = service.clone();
            thread::spawn(move || s.discover());
        }
        let s = service.clone();
        thread::spawn(move || s.auto_sync());
        service
    }

    fn me(&self) -> Me {
        self.shared.me.lock().map(|m| m.clone()).unwrap_or_else(|e| e.into_inner().clone())
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.shared.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn emit(&self, e: Event) {
        (self.shared.events)(e);
    }

    fn peers(&self) -> Vec<Peer> {
        self.shared.store.with_store(|s| sync::peers(s.conn()).map_err(|e| e.to_string())).unwrap_or_default()
    }

    pub fn status(&self) -> Status {
        let peers = self.peers();
        let paired: HashSet<String> = peers.iter().map(|p| p.device_id.clone()).collect();
        let st = self.state();
        let fresh = |n: &Nearby| n.seen.is_some_and(|t| t.elapsed() < NEARBY_FOR);
        let mut nearby: Vec<Nearby> = st
            .nearby
            .values()
            .filter(|n| fresh(n) && !paired.contains(&n.device_id))
            .cloned()
            .collect();
        nearby.sort_by(|a, b| a.name.cmp(&b.name));
        let now = now_ms();
        Status {
            me: self.me(),
            addresses: crate::local_addresses(),
            port: TCP_PORT,
            peers: peers
                .into_iter()
                .map(|p| PeerView {
                    online: st.nearby.get(&p.device_id).is_some_and(fresh)
                        || st.last_ok.get(&p.device_id).is_some_and(|t| t.elapsed() < EVERY + NEARBY_FOR),
                    last: st.last.get(&p.device_id).cloned(),
                    peer: p,
                })
                .collect(),
            nearby,
            offer: st
                .offer
                .as_ref()
                .filter(|o| o.expires_at_ms > now)
                .map(|o| PairOffer { code: o.code.clone(), expires_at_ms: o.expires_at_ms }),
            progress: st.progress.clone(),
            listen_error: st.listen_error.clone(),
            account: self.account_lock().as_ref().map(|a| a.view.clone()),
        }
    }

    pub fn set_name(&self, name: &str) -> Result<(), String> {
        self.shared.store.with_store(|s| sync::set_device_name(s, name).map_err(|e| e.to_string()))?;
        if let Ok(mut me) = self.shared.me.lock() {
            let n = name.trim();
            if !n.is_empty() {
                me.name = n.chars().take(60).collect();
            }
        }
        self.emit(Event::Status);
        Ok(())
    }

    /// Shows a new pairing code for another device to type.
    pub fn show_code(&self) -> PairOffer {
        let offer = Offer { code: new_code(), expires_at_ms: now_ms() + CODE_LIFETIME_MS, tries_left: CODE_TRIES };
        let shown = PairOffer { code: offer.code.clone(), expires_at_ms: offer.expires_at_ms };
        self.state().offer = Some(offer);
        self.emit(Event::Status);
        shown
    }

    pub fn cancel_code(&self) {
        self.state().offer = None;
        self.emit(Event::Status);
    }

    /// Pairs with the device at `address` ("192.168.1.20" or with ":port") showing `code`,
    /// then syncs with it straight away.
    pub fn pair(&self, address: &str, code: &str) -> Result<PeerInfo, String> {
        let code = clean_code(code);
        if code.len() != 6 {
            return Err("Type the 6-digit code shown on the other device.".into());
        }
        let addr = resolve(address)?;
        let me = self.me();
        let (info, key) = session::pair_connect(addr, &code, &me)?;
        if info.device_id == me.device_id {
            return Err("That's this device.".into());
        }
        let address = addr.to_string();
        self.shared.store.with_store(|s| {
            sync::save_peer(s.conn(), &info.device_id, &info.name, &info.kind, &key, Some(&address)).map_err(|e| e.to_string())?;
            account::set_skipped(s, &info.device_id, false)
        })?;
        self.state().want_now.insert(info.device_id.clone());
        self.emit(Event::Paired(info.clone()));
        self.emit(Event::Status);
        Ok(info)
    }

    /// Syncs with one paired device (or all) as soon as possible.
    pub fn sync_now(&self, device_id: Option<&str>) {
        let ids: Vec<String> = match device_id {
            Some(id) => vec![id.to_string()],
            None => self.peers().into_iter().map(|p| p.device_id).collect(),
        };
        let mut st = self.state();
        for id in ids {
            st.next_try.remove(&id);
            st.want_now.insert(id);
        }
    }

    /// Unpairs a device. Its data stays here; it just stops syncing.
    pub fn forget(&self, device_id: &str) -> Result<(), String> {
        self.shared.store.with_store(|s| {
            sync::forget_peer(s.conn(), device_id).map_err(|e| e.to_string())?;
            // A device of the same Google account would otherwise pair again by itself.
            account::set_skipped(s, device_id, true)
        })?;
        self.refresh_account_view();
        let mut st = self.state();
        st.last.remove(device_id);
        st.sent_upto.remove(device_id);
        drop(st);
        self.emit(Event::Status);
        Ok(())
    }

    // ------------------------------------------------------------ pairing by Google account

    fn account_lock(&self) -> std::sync::MutexGuard<'_, Option<Account>> {
        self.shared.account.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Turns on pairing by Google account. `session` gives the current Firebase sign-in
    /// (Ok(None) = not signed in); it is called from a background thread.
    pub fn start_account(&self, firebase: Firebase, session: impl Fn() -> Result<Option<Session>, String> + Send + Sync + 'static) {
        *self.account_lock() = Some(Account { firebase, session: Arc::new(session), view: AccountView::default(), poke: true, last_poke: None });
        let s = self.clone();
        thread::spawn(move || s.account_loop());
    }

    /// Checks the account's devices soon (at most every 15 s when asked by a stranger).
    pub fn account_poke(&self) {
        if let Some(a) = self.account_lock().as_mut() {
            a.poke = true;
        }
    }

    /// Before signing out: takes this device off the account's list, and stops pairing by account.
    pub fn account_leave(&self) {
        let (firebase, session) = {
            let lock = self.account_lock();
            let Some(a) = lock.as_ref() else { return };
            (a.firebase.clone(), a.session.clone())
        };
        if let Ok(Some(session)) = session() {
            let _ = account::check_out(&firebase, &session, &self.me().device_id);
        }
        if let Some(a) = self.account_lock().as_mut() {
            a.view = AccountView::default();
        }
        self.emit(Event::Status);
    }

    /// "Pair again" for an account device that was forgotten here.
    pub fn account_allow(&self, device_id: &str) -> Result<(), String> {
        self.shared.store.with_store(|s| account::set_skipped(s, device_id, false))?;
        self.refresh_account_view();
        self.account_poke();
        self.emit(Event::Status);
        Ok(())
    }

    fn account_loop(&self) {
        const EVERY_CHECK: Duration = Duration::from_secs(5 * 60);
        const POKE_GAP: Duration = Duration::from_secs(15);
        let mut last: Option<Instant> = None;
        loop {
            let due = {
                let mut lock = self.account_lock();
                let Some(a) = lock.as_mut() else { return };
                let poked = a.poke && a.last_poke.is_none_or(|t| t.elapsed() >= POKE_GAP);
                if poked {
                    a.poke = false;
                    a.last_poke = Some(Instant::now());
                }
                poked || last.is_none_or(|t| t.elapsed() >= EVERY_CHECK)
            };
            if due {
                last = Some(Instant::now());
                self.account_check();
            }
            thread::sleep(Duration::from_millis(1000));
        }
    }

    /// One check: say we're here, then pair with the account's other devices.
    fn account_check(&self) {
        let (firebase, session) = {
            let lock = self.account_lock();
            let Some(a) = lock.as_ref() else { return };
            (a.firebase.clone(), a.session.clone())
        };
        let me = self.me();
        let result = session().and_then(|s| match s {
            None => Ok(None),
            Some(s) => {
                let addresses: Vec<String> = crate::local_addresses().into_iter().map(|ip| format!("{ip}:{TCP_PORT}")).collect();
                account::check_in(&firebase, &s, &me, &addresses).map(|list| Some((s.email, list)))
            }
        });
        let mut view = AccountView::default();
        match result {
            Ok(None) => {}
            Ok(Some((email, list))) => {
                view.email = email;
                view.checked_at_ms = now_ms();
                let others: Vec<_> = list.into_iter().filter(|d| d.device_id != me.device_id).collect();
                self.link(&others);
                view.devices = self.account_peers(&others);
            }
            Err(e) => {
                let lock = self.account_lock();
                if let Some(a) = lock.as_ref() {
                    view = a.view.clone();
                }
                view.error = Some(e);
            }
        }
        let changed = {
            let mut lock = self.account_lock();
            let Some(a) = lock.as_mut() else { return };
            let changed = a.view.email != view.email || a.view.devices != view.devices || a.view.error != view.error;
            a.view = view;
            changed
        };
        if changed {
            self.emit(Event::Status);
        }
    }

    fn account_peers(&self, devices: &[account::AccountDevice]) -> Vec<AccountPeer> {
        let skipped = self.shared.store.with_store(|s| Ok(account::skipped(s))).unwrap_or_default();
        devices
            .iter()
            .map(|d| AccountPeer { device_id: d.device_id.clone(), name: d.name.clone(), kind: d.kind.clone(), skipped: skipped.contains(&d.device_id) })
            .collect()
    }

    fn refresh_account_view(&self) {
        let skipped = self.shared.store.with_store(|s| Ok(account::skipped(s))).unwrap_or_default();
        if let Some(a) = self.account_lock().as_mut() {
            for d in &mut a.view.devices {
                d.skipped = skipped.contains(&d.device_id);
            }
        }
    }

    /// Saves the account's devices as paired (unless forgotten here) and syncs with new ones.
    /// Returns how many were newly paired.
    pub fn link(&self, devices: &[account::AccountDevice]) -> usize {
        let me = self.me();
        let mut added = Vec::new();
        let result = self.shared.store.with_store(|s| {
            let skipped = account::skipped(s);
            for d in devices {
                if d.device_id == me.device_id || skipped.contains(&d.device_id) {
                    continue;
                }
                let known = sync::peer(s.conn(), &d.device_id).map_err(|e| e.to_string())?;
                let address = d.addresses.first().map(String::as_str);
                match known {
                    Some(p) if p.public_key == d.public_key => {
                        if p.address.is_none() {
                            if let Some(a) = address {
                                sync::set_peer_address(s.conn(), &d.device_id, a).map_err(|e| e.to_string())?;
                            }
                        }
                    }
                    _ => {
                        sync::save_peer(s.conn(), &d.device_id, &d.name, &d.kind, &d.public_key, address).map_err(|e| e.to_string())?;
                        added.push(PeerInfo { device_id: d.device_id.clone(), name: d.name.clone(), kind: d.kind.clone() });
                    }
                }
            }
            Ok(())
        });
        if result.is_err() {
            return 0;
        }
        let n = added.len();
        for info in added {
            self.state().want_now.insert(info.device_id.clone());
            self.emit(Event::Paired(info));
        }
        if n > 0 {
            self.emit(Event::Status);
        }
        n
    }

    // ------------------------------------------------------------ threads

    fn listen(&self) {
        let listener = match TcpListener::bind(("0.0.0.0", TCP_PORT)) {
            Ok(l) => l,
            Err(e) => {
                self.state().listen_error = Some(format!("Other devices can't connect to this one (port {TCP_PORT}: {e})."));
                self.emit(Event::Status);
                return;
            }
        };
        for stream in listener.incoming().flatten() {
            let s = self.clone();
            thread::spawn(move || s.answer(stream));
        }
    }

    fn answer(&self, mut stream: std::net::TcpStream) {
        let Ok(Some(mode)) = session::read_greeting(&mut stream) else { return };
        let me = self.me();
        match mode {
            wire::MODE_PAIR => {
                let code = {
                    let st = self.state();
                    st.offer.as_ref().filter(|o| o.expires_at_ms > now_ms() && o.tries_left > 0).map(|o| o.code.clone())
                };
                let Some(code) = code else {
                    let _ = session::reply(&mut stream, wire::REPLY_NOT_PAIRING);
                    return;
                };
                if session::reply(&mut stream, wire::REPLY_OK).is_err() {
                    return;
                }
                let address = stream.peer_addr().ok().map(|a| SocketAddr::new(a.ip(), TCP_PORT).to_string());
                match session::pair_accept(stream, &code, &me) {
                    Ok((info, key)) => {
                        let saved = self.shared.store.with_store(|s| {
                            sync::save_peer(s.conn(), &info.device_id, &info.name, &info.kind, &key, address.as_deref())
                                .map_err(|e| e.to_string())?;
                            account::set_skipped(s, &info.device_id, false)
                        });
                        if saved.is_ok() {
                            self.state().offer = None;
                            self.emit(Event::Paired(info));
                        }
                    }
                    Err(_) => {
                        let mut st = self.state();
                        if let Some(o) = st.offer.as_mut() {
                            o.tries_left = o.tries_left.saturating_sub(1);
                            if o.tries_left == 0 {
                                st.offer = None;
                            }
                        }
                    }
                }
                self.emit(Event::Status);
            }
            wire::MODE_SYNC => {
                if !self.claim() {
                    let _ = session::reply(&mut stream, wire::REPLY_BUSY);
                    return;
                }
                let result = session::reply(&mut stream, wire::REPLY_OK)
                    .and_then(|_| session::sync_accept(stream, &me, self.shared.store.as_ref(), &self.progress_sink()));
                if result.as_ref().is_err_and(|e| e == session::NOT_PAIRED) {
                    // Maybe a device of the same Google account that just signed in.
                    self.account_poke();
                }
                self.finish(None, result);
            }
            _ => {}
        }
    }

    /// Takes the one sync slot; false if a sync is already running.
    fn claim(&self) -> bool {
        let mut st = self.state();
        if st.busy {
            return false;
        }
        st.busy = true;
        true
    }

    fn progress_sink(&self) -> impl Fn(Progress) + '_ {
        let last = Mutex::new((Instant::now() - Duration::from_secs(1), String::new()));
        move |p: Progress| {
            self.state().progress = Some(p.clone());
            let mut l = last.lock().unwrap_or_else(|e| e.into_inner());
            let done = p.rows_done == p.rows_total;
            if l.0.elapsed() >= Duration::from_millis(100) || l.1 != p.stage || done {
                *l = (Instant::now(), p.stage.clone());
                self.emit(Event::Progress(p));
            }
        }
    }

    /// Records how a sync went and frees the slot. `peer` = the device we called (None when it
    /// called us; then the outcome names it).
    fn finish(&self, peer: Option<&str>, result: Result<Outcome, String>) {
        let mut st = self.state();
        st.busy = false;
        st.progress = None;
        let outcome = match result {
            Ok(o) => {
                st.last.insert(
                    o.peer_id.clone(),
                    LastSync {
                        at_ms: now_ms(),
                        ok: true,
                        message: String::new(),
                        sent: o.sent,
                        received: o.received.inserted + o.received.updated,
                        conflicts: o.received.conflicts,
                        clock_skew_ms: o.clock_skew_ms,
                        files: o.files_sent + o.files_received,
                    },
                );
                st.sent_upto.insert(o.peer_id.clone(), o.local_upto);
                st.last_ok.insert(o.peer_id.clone(), Instant::now());
                st.next_try.insert(o.peer_id.clone(), Instant::now() + AFTER_CHANGE);
                Some(o)
            }
            Err(message) if message == session::BUSY => {
                // Both devices called each other at once: the one with the smaller ID tries
                // again first, so they don't keep colliding.
                if let Some(id) = peer {
                    let first = self.me().device_id.as_str() < id;
                    let wait = Duration::from_millis(if first { 1500 } else { 5000 } + now_ms() % 1000);
                    st.next_try.insert(id.to_string(), Instant::now() + wait);
                }
                None
            }
            Err(message) => {
                if let Some(id) = peer {
                    let skew = st.last.get(id).map(|l| l.clock_skew_ms).unwrap_or(0);
                    st.last.insert(
                        id.to_string(),
                        LastSync { at_ms: now_ms(), ok: false, message, sent: 0, received: 0, conflicts: 0, clock_skew_ms: skew, files: 0 },
                    );
                    let jitter = Duration::from_millis(now_ms() % 3000);
                    let near = st.nearby.get(id).is_some_and(|n| n.seen.is_some_and(|t| t.elapsed() < NEARBY_FOR));
                    let wait = if near { RETRY_AFTER } else { RETRY_FAR };
                    st.next_try.insert(id.to_string(), Instant::now() + wait + jitter);
                }
                None
            }
        };
        drop(st);
        if let Some(o) = outcome {
            self.emit(Event::Synced(o));
        }
        self.emit(Event::Status);
    }

    fn discover(&self) {
        let disco = match Discovery::open() {
            Ok(d) => d,
            Err(_) => return,
        };
        let packet = |t: &str, me: &Me, pairing: bool| Packet {
            focus: 1,
            t: t.into(),
            id: me.device_id.clone(),
            name: me.name.clone(),
            kind: me.kind.clone(),
            port: TCP_PORT,
            pairing,
        };
        let mut last_announce = Instant::now() - ANNOUNCE_EVERY;
        let mut asked = false;
        loop {
            let me = self.me();
            let pairing = self.state().offer.as_ref().is_some_and(|o| o.expires_at_ms > now_ms());
            if last_announce.elapsed() >= ANNOUNCE_EVERY {
                disco.broadcast(&packet("here", &me, pairing));
                if !asked {
                    disco.broadcast(&packet("who", &me, pairing));
                    asked = true;
                }
                last_announce = Instant::now();
            }
            let Some((p, from)) = disco.recv() else { continue };
            if p.id == me.device_id {
                continue;
            }
            if p.t == "who" {
                disco.send_to(&packet("here", &me, pairing), from);
            }
            let address = SocketAddr::new(from.ip(), p.port).to_string();
            let mut st = self.state();
            let changed = st.nearby.get(&p.id).is_none_or(|n| {
                n.address != address || n.pairing != p.pairing || n.name != p.name || n.seen.is_none_or(|t| t.elapsed() >= NEARBY_FOR)
            });
            st.nearby.insert(
                p.id.clone(),
                Nearby { device_id: p.id, name: p.name, kind: p.kind, address, pairing: p.pairing, paired: false, seen: Some(Instant::now()) },
            );
            drop(st);
            if changed {
                self.emit(Event::Status);
            }
        }
    }

    fn auto_sync(&self) {
        let mut was_online: HashSet<String> = HashSet::new();
        loop {
            thread::sleep(Duration::from_millis(1000));
            let peers = self.peers();
            let local_upto = self.shared.store.with_store(|s| sync::local_upto(s.conn()).map_err(|e| e.to_string())).unwrap_or(0);
            let mut online_now = HashSet::new();
            let mut pick: Option<(Peer, SocketAddr)> = None;
            {
                let mut st = self.state();
                for p in &peers {
                    let near = st.nearby.get(&p.device_id).filter(|n| n.seen.is_some_and(|t| t.elapsed() < NEARBY_FOR));
                    if near.is_some() {
                        online_now.insert(p.device_id.clone());
                    }
                    let wanted = st.want_now.contains(&p.device_id);
                    // Not heard on the network (some Wi-Fi drops broadcasts): try where it was last.
                    let addr = near.map(|n| n.address.clone()).or_else(|| p.address.clone());
                    let Some(addr) = addr.and_then(|a| a.parse::<SocketAddr>().ok()) else {
                        st.want_now.remove(&p.device_id);
                        continue;
                    };
                    let waiting = st.next_try.get(&p.device_id).is_some_and(|t| Instant::now() < *t);
                    let changed = st.sent_upto.get(&p.device_id).is_none_or(|u| local_upto > *u);
                    let stale = st.last_ok.get(&p.device_id).is_none_or(|t| t.elapsed() >= EVERY);
                    if wanted || (!waiting && (changed || stale)) {
                        pick = Some((p.clone(), addr));
                        break;
                    }
                }
            }
            if online_now != was_online {
                was_online = online_now;
                self.emit(Event::Status);
            }
            let Some((peer, addr)) = pick else { continue };
            if !self.claim() {
                continue;
            }
            self.state().want_now.remove(&peer.device_id);
            let me = self.me();
            self.emit(Event::Progress(Progress {
                peer_id: peer.device_id.clone(),
                peer_name: peer.name.clone(),
                stage: "connecting".into(),
                rows_done: 0,
                rows_total: 0,
                bytes_done: 0,
                bytes_total: 0,
                file_name: None,
            }));
            let result = session::sync_connect(addr, &peer, &me, self.shared.store.as_ref(), &self.progress_sink());
            self.finish(Some(&peer.device_id), result);
        }
    }
}

/// "192.168.1.20", "192.168.1.20:47813" or a PC name.
fn resolve(address: &str) -> Result<SocketAddr, String> {
    let a = address.trim();
    if a.is_empty() {
        return Err("Type the other device's address.".into());
    }
    let with_port = if a.contains(':') { a.to_string() } else { format!("{a}:{TCP_PORT}") };
    with_port
        .to_socket_addrs()
        .ok()
        .and_then(|mut it| it.find(SocketAddr::is_ipv4))
        .ok_or_else(|| format!("\"{a}\" isn't an address Kairos can reach."))
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use focus_store::Store;

    use super::*;
    use crate::load_me;

    #[test]
    fn devices_of_the_same_account_pair_unless_forgotten() {
        let store = Arc::new(Mutex::new(Store::open_in_memory().unwrap()));
        let me = store.with_store(|s| load_me(s, "PC", "pc", "1")).unwrap();
        let service = Service::start(store.clone(), me.clone(), |_| {}, false);
        let phone = account::AccountDevice {
            device_id: "phone-1".into(),
            name: "Phone".into(),
            kind: "phone".into(),
            public_key: vec![7; 32],
            addresses: vec!["192.168.1.9:47813".into()],
            last_seen: String::new(),
        };
        let mine = account::AccountDevice { device_id: me.device_id.clone(), public_key: me.public.clone(), ..phone.clone() };
        assert_eq!(service.link(&[mine.clone(), phone.clone()]), 1);
        let peers = store.with_store(|s| sync::peers(s.conn()).map_err(|e| e.to_string())).unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].public_key, vec![7; 32]);
        assert_eq!(peers[0].address.as_deref(), Some("192.168.1.9:47813"));
        // Already paired: nothing new.
        assert_eq!(service.link(&[phone.clone()]), 0);
        // Forgotten here: not paired again by itself.
        service.forget("phone-1").unwrap();
        assert_eq!(service.link(&[phone.clone()]), 0);
        assert!(store.with_store(|s| sync::peers(s.conn()).map_err(|e| e.to_string())).unwrap().is_empty());
        // A reinstalled phone (new key) that wasn't forgotten pairs again.
        store.with_store(|s| account::set_skipped(s, "phone-1", false)).unwrap();
        assert_eq!(service.link(&[account::AccountDevice { public_key: vec![9; 32], ..phone }]), 1);
    }

    #[test]
    fn pair_by_code_then_changes_sync_on_their_own() {
        let device = |name: &str| {
            let mut store = Store::open_in_memory().unwrap();
            let me = load_me(&mut store, name, "pc", "0.21.0").unwrap();
            (Arc::new(Mutex::new(store)), me)
        };
        let (store_a, me_a) = device("Laptop A");
        let (store_b, me_b) = device("Phone");
        let (tx, rx) = mpsc::channel::<String>();
        let tx_b = Mutex::new(tx);
        // B listens on the real port; A only calls out.
        let b = Service::start(store_b.clone(), me_b, move |e| {
            if let Event::Synced(o) = e {
                let _ = tx_b.lock().unwrap().send(o.peer_name);
            }
        }, true);
        let a = Service::start(store_a.clone(), me_a, |_| {}, false);
        thread::sleep(Duration::from_millis(200));

        assert!(a.pair("127.0.0.1", "000000").unwrap_err().contains("isn't showing"));
        let offer = b.show_code();
        let info = a.pair("127.0.0.1", &format!("{} {}", &offer.code[..3], &offer.code[3..])).unwrap();
        assert_eq!(info.name, "Phone");
        // B finishes its side of the handshake a moment after A's call returns.
        let settled = std::time::Instant::now() + Duration::from_secs(3);
        while (b.status().offer.is_some() || b.status().peers.is_empty()) && std::time::Instant::now() < settled {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(b.status().offer.is_none(), "the code is used up");
        assert_eq!(b.status().peers.len(), 1);
        // On one machine A's address would be B's own; on a network each knows the other's.
        store_b.with_store(|s| Ok(s.conn().execute("UPDATE peers SET address = NULL", []).unwrap())).unwrap();
        // A syncs with B right after pairing.
        let got = rx.recv_timeout(Duration::from_secs(10));
        assert_eq!(got.as_deref(), Ok("Laptop A"), "{:?} / {:?}", a.status().peers, b.status().peers);

        // A note made on A reaches B a few seconds later, with nobody pressing anything.
        store_a
            .with_store(|s| focus_store::notes::create(s).map(|_| ()).map_err(|e| e.to_string()))
            .unwrap();
        rx.recv_timeout(Duration::from_secs(15)).unwrap();
        let notes: i64 = store_b.with_store(|s| Ok(s.conn().query_row("SELECT count(*) FROM notes", [], |r| r.get(0)).unwrap())).unwrap();
        assert_eq!(notes, 1);
        let last = a.status().peers[0].last.clone().unwrap();
        assert!(last.ok && last.sent >= 1, "{last:?}");
    }
}
