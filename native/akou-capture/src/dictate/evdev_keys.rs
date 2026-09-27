//! Linux evdev key codes as `keys` names, the capability bits that tell a keyboard from a mouse,
//! and what one device's events do to the gate (DC-N1, DC-A6), with no OS call, so every OS
//! tests what the Linux reader (`linux`) does.
//!
//! - A key is named by its evdev code (`linux/input-event-codes.h`), which is a place on the
//!   keyboard, like macOS's ANSI codes: `KEY_A` is the key labelled A on a US keyboard, whatever
//!   the layout types there. A chord hotkey is a place the user presses without looking.
//! - The Super keys are the Command family (`keys::modifier` reads `LeftSuper` as
//!   `LeftCommand`), Alt the Option family.
//! - Mouse buttons: `BTN_MIDDLE` is `Mouse3`; the back button is `Mouse4` and the forward button
//!   `Mouse5`, as Windows numbers them, whether the mouse reports them as `BTN_SIDE` and
//!   `BTN_EXTRA` or as `BTN_BACK` and `BTN_FORWARD`. Left and right never reach a binding.
//! - An event of value 2 is the kernel's auto-repeat of a key already down: it is dropped here.
//! - `SYN_DROPPED` means the device's buffer overflowed and events were lost. Everything up to the
//!   next `SYN_REPORT` is dropped, then the gate is resynced from the keys the device says are down
//!   now, the same `TapEvent::Disabled` a disabled macOS tap sends, so a hotkey released in the
//!   gap does not stick.

use super::tap::{Gate, TapEvent};

pub const EV_SYN: u16 = 0x00;
pub const EV_KEY: u16 = 0x01;
pub const SYN_REPORT: u16 = 0;
pub const SYN_DROPPED: u16 = 3;
/// The highest key code, so `EVIOCGKEY` answers `KEY_MAX / 8 + 1` bytes.
pub const KEY_MAX: u16 = 0x2ff;

const KEY_SPACE: u16 = 57;

/// Rows of letters and the other runs of consecutive codes: first code, names.
const RUNS: [(u16, &[&str]); 6] = [
    (2, &["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]),
    (16, &["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"]),
    (30, &["A", "S", "D", "F", "G", "H", "J", "K", "L"]),
    (44, &["Z", "X", "C", "V", "B", "N", "M"]),
    (
        59,
        &["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"],
    ),
    (
        183,
        &[
            "F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
        ],
    ),
];

/// The other keys, named as `mac_keys` and `win_keys` name them, so a binding reads the same.
const KEYS: [(u16, &str); 51] = [
    (1, "Escape"),
    (12, "Minus"),
    (13, "Equal"),
    (14, "Backspace"),
    (15, "Tab"),
    (26, "LeftBracket"),
    (27, "RightBracket"),
    (28, "Return"),
    (39, "Semicolon"),
    (40, "Quote"),
    (41, "Grave"),
    (43, "Backslash"),
    (51, "Comma"),
    (52, "Period"),
    (53, "Slash"),
    (55, "KeypadMultiply"),
    (KEY_SPACE, "Space"),
    (58, "CapsLock"),
    (69, "NumLock"),
    (70, "ScrollLock"),
    (71, "Keypad7"),
    (72, "Keypad8"),
    (73, "Keypad9"),
    (74, "KeypadMinus"),
    (75, "Keypad4"),
    (76, "Keypad5"),
    (77, "Keypad6"),
    (78, "KeypadPlus"),
    (79, "Keypad1"),
    (80, "Keypad2"),
    (81, "Keypad3"),
    (82, "Keypad0"),
    (83, "KeypadDecimal"),
    (86, "IntlBackslash"),
    (87, "F11"),
    (88, "F12"),
    (96, "KeypadEnter"),
    (98, "KeypadDivide"),
    (99, "PrintScreen"),
    (102, "Home"),
    (103, "Up"),
    (104, "PageUp"),
    (105, "Left"),
    (106, "Right"),
    (107, "End"),
    (108, "Down"),
    (109, "PageDown"),
    (110, "Insert"),
    (111, "Delete"),
    (117, "KeypadEquals"),
    (127, "ContextMenu"),
];

/// Keys a media keyboard adds.
const MORE_KEYS: [(u16, &str); 5] = [
    (113, "Mute"),
    (114, "VolumeDown"),
    (115, "VolumeUp"),
    (119, "Pause"),
    (138, "Help"),
];

const MODIFIERS: [(u16, &str); 8] = [
    (29, "LeftControl"),
    (97, "RightControl"),
    (42, "LeftShift"),
    (54, "RightShift"),
    (56, "LeftAlt"),
    (100, "RightAlt"),
    (125, "LeftSuper"),
    (126, "RightSuper"),
];

const BUTTONS: [(u16, &str); 5] = [
    (0x112, "Mouse3"),
    (0x113, "Mouse4"),
    (0x114, "Mouse5"),
    (0x116, "Mouse4"),
    (0x115, "Mouse5"),
];

fn named() -> impl Iterator<Item = (u16, &'static str)> {
    RUNS.iter()
        .flat_map(|(first, names)| (*first..).zip(names.iter().copied()))
        .chain(KEYS.iter().copied())
        .chain(MORE_KEYS.iter().copied())
        .chain(MODIFIERS.iter().copied())
        .chain(BUTTONS.iter().copied())
}

/// The name of an evdev key or button code; `None` for a code no binding can name, and for the
/// left and right mouse buttons.
pub fn key_name(code: u16) -> Option<&'static str> {
    named().find(|(c, _)| *c == code).map(|(_, n)| n)
}

/// What a device is to dictation, from its `EV_KEY` capability bits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// It has a space bar or a modifier: read it always.
    Keyboard,
    /// It has a middle or side button and no keys: read it only while a mouse button is bound or
    /// the recorder is open, since it also reports every move.
    Mouse,
    /// A power button, a lid switch, a headset's buttons: never read.
    Other,
}

/// The bits of a sysfs `capabilities/key` file: hexadecimal words, the most significant first,
/// each as wide as the kernel's `long` (`word_bits`). Returns the words least significant first.
pub fn parse_bits(text: &str) -> Vec<u64> {
    let mut words: Vec<u64> = text
        .split_whitespace()
        .map(|w| u64::from_str_radix(w, 16).unwrap_or(0))
        .collect();
    words.reverse();
    words
}

pub fn has_bit(words: &[u64], word_bits: u32, bit: u16) -> bool {
    let (i, b) = (
        usize::from(bit) / word_bits as usize,
        u32::from(bit) % word_bits,
    );
    words.get(i).is_some_and(|w| w >> b & 1 == 1)
}

/// A device's kind from its sysfs `capabilities/key` text (`word_bits` is 64 on a 64-bit kernel).
pub fn kind(key_caps: &str, word_bits: u32) -> Kind {
    let bits = parse_bits(key_caps);
    let has = |c: u16| has_bit(&bits, word_bits, c);
    if has(KEY_SPACE) || MODIFIERS.iter().any(|(c, _)| has(*c)) {
        Kind::Keyboard
    } else if BUTTONS.iter().any(|(c, _)| has(*c)) {
        Kind::Mouse
    } else {
        Kind::Other
    }
}

/// The names of the keys set in an `EVIOCGKEY` answer (one bit per code, byte by byte).
pub fn held_names(bits: &[u8]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (i, byte) in bits.iter().enumerate() {
        for b in 0..8 {
            if byte >> b & 1 == 1
                && let Ok(code) = u16::try_from(i * 8 + b)
                && let Some(n) = key_name(code)
                && !out.iter().any(|o| o == n)
            {
                out.push(n.to_string());
            }
        }
    }
    out
}

/// One device's reading state.
#[derive(Debug, Default)]
pub struct Device {
    /// Between a `SYN_DROPPED` and the next `SYN_REPORT`: the events are incomplete.
    dropping: bool,
}

impl Device {
    /// One event from this device. `held` answers the keys every device says are down now, and is
    /// asked only to resync after lost events.
    pub fn event(
        &mut self,
        gate: &Gate,
        (kind, code, value): (u16, u16, i32),
        t_ns: u64,
        held: &mut dyn FnMut() -> Vec<String>,
    ) {
        if kind == EV_SYN && code == SYN_DROPPED {
            self.dropping = true;
            return;
        }
        if self.dropping {
            if kind == EV_SYN && code == SYN_REPORT {
                self.dropping = false;
                let now = held();
                gate.event(TapEvent::Disabled { t_ns, held: &now });
            }
            return;
        }
        if kind != EV_KEY || !matches!(value, 0 | 1) {
            return;
        }
        if let Some(name) = key_name(code) {
            gate.event(TapEvent::Key {
                down: value == 1,
                name,
                t_ns,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::activation::{Action, Activation, Mode};
    use super::super::insert::Os;
    use super::super::keys::{self, Hotkey};
    use super::super::tap::Note;
    use super::*;

    const MS: u64 = 1_000_000;
    const BTN_LEFT: u16 = 0x110;
    const BTN_RIGHT: u16 = 0x111;

    fn gate(hotkey: &str) -> Gate {
        Gate::new(
            Activation::new(Hotkey::parse(hotkey).unwrap(), Mode::HoldOrToggle),
            Os::Linux,
        )
    }

    fn acts(g: &Gate) -> Vec<Action> {
        std::mem::take(&mut g.lock().queue)
            .into_iter()
            .filter_map(|(_, n)| match n {
                Note::Act(a) => Some(a),
                _ => None,
            })
            .collect()
    }

    fn feed(g: &Gate, d: &mut Device, events: &[(u16, u16, i32, u64)], held: &[&str]) {
        let mut asked = || held.iter().map(|s| s.to_string()).collect();
        for &(k, c, v, ms) in events {
            d.event(g, (k, c, v), ms * MS, &mut asked);
        }
    }

    #[test]
    fn every_code_has_one_name_and_every_name_one_code() {
        let all: Vec<(u16, &str)> = named().filter(|(c, _)| *c < 0x100).collect();
        for (i, (c, n)) in all.iter().enumerate() {
            assert!(
                !all[i + 1..]
                    .iter()
                    .any(|(c2, n2)| c2 == c || keys::same(n, n2)),
                "{c} {n} twice"
            );
            assert_eq!(key_name(*c), Some(*n));
        }
        for (_, n) in MODIFIERS {
            assert!(keys::is_modifier(n), "{n} reads as no modifier");
        }
        assert!(keys::same("LeftSuper", "LeftCommand"));
        assert!(keys::same("RightAlt", "RightOption"));
        assert_eq!(key_name(30), Some("A"));
        assert_eq!(key_name(50), Some("M"));
        assert_eq!(key_name(11), Some("0"));
        assert_eq!(key_name(68), Some("F10"));
        assert_eq!(key_name(194), Some("F24"));
        assert_eq!(key_name(0), None, "KEY_RESERVED");
        assert_eq!(key_name(116), None, "the power key is no binding");
    }

    /// DC-A6: the middle and both side buttons are bindings under either pair of side-button
    /// codes; left and right name nothing.
    #[test]
    fn only_the_middle_and_side_buttons_are_bindings() {
        assert_eq!(key_name(0x112), Some("Mouse3"));
        assert_eq!(key_name(0x113), Some("Mouse4"));
        assert_eq!(key_name(0x116), Some("Mouse4"), "BTN_BACK");
        assert_eq!(key_name(0x114), Some("Mouse5"));
        assert_eq!(key_name(0x115), Some("Mouse5"), "BTN_FORWARD");
        assert_eq!(key_name(BTN_LEFT), None);
        assert_eq!(key_name(BTN_RIGHT), None);
        assert!(Hotkey::parse(key_name(0x113).unwrap()).is_ok());
    }

    /// DC-N1 on Linux: press and release of a chord from a fake evdev source both reach the
    /// session, and so do a modifier-only key's press and release across two keyboards.
    #[test]
    fn dc_n1_press_and_release_from_evdev_reach_the_session() {
        let g = gate("Control+Shift+Space");
        let mut d = Device::default();
        feed(
            &g,
            &mut d,
            &[
                (EV_KEY, 29, 1, 0),
                (EV_SYN, SYN_REPORT, 0, 0),
                (EV_KEY, 42, 1, 10),
                (EV_KEY, KEY_SPACE, 1, 20),
                (EV_KEY, KEY_SPACE, 0, 900),
            ],
            &[],
        );
        let a = acts(&g);
        assert!(a.contains(&Action::Start { t_ns: 20 * MS }), "{a:?}");
        assert!(a.contains(&Action::End { reason: "release" }), "{a:?}");

        let g = gate("RightSuper");
        let (mut one, mut two) = (Device::default(), Device::default());
        feed(&g, &mut one, &[(EV_KEY, 126, 1, 0)], &[]);
        g.lock().act.tick(400 * MS, &mut Vec::new());
        feed(&g, &mut two, &[(EV_KEY, 30, 1, 450)], &[]);
        feed(&g, &mut one, &[(EV_KEY, 126, 0, 900)], &[]);
        let a = acts(&g);
        assert!(
            a.contains(&Action::End { reason: "release" }),
            "the release ends the hold: {a:?}"
        );
    }

    /// DC-A6 on Linux: a side button from a fake mouse runs a session.
    #[test]
    fn dc_a6_a_side_button_runs_a_session() {
        let g = gate("Mouse4");
        let mut d = Device::default();
        feed(&g, &mut d, &[(EV_KEY, 0x116, 1, 0)], &[]);
        g.lock().act.tick(400 * MS, &mut Vec::new());
        assert!(g.lock().act.is_listening());
        feed(&g, &mut d, &[(EV_KEY, 0x116, 0, 900)], &[]);
        assert!(acts(&g).contains(&Action::End { reason: "release" }));
        feed(&g, &mut d, &[(EV_KEY, BTN_LEFT, 1, 1000)], &[]);
        assert!(g.lock().act.held().is_empty(), "a left click is not seen");
    }

    /// Events lost to a full buffer: the hotkey released in the gap goes up at the next report
    /// instead of sticking, and the partial events before that report never reach the gate.
    /// A key still down stays down (positive control).
    #[test]
    fn dc_n1_lost_events_resync_from_the_keys_down_now() {
        let g = gate("RightControl");
        let mut d = Device::default();
        feed(&g, &mut d, &[(EV_KEY, 97, 1, 0)], &[]);
        g.lock().act.tick(400 * MS, &mut Vec::new());
        acts(&g);
        feed(
            &g,
            &mut d,
            &[
                (EV_SYN, SYN_DROPPED, 0, 500),
                (EV_KEY, 30, 1, 510),
                (EV_SYN, SYN_REPORT, 0, 520),
            ],
            &[],
        );
        let q = std::mem::take(&mut g.lock().queue);
        assert!(
            q.contains(&(520 * MS, Note::Act(Action::End { reason: "release" }))),
            "{q:?}"
        );
        assert!(g.lock().act.held().is_empty(), "A was lost, never seen");

        let g = gate("RightControl");
        let mut d = Device::default();
        feed(&g, &mut d, &[(EV_KEY, 97, 1, 0)], &[]);
        feed(
            &g,
            &mut d,
            &[(EV_SYN, SYN_DROPPED, 0, 100), (EV_SYN, SYN_REPORT, 0, 110)],
            &["RightControl"],
        );
        assert_eq!(g.lock().act.held(), ["RightControl"]);
    }

    /// Auto-repeat (value 2) is neither a press nor a release: a held hotkey that repeats stays
    /// held, and its session goes on.
    #[test]
    fn auto_repeat_is_neither_a_press_nor_a_release() {
        let g = gate("RightControl");
        let mut d = Device::default();
        feed(&g, &mut d, &[(EV_KEY, 97, 1, 0)], &[]);
        g.lock().act.tick(400 * MS, &mut Vec::new());
        feed(
            &g,
            &mut d,
            &[(EV_KEY, 97, 2, 450), (EV_KEY, 97, 2, 500)],
            &[],
        );
        assert!(g.lock().act.is_listening(), "a repeat is no release");
        assert!(!acts(&g).contains(&Action::End { reason: "release" }));
        feed(&g, &mut d, &[(EV_KEY, 97, 0, 900)], &[]);
        assert!(acts(&g).contains(&Action::End { reason: "release" }));
    }

    /// A keyboard is read, a mouse only as a mouse, a power button never. The words are those of
    /// a 64-bit kernel, the most significant first.
    #[test]
    fn a_device_kind_comes_from_its_key_bits() {
        // A full keyboard: every code up to 0x7f and a few more.
        let keyboard = "1 0 0 0 0 0 fffffffffffffffe";
        assert_eq!(kind(keyboard, 64), Kind::Keyboard);
        // A mouse: BTN_LEFT to BTN_EXTRA (0x110 to 0x114) in word 4.
        let mouse = "1f0000 0 0 0 0";
        assert_eq!(kind(mouse, 64), Kind::Mouse);
        // The power button: KEY_POWER (116) alone.
        let power = "10000000000000 0";
        assert_eq!(kind(power, 64), Kind::Other);
        assert_eq!(kind("", 64), Kind::Other);
        assert!(has_bit(&parse_bits(power), 64, 116));
        assert!(!has_bit(&parse_bits(power), 64, 115));
    }

    #[test]
    fn the_keys_down_now_come_from_the_bitmask() {
        let mut bits = vec![0u8; usize::from(KEY_MAX) / 8 + 1];
        for code in [29u16, 57, 0x113] {
            bits[usize::from(code) / 8] |= 1 << (code % 8);
        }
        assert_eq!(held_names(&bits), ["LeftControl", "Space", "Mouse4"]);
        assert!(held_names(&[0; 96]).is_empty());
    }
}
