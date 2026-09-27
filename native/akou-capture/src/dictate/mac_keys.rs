//! macOS key codes and modifier flags as `keys` names (DC-N1), with no OS call, so every OS tests
//! the table the macOS tap reads.
//!
//! - A key is named by its ANSI position (`kVK_ANSI_*`), the way `CGEventTap` reports it: the
//!   key labelled C on a US keyboard is `C` on every layout. A chord hotkey is a place on the
//!   keyboard, which is what a user presses without looking.
//! - A modifier arrives as `FlagsChanged` with its key code. Whether it went down or up is read
//!   from the device-dependent flag bit of that side (`NX_DEVICE*KEYMASK`), never by toggling a
//!   remembered state: a release missed while the tap was disabled would otherwise invert every
//!   later press of that key.
//! - `Fn` has no device bit of its own; its state is the `SecondaryFn` flag.
//! - Mouse buttons are numbered from 0 by the OS: 2 is the middle button (`Mouse3`), 3 and 4 the
//!   side buttons (`Mouse4`, `Mouse5`). Left and right never reach a binding (DC-A6).

/// `kVK_*` key codes and their `keys` names. Modifiers are in `MODIFIERS`.
const KEYS: [(u16, &str); 105] = [
    (0x00, "A"),
    (0x01, "S"),
    (0x02, "D"),
    (0x03, "F"),
    (0x04, "H"),
    (0x05, "G"),
    (0x06, "Z"),
    (0x07, "X"),
    (0x08, "C"),
    (0x09, "V"),
    (0x0A, "Section"),
    (0x0B, "B"),
    (0x0C, "Q"),
    (0x0D, "W"),
    (0x0E, "E"),
    (0x0F, "R"),
    (0x10, "Y"),
    (0x11, "T"),
    (0x12, "1"),
    (0x13, "2"),
    (0x14, "3"),
    (0x15, "4"),
    (0x16, "6"),
    (0x17, "5"),
    (0x18, "Equal"),
    (0x19, "9"),
    (0x1A, "7"),
    (0x1B, "Minus"),
    (0x1C, "8"),
    (0x1D, "0"),
    (0x1E, "RightBracket"),
    (0x1F, "O"),
    (0x20, "U"),
    (0x21, "LeftBracket"),
    (0x22, "I"),
    (0x23, "P"),
    (0x24, "Return"),
    (0x25, "L"),
    (0x26, "J"),
    (0x27, "Quote"),
    (0x28, "K"),
    (0x29, "Semicolon"),
    (0x2A, "Backslash"),
    (0x2B, "Comma"),
    (0x2C, "Slash"),
    (0x2D, "N"),
    (0x2E, "M"),
    (0x2F, "Period"),
    (0x30, "Tab"),
    (0x31, "Space"),
    (0x32, "Grave"),
    (0x33, "Backspace"),
    (0x35, "Escape"),
    (0x39, "CapsLock"),
    (0x40, "F17"),
    (0x41, "KeypadDecimal"),
    (0x43, "KeypadMultiply"),
    (0x45, "KeypadPlus"),
    (0x47, "KeypadClear"),
    (0x48, "VolumeUp"),
    (0x49, "VolumeDown"),
    (0x4A, "Mute"),
    (0x4B, "KeypadDivide"),
    (0x4C, "KeypadEnter"),
    (0x4E, "KeypadMinus"),
    (0x4F, "F18"),
    (0x50, "F19"),
    (0x51, "KeypadEquals"),
    (0x52, "Keypad0"),
    (0x53, "Keypad1"),
    (0x54, "Keypad2"),
    (0x55, "Keypad3"),
    (0x56, "Keypad4"),
    (0x57, "Keypad5"),
    (0x58, "Keypad6"),
    (0x59, "Keypad7"),
    (0x5A, "F20"),
    (0x5B, "Keypad8"),
    (0x5C, "Keypad9"),
    (0x60, "F5"),
    (0x61, "F6"),
    (0x62, "F7"),
    (0x63, "F3"),
    (0x64, "F8"),
    (0x65, "F9"),
    (0x67, "F11"),
    (0x69, "F13"),
    (0x6A, "F16"),
    (0x6B, "F14"),
    (0x6D, "F10"),
    (0x6F, "F12"),
    (0x71, "F15"),
    (0x72, "Help"),
    (0x73, "Home"),
    (0x74, "PageUp"),
    (0x75, "Delete"),
    (0x76, "F4"),
    (0x77, "End"),
    (0x78, "F2"),
    (0x79, "PageDown"),
    (0x7A, "F1"),
    (0x7B, "Left"),
    (0x7C, "Right"),
    (0x7D, "Down"),
    (0x7E, "Up"),
];

/// `CGEventFlags` bits the tap reads.
pub mod flag {
    pub const LEFT_CONTROL: u64 = 0x0000_0001;
    pub const LEFT_SHIFT: u64 = 0x0000_0002;
    pub const RIGHT_SHIFT: u64 = 0x0000_0004;
    pub const LEFT_COMMAND: u64 = 0x0000_0008;
    pub const RIGHT_COMMAND: u64 = 0x0000_0010;
    pub const LEFT_OPTION: u64 = 0x0000_0020;
    pub const RIGHT_OPTION: u64 = 0x0000_0040;
    pub const RIGHT_CONTROL: u64 = 0x0000_2000;
    pub const SECONDARY_FN: u64 = 0x0080_0000;
    /// The side-independent masks (`kCGEventFlagMask*`) an app reads a shortcut from.
    pub const SHIFT: u64 = 0x0002_0000;
    pub const CONTROL: u64 = 0x0004_0000;
    pub const OPTION: u64 = 0x0008_0000;
    pub const COMMAND: u64 = 0x0010_0000;
}

/// The modifier keys: key code, name, and the device bit that says it is down.
const MODIFIERS: [(u16, &str, u64); 9] = [
    (0x36, "RightCommand", flag::RIGHT_COMMAND),
    (0x37, "LeftCommand", flag::LEFT_COMMAND),
    (0x38, "LeftShift", flag::LEFT_SHIFT),
    (0x3A, "LeftOption", flag::LEFT_OPTION),
    (0x3B, "LeftControl", flag::LEFT_CONTROL),
    (0x3C, "RightShift", flag::RIGHT_SHIFT),
    (0x3D, "RightOption", flag::RIGHT_OPTION),
    (0x3E, "RightControl", flag::RIGHT_CONTROL),
    (0x3F, "Fn", flag::SECONDARY_FN),
];

/// The name of a key that is not a modifier; `None` for a code no binding can name (Mission
/// Control's, a vendor key).
pub fn key_name(code: u16) -> Option<&'static str> {
    KEYS.iter().find(|(c, _)| *c == code).map(|(_, n)| *n)
}

/// A `FlagsChanged` event: which modifier it is and whether it is down now. `None` for a code that
/// is no modifier (Caps Lock arrives here too, and is a key: `key_name`).
pub fn modifier_change(code: u16, flags: u64) -> Option<(&'static str, bool)> {
    MODIFIERS
        .iter()
        .find(|(c, _, _)| *c == code)
        .map(|(_, name, bit)| (*name, flags & bit != 0))
}

/// Every modifier the flags say is down now, for a tap that was disabled (`TapEvent::Disabled`).
pub fn held_modifiers(flags: u64) -> Vec<String> {
    MODIFIERS
        .iter()
        .filter(|(_, _, bit)| flags & bit != 0)
        .map(|(_, name, _)| (*name).to_string())
        .collect()
}

/// A modifier the helper posts (DC-N6): its key code and every flag it sets while down, the
/// family's mask and its side's bit. A family name (`Command`, `Control`, `Shift`, `Option`) is
/// its left key; a side's name (`RightOption`, a hotkey still held) is that key.
pub fn modifier_key(name: &str) -> Option<(u16, u64)> {
    let side = match name {
        "Command" => "LeftCommand",
        "Control" => "LeftControl",
        "Shift" => "LeftShift",
        "Option" | "Alt" => "LeftOption",
        other => other,
    };
    let (code, _, bit) = MODIFIERS.iter().find(|(_, n, _)| *n == side)?;
    let family = match side.trim_start_matches("Left").trim_start_matches("Right") {
        "Command" => flag::COMMAND,
        "Control" => flag::CONTROL,
        "Shift" => flag::SHIFT,
        "Option" => flag::OPTION,
        _ => 0,
    };
    Some((*code, family | bit))
}

/// The key code of a key name (not a modifier), for asking the OS whether it is still down.
pub fn key_code(name: &str) -> Option<u16> {
    KEYS.iter()
        .find(|(_, n)| super::keys::same(n, name))
        .map(|(c, _)| *c)
}

/// An `OtherMouseDown`/`Up` button number as a binding name; left and right are never here.
pub fn mouse_name(button: i64) -> Option<&'static str> {
    match button {
        2 => Some("Mouse3"),
        3 => Some("Mouse4"),
        4 => Some("Mouse5"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::super::keys::{self, Hotkey};
    use super::*;

    #[test]
    fn every_code_has_one_name_and_every_name_one_code() {
        let all = KEYS;
        for (i, (c, n)) in all.iter().enumerate() {
            assert!(
                !all[i + 1..]
                    .iter()
                    .any(|(c2, n2)| c2 == c || keys::same(n, n2)),
                "{c:#x} {n} twice"
            );
            assert!(
                !MODIFIERS.iter().any(|(m, _, _)| m == c),
                "{n} is a modifier"
            );
            assert_eq!(key_code(n), Some(*c));
            assert!(!keys::is_modifier(n), "{n} reads as a modifier");
        }
    }

    /// The keys DC-A4 swallows and DC-L2 reads on, and the default chord's key, are named as
    /// `activation` and `tap` spell them.
    #[test]
    fn the_keys_the_session_acts_on_have_its_names() {
        assert_eq!(key_name(0x35), Some("Escape"));
        assert_eq!(key_name(0x24), Some("Return"));
        assert_eq!(key_name(0x4C), Some("KeypadEnter"));
        assert_eq!(key_name(0x30), Some("Tab"));
        assert_eq!(key_name(0x31), Some("Space"));
        assert_eq!(key_name(0x08), Some("C"));
        assert_eq!(key_name(0xA0), None, "Mission Control's key names nothing");
        let chord = Hotkey::parse("Control+Shift+Space").unwrap();
        assert!(chord.pressed_by(
            key_name(0x31).unwrap(),
            &["LeftControl".into(), "RightShift".into()]
        ));
    }

    /// A modifier's state comes from its own side's bit, so a release the tap never saw cannot
    /// turn the next press into a release.
    #[test]
    fn a_modifier_is_down_exactly_when_its_sides_bit_is_set() {
        use flag::*;
        assert_eq!(
            modifier_change(0x36, RIGHT_COMMAND | 0x10_0000),
            Some(("RightCommand", true))
        );
        // Left Command still down, right released: the right key is up.
        assert_eq!(
            modifier_change(0x36, LEFT_COMMAND | 0x10_0000),
            Some(("RightCommand", false))
        );
        assert_eq!(
            modifier_change(0x3E, RIGHT_CONTROL),
            Some(("RightControl", true))
        );
        assert_eq!(modifier_change(0x3F, SECONDARY_FN), Some(("Fn", true)));
        assert_eq!(modifier_change(0x3F, 0), Some(("Fn", false)));
        assert_eq!(modifier_change(0x39, 0x1_0000), None, "Caps Lock is a key");
        for (code, name, _) in MODIFIERS {
            assert!(keys::is_modifier(name), "{name}");
            assert_eq!(key_name(code), None, "{name} is not a plain key");
        }
        assert_eq!(
            held_modifiers(LEFT_SHIFT | RIGHT_OPTION),
            vec!["LeftShift".to_string(), "RightOption".to_string()]
        );
        assert!(held_modifiers(0).is_empty());
    }

    /// The chord's modifiers and a released hotkey are posted with the key and the flags an app
    /// reads: Command+V carries the Command mask, and a Right Option pressed again is the right
    /// key, not the left one.
    #[test]
    fn a_posted_modifier_has_its_key_and_its_flags() {
        use flag::*;
        assert_eq!(
            modifier_key("Command"),
            Some((0x37, COMMAND | LEFT_COMMAND))
        );
        assert_eq!(
            modifier_key("Control"),
            Some((0x3B, CONTROL | LEFT_CONTROL))
        );
        assert_eq!(modifier_key("Shift"), Some((0x38, SHIFT | LEFT_SHIFT)));
        assert_eq!(
            modifier_key("RightOption"),
            Some((0x3D, OPTION | RIGHT_OPTION))
        );
        assert_eq!(
            modifier_key("RightCommand"),
            Some((0x36, COMMAND | RIGHT_COMMAND))
        );
        assert_eq!(modifier_key("Fn"), Some((0x3F, SECONDARY_FN)));
        assert_eq!(modifier_key("Hyper"), None);
        // Every modifier the tap can report held can be released and pressed again.
        for (_, name, bit) in MODIFIERS {
            let (_, flags) = modifier_key(name).unwrap();
            assert_ne!(flags & bit, 0, "{name}");
        }
    }

    #[test]
    fn only_the_middle_and_side_buttons_are_bindings() {
        assert_eq!(mouse_name(0), None);
        assert_eq!(mouse_name(1), None);
        assert_eq!(mouse_name(2), Some("Mouse3"));
        assert_eq!(mouse_name(3), Some("Mouse4"));
        assert_eq!(mouse_name(4), Some("Mouse5"));
        assert!(Hotkey::parse(mouse_name(3).unwrap()).is_ok());
    }
}
