//! One round of syncing, for a phone woken in the background (Android's WorkManager) with no
//! app running to keep a `Service` going: ask who's on the Wi-Fi, sync with each paired device
//! once, and return.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use focus_store::sync;

use crate::discovery::{Discovery, Packet};
use crate::session::{self, Outcome};
use crate::{Me, StoreAccess, TCP_PORT};

/// Asks "who's there?" for `listen_for`, then syncs with every paired device it can reach
/// (where it answered from, or where it was last). Returns each device's name and result.
pub fn sync_all_once<S: StoreAccess>(store: &S, me: &Me, listen_for: Duration) -> Vec<(String, Result<Outcome, String>)> {
    let peers = store.with_store(|s| sync::peers(s.conn()).map_err(|e| e.to_string())).unwrap_or_default();
    if peers.is_empty() {
        return Vec::new();
    }
    let found = find(me, listen_for);
    peers
        .into_iter()
        .map(|peer| {
            let addr = found.get(&peer.device_id).copied().or_else(|| peer.address.as_deref().and_then(|a| a.parse().ok()));
            let result = match addr {
                Some(addr) => session::sync_connect(addr, &peer, me, store, &|_| {}),
                None => Err("not found on this network".to_string()),
            };
            (peer.name, result)
        })
        .collect()
}

/// Devices that answered "who" within `listen_for`: device ID → sync address.
fn find(me: &Me, listen_for: Duration) -> HashMap<String, SocketAddr> {
    let mut found = HashMap::new();
    let Ok(disco) = Discovery::open() else { return found };
    let who = Packet {
        focus: 1,
        t: "who".into(),
        id: me.device_id.clone(),
        name: me.name.clone(),
        kind: me.kind.clone(),
        port: TCP_PORT,
        pairing: false,
    };
    let until = Instant::now() + listen_for;
    let mut asked_at = Instant::now() - Duration::from_secs(10);
    while Instant::now() < until {
        // Ask again now and then: one broadcast can be lost.
        if asked_at.elapsed() >= Duration::from_millis(700) {
            disco.broadcast(&who);
            asked_at = Instant::now();
        }
        if let Some((p, from)) = disco.recv()
            && p.id != me.device_id
            && p.t == "here"
        {
            found.insert(p.id, SocketAddr::new(from.ip(), p.port));
        }
    }
    found
}
