//! Pause, Resume, Skip and Stop pressed on one device for the timer running on another (the
//! laptop's timer from the phone, or the phone's from the laptop). The command travels as the
//! synced setting `focus.remote`; the device it names applies it once (it remembers the last
//! one in the local `focus.remoteDone`) and its timer change comes back the usual way
//! (`focus.live` / `focus.livePhone`).

use serde::{Deserialize, Serialize};

use crate::Store;
use crate::error::Result;
use crate::settings;

/// A command older than this is dropped (the other device was off when it was sent).
pub const FRESH_FOR_MS: u64 = 10 * 60 * 1000;

pub const ACTIONS: &[&str] = &["pause", "resume", "skip", "stop"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommand {
    pub id: String,
    /// The device whose timer it is for (`LiveClock::device_id`).
    pub target: String,
    /// pause | resume | skip | stop
    pub action: String,
    pub at_ms: u64,
}

/// Sends `action` to the timer on device `target`.
pub fn send(store: &mut Store, target: &str, action: &str, now_ms: u64) -> Result<()> {
    if !ACTIONS.contains(&action) {
        return Err(crate::error::StoreError::Invalid(format!("unknown timer action {action:?}")));
    }
    let id = format!("{}-{}-{}", store.device_id(), now_ms, action);
    let cmd = RemoteCommand { id, target: target.to_string(), action: action.to_string(), at_ms: now_ms };
    settings::set(store, "focus.remote", &Some(cmd))
}

/// The command waiting for this device, if there is a new one, marked as done. The caller
/// applies it.
pub fn take(store: &mut Store, now_ms: u64) -> Result<Option<String>> {
    let cmd: Option<RemoteCommand> = serde_json::from_value(settings::get(store, "focus.remote")?).ok().flatten();
    let Some(cmd) = cmd else { return Ok(None) };
    if cmd.target != store.device_id() {
        return Ok(None);
    }
    let done: String = settings::get(store, "focus.remoteDone")?;
    if done == cmd.id {
        return Ok(None);
    }
    settings::set(store, "focus.remoteDone", &cmd.id)?;
    let fresh = now_ms.saturating_sub(cmd.at_ms) < FRESH_FOR_MS && cmd.at_ms <= now_ms + FRESH_FOR_MS;
    Ok(fresh.then_some(cmd.action))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_is_applied_once_and_only_by_its_device() {
        let mut store = Store::open_in_memory().unwrap();
        let me = store.device_id().to_string();
        send(&mut store, "someone-else", "pause", 1_000).unwrap();
        assert_eq!(take(&mut store, 2_000).unwrap(), None);
        send(&mut store, &me, "stop", 3_000).unwrap();
        assert_eq!(take(&mut store, 4_000).unwrap().as_deref(), Some("stop"));
        assert_eq!(take(&mut store, 5_000).unwrap(), None, "only once");
        send(&mut store, &me, "pause", 6_000).unwrap();
        assert_eq!(take(&mut store, 6_000 + FRESH_FOR_MS + 1).unwrap(), None, "too old");
        assert!(send(&mut store, &me, "explode", 7_000).is_err());
        assert!(settings::LOCAL_ONLY.contains(&"focus.remoteDone"));
        assert!(!settings::LOCAL_ONLY.contains(&"focus.remote"));
    }
}
