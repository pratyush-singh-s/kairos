//! Gentle chimes for timer events, made in code (no sound files, nothing copied from other apps).
//! Each chime is a few soft bell tones: a pure tone with a little warmth, a slow fade-in so it never
//! clicks, and a long natural fade-out. Played through Windows' PlaySound, so it works while the
//! Focus window is hidden.

use std::f32::consts::TAU;

const RATE: u32 = 44_100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Chime {
    /// Focus session finished: three falling notes, "time to rest".
    ToBreak,
    /// Break finished: three rising notes, "back to it".
    ToFocus,
    /// Whole run finished: a slower four-note rise.
    Finished,
}

/// (frequency in Hz, start in seconds)
fn notes(chime: Chime) -> &'static [(f32, f32)] {
    // G5 E5 C5 / C5 E5 G5 / C5 E5 G5 C6 — a C major chord, the calmest choice.
    match chime {
        Chime::ToBreak => &[(783.99, 0.0), (659.25, 0.28), (523.25, 0.56)],
        Chime::ToFocus => &[(523.25, 0.0), (659.25, 0.24), (783.99, 0.48)],
        Chime::Finished => &[(523.25, 0.0), (659.25, 0.32), (783.99, 0.64), (1046.5, 0.96)],
    }
}

/// Renders the chime as a 16-bit mono WAV file in memory. `volume` is 0–100.
pub fn render_wav(chime: Chime, volume: u8) -> Vec<u8> {
    let notes = notes(chime);
    let ring = 2.2_f32; // seconds each note rings for
    let total = notes.last().map_or(0.0, |n| n.1) + ring;
    let len = (total * RATE as f32) as usize;
    let mut mix = vec![0.0_f32; len];
    for &(freq, start) in notes {
        let offset = (start * RATE as f32) as usize;
        for i in 0..((ring * RATE as f32) as usize) {
            let t = i as f32 / RATE as f32;
            let attack = (t / 0.012).min(1.0); // 12 ms fade-in: no click
            let decay = (-t * 2.6).exp(); // natural bell fade
            let tail = ((ring - t) / 0.3).clamp(0.0, 1.0); // reach exact silence at the end
            let tone = (TAU * freq * t).sin() + 0.18 * (TAU * 2.0 * freq * t).sin() * (-t * 5.0).exp()
                + 0.06 * (TAU * 3.0 * freq * t).sin() * (-t * 8.0).exp();
            if let Some(s) = mix.get_mut(offset + i) {
                *s += tone * attack * decay * tail;
            }
        }
    }
    // Normalise so overlapping notes never clip, then apply the volume (gentle at most).
    let peak = mix.iter().fold(0.0_f32, |m, s| m.max(s.abs())).max(1e-6);
    let gain = 0.55 * (volume.min(100) as f32 / 100.0) / peak;
    let samples: Vec<i16> = mix.iter().map(|s| (s * gain * i16::MAX as f32) as i16).collect();
    wav(&samples)
}

fn wav(samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes()); // bytes per second
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

#[cfg(windows)]
mod player {
    use std::sync::Mutex;
    use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};

    // PlaySound reads from our buffer while it plays, so the buffer must outlive the sound.
    static PLAYING: Mutex<Vec<u8>> = Mutex::new(Vec::new());

    pub fn play(wav: Vec<u8>) -> Result<(), String> {
        let mut slot = PLAYING.lock().map_err(|_| "sound is unavailable")?;
        unsafe {
            // Stop any chime still playing before its buffer is replaced.
            PlaySoundW(std::ptr::null(), std::ptr::null_mut(), 0);
        }
        *slot = wav;
        let ok = unsafe { PlaySoundW(slot.as_ptr().cast(), std::ptr::null_mut(), SND_MEMORY | SND_ASYNC | SND_NODEFAULT) };
        if ok == 0 { Err("Windows could not play the sound".into()) } else { Ok(()) }
    }
}

#[cfg(not(windows))]
mod player {
    pub fn play(_wav: Vec<u8>) -> Result<(), String> {
        Err("sound is only supported on Windows".into())
    }
}

pub fn play(chime: Chime, volume: u8) -> Result<(), String> {
    player::play(render_wav(chime, volume))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_matches_the_data() {
        let w = render_wav(Chime::ToBreak, 60);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(&w[8..16], b"WAVEfmt ");
        let data_len = u32::from_le_bytes(w[40..44].try_into().unwrap()) as usize;
        assert_eq!(w.len(), 44 + data_len);
    }

    #[test]
    fn chimes_are_gentle_and_silent_at_zero() {
        for chime in [Chime::ToBreak, Chime::ToFocus, Chime::Finished] {
            let peak = |w: &[u8]| w[44..].chunks(2).map(|c| i16::from_le_bytes([c[0], c[1]]).unsigned_abs()).max().unwrap();
            assert!(peak(&render_wav(chime, 100)) <= (0.56 * i16::MAX as f32) as u16, "never louder than ~55%");
            assert_eq!(peak(&render_wav(chime, 0)), 0);
            // Starts and ends in silence: no clicks.
            let w = render_wav(chime, 100);
            let first = i16::from_le_bytes([w[44], w[45]]);
            let last = i16::from_le_bytes([w[w.len() - 2], w[w.len() - 1]]);
            assert!(first.abs() < 50 && last.abs() < 50);
        }
    }
}
