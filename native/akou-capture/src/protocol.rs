//! `akou-capture/1` (docs/DESIGN.md section 2.4). The TypeScript side in
//! `src/main/capture/protocol.ts` is the contract; this file matches it byte for byte.
//!
//! - **stdout**: binary packets, little-endian, both channels at 16 kHz mono float:
//!   `"AKP1" | u8 channel (0 mic, 1 call) | u8 flags (1 = zero-filled) | u16 reserved |
//!   u64 capture_ns | f64 file_seconds | u32 frames | f32 samples[frames]`.
//! - **stderr**: one JSON object per line, tagged by `type`. A `capture_ns` is a decimal string,
//!   because u64 nanoseconds exceed what a JSON number holds exactly.
//! - **stdin**: one command per line. Closing stdin means stop.

use crate::json::Json;

pub const PROTOCOL: &str = "akou-capture/1";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const MAGIC: &[u8; 4] = b"AKP1";
pub const HEADER_BYTES: usize = 28;
/// Every packet sample is at this rate.
pub const RATE: u32 = 16_000;
/// A packet longer than this is a protocol error on the app side.
pub const MAX_PACKET_FRAMES: usize = RATE as usize * 10;
pub const FLAG_ZERO_FILLED: u8 = 1;

/// sysexits codes (DESIGN 2.4), the same table as `EXIT` in protocol.ts.
pub mod exit {
    pub const OK: i32 = 0;
    pub const USAGE: i32 = 64;
    pub const NO_DEVICE: i32 = 66;
    pub const UNAVAILABLE: i32 = 69;
    pub const SOFTWARE: i32 = 70;
    pub const IO: i32 = 74;
    pub const PERMISSION: i32 = 77;
}

/// The two channels. The discriminant is the wire code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Ch {
    Mic = 0,
    Call = 1,
}

impl Ch {
    pub const BOTH: [Ch; 2] = [Ch::Mic, Ch::Call];

    pub fn name(self) -> &'static str {
        match self {
            Ch::Mic => "mic",
            Ch::Call => "call",
        }
    }

    pub fn index(self) -> usize {
        self as usize
    }
}

/// Appends one packet to `out`.
pub fn encode_packet(
    out: &mut Vec<u8>,
    ch: Ch,
    zero_filled: bool,
    capture_ns: u64,
    file_seconds: f64,
    samples: &[f32],
) {
    debug_assert!(samples.len() <= MAX_PACKET_FRAMES);
    out.reserve(HEADER_BYTES + samples.len() * 4);
    out.extend_from_slice(MAGIC);
    out.push(ch as u8);
    out.push(if zero_filled { FLAG_ZERO_FILLED } else { 0 });
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&capture_ns.to_le_bytes());
    out.extend_from_slice(&file_seconds.to_le_bytes());
    out.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
}

/// A decoded packet (tests and tools read the helper's own output with this).
#[derive(Clone, Debug, PartialEq)]
pub struct Packet {
    pub ch: Ch,
    pub zero_filled: bool,
    pub capture_ns: u64,
    pub file_seconds: f64,
    pub samples: Vec<f32>,
}

/// Decodes every complete packet in `bytes`; returns them and the bytes consumed.
pub fn decode_packets(bytes: &[u8]) -> Result<(Vec<Packet>, usize), String> {
    let mut out = Vec::new();
    let mut pos = 0;
    while bytes.len() - pos >= HEADER_BYTES {
        let h = &bytes[pos..pos + HEADER_BYTES];
        if &h[0..4] != MAGIC {
            return Err(format!("bad packet magic at byte {pos}"));
        }
        let ch = match h[4] {
            0 => Ch::Mic,
            1 => Ch::Call,
            c => return Err(format!("bad channel {c} at byte {pos}")),
        };
        let frames = u32::from_le_bytes(h[24..28].try_into().expect("4 bytes")) as usize;
        if frames > MAX_PACKET_FRAMES {
            return Err(format!("packet of {frames} frames at byte {pos}"));
        }
        let total = HEADER_BYTES + frames * 4;
        if bytes.len() - pos < total {
            break;
        }
        let body = &bytes[pos + HEADER_BYTES..pos + total];
        out.push(Packet {
            ch,
            zero_filled: h[5] & FLAG_ZERO_FILLED != 0,
            capture_ns: u64::from_le_bytes(h[8..16].try_into().expect("8 bytes")),
            file_seconds: f64::from_le_bytes(h[16..24].try_into().expect("8 bytes")),
            samples: body
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().expect("4 bytes")))
                .collect(),
        });
        pos += total;
    }
    Ok((out, pos))
}

// ---------------------------------------------------------------------------
// stderr messages

#[derive(Clone, Debug, PartialEq)]
pub struct MicInfo {
    pub id: String,
    pub name: String,
    pub rate: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CallInfo {
    pub mode: String,
    pub rate: u32,
}

fn ns(v: u64) -> Json {
    Json::Str(v.to_string())
}

pub fn hello(caps: &[&str]) -> String {
    Json::obj(vec![
        ("type", Json::str("hello")),
        ("protocol", Json::str(PROTOCOL)),
        ("version", Json::str(VERSION)),
        (
            "caps",
            Json::Arr(caps.iter().map(|c| Json::str(*c)).collect()),
        ),
    ])
    .to_line()
}

pub fn capturing(
    mic: Option<&MicInfo>,
    call: Option<&CallInfo>,
    exclude: &[String],
    capture_ns: u64,
) -> String {
    Json::obj(vec![
        ("type", Json::str("capturing")),
        (
            "mic",
            mic.map_or(Json::Null, |m| {
                Json::obj(vec![
                    ("id", Json::str(&m.id)),
                    ("name", Json::str(&m.name)),
                    ("rate", Json::Int(m.rate.into())),
                ])
            }),
        ),
        (
            "call",
            call.map_or(Json::Null, |c| {
                Json::obj(vec![
                    ("mode", Json::str(&c.mode)),
                    ("rate", Json::Int(c.rate.into())),
                ])
            }),
        ),
        (
            "exclude",
            Json::Arr(exclude.iter().map(Json::str).collect()),
        ),
        ("capture_ns", ns(capture_ns)),
    ])
    .to_line()
}

pub fn first_audio(ch: Ch, capture_ns: u64) -> String {
    Json::obj(vec![
        ("type", Json::str("first_audio")),
        ("ch", Json::str(ch.name())),
        ("capture_ns", ns(capture_ns)),
    ])
    .to_line()
}

pub fn level(mic_dbfs: f64, call_dbfs: f64) -> String {
    Json::obj(vec![
        ("type", Json::str("level")),
        ("mic_dbfs", Json::Num(mic_dbfs)),
        ("call_dbfs", Json::Num(call_dbfs)),
    ])
    .to_line()
}

pub fn health(ch: Ch, state: &str, silent_for: f64, rebuilds: u32, detail: &str) -> String {
    Json::obj(vec![
        ("type", Json::str("health")),
        ("ch", Json::str(ch.name())),
        ("state", Json::str(state)),
        ("silent_for", Json::Num(silent_for)),
        ("rebuilds", Json::Int(rebuilds.into())),
        ("detail", Json::str(detail)),
    ])
    .to_line()
}

pub fn device(ch: Ch, event: &str, name: &str) -> String {
    Json::obj(vec![
        ("type", Json::str("device")),
        ("ch", Json::str(ch.name())),
        ("event", Json::str(event)),
        ("name", Json::str(name)),
    ])
    .to_line()
}

pub fn warn(code: &str, msg: &str) -> String {
    Json::obj(vec![
        ("type", Json::str("warn")),
        ("code", Json::str(code)),
        ("msg", Json::str(msg)),
    ])
    .to_line()
}

pub fn stopped(file_seconds: f64, reason: &str) -> String {
    Json::obj(vec![
        ("type", Json::str("stopped")),
        ("file_seconds", Json::Num(file_seconds)),
        ("reason", Json::str(reason)),
    ])
    .to_line()
}

/// The one stdout line of `akou-capture devices`.
pub fn devices(list: &crate::source::Endpoints) -> String {
    let side = |eps: &[crate::source::Endpoint]| {
        Json::Arr(
            eps.iter()
                .map(|e| {
                    Json::obj(vec![
                        ("id", Json::str(&e.id)),
                        ("name", Json::str(&e.name)),
                        ("default", Json::Bool(e.default)),
                    ])
                })
                .collect(),
        )
    };
    Json::obj(vec![
        ("type", Json::str("devices")),
        ("backend", Json::str(list.backend)),
        ("inputs", side(&list.inputs)),
        ("outputs", side(&list.outputs)),
    ])
    .to_line()
}

// ---------------------------------------------------------------------------
// stdin commands

/// The commands `HelperCommand` in protocol.ts can send, plus `mute`/`unmute`, which zero the
/// mic channel in the file and the packets. The app mutes on its side today and does not send
/// them; the helper accepts them so a mute can also keep the mic out of the recording.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    ProbeCall,
    RebuildCall,
    RebuildMic,
    Stop,
    Pause,
    Resume,
    Mute,
    Unmute,
}

impl Command {
    pub fn parse(line: &str) -> Option<Command> {
        Some(match line.trim() {
            "probe_call" => Command::ProbeCall,
            "rebuild_call" => Command::RebuildCall,
            "rebuild_mic" => Command::RebuildMic,
            "stop" => Command::Stop,
            "pause" => Command::Pause,
            "resume" => Command::Resume,
            "mute" => Command::Mute,
            "unmute" => Command::Unmute,
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `encodePacket` in protocol.ts for the same packet, as hex.
    const TS_PACKET: &str =
        "414b5031010100004ef330a64b9bb6010000000000002940030000000000003f000080be0000803f";

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn a_packet_is_byte_identical_to_the_typescript_encoder() {
        let mut out = Vec::new();
        encode_packet(
            &mut out,
            Ch::Call,
            true,
            123_456_789_012_345_678,
            12.5,
            &[0.5, -0.25, 1.0],
        );
        assert_eq!(hex(&out), TS_PACKET);
        let (packets, used) = decode_packets(&out).unwrap();
        assert_eq!(used, out.len());
        assert_eq!(packets[0].samples, vec![0.5, -0.25, 1.0]);
        assert!(packets[0].zero_filled);
        assert_eq!(packets[0].capture_ns, 123_456_789_012_345_678);
    }

    #[test]
    fn decoding_keeps_a_split_packet_for_later_and_rejects_bad_framing() {
        let mut out = Vec::new();
        encode_packet(&mut out, Ch::Mic, false, 1, 0.0, &[0.1; 10]);
        let (p, used) = decode_packets(&out[..out.len() - 1]).unwrap();
        assert!(p.is_empty());
        assert_eq!(used, 0);
        let mut bad = out.clone();
        bad[4] = 2;
        assert!(decode_packets(&bad).is_err());
        bad = out.clone();
        bad[0] = b'X';
        assert!(decode_packets(&bad).is_err());
    }

    /// DESIGN 2.4 carries one line of each message exactly as the app parses them; the helper
    /// must write the same bytes for the same values.
    #[test]
    fn stderr_lines_match_the_design_block_byte_for_byte() {
        let design =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/DESIGN.md"))
                .expect("docs/DESIGN.md")
                .replace("\r\n", "\n");
        let start = design.find("```jsonl\n").expect("jsonl block") + "```jsonl\n".len();
        let end = start + design[start..].find("```").expect("block end");
        let lines: Vec<&str> = design[start..end].lines().collect();
        let hello_line = Json::obj(vec![
            ("type", Json::str("hello")),
            ("protocol", Json::str(PROTOCOL)),
            ("version", Json::str("0.1.0")),
            ("caps", Json::Arr(vec![Json::str("tap")])),
        ])
        .to_line();
        let ours = vec![
            hello_line,
            capturing(
                Some(&MicInfo {
                    id: "default".into(),
                    name: "MacBook Pro Microphone".into(),
                    rate: 48000,
                }),
                Some(&CallInfo {
                    mode: "system".into(),
                    rate: 48000,
                }),
                &["akou Graphics and Media".to_string()],
                123_456_789_012_345_678,
            ),
            first_audio(Ch::Mic, 123_456_789_032_345_678),
            level(-20.5, -31.0),
            health(
                Ch::Call,
                "dead",
                12.0,
                1,
                "output running, tap delivers zeros",
            ),
            device(Ch::Mic, "changed", "USB Microphone"),
            warn(
                "permission-suspect",
                "open System Settings > Privacy & Security > Screen & System Audio Recording",
            ),
            stopped(12.5, "stop"),
        ];
        assert_eq!(lines, ours);
        // The hello this build writes differs from the example only in its version.
        assert!(
            hello(&["tap"])
                .starts_with(r#"{"type":"hello","protocol":"akou-capture/1","version":""#)
        );
    }

    #[test]
    fn commands() {
        assert_eq!(Command::parse("stop\r"), Some(Command::Stop));
        assert_eq!(Command::parse(" pause "), Some(Command::Pause));
        assert_eq!(Command::parse("rebuild_call"), Some(Command::RebuildCall));
        assert_eq!(Command::parse("mute"), Some(Command::Mute));
        assert_eq!(Command::parse("dance"), None);
    }
}
