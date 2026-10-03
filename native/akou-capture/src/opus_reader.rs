//! Reading a part's Ogg Opus file back for the app's final pass (SV-P10): the desktop app has no
//! Opus decoder of its own, and the helper already links libopus to write the file, so
//! `akou-capture decode` hands the app the part as 16 kHz stereo float, mic on the left and call on
//! the right, with no WAV written anywhere.
//!
//! libopus decodes straight to 16 kHz, so there is no resampler. RFC 7845 counts granules and
//! pre-skip at 48 kHz whatever the output rate; a 16 kHz frame `t` is the 48 kHz sample
//! `pre_skip + 3 t`. The length is the last complete page's granule minus pre-skip (4.1 and 4.3),
//! so a file cut off by a crash decodes up to its last complete page, as `recover` reads it.
//!
//! A range (`from`, `frames`) is decoded without decoding what comes before it: packets before the
//! range are skipped unread, and decoding starts 200 ms early so the decoder has settled by the
//! first frame it writes. RFC 7845 section 4.6 asks for at least 80 ms; on the helper's own files
//! 80 ms still left the first 50 ms of a range 0.056 off the whole-file decode, 200 ms leaves it
//! 0.002 off.

use std::fs::File;
use std::io::{self, BufReader, Write};
use std::path::Path;

use opus::{Channels, Decoder};

use crate::opus_writer::recover;

/// The rate the app's recognizers take.
pub const DECODE_RATE: u32 = 16_000;
/// 48 kHz samples per 16 kHz frame.
const STEP: u64 = 48_000 / DECODE_RATE as u64;
/// Decoding starts this many 16 kHz frames before the range.
const PREROLL: u64 = DECODE_RATE as u64 * 200 / 1000;
/// The longest Opus packet, 120 ms, at 16 kHz.
const MAX_PACKET_FRAMES: usize = DECODE_RATE as usize * 120 / 1000;

/// What `decode --info` reports.
#[derive(Debug, Clone, PartialEq)]
pub struct Info {
    /// 16 kHz frames the file decodes to.
    pub frames: u64,
    /// The stream was ended; false for a file cut off by a crash.
    pub ended: bool,
}

pub fn info(path: &Path) -> io::Result<Info> {
    Ok(read_info(path)?.0)
}

/// The info and the pre-skip in 48 kHz samples.
fn read_info(path: &Path) -> io::Result<(Info, u64)> {
    let rec = recover(path)?;
    if rec.channels == 0 || rec.channels > 2 {
        return Err(io::Error::other(format!(
            "{} has {} channels, not 1 or 2",
            path.display(),
            rec.channels
        )));
    }
    let played = rec.last_granule.saturating_sub(rec.pre_skip as u64);
    let info = Info {
        frames: played / STEP,
        ended: rec.ended,
    };
    Ok((info, rec.pre_skip as u64))
}

/// Writes frames `from` to `from + frames` (fewer past the end) as interleaved stereo little-endian
/// f32 at 16 kHz, left then right. Returns the frames written.
pub fn decode(path: &Path, from: u64, frames: Option<u64>, out: &mut dyn Write) -> io::Result<u64> {
    let (info, pre_skip) = read_info(path)?;
    let end = frames.map_or(info.frames, |n| from.saturating_add(n).min(info.frames));
    if from >= end {
        return Ok(0);
    }
    let start = from.saturating_sub(PREROLL);
    let mut dec = Decoder::new(DECODE_RATE, Channels::Stereo).map_err(io::Error::other)?;
    let mut r = ogg::reading::PacketReader::new(BufReader::new(File::open(path)?));
    let mut pcm = vec![0.0f32; MAX_PACKET_FRAMES * 2];
    let mut bytes = Vec::with_capacity(MAX_PACKET_FRAMES * 8);
    // 48 kHz samples the packets before this one decode to, pre-skip included.
    let mut at48 = 0u64;
    let mut n = 0usize;
    let mut decoding = false;
    let mut written = 0u64;
    // A torn last page is an error from the reader; `info` already stopped the length before it.
    while let Ok(Some(p)) = r.read_packet() {
        n += 1;
        if n <= 2 {
            continue; // OpusHead, OpusTags
        }
        let len48 = opus::packet::get_nb_samples(&p.data, 48_000).unwrap_or(960) as u64;
        // This packet's first and past-last 16 kHz frames on the output timeline (before pre-skip
        // is negative, hence the signed arithmetic).
        let first = (at48 as i64 - pre_skip as i64).div_euclid(STEP as i64);
        let last = (at48 as i64 + len48 as i64 - pre_skip as i64).div_euclid(STEP as i64);
        at48 += len48;
        if first >= end as i64 {
            break;
        }
        if !decoding && last <= start as i64 {
            continue;
        }
        decoding = true;
        // A packet libopus refuses decodes as the loss it is: concealment, never a stop.
        let got = match dec.decode_float(&p.data, &mut pcm, false) {
            Ok(k) => k,
            Err(_) => dec
                .decode_float(&[], &mut pcm[..(len48 / STEP) as usize * 2], false)
                .unwrap_or(0),
        };
        bytes.clear();
        for i in 0..got {
            let t = first + i as i64;
            if t < from as i64 || t >= end as i64 {
                continue;
            }
            bytes.extend_from_slice(&pcm[2 * i].to_le_bytes());
            bytes.extend_from_slice(&pcm[2 * i + 1].to_le_bytes());
            written += 1;
        }
        out.write_all(&bytes)?;
    }
    out.flush()?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aligner::{RATE, SLOT};
    use crate::opus_writer::OpusWriter;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("akou-capture-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn sine(freq: f64, i: usize) -> f32 {
        0.3 * (2.0 * std::f64::consts::PI * freq * i as f64 / RATE as f64).sin() as f32
    }

    /// `slots` 20 ms frames: 440 Hz on the left (the mic), 1 kHz on the right (the call).
    fn write_tones(path: &Path, slots: usize, tail: usize) {
        let mut w = OpusWriter::create(path, 5, "akou-capture test").unwrap();
        let (mut l, mut r) = (vec![0.0; SLOT], vec![0.0; SLOT]);
        for f in 0..slots {
            for i in 0..SLOT {
                l[i] = sine(440.0, f * SLOT + i);
                r[i] = sine(1_000.0, f * SLOT + i);
            }
            w.write(&l, &r).unwrap();
        }
        w.finish(&vec![0.2; tail], &vec![0.2; tail]).unwrap();
    }

    fn channels(bytes: &[u8]) -> (Vec<f32>, Vec<f32>) {
        let f: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        (
            f.iter().step_by(2).copied().collect(),
            f.iter().skip(1).step_by(2).copied().collect(),
        )
    }

    /// Goertzel power of `freq` in `x` at 16 kHz.
    fn power(x: &[f32], freq: f64) -> f64 {
        let k = 2.0 * (2.0 * std::f64::consts::PI * freq / DECODE_RATE as f64).cos();
        let (mut s1, mut s2) = (0.0f64, 0.0f64);
        for &v in x {
            let s = v as f64 + k * s1 - s2;
            s2 = s1;
            s1 = s;
        }
        s1 * s1 + s2 * s2 - k * s1 * s2
    }

    #[test]
    fn decodes_the_whole_part_at_16_khz_with_the_mic_left_and_the_call_right() {
        let path = tmp("whole.opus");
        write_tones(&path, 175, 480); // 3.51 s
        let info = info(&path).unwrap();
        assert!(info.ended);
        // Every sample written and nothing more: (175 * 960 + 480) / 3.
        assert_eq!(info.frames, 56_160);
        let mut out = Vec::new();
        assert_eq!(decode(&path, 0, None, &mut out).unwrap(), 56_160);
        assert_eq!(out.len(), 56_160 * 8);
        let (l, r) = channels(&out);
        let (l, r) = (&l[16_000..32_000], &r[16_000..32_000]);
        assert!(power(l, 440.0) > 100.0 * power(l, 1_000.0));
        assert!(power(r, 1_000.0) > 100.0 * power(r, 440.0));
    }

    #[test]
    fn a_range_decodes_to_the_same_frames_as_the_whole_part() {
        let path = tmp("range.opus");
        write_tones(&path, 250, 0); // 5 s
        let mut whole = Vec::new();
        decode(&path, 0, None, &mut whole).unwrap();
        let (wl, wr) = channels(&whole);
        let (from, n) = (40_000u64, 16_000u64);
        let mut part = Vec::new();
        assert_eq!(decode(&path, from, Some(n), &mut part).unwrap(), n);
        let (pl, pr) = channels(&part);
        let a = from as usize;
        let err = |x: &[f32], y: &[f32]| {
            x.iter()
                .zip(y)
                .map(|(p, q)| (p - q).abs())
                .fold(0.0f32, f32::max)
        };
        // The preroll settles the decoder: the range matches the whole decode to within 0.01 of
        // the tones' 0.3 amplitude (0.002 measured; 80 ms of preroll left 0.056).
        assert!(err(&pl, &wl[a..a + n as usize]) < 0.01, "left");
        assert!(err(&pr, &wr[a..a + n as usize]) < 0.01, "right");
    }

    #[test]
    fn a_range_past_the_end_is_cut_to_the_part() {
        let path = tmp("end.opus");
        write_tones(&path, 100, 0); // 2 s = 32 000 frames
        let mut out = Vec::new();
        assert_eq!(decode(&path, 30_000, Some(9_600), &mut out).unwrap(), 2_000);
        assert_eq!(out.len(), 2_000 * 8);
        let mut none = Vec::new();
        assert_eq!(decode(&path, 32_000, Some(10), &mut none).unwrap(), 0);
        assert!(none.is_empty());
    }

    /// A crash mid-recording leaves no end of stream: the part decodes up to its last complete
    /// page, and the length says so.
    #[test]
    fn a_part_cut_off_by_a_crash_decodes_to_its_last_page() {
        let path = tmp("crash.opus");
        let mut w = OpusWriter::create(&path, 9, "akou-capture test").unwrap();
        let (l, r) = (vec![0.1; SLOT], vec![-0.1; SLOT]);
        for _ in 0..260 {
            w.write(&l, &r).unwrap();
        }
        let pre_skip = w.pre_skip() as u64;
        std::mem::forget(w);
        let info = info(&path).unwrap();
        assert!(!info.ended);
        assert_eq!(info.frames, (5 * 48_000 - pre_skip) / 3);
        let mut out = Vec::new();
        assert_eq!(decode(&path, 0, None, &mut out).unwrap(), info.frames);
    }

    /// A dictation's audio (`encode`, DC-H2): mono from 16 kHz input. It decodes to exactly the
    /// frames written, in time with the input (the pre-skip is counted at 48 kHz, so a lookahead
    /// left at 16 kHz would shift it by 69 frames), the same on both channels, at about a tenth of
    /// the 16-bit WAV it replaces.
    #[test]
    fn a_mono_16_khz_dictation_decodes_in_time_and_small() {
        let path = tmp("dictation.opus");
        let rate = DECODE_RATE as usize;
        let slot = rate / 50;
        // A chirp from 200 Hz to 2 kHz over 3 s: no period, so one lag lines it up.
        let chirp = |i: usize| {
            let t = i as f64 / rate as f64;
            0.3 * (2.0 * std::f64::consts::PI * (200.0 * t + 300.0 * t * t)).sin() as f32
        };
        let input: Vec<f32> = (0..3 * rate + 100).map(chirp).collect();
        let mut w = OpusWriter::create_mono(&path, 3, "akou-capture test", DECODE_RATE).unwrap();
        let whole = input.len() / slot * slot;
        for f in input[..whole].chunks(slot) {
            w.write(f, &[]).unwrap();
        }
        let secs = w.finish(&input[whole..], &[]).unwrap();
        assert!((secs - input.len() as f64 / rate as f64).abs() < 1e-9);
        assert_eq!(recover(&path).unwrap().channels, 1);

        let info = info(&path).unwrap();
        assert!(info.ended);
        assert_eq!(info.frames, input.len() as u64);
        let mut out = Vec::new();
        assert_eq!(
            decode(&path, 0, None, &mut out).unwrap(),
            input.len() as u64
        );
        let (l, r) = channels(&out);
        assert_eq!(l, r);

        let mid = &input[rate..2 * rate];
        let lag = (-80i64..=80)
            .max_by(|a, b| {
                let c = |lag: i64| -> f64 {
                    mid.iter()
                        .enumerate()
                        .map(|(i, &x)| x as f64 * l[(rate as i64 + i as i64 + lag) as usize] as f64)
                        .sum()
                };
                c(*a).total_cmp(&c(*b))
            })
            .unwrap();
        assert!(lag.abs() <= 2, "decoded {lag} frames off the input");

        let wav = 44 + 2 * input.len() as u64;
        let opus = std::fs::metadata(&path).unwrap().len();
        assert!(opus * 8 < wav, "{opus} bytes of Opus against {wav} of WAV");
    }

    #[test]
    fn a_file_that_is_not_ogg_opus_is_an_error() {
        let path = tmp("not.opus");
        std::fs::write(&path, b"RIFF....WAVEfmt ").unwrap();
        assert!(info(&path).is_err());
        assert!(decode(&path, 0, None, &mut Vec::new()).is_err());
    }
}
