//! Bytes on the connection: a short plain greeting, then Noise handshake messages, then
//! encrypted messages. Every frame is a 2-byte length and up to 65 535 bytes; a message
//! longer than one frame is spread over several.

use std::io::{Read, Write};
use std::net::TcpStream;

use serde::Serialize;
use serde::de::DeserializeOwned;
use snow::{HandshakeState, TransportState};

/// First bytes from the device that connects: "FOCUS", the protocol, and what it wants.
pub const MAGIC: &[u8; 5] = b"FOCUS";
pub const MODE_PAIR: u8 = b'P';
pub const MODE_SYNC: u8 = b'S';
/// The answering device's one-byte reply to the greeting.
pub const REPLY_OK: u8 = b'K';
pub const REPLY_BUSY: u8 = b'B';
pub const REPLY_NOT_PAIRING: u8 = b'N';

const MAX_FRAME: usize = 65_535;
const TAG: usize = 16;
const MAX_CHUNK: usize = MAX_FRAME - TAG;
/// Largest single message (a big first sync is sent in many smaller ones).
const MAX_MESSAGE: usize = 64 * 1024 * 1024;

pub type Result<T> = std::result::Result<T, String>;

pub fn io_err(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => "The other device stopped answering.".into(),
        std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted => {
            "The other device closed the connection.".into()
        }
        _ => format!("Connection problem: {e}"),
    }
}

pub fn write_frame(stream: &mut TcpStream, bytes: &[u8]) -> Result<()> {
    let len = u16::try_from(bytes.len()).map_err(|_| "frame too large".to_string())?;
    stream.write_all(&len.to_be_bytes()).map_err(io_err)?;
    stream.write_all(bytes).map_err(io_err)?;
    Ok(())
}

pub fn read_frame(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let mut len = [0u8; 2];
    stream.read_exact(&mut len).map_err(io_err)?;
    let mut buf = vec![0u8; u16::from_be_bytes(len) as usize];
    stream.read_exact(&mut buf).map_err(io_err)?;
    Ok(buf)
}

/// Writes the next handshake message (with an optional payload).
pub fn hs_write(stream: &mut TcpStream, hs: &mut HandshakeState, payload: &[u8]) -> Result<()> {
    let mut buf = vec![0u8; MAX_FRAME];
    let n = hs.write_message(payload, &mut buf).map_err(|e| format!("handshake: {e}"))?;
    write_frame(stream, &buf[..n])
}

/// Reads the next handshake message; a failure here usually means the wrong pairing code
/// or a device that isn't paired.
pub fn hs_read(stream: &mut TcpStream, hs: &mut HandshakeState) -> Result<Vec<u8>> {
    let frame = read_frame(stream)?;
    let mut buf = vec![0u8; MAX_FRAME];
    let n = hs.read_message(&frame, &mut buf).map_err(|_| "handshake failed".to_string())?;
    buf.truncate(n);
    Ok(buf)
}

/// An encrypted connection after the handshake.
pub struct Channel {
    pub stream: TcpStream,
    noise: TransportState,
    /// Bytes received in frames but not yet read as messages.
    pending: Vec<u8>,
}

impl Channel {
    pub fn new(stream: TcpStream, noise: TransportState) -> Self {
        Self { stream, noise, pending: Vec::new() }
    }

    pub fn send_bytes(&mut self, msg: &[u8]) -> Result<()> {
        if msg.len() > MAX_MESSAGE {
            return Err("message too large".into());
        }
        let mut plain = Vec::with_capacity(msg.len() + 4);
        plain.extend_from_slice(&(msg.len() as u32).to_be_bytes());
        plain.extend_from_slice(msg);
        let mut out = vec![0u8; MAX_FRAME];
        for chunk in plain.chunks(MAX_CHUNK) {
            let n = self.noise.write_message(chunk, &mut out).map_err(|e| format!("encrypt: {e}"))?;
            write_frame(&mut self.stream, &out[..n])?;
        }
        self.stream.flush().map_err(io_err)
    }

    pub fn recv_bytes(&mut self) -> Result<Vec<u8>> {
        self.fill(4)?;
        let len = u32::from_be_bytes([self.pending[0], self.pending[1], self.pending[2], self.pending[3]]) as usize;
        if len > MAX_MESSAGE {
            return Err("message too large".into());
        }
        self.fill(4 + len)?;
        let msg = self.pending[4..4 + len].to_vec();
        self.pending.drain(..4 + len);
        Ok(msg)
    }

    fn fill(&mut self, want: usize) -> Result<()> {
        let mut out = vec![0u8; MAX_FRAME];
        while self.pending.len() < want {
            let frame = read_frame(&mut self.stream)?;
            let n = self.noise.read_message(&frame, &mut out).map_err(|_| "a message was damaged on the way".to_string())?;
            self.pending.extend_from_slice(&out[..n]);
        }
        Ok(())
    }

    pub fn send<T: Serialize>(&mut self, msg: &T) -> Result<usize> {
        let bytes = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        self.send_bytes(&bytes)?;
        Ok(bytes.len())
    }

    pub fn recv<T: DeserializeOwned>(&mut self) -> Result<(T, usize)> {
        let bytes = self.recv_bytes()?;
        let msg = serde_json::from_slice(&bytes).map_err(|e| format!("unexpected message: {e}"))?;
        Ok((msg, bytes.len()))
    }
}
