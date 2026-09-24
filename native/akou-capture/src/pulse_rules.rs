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
}
