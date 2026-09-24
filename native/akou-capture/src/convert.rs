//! Conversion to float at the edge (DESIGN 2.1, TRAPS "Health verdicts on the wrong format").
//!
//! Every device buffer, whatever its format, becomes mono 32-bit float here, and the "did this
//! buffer carry any audio" verdict is taken on the converted data with the maximum over all
//! channels, so a signal on the second channel only is never mistaken for silence.

/// A device sample format. All little-endian (every target of akou is).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleKind {
    U8,
    I16,
    /// 24-bit in 3 bytes.
    I24Packed,
    /// 24-bit value in the low bits of an `i32` (range ±2^23), as cpal delivers `I24`.
    I24InI32,
    /// 32-bit integer; also 24-bit aligned high in 32 bits.
    I32,
    F32,
    F64,
}

impl SampleKind {
    pub fn bytes(self) -> usize {
        match self {
            SampleKind::U8 => 1,
            SampleKind::I16 => 2,
            SampleKind::I24Packed => 3,
            SampleKind::I24InI32 | SampleKind::I32 | SampleKind::F32 => 4,
            SampleKind::F64 => 8,
        }
    }

    #[inline]
    fn read(self, b: &[u8]) -> f32 {
        match self {
            SampleKind::U8 => (b[0] as f32 - 128.0) / 128.0,
            SampleKind::I16 => i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0,
            SampleKind::I24Packed => {
                let v = i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8;
                v as f32 / 8_388_608.0
            }
            SampleKind::I24InI32 => {
                // The low 24 bits, sign-extended whether or not the container already was.
                ((i32::from_le_bytes([b[0], b[1], b[2], b[3]]) << 8) >> 8) as f32 / 8_388_608.0
            }
            SampleKind::I32 => {
                (i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64 / 2_147_483_648.0) as f32
            }
            SampleKind::F32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            SampleKind::F64 => {
                f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]) as f32
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Format {
    pub kind: SampleKind,
    pub channels: usize,
    /// One buffer with the channels interleaved, or one buffer per channel.
    pub interleaved: bool,
}

/// Converts one device buffer to mono float by averaging the channels ("keep channel 0" lost
/// the far side of a call once), appending to `out`. Returns true when any sample on any
/// channel is non-zero. A non-finite float sample counts as silence and is written as zero.
///
/// `buffers` holds one slice for interleaved data, or one slice per channel.
pub fn to_mono(fmt: Format, buffers: &[&[u8]], out: &mut Vec<f32>) -> bool {
    let size = fmt.kind.bytes();
    let channels = fmt.channels.max(1);
    let mut heard = false;
    if fmt.interleaved {
        let Some(buf) = buffers.first() else {
            return false;
        };
        let frames = buf.len() / (size * channels);
        out.reserve(frames);
        for f in 0..frames {
            let mut sum = 0.0f32;
            for c in 0..channels {
                let at = (f * channels + c) * size;
                let v = clean(fmt.kind.read(&buf[at..at + size]));
                heard |= v != 0.0;
                sum += v;
            }
            out.push(sum / channels as f32);
        }
    } else {
        let used = &buffers[..buffers.len().min(channels)];
        let n = used.len().max(1);
        let frames = used.iter().map(|b| b.len() / size).min().unwrap_or(0);
        out.reserve(frames);
        for f in 0..frames {
            let mut sum = 0.0f32;
            for b in used {
                let v = clean(fmt.kind.read(&b[f * size..f * size + size]));
                heard |= v != 0.0;
                sum += v;
            }
            out.push(sum / n as f32);
        }
    }
    heard
}

#[inline]
fn clean(v: f32) -> f32 {
    if v.is_finite() { v } else { 0.0 }
}

/// Folds interleaved float frames to mono; returns true when any sample on any channel is
/// non-zero. The file source and tests use this.
pub fn fold_f32(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) -> bool {
    let channels = channels.max(1);
    let mut heard = false;
    out.reserve(interleaved.len() / channels);
    for frame in interleaved.chunks_exact(channels) {
        let mut sum = 0.0;
        for &v in frame {
            let v = clean(v);
            heard |= v != 0.0;
            sum += v;
        }
        out.push(sum / channels as f32);
    }
    heard
}

#[cfg(test)]
mod tests {
    use super::*;

    const KINDS: [SampleKind; 7] = [
        SampleKind::U8,
        SampleKind::I16,
        SampleKind::I24Packed,
        SampleKind::I24InI32,
        SampleKind::I32,
        SampleKind::F32,
        SampleKind::F64,
    ];

    fn encode(kind: SampleKind, v: f32) -> Vec<u8> {
        let v = v.clamp(-1.0, 0.999_99);
        match kind {
            SampleKind::U8 => vec![((v * 128.0).round() as i32 + 128).clamp(0, 255) as u8],
            SampleKind::I16 => ((v * 32768.0).round() as i16).to_le_bytes().to_vec(),
            SampleKind::I24Packed => {
                let i = (v * 8_388_608.0).round() as i32;
                i.to_le_bytes()[..3].to_vec()
            }
            SampleKind::I24InI32 => ((v * 8_388_608.0).round() as i32).to_le_bytes().to_vec(),
            SampleKind::I32 => ((v as f64 * 2_147_483_648.0).round() as i32)
                .to_le_bytes()
                .to_vec(),
            SampleKind::F32 => v.to_le_bytes().to_vec(),
            SampleKind::F64 => (v as f64).to_le_bytes().to_vec(),
        }
    }

    fn tolerance(kind: SampleKind) -> f32 {
        match kind {
            SampleKind::U8 => 1.0 / 64.0,
            SampleKind::I16 => 1e-4,
            _ => 1e-6,
        }
    }

    /// A small deterministic generator, so the property test needs no crate.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((self.0 >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
        }
    }

    /// Builds a buffer layout for `frames[f][c]` in the given format.
    fn layout(fmt: Format, frames: &[Vec<f32>]) -> Vec<Vec<u8>> {
        if fmt.interleaved {
            let mut b = Vec::new();
            for fr in frames {
                for &v in fr {
                    b.extend(encode(fmt.kind, v));
                }
            }
            vec![b]
        } else {
            (0..fmt.channels)
                .map(|c| {
                    frames
                        .iter()
                        .flat_map(|fr| encode(fmt.kind, fr[c]))
                        .collect()
                })
                .collect()
        }
    }

    #[test]
    fn every_format_converts_to_the_mean_of_its_channels() {
        let mut rng = Lcg(42);
        for kind in KINDS {
            for channels in [1usize, 2, 6] {
                for interleaved in [true, false] {
                    let fmt = Format {
                        kind,
                        channels,
                        interleaved,
                    };
                    let frames: Vec<Vec<f32>> = (0..257)
                        .map(|_| (0..channels).map(|_| rng.next() * 0.9).collect())
                        .collect();
                    let bufs = layout(fmt, &frames);
                    let refs: Vec<&[u8]> = bufs.iter().map(|b| b.as_slice()).collect();
                    let mut out = Vec::new();
                    let heard = to_mono(fmt, &refs, &mut out);
                    assert!(heard, "{fmt:?}");
                    assert_eq!(out.len(), frames.len(), "{fmt:?}");
                    for (o, fr) in out.iter().zip(&frames) {
                        let mean = fr.iter().sum::<f32>() / channels as f32;
                        assert!(
                            (o - mean).abs() <= tolerance(kind),
                            "{fmt:?}: {o} vs {mean}"
                        );
                    }
                }
            }
        }
    }

    /// [T0.28] Health verdicts on the wrong format: the verdict is the maximum over all
    /// channels. Positive control: all-zero input is silence in every format.
    #[test]
    fn t0_28_a_signal_on_the_last_channel_only_is_heard_in_every_format() {
        for kind in KINDS {
            for interleaved in [true, false] {
                let fmt = Format {
                    kind,
                    channels: 2,
                    interleaved,
                };
                let mut frames = vec![vec![0.0f32, 0.0]; 64];
                let silent = layout(fmt, &frames);
                let refs: Vec<&[u8]> = silent.iter().map(|b| b.as_slice()).collect();
                let mut out = Vec::new();
                assert!(
                    !to_mono(fmt, &refs, &mut out),
                    "{fmt:?} zeros read as audio"
                );
                assert!(out.iter().all(|v| *v == 0.0));
                frames[40][1] = 0.5;
                let one = layout(fmt, &frames);
                let refs: Vec<&[u8]> = one.iter().map(|b| b.as_slice()).collect();
                out.clear();
                assert!(to_mono(fmt, &refs, &mut out), "{fmt:?} missed channel 1");
            }
        }
    }

    #[test]
    fn non_finite_samples_are_silence() {
        let mut out = Vec::new();
        assert!(!fold_f32(&[f32::NAN, f32::INFINITY, 0.0, 0.0], 2, &mut out));
        assert_eq!(out, vec![0.0, 0.0]);
    }
}
