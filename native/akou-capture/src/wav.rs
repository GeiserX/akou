//! A WAV reader for the file source: PCM 8/16/24/32-bit or 32/64-bit float, any rate, any
//! channel count, through the same converter as the devices.

use crate::convert::{Format, SampleKind, to_mono};

#[derive(Clone, Debug)]
pub struct Wav {
    pub rate: u32,
    pub channels: usize,
    /// One mono float signal per channel.
    pub data: Vec<Vec<f32>>,
}

impl Wav {
    pub fn frames(&self) -> usize {
        self.data.first().map_or(0, |c| c.len())
    }
}

fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}

fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

pub fn parse(bytes: &[u8]) -> Result<Wav, String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a WAV file".into());
    }
    let mut o = 12;
    let mut fmt: Option<(u16, usize, u32, u16)> = None;
    while o + 8 <= bytes.len() {
        let id = &bytes[o..o + 4];
        let size = u32_at(bytes, o + 4) as usize;
        let body = o + 8;
        if id == b"fmt " {
            if size < 16 || body + 16 > bytes.len() {
                return Err("short fmt chunk".into());
            }
            let mut tag = u16_at(bytes, body);
            let channels = u16_at(bytes, body + 2) as usize;
            let rate = u32_at(bytes, body + 4);
            let bits = u16_at(bytes, body + 14);
            if tag == 0xFFFE && size >= 40 && body + 26 <= bytes.len() {
                // WAVE_FORMAT_EXTENSIBLE: the real tag is the first two bytes of the subformat.
                tag = u16_at(bytes, body + 24);
            }
            fmt = Some((tag, channels, rate, bits));
        } else if id == b"data" {
            let (tag, channels, rate, bits) = fmt.ok_or("data before fmt")?;
            if channels == 0 || rate == 0 {
                return Err("WAV with no channels or rate".into());
            }
            let kind = match (tag, bits) {
                (1, 8) => SampleKind::U8,
                (1, 16) => SampleKind::I16,
                (1, 24) => SampleKind::I24Packed,
                (1, 32) => SampleKind::I32,
                (3, 32) => SampleKind::F32,
                (3, 64) => SampleKind::F64,
                _ => return Err(format!("unsupported WAV format {tag} with {bits} bits")),
            };
            let end = (body + size).min(bytes.len());
            let raw = &bytes[body..end];
            let size = kind.bytes();
            let frames = raw.len() / (size * channels);
            let mut data = vec![Vec::with_capacity(frames); channels];
            // One channel at a time through the converter, as a one-channel interleaved buffer.
            let mut one = Vec::with_capacity(size);
            for f in 0..frames {
                for (c, out) in data.iter_mut().enumerate() {
                    let at = (f * channels + c) * size;
                    one.clear();
                    one.extend_from_slice(&raw[at..at + size]);
                    to_mono(
                        Format {
                            kind,
                            channels: 1,
                            interleaved: true,
                        },
                        &[&one],
                        out,
                    );
                }
            }
            return Ok(Wav {
                rate,
                channels,
                data,
            });
        }
        o = body + size + (size & 1);
    }
    Err("WAV has no data chunk".into())
}

/// A 16-bit PCM WAV, for tests and tools.
pub fn encode_i16(rate: u32, channels: &[Vec<f32>]) -> Vec<u8> {
    let ch = channels.len();
    let frames = channels.iter().map(|c| c.len()).max().unwrap_or(0);
    let data = frames * ch * 2;
    let mut b = Vec::with_capacity(44 + data);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data as u32).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&(ch as u16).to_le_bytes());
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * ch as u32 * 2).to_le_bytes());
    b.extend_from_slice(&(ch as u16 * 2).to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(data as u32).to_le_bytes());
    for f in 0..frames {
        for c in channels {
            let v = c.get(f).copied().unwrap_or(0.0);
            let s = (v * 32767.0).round().clamp(-32768.0, 32767.0) as i16;
            b.extend_from_slice(&s.to_le_bytes());
        }
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_stereo_16_bit_file() {
        let left: Vec<f32> = (0..100).map(|i| i as f32 / 200.0).collect();
        let right: Vec<f32> = (0..100).map(|i| -(i as f32) / 400.0).collect();
        let w = parse(&encode_i16(16_000, &[left.clone(), right.clone()])).unwrap();
        assert_eq!((w.rate, w.channels, w.frames()), (16_000, 2, 100));
        for (a, b) in w.data[0].iter().zip(&left) {
            assert!((a - b).abs() < 1e-4);
        }
        for (a, b) in w.data[1].iter().zip(&right) {
            assert!((a - b).abs() < 1e-4);
        }
    }

    #[test]
    fn rejects_what_it_cannot_read() {
        assert!(parse(b"nope").is_err());
        let mut b = encode_i16(16_000, &[vec![0.0; 4]]);
        b[20] = 7; // format tag
        assert!(parse(&b).is_err());
    }
}
