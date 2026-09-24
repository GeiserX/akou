//! The part's audio file (DESIGN section 2): Ogg Opus, 48 kHz stereo, mic on the left and call on
//! the right, 48 kbps, 20 ms packets, one Ogg page a second.
//!
//! Crash safety: every page carries the granule position of its last packet (pre-skip plus the
//! samples so far, RFC 7845), and each page is handed to the OS as soon as it is complete, so a
//! file cut off by a crash is playable up to its last page and its duration reads from that
//! page's granule. The file is fsynced every ten pages and at the end. `finish` writes the last
//! short packet with end trimming and the end-of-stream flag.

use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;

use ogg::writing::{PacketWriteEndInfo, PacketWriter};
use opus::{Application, Bitrate, Channels, Encoder};

use crate::aligner::{RATE, SLOT};

pub const BITRATE: i32 = 48_000;
/// Packets per Ogg page: one page a second.
pub const PACKETS_PER_PAGE: u32 = 50;
const PAGES_PER_SYNC: u32 = 10;
const MAX_PACKET: usize = 4000;

pub struct OpusWriter {
    pw: PacketWriter<'static, BufWriter<File>>,
    enc: Encoder,
    serial: u32,
    pre_skip: u16,
    /// Samples per channel written (not counting pre-skip).
    samples: u64,
    in_page: u32,
    pages: u32,
    buf: Vec<u8>,
    frame: Vec<f32>,
}

fn io_err(e: impl std::fmt::Display) -> io::Error {
    io::Error::other(e.to_string())
}

impl OpusWriter {
    /// Creates (or truncates) the file and writes both Opus headers on their own pages.
    pub fn create(path: &Path, serial: u32, vendor: &str) -> io::Result<OpusWriter> {
        let file = File::create(path)?;
        let mut enc = Encoder::new(RATE, Channels::Stereo, Application::Voip).map_err(io_err)?;
        enc.set_bitrate(Bitrate::Bits(BITRATE)).map_err(io_err)?;
        let pre_skip = enc
            .get_lookahead()
            .map_err(io_err)?
            .clamp(0, u16::MAX as i32) as u16;
        let mut pw = PacketWriter::new(BufWriter::new(file));

        let mut head = Vec::with_capacity(19);
        head.extend_from_slice(b"OpusHead");
        head.push(1); // version
        head.push(2); // channels
        head.extend_from_slice(&pre_skip.to_le_bytes());
        head.extend_from_slice(&RATE.to_le_bytes()); // input rate, informational
        head.extend_from_slice(&0i16.to_le_bytes()); // output gain
        head.push(0); // mapping family 0: mono or stereo
        pw.write_packet(head, serial, PacketWriteEndInfo::EndPage, 0)?;

        let mut tags = Vec::new();
        tags.extend_from_slice(b"OpusTags");
        tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        tags.extend_from_slice(vendor.as_bytes());
        tags.extend_from_slice(&0u32.to_le_bytes()); // no user comments
        pw.write_packet(tags, serial, PacketWriteEndInfo::EndPage, 0)?;
        pw.inner_mut().flush()?;
        pw.inner_mut().get_ref().sync_data()?;

        Ok(OpusWriter {
            pw,
            enc,
            serial,
            pre_skip,
            samples: 0,
            in_page: 0,
            pages: 0,
            buf: vec![0; MAX_PACKET],
            frame: Vec::with_capacity(SLOT * 2),
        })
    }

    pub fn pre_skip(&self) -> u16 {
        self.pre_skip
    }

    /// Seconds written.
    pub fn seconds(&self) -> f64 {
        self.samples as f64 / RATE as f64
    }

    fn encode(&mut self, left: &[f32], right: &[f32]) -> io::Result<usize> {
        self.frame.clear();
        for i in 0..SLOT {
            self.frame.push(left.get(i).copied().unwrap_or(0.0));
            self.frame.push(right.get(i).copied().unwrap_or(0.0));
        }
        self.enc
            .encode_float(&self.frame, &mut self.buf)
            .map_err(io_err)
    }

    /// Writes one 20 ms frame (960 samples per channel).
    pub fn write(&mut self, left: &[f32], right: &[f32]) -> io::Result<()> {
        debug_assert_eq!(left.len(), SLOT);
        let n = self.encode(left, right)?;
        self.samples += SLOT as u64;
        self.in_page += 1;
        let end = if self.in_page >= PACKETS_PER_PAGE {
            PacketWriteEndInfo::EndPage
        } else {
            PacketWriteEndInfo::NormalPacket
        };
        let granule = self.pre_skip as u64 + self.samples;
        self.pw
            .write_packet(self.buf[..n].to_vec(), self.serial, end, granule)?;
        if self.in_page >= PACKETS_PER_PAGE {
            self.in_page = 0;
            self.pages += 1;
            self.pw.inner_mut().flush()?;
            if self.pages.is_multiple_of(PAGES_PER_SYNC) {
                self.pw.inner_mut().get_ref().sync_data()?;
            }
        }
        Ok(())
    }

    /// Ends the stream. `tail` holds up to 959 more samples per channel; they are padded to a
    /// full frame and trimmed by the final granule position.
    pub fn finish(mut self, tail_left: &[f32], tail_right: &[f32]) -> io::Result<f64> {
        let tail = tail_left.len().min(SLOT - 1);
        let n = self.encode(
            &tail_left[..tail],
            &tail_right[..tail.min(tail_right.len())],
        )?;
        self.samples += tail as u64;
        let granule = self.pre_skip as u64 + self.samples;
        self.pw.write_packet(
            self.buf[..n].to_vec(),
            self.serial,
            PacketWriteEndInfo::EndStream,
            granule,
        )?;
        let mut inner = self.pw.into_inner();
        inner.flush()?;
        inner.get_ref().sync_all()?;
        Ok(self.samples as f64 / RATE as f64)
    }
}

/// What a reader recovers from a file that may have been cut off: the last complete page's
/// granule and the header fields. Used by the tests and by `akou-capture probe-file`.
#[derive(Debug, Clone, PartialEq)]
pub struct Recovered {
    pub channels: u8,
    pub pre_skip: u16,
    pub last_granule: u64,
    pub ended: bool,
    pub packets: usize,
}

impl Recovered {
    pub fn seconds(&self) -> f64 {
        self.last_granule.saturating_sub(self.pre_skip as u64) as f64 / RATE as f64
    }
}

pub fn recover(path: &Path) -> io::Result<Recovered> {
    let file = std::io::BufReader::new(File::open(path)?);
    let mut r = ogg::reading::PacketReader::new(file);
    let mut out = Recovered {
        channels: 0,
        pre_skip: 0,
        last_granule: 0,
        ended: false,
        packets: 0,
    };
    let mut n = 0usize;
    // A torn last page is an error from the reader; everything before it counts.
    while let Ok(Some(p)) = r.read_packet() {
        if n == 0 {
            if p.data.len() < 19 || &p.data[..8] != b"OpusHead" {
                return Err(io_err("not an Ogg Opus file"));
            }
            out.channels = p.data[9];
            out.pre_skip = u16::from_le_bytes([p.data[10], p.data[11]]);
        } else if n >= 2 {
            out.packets += 1;
        }
        if p.last_in_page() {
            out.last_granule = out.last_granule.max(p.absgp_page());
        }
        out.ended |= p.last_in_stream();
        n += 1;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("akou-capture-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn sine(freq: f64, i: usize) -> f32 {
        0.3 * (2.0 * std::f64::consts::PI * freq * i as f64 / RATE as f64).sin() as f32
    }

    fn write_seconds(w: &mut OpusWriter, frames: usize) {
        let mut l = vec![0.0; SLOT];
        let mut r = vec![0.0; SLOT];
        for f in 0..frames {
            for i in 0..SLOT {
                l[i] = sine(440.0, f * SLOT + i);
                r[i] = sine(1_000.0, f * SLOT + i);
            }
            w.write(&l, &r).unwrap();
        }
    }

    /// Goertzel power of `freq` in `x`.
    fn power(x: &[f32], freq: f64) -> f64 {
        let k = 2.0 * (2.0 * std::f64::consts::PI * freq / RATE as f64).cos();
        let (mut s1, mut s2) = (0.0f64, 0.0f64);
        for &v in x {
            let s = v as f64 + k * s1 - s2;
            s2 = s1;
            s1 = s;
        }
        s1 * s1 + s2 * s2 - k * s1 * s2
    }

    #[test]
    fn writes_stereo_with_the_mic_left_and_the_call_right() {
        let path = tmp("stereo.opus");
        let mut w = OpusWriter::create(&path, 7, "akou-capture test").unwrap();
        write_seconds(&mut w, 175); // 3.5 s
        let secs = w.finish(&[0.1; 480], &[0.1; 480]).unwrap();
        assert!((secs - 3.51).abs() < 1e-9);

        let rec = recover(&path).unwrap();
        assert_eq!(rec.channels, 2);
        assert!(rec.ended);
        assert_eq!(rec.last_granule - rec.pre_skip as u64, 175 * 960 + 480);
        assert_eq!(rec.packets, 176);

        // Decode and look at each side: 440 Hz on the left, 1 kHz on the right.
        let mut dec = opus::Decoder::new(RATE, Channels::Stereo).unwrap();
        let mut r =
            ogg::reading::PacketReader::new(std::io::BufReader::new(File::open(&path).unwrap()));
        let (mut left, mut right) = (Vec::new(), Vec::new());
        let mut pcm = vec![0.0f32; 5760 * 2];
        let mut i = 0;
        while let Some(p) = r.read_packet().unwrap() {
            i += 1;
            if i <= 2 {
                continue;
            }
            let n = dec.decode_float(&p.data, &mut pcm, false).unwrap();
            for f in 0..n {
                left.push(pcm[2 * f]);
                right.push(pcm[2 * f + 1]);
            }
        }
        let (l, r) = (&left[48_000..96_000], &right[48_000..96_000]);
        assert!(power(l, 440.0) > 100.0 * power(l, 1_000.0));
        assert!(power(r, 1_000.0) > 100.0 * power(r, 440.0));
    }

    /// A crash mid-recording: the writer is never finished. The file reads up to its last
    /// complete page, and that page's granule gives the duration to within a second.
    #[test]
    fn a_file_cut_off_by_a_crash_reads_to_its_last_page() {
        let path = tmp("crash.opus");
        let mut w = OpusWriter::create(&path, 9, "akou-capture test").unwrap();
        write_seconds(&mut w, 260); // 5.2 s
        // No finish: what a killed process leaves (the BufWriter's unflushed tail is lost).
        std::mem::forget(w);
        let rec = recover(&path).unwrap();
        assert!(!rec.ended);
        assert_eq!(rec.seconds(), 5.0);
        // Cut into the last page as well: still readable, one page less.
        let bytes = std::fs::read(&path).unwrap();
        let cut = tmp("cut.opus");
        std::fs::write(&cut, &bytes[..bytes.len() - 100]).unwrap();
        let rec = recover(&cut).unwrap();
        assert_eq!(rec.seconds(), 4.0);
    }

    #[test]
    fn pages_carry_monotonic_granules_one_a_second() {
        let path = tmp("granules.opus");
        let mut w = OpusWriter::create(&path, 11, "akou-capture test").unwrap();
        write_seconds(&mut w, 150);
        w.finish(&[], &[]).unwrap();
        let mut r =
            ogg::reading::PacketReader::new(std::io::BufReader::new(File::open(&path).unwrap()));
        let mut granules = Vec::new();
        while let Some(p) = r.read_packet().unwrap() {
            if p.last_in_page() {
                granules.push(p.absgp_page());
            }
        }
        let pre = granules[2] - 50 * 960;
        let data: Vec<u64> = granules[2..].iter().map(|g| g - pre).collect();
        assert_eq!(data, vec![48_000, 96_000, 144_000, 144_000]);
    }
}
