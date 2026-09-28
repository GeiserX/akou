//! Which microphone dictation listens on (docs/ux/DICTATION.md DC-N5).
//!
//! - `dictation.mic` pinned to a device id wins while that device is listed.
//! - Otherwise the system default, except that with `dictation.preferBuiltInOverBluetooth` on (the
//!   default) a Bluetooth default gives way to the built-in mic when there is one: a Bluetooth
//!   headset that records drops to its low-quality profile, and the profile switch delays the
//!   first word. A MacBook with its lid closed hears nothing through its built-in mic, so a closed
//!   lid takes the built-in mic out of the list.
//! - A stream that dies (a device unplugged) is reopened on the next device in the order pinned,
//!   built-in, default, skipping the one that died, without ending the session in progress.
//!
//! The choice is a pure function of the device list, so the tests hold a fake list; each OS
//! backend only lists its inputs (`live::Device::inputs`).

use crate::json::Json;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    BuiltIn,
    Bluetooth,
    Other,
}

impl Transport {
    pub fn name(self) -> &'static str {
        match self {
            Transport::BuiltIn => "built-in",
            Transport::Bluetooth => "bluetooth",
            Transport::Other => "other",
        }
    }
}

/// One input device as the OS lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Input {
    /// The id `rebuild_mic` and `dictation.mic` name (the Core Audio device UID on macOS).
    pub id: String,
    pub transport: Transport,
    /// The system default input.
    pub default: bool,
}

/// Why this device: `pinned` (`dictation.mic`), `built-in` (instead of a Bluetooth default),
/// `default`, or `fallback` (the pinned device is gone, or the stream died and the next one took
/// over).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub id: String,
    pub transport: Transport,
    pub why: &'static str,
}

impl Choice {
    /// The device as `session.started` reports it, so the item records which mic it heard.
    pub fn json(&self) -> Json {
        Json::obj(vec![
            ("transport", Json::str(self.transport.name())),
            ("why", Json::str(self.why)),
        ])
    }
}

/// Linux: a PulseAudio or PipeWire source's transport, from its name. A Bluetooth headset's mic
/// is `bluez_input.*` (PipeWire) or `bluez_source.*` (PulseAudio). The name does not tell a
/// laptop's own mic from a desktop's empty line-in jack, so nothing else is taken for built-in.
pub fn pulse_transport(source: &str) -> Transport {
    if source.starts_with("bluez_") {
        Transport::Bluetooth
    } else {
        Transport::Other
    }
}

/// The settings the choice follows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// A device id, or `default` (or empty) for the system default.
    pub pinned: String,
    pub prefer_built_in: bool,
}

impl Default for Policy {
    fn default() -> Policy {
        Policy {
            pinned: "default".into(),
            prefer_built_in: true,
        }
    }
}

/// The device to open. `lid_closed` takes the built-in mic out; `avoid` holds the device whose
/// stream just died. `None` when nothing is listed that may be opened.
pub fn choose(inputs: &[Input], p: &Policy, lid_closed: bool, avoid: &[String]) -> Option<Choice> {
    let usable: Vec<&Input> = inputs
        .iter()
        .filter(|i| !avoid.contains(&i.id))
        .filter(|i| !(lid_closed && i.transport == Transport::BuiltIn))
        .collect();
    let pick = |i: &Input, why| Choice {
        id: i.id.clone(),
        transport: i.transport,
        why,
    };
    let pinned = !(p.pinned.is_empty() || p.pinned == "default");
    if pinned && let Some(i) = usable.iter().find(|i| i.id == p.pinned) {
        return Some(pick(i, "pinned"));
    }
    // A pinned device that is gone, or a stream that died: the next in the order pinned,
    // built-in, default.
    let fallback = pinned || !avoid.is_empty();
    let built_in = usable.iter().find(|i| i.transport == Transport::BuiltIn);
    let default = usable.iter().find(|i| i.default);
    if let Some(b) = built_in {
        if fallback {
            return Some(pick(b, "fallback"));
        }
        if p.prefer_built_in && default.is_some_and(|d| d.transport == Transport::Bluetooth) {
            return Some(pick(b, "built-in"));
        }
    }
    let why = if fallback { "fallback" } else { "default" };
    default.or_else(|| usable.first()).map(|i| pick(i, why))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(id: &str, transport: Transport, default: bool) -> Input {
        Input {
            id: id.into(),
            transport,
            default,
        }
    }

    /// A Bluetooth headset as the default, the built-in mic, and a USB mic.
    fn desk() -> Vec<Input> {
        vec![
            input("headset", Transport::Bluetooth, true),
            input("mac", Transport::BuiltIn, false),
            input("usb", Transport::Other, false),
        ]
    }

    fn policy(pinned: &str, prefer: bool) -> Policy {
        Policy {
            pinned: pinned.into(),
            prefer_built_in: prefer,
        }
    }

    fn chosen(c: Option<Choice>) -> (String, &'static str) {
        let c = c.expect("a device");
        (c.id, c.why)
    }

    /// DC-N5: a Bluetooth default and a built-in mic: the built-in one is opened, and the choice
    /// says why; with the setting off the default is opened (the positive control).
    #[test]
    fn dc_n5_the_built_in_mic_wins_over_a_bluetooth_default() {
        assert_eq!(
            chosen(choose(&desk(), &policy("default", true), false, &[])),
            ("mac".into(), "built-in")
        );
        assert_eq!(
            chosen(choose(&desk(), &policy("default", false), false, &[])),
            ("headset".into(), "default")
        );
        // A wired default is not Bluetooth: nothing to prefer over.
        let mut wired = desk();
        wired[0].transport = Transport::Other;
        assert_eq!(
            chosen(choose(&wired, &policy("", true), false, &[])),
            ("headset".into(), "default")
        );
    }

    /// DC-N5: a MacBook with its lid closed has no usable built-in mic, so the Bluetooth default
    /// is opened.
    #[test]
    fn dc_n5_a_closed_lid_keeps_the_bluetooth_default() {
        assert_eq!(
            chosen(choose(&desk(), &policy("default", true), true, &[])),
            ("headset".into(), "default")
        );
    }

    /// DC-N5: a pinned device wins while it is listed; once it is gone the order is built-in,
    /// then default.
    #[test]
    fn dc_n5_a_pinned_device_wins_and_falls_back_in_order() {
        assert_eq!(
            chosen(choose(&desk(), &policy("usb", true), false, &[])),
            ("usb".into(), "pinned")
        );
        let unplugged: Vec<Input> = desk().into_iter().filter(|i| i.id != "usb").collect();
        assert_eq!(
            chosen(choose(&unplugged, &policy("usb", false), false, &[])),
            ("mac".into(), "fallback")
        );
        assert_eq!(
            chosen(choose(&unplugged, &policy("usb", false), true, &[])),
            ("headset".into(), "fallback"),
            "lid closed: the default"
        );
    }

    /// DC-N5: the stream of the pinned device died but the device is still listed: the next one
    /// is the built-in mic, then the default; the dead one is never picked again.
    #[test]
    fn dc_n5_a_dead_stream_moves_to_the_next_device() {
        let p = policy("usb", true);
        assert_eq!(
            chosen(choose(&desk(), &p, false, &["usb".into()])),
            ("mac".into(), "fallback")
        );
        assert_eq!(
            chosen(choose(&desk(), &p, false, &["usb".into(), "mac".into()])),
            ("headset".into(), "fallback")
        );
        assert_eq!(
            choose(
                &desk(),
                &p,
                false,
                &["usb".into(), "mac".into(), "headset".into()]
            ),
            None
        );
        // The default died with nothing pinned: the built-in one, even with the setting off.
        assert_eq!(
            chosen(choose(
                &desk(),
                &policy("default", false),
                false,
                &["headset".into()]
            )),
            ("mac".into(), "fallback")
        );
    }

    /// DC-N4 and DC-N5 on Linux: a Bluetooth source is told by its name under both sound
    /// servers, so it is never kept warm; a wired or on-board source is `other`.
    #[test]
    fn a_linux_bluetooth_source_is_told_by_its_name() {
        for s in [
            "bluez_input.00_11_22_33_44_55.0",
            "bluez_source.00_11_22_33_44_55.handsfree_head_unit",
        ] {
            assert_eq!(pulse_transport(s), Transport::Bluetooth, "{s}");
        }
        for s in [
            "alsa_input.pci-0000_00_1f.3.analog-stereo",
            "alsa_input.usb-Blue_Yeti-00.analog-stereo",
            "default",
        ] {
            assert_eq!(pulse_transport(s), Transport::Other, "{s}");
        }
    }

    #[test]
    fn with_no_default_listed_any_input_is_better_than_none() {
        let odd = vec![input("usb", Transport::Other, false)];
        assert_eq!(
            chosen(choose(&odd, &Policy::default(), false, &[])),
            ("usb".into(), "default")
        );
        assert_eq!(choose(&[], &Policy::default(), false, &[]), None);
    }
}
