//! The phone's background round (`sync_all_once`): with the app closed, a change made on the
//! phone reaches the PC and the PC's reaches the phone. Its own test binary, so it doesn't share
//! the sync port with the unit tests (cargo runs test binaries one after another).

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use focus_store::Store;
use focus_sync::{Service, StoreAccess, load_me, sync_all_once};

fn count_notes(store: &Mutex<Store>) -> i64 {
    store.with_store(|s| Ok(s.conn().query_row("SELECT count(*) FROM notes", [], |r| r.get(0)).unwrap())).unwrap()
}

#[test]
fn a_background_round_syncs_both_ways() {
    let pc_store = Arc::new(Mutex::new(Store::open_in_memory().unwrap()));
    let pc_me = pc_store.with_store(|s| load_me(s, "Laptop", "pc", "0.21.3")).unwrap();
    let pc = Service::start(pc_store.clone(), pc_me, |_| {}, true);

    let phone_store = Arc::new(Mutex::new(Store::open_in_memory().unwrap()));
    let phone_me = phone_store.with_store(|s| load_me(s, "Phone", "phone", "0.23.0")).unwrap();
    // Pair the way the phone app does (its service only calls out here).
    let phone_app = Service::start(phone_store.clone(), phone_me.clone(), |_| {}, false);
    thread::sleep(Duration::from_millis(200));
    let offer = pc.show_code();
    phone_app.pair("127.0.0.1", &offer.code).unwrap();
    thread::sleep(Duration::from_secs(1));

    // One note on each side.
    phone_store.with_store(|s| focus_store::notes::create(s).map(|_| ()).map_err(|e| e.to_string())).unwrap();
    pc_store.with_store(|s| focus_store::notes::create(s).map(|_| ()).map_err(|e| e.to_string())).unwrap();

    // A fresh store handle, as the background worker opens it.
    let results = sync_all_once(phone_store.as_ref(), &phone_me, Duration::from_millis(500));
    assert_eq!(results.len(), 1);
    assert!(results[0].1.is_ok(), "{:?}", results[0].1.as_ref().err());
    // The open phone app may have synced too; either way both sides now have both notes.
    assert_eq!(count_notes(&phone_store), 2);
    assert_eq!(count_notes(&pc_store), 2);
}
