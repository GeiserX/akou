//! What the Linux front end decides before it talks to the sound server (DESIGN 2.2), as pure
//! functions, so every OS runs their tests.

use crate::health::device_watch::{MicTarget, mic_target};
use crate::source::OpenError;

/// A source as the server lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceView {
    pub name: String,
    pub description: String,
    /// The sink this source is the monitor of: it carries what that output plays.
    pub monitor_of: Option<String>,
}

/// The microphone to record: the source name, and the pinned id that was not found when the
/// default stands in for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MicPick {
    pub source: String,
    pub fallback_from: Option<String>,
}

/// Picks the microphone. Monitors are outputs, never microphones: a pinned id that names one is
/// treated as absent, and a default input that is a monitor (a machine with no microphone, whose
/// server then defaults to the output's monitor) is refused, because recording it would put the
/// call on the mic channel too.
pub fn pick_mic(
    requested: &str,
    sources: &[SourceView],
    default_source: Option<&str>,
) -> Result<MicPick, OpenError> {
    let mics: Vec<String> = sources
        .iter()
        .filter(|s| s.monitor_of.is_none())
        .map(|s| s.name.clone())
        .collect();
    let fallback_from = match mic_target(requested, &mics) {
        MicTarget::Pinned(id) => {
            return Ok(MicPick {
                source: id,
                fallback_from: None,
            });
        }
        MicTarget::Default => None,
        MicTarget::FallbackFromPinned(id) => Some(id),
    };
    let Some(d) = default_source.filter(|d| !d.is_empty()) else {
        return Err(OpenError::no_device(
            "the sound server has no default input",
        ));
    };
    if let Some(of) = sources
        .iter()
        .find(|s| s.name == d)
        .and_then(|s| s.monitor_of.as_deref())
    {
        return Err(OpenError::no_device(format!(
            "the default input is the monitor of the output {of}, not a microphone"
        )));
    }
    Ok(MicPick {
        source: d.to_string(),
        fallback_from,
    })
}

/// Bytes the server gathers before it sends a record stream's data: 20 ms of 32-bit float
/// frames at the source's own rate and channel count.
pub fn fragment_bytes(rate: u32, channels: u8) -> u32 {
    (rate / 50).max(1) * channels.max(1) as u32 * 4
}

/// Cuts a byte stream into whole frames. The server may split a buffer anywhere; converting a
/// partial frame would swap the channels of everything after it.
pub struct Framer {
    frame: usize,
    rest: Vec<u8>,
}

impl Framer {
    pub fn new(frame_bytes: usize) -> Self {
        Framer {
            frame: frame_bytes.max(1),
            rest: Vec::new(),
        }
    }

    /// Appends to `out` every whole frame now available and keeps the remainder.
    pub fn push(&mut self, data: &[u8], out: &mut Vec<u8>) {
        self.rest.extend_from_slice(data);
        let whole = self.rest.len() / self.frame * self.frame;
        out.extend_from_slice(&self.rest[..whole]);
        self.rest.drain(..whole);
    }
}

/// Audio a stream delivers at its first open before its buffers are used: enough delivery
/// periods for the lowest arrival to have come, whatever the server's quantum (1024 frames
/// against our 20 ms fragments repeats every 320 ms). It comes before `capturing`.
pub const SETTLE_S: f64 = 0.4;

/// The first-open hold-back. The aligner places a source by its first buffer, so at the first
/// open (before `capturing`) buffers are held back until the arrival stamps have settled, or the
/// whole stream would sit up to a delivery period late. The hold-back ends when the stamps have
/// settled, when a gap restarted the clock (the first words after a silence are never held
/// back), or when `open` has stopped waiting for the settle (`released`): from then on
/// `capturing` is said, and every buffer belongs to the part.
pub struct Settle {
    holding: bool,
}

impl Settle {
    /// `settle` is false for a rebuild, which forwards at once.
    pub fn new(settle: bool) -> Self {
        Settle { holding: settle }
    }

    /// Whether this buffer is forwarded.
    pub fn forward(&mut self, seen_s: f64, restarts: u64, released: bool) -> bool {
        if self.holding && (released || seen_s >= SETTLE_S || restarts > 0) {
            self.holding = false;
        }
        !self.holding
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(name: &str, monitor_of: Option<&str>) -> SourceView {
        SourceView {
            name: name.into(),
            description: format!("{name} description"),
            monitor_of: monitor_of.map(String::from),
        }
    }

    fn sources() -> Vec<SourceView> {
        vec![
            src(
                "alsa_output.pci.analog-stereo.monitor",
                Some("alsa_output.pci.analog-stereo"),
            ),
            src("alsa_input.pci.analog-stereo", None),
            src("alsa_input.usb-headset.mono", None),
        ]
    }

    #[test]
    fn the_default_or_a_pinned_microphone_is_recorded() {
        let s = sources();
        let d = Some("alsa_input.pci.analog-stereo");
        assert_eq!(
            pick_mic("default", &s, d).unwrap(),
            MicPick {
                source: "alsa_input.pci.analog-stereo".into(),
                fallback_from: None
            }
        );
        assert_eq!(
            pick_mic("alsa_input.usb-headset.mono", &s, d)
                .unwrap()
                .source,
            "alsa_input.usb-headset.mono"
        );
    }

    #[test]
    fn a_vanished_pinned_microphone_falls_back_to_the_default_and_says_so() {
        let pick = pick_mic(
            "alsa_input.gone",
            &sources(),
            Some("alsa_input.pci.analog-stereo"),
        )
        .unwrap();
        assert_eq!(pick.source, "alsa_input.pci.analog-stereo");
        assert_eq!(pick.fallback_from.as_deref(), Some("alsa_input.gone"));
    }

    /// A monitor as the default input would record the call on both channels.
    #[test]
    fn a_monitor_is_never_the_microphone() {
        let s = sources();
        let e = pick_mic("default", &s, Some("alsa_output.pci.analog-stereo.monitor")).unwrap_err();
        assert_eq!(e.code, "no-device");
        assert!(e.msg.contains("monitor"), "{}", e.msg);
        // Pinning a monitor is a vanished pin: the default microphone is used instead.
        let pick = pick_mic(
            "alsa_output.pci.analog-stereo.monitor",
            &s,
            Some("alsa_input.pci.analog-stereo"),
        )
        .unwrap();
        assert_eq!(pick.source, "alsa_input.pci.analog-stereo");
        // Positive control: the same default that is not a monitor is accepted.
        assert!(pick_mic("default", &s, Some("alsa_input.usb-headset.mono")).is_ok());
        assert!(pick_mic("default", &s, None).is_err());
    }

    #[test]
    fn fragments_are_20_ms_of_float_frames_at_the_native_rate() {
        assert_eq!(fragment_bytes(48_000, 2), 960 * 2 * 4);
        assert_eq!(fragment_bytes(44_100, 1), 882 * 4);
    }

    #[test]
    fn a_buffer_split_inside_a_frame_keeps_the_channels_in_place() {
        // Stereo f32: 8-byte frames, fed in pieces of 3, 7 and 13 bytes.
        let bytes: Vec<u8> = (0..80u8).collect();
        let mut f = Framer::new(8);
        let mut out = Vec::new();
        let mut i = 0;
        for n in [3usize, 7, 13].iter().cycle() {
            if i >= bytes.len() {
                break;
            }
            let end = (i + n).min(bytes.len());
            let before = out.len();
            f.push(&bytes[i..end], &mut out);
            assert_eq!((out.len() - before) % 8, 0, "only whole frames come out");
            i = end;
        }
        assert_eq!(out, bytes);
    }

    /// A source that sends nothing during the settle wait (a null sink with nothing playing, a
    /// Bluetooth headset still switching profile): `open` gives up waiting and says `capturing`,
    /// and the first buffer after that is forwarded, not the first 0.4 s of it dropped.
    #[test]
    fn a_source_silent_through_the_settle_wait_forwards_its_first_buffer_after_capturing() {
        let mut s = Settle::new(true);
        // Before `capturing`, a stream that has only started is held back.
        assert!(!s.forward(0.02, 0, false));
        // Released: the next buffer, 20 ms into the stream, is forwarded.
        assert!(s.forward(0.04, 0, true));
        // Once forwarding, it stays forwarding.
        assert!(s.forward(0.06, 0, false));
        // Positive control: without the release the first 0.4 s after `capturing` are dropped.
        let mut held = Settle::new(true);
        let dropped = (1..=40)
            .filter(|k| !held.forward(*k as f64 * 0.02, 0, false))
            .count();
        assert_eq!(dropped, 19, "every buffer until 0.4 s of audio was seen");
    }

    #[test]
    fn the_hold_back_ends_on_settled_stamps_or_a_gap_and_a_rebuild_has_none() {
        let mut s = Settle::new(true);
        assert!(!s.forward(0.38, 0, false));
        assert!(s.forward(0.40, 0, false));
        let mut gap = Settle::new(true);
        assert!(gap.forward(0.02, 1, false));
        assert!(Settle::new(false).forward(0.0, 0, false));
    }
}
