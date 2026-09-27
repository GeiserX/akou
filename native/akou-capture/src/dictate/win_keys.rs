//! Windows virtual keys and low-level hook messages as `keys` names (DC-N1, DC-A6), with no OS
//! call, so every OS tests the table the Windows hook reads.
//!
//! - A key is named by its virtual key, the label the active layout gives it: `VK_A` is the key
//!   that types A. That is what every Windows shortcut and `RegisterHotKey` match on, so a chord
//!   hotkey means the same key it means to every other app on the machine.
//! - The low-level hook reports the side of a modifier (`VK_LCONTROL`, `VK_RMENU`); a generic
//!   `VK_SHIFT`, `VK_CONTROL` or `VK_MENU` (another program's injected input) is given its side
//!   from the scan code or the extended flag.
//! - **AltGr.** On a layout with AltGr, Windows sends a fake Left Control (scan code `0x21D`) before
//!   every Right Alt. It is no key the user pressed: it names nothing here, so it never breaks a
//!   modifier-only press of Right Alt and never reaches a binding.
//! - Return and keypad Enter share `VK_RETURN`; keypad Enter carries the extended flag.
//! - Mouse buttons come as `WM_MBUTTONDOWN` (`Mouse3`) and `WM_XBUTTONDOWN` with `XBUTTON1`
//!   (`Mouse4`) or `XBUTTON2` (`Mouse5`) in the high word of `mouseData`. Left and right never
//!   reach a binding (DC-A6).

/// Virtual keys that are no modifier, with their `keys` names. The names match `mac_keys`, so a
/// binding reads the same on both.
const KEYS: [(u16, &str); 94] = [
    (0x08, "Backspace"),
    (0x09, "Tab"),
    (0x0C, "KeypadClear"),
    (0x0D, "Return"),
    (0x13, "Pause"),
    (0x14, "CapsLock"),
    (0x1B, "Escape"),
    (0x20, "Space"),
    (0x21, "PageUp"),
    (0x22, "PageDown"),
    (0x23, "End"),
    (0x24, "Home"),
    (0x25, "Left"),
    (0x26, "Up"),
    (0x27, "Right"),
    (0x28, "Down"),
    (0x2C, "PrintScreen"),
    (0x2D, "Insert"),
    (0x2E, "Delete"),
    (0x30, "0"),
    (0x31, "1"),
    (0x32, "2"),
    (0x33, "3"),
    (0x34, "4"),
    (0x35, "5"),
    (0x36, "6"),
    (0x37, "7"),
    (0x38, "8"),
    (0x39, "9"),
    (0x41, "A"),
    (0x42, "B"),
    (0x43, "C"),
    (0x44, "D"),
    (0x45, "E"),
    (0x46, "F"),
    (0x47, "G"),
    (0x48, "H"),
    (0x49, "I"),
    (0x4A, "J"),
    (0x4B, "K"),
    (0x4C, "L"),
    (0x4D, "M"),
    (0x4E, "N"),
    (0x4F, "O"),
    (0x50, "P"),
    (0x51, "Q"),
    (0x52, "R"),
    (0x53, "S"),
    (0x54, "T"),
    (0x55, "U"),
    (0x56, "V"),
    (0x57, "W"),
    (0x58, "X"),
    (0x59, "Y"),
    (0x5A, "Z"),
    (0x5D, "ContextMenu"),
    (0x60, "Keypad0"),
    (0x61, "Keypad1"),
    (0x62, "Keypad2"),
    (0x63, "Keypad3"),
    (0x64, "Keypad4"),
    (0x65, "Keypad5"),
    (0x66, "Keypad6"),
    (0x67, "Keypad7"),
    (0x68, "Keypad8"),
    (0x69, "Keypad9"),
    (0x6A, "KeypadMultiply"),
    (0x6B, "KeypadPlus"),
    (0x6D, "KeypadMinus"),
    (0x6E, "KeypadDecimal"),
    (0x6F, "KeypadDivide"),
    (0x70, "F1"),
    (0x71, "F2"),
    (0x72, "F3"),
    (0x73, "F4"),
    (0x74, "F5"),
    (0x75, "F6"),
    (0x76, "F7"),
    (0x77, "F8"),
    (0x78, "F9"),
    (0x79, "F10"),
    (0x7A, "F11"),
    (0x7B, "F12"),
    (0x90, "NumLock"),
    (0x91, "ScrollLock"),
    (0xAD, "Mute"),
    (0xAE, "VolumeDown"),
    (0xAF, "VolumeUp"),
    (0xBA, "Semicolon"),
    (0xBB, "Equal"),
    (0xBC, "Comma"),
    (0xBD, "Minus"),
    (0xBE, "Period"),
    (0xBF, "Slash"),
];

/// The rest of the US punctuation, F13 to F24 and the ISO key beside Left Shift.
const MORE_KEYS: [(u16, &str); 18] = [
    (0xC0, "Grave"),
    (0xDB, "LeftBracket"),
    (0xDC, "Backslash"),
    (0xDD, "RightBracket"),
    (0xDE, "Quote"),
    (0xE2, "IntlBackslash"),
    (0x7C, "F13"),
    (0x7D, "F14"),
    (0x7E, "F15"),
    (0x7F, "F16"),
    (0x80, "F17"),
    (0x81, "F18"),
    (0x82, "F19"),
    (0x83, "F20"),
    (0x84, "F21"),
    (0x85, "F22"),
    (0x86, "F23"),
    (0x87, "F24"),
];

/// The side-specific modifiers the hook reports, and the `keys` names Windows users know them by.
const MODIFIERS: [(u16, &str); 8] = [
    (0xA0, "LeftShift"),
    (0xA1, "RightShift"),
    (0xA2, "LeftControl"),
    (0xA3, "RightControl"),
    (0xA4, "LeftAlt"),
    (0xA5, "RightAlt"),
    (0x5B, "LeftWin"),
    (0x5C, "RightWin"),
];

/// The unassigned virtual key posted so a released Win or Alt opens no menu (AutoHotkey's
/// `#MenuMaskKey`, DC-N1).
pub const MASK_KEY: u16 = 0xE8;

/// The scan code of the Left Control Windows fakes before an AltGr (Right Alt).
const ALTGR_FAKE_CONTROL: u32 = 0x21D;
/// The right Shift key's scan code, for a generic `VK_SHIFT`.
const RIGHT_SHIFT_SCAN: u32 = 0x36;

fn all_keys() -> impl Iterator<Item = &'static (u16, &'static str)> {
    KEYS.iter().chain(MORE_KEYS.iter())
}

/// The name of the key a low-level keyboard hook reported: its virtual key, scan code and whether
/// `LLKHF_EXTENDED` is set. `None` for a key no binding can name, and for the fake Left Control
/// of AltGr.
pub fn key_name(vk: u32, scan: u32, extended: bool) -> Option<&'static str> {
    let vk = u16::try_from(vk).ok()?;
    let named = |v: u16| MODIFIERS.iter().find(|(c, _)| *c == v).map(|(_, n)| *n);
    match vk {
        0xA2 if scan == ALTGR_FAKE_CONTROL => None,
        // Generic modifiers from another program's injected input.
        0x10 => named(if scan == RIGHT_SHIFT_SCAN { 0xA1 } else { 0xA0 }),
        0x11 if scan == ALTGR_FAKE_CONTROL => None,
        0x11 => named(if extended { 0xA3 } else { 0xA2 }),
        0x12 => named(if extended { 0xA5 } else { 0xA4 }),
        0x0D if extended => Some("KeypadEnter"),
        v => named(v).or_else(|| all_keys().find(|(c, _)| *c == v).map(|(_, n)| *n)),
    }
}

/// A key the helper posts or asks the state of: its virtual key and whether it needs
/// `KEYEVENTF_EXTENDEDKEY`. A modifier family (`Control`, `Shift`, `Option` or `Alt`, `Command`
/// or `Win`) is its left key; a side's name (a hotkey still held) is that key.
pub fn vk_of(name: &str) -> Option<(u16, bool)> {
    use super::keys::{self, Mod, Side};
    if keys::same(name, "KeypadEnter") {
        return Some((0x0D, true));
    }
    if let Some((m, side)) = keys::modifier(name) {
        let right = side == Side::Right;
        return match m {
            Mod::Shift => Some((if right { 0xA1 } else { 0xA0 }, false)),
            Mod::Control => Some((if right { 0xA3 } else { 0xA2 }, right)),
            Mod::Option => Some((if right { 0xA5 } else { 0xA4 }, right)),
            Mod::Command => Some((if right { 0x5C } else { 0x5B }, true)),
            Mod::Fn => None,
        };
    }
    let (vk, _) = all_keys().find(|(_, n)| keys::same(n, name))?;
    // The navigation block and the keypad's divide are extended keys.
    let extended = matches!(vk, 0x21..=0x28 | 0x2D | 0x2E | 0x6F | 0x5D | 0x2C | 0x90);
    Some((*vk, extended))
}

/// The modifiers the hook can report, for asking which are down now.
pub fn modifier_vks() -> impl Iterator<Item = (u16, &'static str)> {
    MODIFIERS.iter().copied()
}

/// `WM_MBUTTONDOWN` and the other mouse messages a low-level mouse hook receives.
pub mod msg {
    pub const MBUTTONDOWN: u32 = 0x0207;
    pub const MBUTTONUP: u32 = 0x0208;
    pub const XBUTTONDOWN: u32 = 0x020B;
    pub const XBUTTONUP: u32 = 0x020C;
}

/// A low-level mouse hook message as a binding name and whether the button went down; `None` for
/// the left and right buttons, the wheel and a move.
pub fn mouse_name(message: u32, mouse_data: u32) -> Option<(&'static str, bool)> {
    let x = || match mouse_data >> 16 {
        1 => Some("Mouse4"),
        2 => Some("Mouse5"),
        _ => None,
    };
    match message {
        msg::MBUTTONDOWN => Some(("Mouse3", true)),
        msg::MBUTTONUP => Some(("Mouse3", false)),
        msg::XBUTTONDOWN => x().map(|n| (n, true)),
        msg::XBUTTONUP => x().map(|n| (n, false)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::super::keys::{self, Hotkey};
    use super::*;

    #[test]
    fn every_key_has_one_name_and_every_name_one_key() {
        let all: Vec<_> = all_keys().chain(MODIFIERS.iter()).collect();
        for (i, (c, n)) in all.iter().enumerate() {
            assert!(
                !all[i + 1..]
                    .iter()
                    .any(|(c2, n2)| c2 == c || keys::same(n, n2)),
                "{c:#x} {n} twice"
            );
            assert_eq!(key_name(u32::from(*c), 0, false), Some(*n), "{n}");
            assert_eq!(vk_of(n).map(|(v, _)| v), Some(*c), "{n}");
        }
        for (_, n) in MODIFIERS {
            assert!(keys::is_modifier(n), "{n} reads as no modifier");
        }
        for (_, n) in all_keys() {
            assert!(!keys::is_modifier(n), "{n} reads as a modifier");
        }
    }

    /// The keys DC-A4 swallows and DC-L2 reads on, and the default binding, are named as
    /// `activation` and `tap` spell them.
    #[test]
    fn the_keys_the_session_acts_on_have_its_names() {
        assert_eq!(key_name(0x1B, 0x01, false), Some("Escape"));
        assert_eq!(key_name(0x0D, 0x1C, false), Some("Return"));
        assert_eq!(key_name(0x0D, 0x1C, true), Some("KeypadEnter"));
        assert_eq!(key_name(0x09, 0x0F, false), Some("Tab"));
        assert_eq!(key_name(0x20, 0x39, false), Some("Space"));
        assert_eq!(key_name(0xFF, 0, false), None, "a vendor key names nothing");
        assert_eq!(key_name(0x1_0041, 0, false), None);
        let default = Hotkey::parse("RightControl").unwrap();
        assert!(default.pressed_by(key_name(0xA3, 0x1D, true).unwrap(), &[]));
        let chord = Hotkey::parse("Control+Shift+Space").unwrap();
        assert!(chord.pressed_by(
            key_name(0x20, 0x39, false).unwrap(),
            &["LeftControl".into(), "RightShift".into()]
        ));
        // Win and Alt are the Command and Option families, so the mask key rule sees them.
        assert!(keys::same("RightWin", "RightCommand"));
        assert!(keys::same("LeftAlt", "LeftOption"));
    }

    /// AltGr's fake Left Control is no key: a modifier-only Right Alt press is not broken by it,
    /// and a Left Control with its real scan code still is Left Control (positive control).
    #[test]
    fn altgr_fake_control_names_nothing() {
        assert_eq!(key_name(0xA2, 0x21D, false), None);
        assert_eq!(key_name(0x11, 0x21D, false), None);
        assert_eq!(key_name(0xA2, 0x1D, false), Some("LeftControl"));
        assert_eq!(key_name(0xA5, 0x38, true), Some("RightAlt"));
    }

    #[test]
    fn a_generic_modifier_gets_its_side() {
        assert_eq!(key_name(0x10, 0x2A, false), Some("LeftShift"));
        assert_eq!(key_name(0x10, 0x36, false), Some("RightShift"));
        assert_eq!(key_name(0x11, 0x1D, false), Some("LeftControl"));
        assert_eq!(key_name(0x11, 0x1D, true), Some("RightControl"));
        assert_eq!(key_name(0x12, 0x38, false), Some("LeftAlt"));
        assert_eq!(key_name(0x12, 0x38, true), Some("RightAlt"));
    }

    /// The paste chord's modifiers and a released hotkey are posted as the right keys: a family is
    /// its left key, a side is that side, and the right-hand Control and Alt and both Win keys are
    /// extended keys.
    #[test]
    fn a_posted_key_has_its_virtual_key_and_extended_flag() {
        assert_eq!(vk_of("Control"), Some((0xA2, false)));
        assert_eq!(vk_of("Shift"), Some((0xA0, false)));
        assert_eq!(vk_of("Alt"), Some((0xA4, false)));
        assert_eq!(vk_of("Command"), Some((0x5B, true)));
        assert_eq!(vk_of("RightControl"), Some((0xA3, true)));
        assert_eq!(vk_of("RightCtrl"), Some((0xA3, true)));
        assert_eq!(vk_of("RightAlt"), Some((0xA5, true)));
        assert_eq!(vk_of("Return"), Some((0x0D, false)));
        assert_eq!(vk_of("KeypadEnter"), Some((0x0D, true)));
        assert_eq!(vk_of("Insert"), Some((0x2D, true)));
        assert_eq!(vk_of("v"), Some((0x56, false)));
        assert_eq!(vk_of("Fn"), None, "Windows never sees Fn");
        assert_eq!(vk_of("Hyper"), None);
        // Every modifier the hook can report held can be released and pressed again.
        for (vk, name) in modifier_vks() {
            assert_eq!(vk_of(name).map(|(v, _)| v), Some(vk), "{name}");
        }
    }

    #[test]
    fn only_the_middle_and_side_buttons_are_bindings() {
        assert_eq!(mouse_name(msg::MBUTTONDOWN, 0), Some(("Mouse3", true)));
        assert_eq!(mouse_name(msg::MBUTTONUP, 0), Some(("Mouse3", false)));
        assert_eq!(
            mouse_name(msg::XBUTTONDOWN, 1 << 16),
            Some(("Mouse4", true))
        );
        assert_eq!(mouse_name(msg::XBUTTONUP, 2 << 16), Some(("Mouse5", false)));
        assert_eq!(mouse_name(msg::XBUTTONDOWN, 3 << 16), None);
        // WM_LBUTTONDOWN, WM_RBUTTONDOWN, WM_MOUSEWHEEL, WM_MOUSEMOVE.
        for m in [0x0201, 0x0204, 0x020A, 0x0200] {
            assert_eq!(mouse_name(m, 1 << 16), None, "{m:#x}");
        }
        assert!(Hotkey::parse(mouse_name(msg::XBUTTONDOWN, 1 << 16).unwrap().0).is_ok());
    }
}
