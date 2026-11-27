//! Syncing Focus between your devices (Phase 9): two PCs, or a PC and the phone, on the same
//! Wi-Fi. No server and no cloud: the devices talk directly.
//!
//! - **Finding each other**: every few seconds each device says "here I am" by UDP broadcast
//!   (port 47812) and answers "who's there?" with a direct reply, so a phone that can't hear
//!   broadcasts still finds the PC. A device can also be reached by typing its address.
//! - **Pairing** (once): one device shows a 6-digit code, the other types it. SPAKE2 turns the
//!   code into a strong shared key without sending it, and a Noise XXpsk3 handshake keyed with
//!   it swaps the two devices' long-term keys. A wrong code fails the handshake; three wrong
//!   tries end the offer.
//! - **Syncing**: a Noise XX handshake (TCP port 47813) proves each side holds the key saved at
//!   pairing; everything after is encrypted (ChaCha20-Poly1305). Each side sends the rows the
//!   other doesn't have and applies what it gets (see `focus_store::sync`).

pub mod account;
mod discovery;
mod once;
mod service;
mod session;
mod wire;

use std::sync::Mutex;

use focus_store::Store;
use serde::{Deserialize, Serialize};

pub use account::{AccountDevice, AccountView, EmailSignIn, Firebase, Session};
pub use discovery::Nearby;
pub use once::sync_all_once;
pub use service::{Event, LastSync, PairOffer, Service, Status};
pub use session::{Outcome, PeerInfo, Progress};

/// Ports, fixed so nothing has to be set up on either device.
pub const UDP_PORT: u16 = 47812;
pub const TCP_PORT: u16 = 47813;
/// Bumped when devices of different versions could no longer understand each other.
pub const PROTOCOL: u32 = 1;

/// How the sync code reaches the database (the app wraps its own store in this).
pub trait StoreAccess: Send + Sync + 'static {
    fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String>;
}

impl StoreAccess for Mutex<Store> {
    fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.lock().map_err(|_| "database unavailable".to_string())?;
        f(&mut guard)
    }
}

/// This device, as other devices see it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub device_id: String,
    pub name: String,
    /// "pc" or "phone".
    pub kind: String,
    pub app_version: String,
    pub schema: i64,
    #[serde(skip)]
    pub private: Vec<u8>,
    #[serde(skip)]
    pub public: Vec<u8>,
}

const NOISE_SYNC: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";
const NOISE_PAIR: &str = "Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s";

/// Loads this device's sync identity, making its key pair the first time.
pub fn load_me(store: &mut Store, default_name: &str, kind: &str, app_version: &str) -> Result<Me, String> {
    let (private, public) = match focus_store::sync::identity(store).map_err(|e| e.to_string())? {
        Some(pair) => pair,
        None => {
            let builder = snow::Builder::new(NOISE_SYNC.parse().map_err(|e| format!("{e}"))?);
            let pair = builder.generate_keypair().map_err(|e| format!("{e}"))?;
            focus_store::sync::save_identity(store, &pair.private, &pair.public).map_err(|e| e.to_string())?;
            (pair.private, pair.public)
        }
    };
    let name = focus_store::sync::device_name(store).map_err(|e| e.to_string())?;
    let name = if name.trim().is_empty() { default_name.trim().to_string() } else { name };
    let schema = store.status().map_err(|e| e.to_string())?.schema_version;
    Ok(Me {
        device_id: store.device_id().to_string(),
        name: if name.is_empty() { "Kairos".into() } else { name },
        kind: kind.to_string(),
        app_version: app_version.to_string(),
        schema,
        private,
        public,
    })
}

/// A new 6-digit pairing code.
pub fn new_code() -> String {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).unwrap_or_default();
    format!("{:06}", u32::from_le_bytes(bytes) % 1_000_000)
}

/// The code as typed: digits only.
pub fn clean_code(code: &str) -> String {
    code.chars().filter(char::is_ascii_digit).collect()
}

/// This device's IPv4 addresses on the local network (to type on the other device).
pub fn local_addresses() -> Vec<String> {
    discovery::interfaces().into_iter().map(|(ip, _)| ip.to_string()).collect()
}
