//! The parts of `akou-diarize` that need no model: the frame reader, the arithmetic of which
//! audio a live step has decided, and the lines written to stdout. `main.rs` puts the model
//! behind them.
//!
//! The protocol, `akou-diarize/1` (docs/DESIGN.md section 3.4):
//!
//! ```text
//! stdin   frames: 1 byte kind, u32 little-endian payload length, payload
//!           a  audio: f32 little-endian samples, 16 kHz mono, appended to the stream
//!           f  flush: decide everything appended so far
//!           r  reset: forget the stream; the next audio starts a new one at sample 0
//!         end of input: exit 0
//! stdout  one JSON object per line
//!           {"type":"ready","protocol":"akou-diarize/1","version":"…","mode":"live","latency":2}
//!           {"type":"turn","spk":0,"start":1600,"end":32000}   samples on the stream, end exclusive
//!           {"type":"decided","at":26880}   every sample before `at` is decided (live mode)
//!           {"type":"flushed","at":40000}
//!           {"type":"reset"}   answers `r`: every later line belongs to the new stream
//!           {"type":"error","message":"…"}   then the helper exits non-zero
//! ```
//!
//! In `final` mode the audio is held until `f`, then the whole stream is decided at once at the
//! model's 30.4 s latency, which is the path measured against NeMo; the stream then starts over.
//! In `live` mode each step is decided as soon as its audio and look-ahead have arrived, and `f`
//! decides the rest (zero-padded) without ending the stream.

use std::io::{self, Read};

pub const PROTOCOL: &str = "akou-diarize/1";
pub const RATE: usize = 16_000;
/// A frame's payload may not exceed this: 16 MiB is over four minutes of audio.
pub const MAX_FRAME: usize = 16 << 20;

/// Mel frames per 80 ms model frame, and samples per mel frame (the model's front end).
const SUBSAMPLING: usize = 8;
const HOP: usize = 160;

/// Streaming geometry in 80 ms model frames. The live one is NVIDIA's 1.04 s preset with a longer
/// chunk: 2.0 s of latency, measured as accurate as 1.04 s at half the compute.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Geometry {
    pub chunk_len: usize,
    pub right_context: usize,
    pub fifo_len: usize,
    pub spkcache_update_period: usize,
    pub spkcache_len: usize,
}

pub const LIVE: Geometry = Geometry {
    chunk_len: 21,
    right_context: 4,
    fifo_len: 264,
    spkcache_update_period: 222,
    spkcache_len: 264,
};

/// NVIDIA's offline preset, 30.4 s: what the final pass uses.
pub const FINAL: Geometry = Geometry {
    chunk_len: 340,
    right_context: 40,
    fifo_len: 40,
    spkcache_update_period: 300,
    spkcache_len: 264,
};

impl Geometry {
    /// Seconds of audio a step waits for: `(chunk + right context) * 80 ms`.
    pub fn latency(&self) -> f64 {
        (self.chunk_len + self.right_context) as f64 * 0.08
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Final,
    Live,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "final" => Some(Mode::Final),
            "live" => Some(Mode::Live),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Mode::Final => "final",
            Mode::Live => "live",
        }
    }

    pub fn geometry(self) -> Geometry {
        match self {
            Mode::Final => FINAL,
            Mode::Live => LIVE,
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Frame {
    Audio(Vec<f32>),
    Flush,
    Reset,
}

/// Reads one frame. `Ok(None)` is a clean end of input (nothing of a next frame was read).
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut head = [0u8; 5];
    let mut got = 0;
    while got < head.len() {
        match r.read(&mut head[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "input ended inside a frame header",
                ));
            }
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_FRAME {
        return Err(bad(format!(
            "a frame of {len} bytes is over the {MAX_FRAME} limit"
        )));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    match head[0] {
        b'a' => {
            if !len.is_multiple_of(4) {
                return Err(bad(format!(
                    "audio of {len} bytes is not whole f32 samples"
                )));
            }
            let (samples, _) = payload.as_chunks::<4>();
            Ok(Some(Frame::Audio(
                samples.iter().map(|c| f32::from_le_bytes(*c)).collect(),
            )))
        }
        b'f' => Ok(Some(Frame::Flush)),
        b'r' => Ok(Some(Frame::Reset)),
        k => Err(bad(format!("unknown frame kind 0x{k:02x}"))),
    }
}

fn bad(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg)
}

/// Which part of a live stream is decided. It mirrors the step loop of `Sortformer::feed`: a step
/// runs once a whole window (chunk plus look-ahead) is buffered and advances by one chunk, and a
/// flush decides whatever is left.
#[derive(Debug)]
pub struct Steps {
    window: usize,
    stride: usize,
    pending: usize,
    decided: u64,
}

impl Steps {
    pub fn new(g: Geometry) -> Steps {
        Steps {
            window: (g.chunk_len + g.right_context) * SUBSAMPLING * HOP,
            stride: g.chunk_len * SUBSAMPLING * HOP,
            pending: 0,
            decided: 0,
        }
    }

    /// Counts `n` appended samples; true when at least one step ran.
    pub fn push(&mut self, n: usize) -> bool {
        self.pending += n;
        let before = self.decided;
        while self.pending >= self.window {
            self.pending -= self.stride;
            self.decided += self.stride as u64;
        }
        self.decided != before
    }

    pub fn flush(&mut self) {
        self.decided += self.pending as u64;
        self.pending = 0;
    }

    pub fn reset(&mut self) {
        self.pending = 0;
        self.decided = 0;
    }

    pub fn decided(&self) -> u64 {
        self.decided
    }
}

/// Zero samples to append before a stream of `n` samples is decided as one chunk.
///
/// parakeet-rs 0.3.8 hands ONNX Runtime a column-major chunk, which it refuses ("Array has a
/// non-contiguous layout"), when a whole stream, or a live flush's remainder, is one chunk whose
/// mel frame count (`n / 160 + 1`) is a multiple of 8. Padding up to the next hop, at most 160
/// samples (10 ms) of silence, moves the count off the multiple. Turns are clipped back to the real audio.
pub fn whole_chunk_pad(n: usize) -> usize {
    if (n / HOP + 1).is_multiple_of(SUBSAMPLING) {
        HOP - n % HOP
    } else {
        0
    }
}

/// A live stream's two timelines: the model's, which holds the silence padded in at flushes
/// (`whole_chunk_pad`), and the caller's, which holds only the audio it sent. Every position the
/// helper writes is on the caller's.
#[derive(Debug)]
pub struct Timeline {
    geometry: Geometry,
    steps: Steps,
    /// Samples the caller has sent since the last reset.
    sent: u64,
    /// Padding in the model's stream before the current flush.
    shift: u64,
    /// Padding added during the current flush.
    padding: u64,
}

impl Timeline {
    pub fn new(g: Geometry) -> Timeline {
        Timeline {
            geometry: g,
            steps: Steps::new(g),
            sent: 0,
            shift: 0,
            padding: 0,
        }
    }

    /// Counts `n` samples of the caller's audio; true when a step ran.
    pub fn push(&mut self, n: usize) -> bool {
        self.sent += n as u64;
        self.steps.push(n)
    }

    /// Zeros to feed before flushing; call `padded` after feeding them, until this is 0.
    pub fn pad_needed(&self) -> usize {
        whole_chunk_pad(self.steps.pending)
    }

    pub fn padded(&mut self, n: usize) {
        self.padding += n as u64;
        self.steps.push(n);
    }

    /// A turn on the model's timeline as the caller sees it, clipped to the audio it sent; None
    /// when nothing of it is real audio.
    pub fn turn(&self, start: u64, end: u64) -> Option<(u64, u64)> {
        let real_end = self.sent + self.shift;
        let (s, e) = (start.min(real_end), end.min(real_end));
        (e > s).then(|| (s - self.shift, e - self.shift))
    }

    /// Where the caller's decided audio ends.
    pub fn decided(&self) -> u64 {
        self.steps.decided().min(self.sent + self.shift) - self.shift
    }

    /// The flush ran: the stream goes on after everything sent, padding included.
    pub fn flushed(&mut self) {
        self.steps.flush();
        self.shift += self.padding;
        self.padding = 0;
    }

    pub fn reset(&mut self) {
        *self = Timeline::new(self.geometry);
    }
}

pub fn ready_line(version: &str, mode: Mode) -> String {
    format!(
        "{{\"type\":\"ready\",\"protocol\":\"{PROTOCOL}\",\"version\":{},\"mode\":\"{}\",\"latency\":{}}}",
        serde_json::to_string(version).unwrap_or_else(|_| "\"\"".into()),
        mode.name(),
        mode.geometry().latency()
    )
}

pub const RESET_LINE: &str = r#"{"type":"reset"}"#;

pub fn turn_line(spk: usize, start: u64, end: u64) -> String {
    format!("{{\"type\":\"turn\",\"spk\":{spk},\"start\":{start},\"end\":{end}}}")
}

pub fn at_line(kind: &str, at: u64) -> String {
    format!("{{\"type\":\"{kind}\",\"at\":{at}}}")
}

pub fn error_line(message: &str) -> String {
    format!(
        "{{\"type\":\"error\",\"message\":{}}}",
        serde_json::to_string(message).unwrap_or_else(|_| "\"\"".into())
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
        let mut v = vec![kind];
        v.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn frames_round_trip_and_end_cleanly() {
        let samples = [0.5f32, -0.25, 1.0];
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut input = frame(b'a', &bytes);
        input.extend(frame(b'f', &[]));
        input.extend(frame(b'r', &[]));
        let mut r = input.as_slice();
        assert_eq!(
            read_frame(&mut r).unwrap(),
            Some(Frame::Audio(samples.to_vec()))
        );
        assert_eq!(read_frame(&mut r).unwrap(), Some(Frame::Flush));
        assert_eq!(read_frame(&mut r).unwrap(), Some(Frame::Reset));
        assert_eq!(read_frame(&mut r).unwrap(), None);
    }

    #[test]
    fn a_torn_frame_an_unknown_kind_and_a_huge_length_are_errors() {
        let torn = [b'a', 8, 0];
        assert!(read_frame(&mut &torn[..]).is_err());
        let short_payload = frame(b'a', &[0; 8]);
        assert!(read_frame(&mut &short_payload[..6]).is_err());
        assert!(read_frame(&mut &frame(b'x', &[])[..]).is_err());
        assert!(read_frame(&mut &frame(b'a', &[0; 3])[..]).is_err());
        let mut huge = vec![b'a'];
        huge.extend_from_slice(&((MAX_FRAME + 1) as u32).to_le_bytes());
        assert!(read_frame(&mut huge.as_slice()).is_err());
    }

    #[test]
    fn steps_decide_one_chunk_per_window_and_flush_decides_the_rest() {
        let mut s = Steps::new(LIVE);
        let window = 25 * 8 * 160;
        let stride = 21 * 8 * 160;
        // Positive control: one sample short of a window decides nothing.
        assert!(!s.push(window - 1));
        assert_eq!(s.decided(), 0);
        assert!(s.push(1));
        assert_eq!(s.decided(), stride as u64);
        // Three more chunks at once run three steps.
        assert!(s.push(3 * stride));
        assert_eq!(s.decided(), 4 * stride as u64);
        s.flush();
        assert_eq!(s.decided(), (window + 3 * stride) as u64);
        // The stream continues after a flush: positions keep counting.
        assert!(!s.push(stride));
        s.reset();
        assert_eq!(s.decided(), 0);
    }

    #[test]
    fn a_whole_chunk_is_padded_off_a_multiple_of_eight_mel_frames() {
        // Measured on 0.3.8: 2400 and 2401 samples (16 frames) fail; 2399 (15) and 2560 (17) run.
        assert_eq!(whole_chunk_pad(2399), 0);
        assert_eq!(whole_chunk_pad(2400), 160);
        assert_eq!(whole_chunk_pad(2401), 159);
        assert_eq!(whole_chunk_pad(2559), 1);
        assert_eq!(whole_chunk_pad(2560), 0);
        for n in 0..40_000 {
            let padded = n + whole_chunk_pad(n);
            assert!(!(padded / 160 + 1).is_multiple_of(8), "{n}");
            assert!(padded - n <= 160);
        }
    }

    #[test]
    fn padding_at_a_flush_never_shows_on_the_callers_timeline() {
        let mut t = Timeline::new(LIVE);
        let window = 25 * 8 * 160;
        let stride = 21 * 8 * 160;
        assert!(t.push(window));
        assert_eq!(t.decided(), stride as u64);
        // Remainder 5120 samples: 33 mel frames, no padding.
        assert_eq!(t.pad_needed(), 0);
        // 1200 more: 6320 samples, 40 frames, a multiple of 8: 80 samples of silence.
        assert!(!t.push(1200));
        assert_eq!(t.pad_needed(), 80);
        let sent_end = (window + 1200) as u64;
        t.padded(80);
        assert_eq!(t.pad_needed(), 0);
        // A turn reaching into the padding is clipped to the real audio; one inside it is dropped.
        assert_eq!(
            t.turn(sent_end - 10, sent_end + 50),
            Some((sent_end - 10, sent_end))
        );
        assert_eq!(t.turn(sent_end + 1, sent_end + 50), None);
        t.flushed();
        assert_eq!(t.decided(), sent_end);
        // After the flush the model's positions run 80 ahead; the caller's do not.
        t.push(window);
        assert_eq!(
            t.turn(sent_end + 80, sent_end + 180),
            Some((sent_end, sent_end + 100))
        );
        assert!(t.decided() > sent_end);
        t.reset();
        assert_eq!(t.decided(), 0);
        t.push(100);
        assert_eq!(t.turn(0, 10), Some((0, 10)));
    }

    #[test]
    fn geometry_latencies_are_the_measured_ones() {
        assert!((LIVE.latency() - 2.0).abs() < 1e-9);
        assert!((FINAL.latency() - 30.4).abs() < 1e-9);
    }

    #[test]
    fn lines_are_one_json_object_each() {
        assert_eq!(
            turn_line(1, 10, 20),
            r#"{"type":"turn","spk":1,"start":10,"end":20}"#
        );
        assert_eq!(
            at_line("decided", 26880),
            r#"{"type":"decided","at":26880}"#
        );
        let e = error_line("bad \"model\"\nfile");
        assert_eq!(e, r#"{"type":"error","message":"bad \"model\"\nfile"}"#);
        let r = ready_line("0.1.0", Mode::Live);
        let v: serde_json::Value = serde_json::from_str(&r).unwrap();
        assert_eq!(v["protocol"], PROTOCOL);
        assert_eq!(v["mode"], "live");
        assert_eq!(v["latency"], 2.0);
    }
}
