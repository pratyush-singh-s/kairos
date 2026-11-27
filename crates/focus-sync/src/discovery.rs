//! Finding Focus on other devices of the same Wi-Fi: small UDP messages on port 47812.
//! "here" says who we are (broadcast every few seconds, and sent straight back to whoever
//! asks); "who" asks everyone to answer. Phones often drop broadcasts they receive, so a phone
//! asks "who" and hears the direct answers.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::UDP_PORT;

/// A Focus device seen on the network. Mirrored by `SyncNearby` in src/ipc/sync.ts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Nearby {
    pub device_id: String,
    pub name: String,
    pub kind: String,
    /// "192.168.1.20:47813"
    pub address: String,
    /// It is showing a pairing code right now.
    pub pairing: bool,
    /// Already paired with this device.
    pub paired: bool,
    #[serde(skip)]
    pub seen: Option<Instant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Packet {
    pub focus: u32,
    /// "here" or "who".
    pub t: String,
    pub id: String,
    pub name: String,
    pub kind: String,
    pub port: u16,
    #[serde(default)]
    pub pairing: bool,
}

/// This device's IPv4 addresses with their network's broadcast address.
pub fn interfaces() -> Vec<(Ipv4Addr, Ipv4Addr)> {
    let mut out = Vec::new();
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        if let if_addrs::IfAddr::V4(v4) = iface.addr {
            if v4.ip.is_loopback() || v4.ip.is_link_local() || v4.ip.is_unspecified() {
                continue;
            }
            let broadcast = v4.broadcast.unwrap_or_else(|| Ipv4Addr::from(u32::from(v4.ip) | !u32::from(v4.netmask)));
            out.push((v4.ip, broadcast));
        }
    }
    out
}

pub struct Discovery {
    socket: UdpSocket,
}

impl Discovery {
    /// Listens on the discovery port; if another program has it, still asks and hears replies.
    pub fn open() -> std::io::Result<Self> {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, UDP_PORT)).or_else(|_| UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)))?;
        socket.set_broadcast(true)?;
        socket.set_read_timeout(Some(Duration::from_millis(500)))?;
        Ok(Self { socket })
    }

    /// Sends `packet` to every network this device is on.
    pub fn broadcast(&self, packet: &Packet) {
        let Ok(bytes) = serde_json::to_vec(packet) else { return };
        let mut targets: Vec<Ipv4Addr> = interfaces().into_iter().map(|(_, b)| b).collect();
        targets.push(Ipv4Addr::BROADCAST);
        targets.dedup();
        for ip in targets {
            let _ = self.socket.send_to(&bytes, SocketAddrV4::new(ip, UDP_PORT));
        }
    }

    pub fn send_to(&self, packet: &Packet, to: SocketAddr) {
        if let Ok(bytes) = serde_json::to_vec(packet) {
            let _ = self.socket.send_to(&bytes, to);
        }
    }

    /// Waits briefly for one message. None on timeout or anything that isn't Focus.
    pub fn recv(&self) -> Option<(Packet, SocketAddr)> {
        let mut buf = [0u8; 2048];
        let (n, from) = self.socket.recv_from(&mut buf).ok()?;
        let packet: Packet = serde_json::from_slice(&buf[..n]).ok()?;
        (packet.focus == 1).then_some((packet, from))
    }
}
