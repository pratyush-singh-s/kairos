//! Hybrid logical clock (HLC).
//!
//! Each change gets a stamp `"<wall ms, 13 digits>-<counter, 5 digits>-<device id>"`.
//! Stamps compare correctly as plain strings, keep moving forward even if the PC clock
//! jumps back, and stay ahead of any stamp received from the other PC. Last-write-wins
//! merging compares these stamps.

use std::cmp::max;

use crate::error::{Result, StoreError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Stamp {
    pub wall_ms: u64,
    pub counter: u32,
}

const MAX_COUNTER: u32 = 99_999;

#[derive(Debug, Clone)]
pub struct HybridClock {
    device_id: String,
    last: Stamp,
}

impl HybridClock {
    pub fn new(device_id: impl Into<String>) -> Self {
        Self { device_id: device_id.into(), last: Stamp { wall_ms: 0, counter: 0 } }
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// Stamp for a local change made at `now_ms` (the PC's wall clock).
    pub fn tick(&mut self, now_ms: u64) -> String {
        self.last = if now_ms > self.last.wall_ms {
            Stamp { wall_ms: now_ms, counter: 0 }
        } else {
            self.bump(self.last)
        };
        self.format(self.last)
    }

    /// Advance past a stamp received from another PC, so later local changes sort after it.
    pub fn observe(&mut self, remote: &str, now_ms: u64) -> Result<()> {
        let r = parse(remote)?;
        let wall = max(max(now_ms, self.last.wall_ms), r.wall_ms);
        self.last = if wall == self.last.wall_ms && wall == r.wall_ms {
            self.bump(Stamp { wall_ms: wall, counter: max(self.last.counter, r.counter) })
        } else if wall == self.last.wall_ms {
            self.bump(self.last)
        } else if wall == r.wall_ms {
            self.bump(r)
        } else {
            Stamp { wall_ms: wall, counter: 0 }
        };
        Ok(())
    }

    fn bump(&self, s: Stamp) -> Stamp {
        if s.counter >= MAX_COUNTER {
            // Extremely unlikely (100k changes in one millisecond): borrow the next millisecond.
            Stamp { wall_ms: s.wall_ms + 1, counter: 0 }
        } else {
            Stamp { wall_ms: s.wall_ms, counter: s.counter + 1 }
        }
    }

    fn format(&self, s: Stamp) -> String {
        format!("{:013}-{:05}-{}", s.wall_ms, s.counter, self.device_id)
    }
}

/// Reads the time part of a stamp.
pub fn parse(stamp: &str) -> Result<Stamp> {
    let mut parts = stamp.splitn(3, '-');
    let wall = parts.next().and_then(|p| p.parse::<u64>().ok());
    let counter = parts.next().and_then(|p| p.parse::<u32>().ok());
    let device = parts.next();
    match (wall, counter, device) {
        (Some(wall_ms), Some(counter), Some(d)) if !d.is_empty() => Ok(Stamp { wall_ms, counter }),
        _ => Err(StoreError::Invalid(format!("not a clock stamp: {stamp:?}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_increase_with_time() {
        let mut c = HybridClock::new("pc1");
        let a = c.tick(1_000);
        let b = c.tick(2_000);
        assert!(a < b);
        assert_eq!(b, "0000000002000-00000-pc1");
    }

    #[test]
    fn same_millisecond_uses_the_counter() {
        let mut c = HybridClock::new("pc1");
        let a = c.tick(5_000);
        let b = c.tick(5_000);
        assert!(a < b);
        assert_eq!(b, "0000000005000-00001-pc1");
    }

    #[test]
    fn clock_going_backwards_still_moves_forward() {
        let mut c = HybridClock::new("pc1");
        let a = c.tick(10_000);
        let b = c.tick(4_000); // PC clock was set back
        assert!(a < b);
    }

    #[test]
    fn observing_a_remote_stamp_keeps_local_changes_after_it() {
        let mut pc1 = HybridClock::new("pc1");
        let mut pc2 = HybridClock::new("pc2");
        let remote = pc2.tick(50_000); // pc2's clock runs ahead
        pc1.observe(&remote, 20_000).unwrap();
        let local = pc1.tick(20_001);
        assert!(parse(&local).unwrap() > parse(&remote).unwrap());
    }

    #[test]
    fn rejects_malformed_stamps() {
        assert!(parse("hello").is_err());
        assert!(parse("123-abc-pc1").is_err());
        assert!(parse("0000000001000-00000-").is_err());
    }
}
