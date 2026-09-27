//! Key names, hotkey bindings (DC-A2) and the scripted key source of `--keys FILE` (DC-N10).
//!
//! A key is named the way `dictation.hotkey` names it: the side-specific modifiers
//! (`RightCommand`, `LeftOption`, `RightControl`, `LeftShift`, ...), `Fn`, the mouse buttons
//! `Mouse3` to `Mouse5`, and any other key by its label (`Escape`, `Enter`, `Space`, `C`, `F5`).
//! A binding is one modifier alone (`RightCommand`), one mouse button alone (`Mouse4`, DC-A6), or
//! a chord (`Control+Shift+Space`), whose modifiers may name a side or not.
//!
//! Two names are the same key by `same`, everywhere: a modifier by its kind and side
//! (`RightCtrl` is `RightControl`), anything else ignoring ASCII case (`space` is `Space`).

/// The four modifiers that come in a left and a right key, plus `Fn`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mod {
    Command,
    Option,
    Control,
    Shift,
    Fn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
    Either,
}

const MODS: [(&str, Mod); 5] = [
    ("Command", Mod::Command),
    ("Option", Mod::Option),
    ("Control", Mod::Control),
    ("Shift", Mod::Shift),
    ("Fn", Mod::Fn),
];

/// `RightCommand` is `(Command, Right)`, `Shift` is `(Shift, Either)`, `Fn` is `(Fn, Either)`,
/// and a key that is no modifier is `None`. `Cmd`, `Alt` and `Ctrl` are accepted spellings.
pub fn modifier(name: &str) -> Option<(Mod, Side)> {
    let (side, rest) = if let Some(r) = name.strip_prefix("Left") {
        (Side::Left, r)
    } else if let Some(r) = name.strip_prefix("Right") {
        (Side::Right, r)
    } else {
        (Side::Either, name)
    };
    let rest = match rest {
        "Cmd" | "Meta" | "Super" | "Win" => "Command",
        "Alt" => "Option",
        "Ctrl" => "Control",
        r => r,
    };
    let m = MODS.iter().find(|(n, _)| *n == rest)?.1;
    if m == Mod::Fn && side != Side::Either {
        return None;
    }
    Some((m, side))
}

pub fn is_modifier(name: &str) -> bool {
    modifier(name).is_some()
}

/// Whether `a` and `b` name the same key: a modifier by kind and side, anything else ignoring
/// ASCII case. The one comparison of key names, so a key going down and the same key going up
/// always match, however the OS or the setting spells it.
pub fn same(a: &str, b: &str) -> bool {
    match (modifier(a), modifier(b)) {
        (Some(x), Some(y)) => x == y,
        (None, None) => a.eq_ignore_ascii_case(b),
        _ => false,
    }
}

/// `Mouse1` to `Mouse5` as a button number.
fn mouse_button(name: &str) -> Option<u8> {
    let n = name.get(..5)?;
    if !n.eq_ignore_ascii_case("mouse") {
        return None;
    }
    name[5..].parse().ok().filter(|b| (1..=5).contains(b))
}

/// DC-A6: the left and right buttons would take every click from every app.
fn refuse_mouse(name: &str) -> Result<(), String> {
    match mouse_button(name) {
        Some(b @ (1 | 2)) => Err(format!(
            "Mouse{b} is the {} button, which every app needs; use Mouse3, Mouse4 or Mouse5",
            if b == 1 { "left" } else { "right" }
        )),
        _ => Ok(()),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Hotkey {
    /// One modifier key alone, side-specific (or `Fn`): `RightCommand`.
    Modifier(String),
    /// Modifiers held while `key` goes down: `Control+Shift+Space`.
    Chord { mods: Vec<(Mod, Side)>, key: String },
}

impl Hotkey {
    pub fn parse(s: &str) -> Result<Hotkey, String> {
        let parts: Vec<&str> = s.split('+').map(str::trim).collect();
        if parts.iter().any(|p| p.is_empty()) {
            return Err(format!("{s:?} is not a key or a chord"));
        }
        if let [one] = parts.as_slice() {
            refuse_mouse(one)?;
            if let Some(b) = mouse_button(one) {
                // A button alone behaves as a chord with no modifier: it starts at button-down
                // and is swallowed, so Mouse4 does not also go back a page.
                return Ok(Hotkey::Chord {
                    mods: Vec::new(),
                    key: format!("Mouse{b}"),
                });
            }
            return match modifier(one) {
                Some((Mod::Fn, _)) => Ok(Hotkey::Modifier("Fn".into())),
                Some((_, Side::Either)) => {
                    Err(format!("{one} alone needs a side: Left{one} or Right{one}"))
                }
                Some(_) => Ok(Hotkey::Modifier((*one).to_string())),
                None => Err(format!(
                    "{one} alone would take the key from every app; add a modifier"
                )),
            };
        }
        let (key, mods) = parts.split_last().expect("at least two parts");
        if is_modifier(key) {
            return Err(format!("the last key of {s} must not be a modifier"));
        }
        refuse_mouse(key)?;
        let mut out: Vec<(Mod, Side)> = Vec::new();
        for m in mods {
            let (m, side) = modifier(m).ok_or_else(|| format!("{m} is not a modifier"))?;
            if let Some((_, other)) = out.iter().find(|(o, _)| *o == m) {
                return Err(
                    if *other != side && *other != Side::Either && side != Side::Either {
                        format!("{s} holds the left and the right {m:?} at once; pick one")
                    } else {
                        format!("{s} names {m:?} twice")
                    },
                );
            }
            out.push((m, side));
        }
        Ok(Hotkey::Chord {
            mods: out,
            key: (*key).to_string(),
        })
    }

    /// The key whose going down and up is the press.
    pub fn trigger(&self) -> &str {
        match self {
            Hotkey::Modifier(k) => k,
            Hotkey::Chord { key, .. } => key,
        }
    }

    pub fn is_modifier_only(&self) -> bool {
        matches!(self, Hotkey::Modifier(_))
    }

    /// Whether `key` going down, with `held` already down, is this binding's press.
    pub fn pressed_by(&self, key: &str, held: &[String]) -> bool {
        match self {
            Hotkey::Modifier(k) => same(k, key),
            Hotkey::Chord { mods, key: k } => {
                same(k, key)
                    && mods.iter().all(|(m, side)| {
                        held.iter().any(|h| {
                            modifier(h).is_some_and(|(hm, hs)| {
                                hm == *m && (*side == Side::Either || hs == *side)
                            })
                        })
                    })
            }
        }
    }
}

/// One line of a keys file: at `ms` on the audio timeline, `key` went down or up.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scripted {
    pub ms: u64,
    pub down: bool,
    pub key: String,
}

/// Reads a keys file: one `<ms> down|up <Key>` per line, `#` starts a comment. Times must not go
/// backwards, so a script reads in the order it happens.
pub fn parse_script(text: &str) -> Result<Vec<Scripted>, String> {
    let mut out: Vec<Scripted> = Vec::new();
    for (n, raw) in text.lines().enumerate() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let bad = || format!("keys line {}: {raw:?} is not `<ms> down|up <Key>`", n + 1);
        let mut it = line.split_whitespace();
        let ms: u64 = it.next().and_then(|v| v.parse().ok()).ok_or_else(bad)?;
        let down = match it.next() {
            Some("down") => true,
            Some("up") => false,
            _ => return Err(bad()),
        };
        let key = it.next().ok_or_else(bad)?.to_string();
        if it.next().is_some() {
            return Err(bad());
        }
        if out.last().is_some_and(|l| l.ms > ms) {
            return Err(format!("keys line {}: time goes backwards", n + 1));
        }
        out.push(Scripted { ms, down, key });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DC-A2: modifier-only and side-specific keys are valid bindings beside chords, and a chord of
    /// a left and a right of the same modifier is refused.
    #[test]
    fn dc_a2_bindings_parse_and_the_impossible_ones_are_refused() {
        assert_eq!(
            Hotkey::parse("RightCommand").unwrap(),
            Hotkey::Modifier("RightCommand".into())
        );
        assert!(Hotkey::parse("RightCommand").unwrap().is_modifier_only());
        assert_eq!(Hotkey::parse("Fn").unwrap(), Hotkey::Modifier("Fn".into()));
        let chord = Hotkey::parse("Control+Shift+Space").unwrap();
        assert!(!chord.is_modifier_only());
        assert_eq!(chord.trigger(), "Space");
        let e = Hotkey::parse("LeftOption+RightOption+K").unwrap_err();
        assert!(e.contains("left and the right"), "{e}");
        assert!(Hotkey::parse("LeftOption+RightOption").is_err());
        assert!(
            Hotkey::parse("Command")
                .unwrap_err()
                .contains("needs a side")
        );
        assert!(
            Hotkey::parse("Space").is_err(),
            "a bare key would eat typing"
        );
        assert!(Hotkey::parse("Control+").is_err());
        assert!(Hotkey::parse("Shift+Shift+A").is_err());
        assert!(Hotkey::parse("RightFn").is_err());
    }

    #[test]
    fn a_chord_is_pressed_only_with_its_modifiers_on_the_named_side() {
        let chord = Hotkey::parse("RightControl+Shift+Space").unwrap();
        let held = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(chord.pressed_by("Space", &held(&["RightControl", "LeftShift"])));
        assert!(!chord.pressed_by("Space", &held(&["LeftControl", "LeftShift"])));
        assert!(!chord.pressed_by("Space", &held(&["RightControl"])));
        assert!(!chord.pressed_by("K", &held(&["RightControl", "LeftShift"])));
    }

    /// DC-A6: `Mouse4` is a binding that starts at button-down; the left and right buttons are
    /// refused alone and in a chord, and the wheel is no button at all.
    #[test]
    fn dc_a6_mouse_buttons_three_to_five_bind_and_the_rest_are_refused() {
        for b in ["Mouse3", "Mouse4", "mouse5"] {
            let h = Hotkey::parse(b).unwrap();
            assert!(!h.is_modifier_only(), "{b}");
            assert!(same(h.trigger(), b), "{b}");
            assert!(h.pressed_by(b, &[]), "{b}");
        }
        assert!(Hotkey::parse("Mouse1").unwrap_err().contains("left button"));
        assert!(
            Hotkey::parse("Mouse2")
                .unwrap_err()
                .contains("right button")
        );
        assert!(Hotkey::parse("Control+Mouse1").is_err());
        assert!(Hotkey::parse("Control+Mouse4").is_ok());
        assert!(Hotkey::parse("WheelUp").is_err());
        assert!(Hotkey::parse("Mouse6").is_err());
    }

    /// One comparison for every key name: sides and spellings of a modifier, and the case of any
    /// other key, so a key's down and its up always match.
    #[test]
    fn same_matches_a_key_however_it_is_spelled() {
        assert!(same("RightCtrl", "RightControl"));
        assert!(same("space", "Space"));
        assert!(same("LeftWin", "LeftCommand"));
        assert!(!same("LeftControl", "RightControl"));
        assert!(!same("Control", "LeftControl"), "a side is not either side");
        assert!(!same("Shift", "S"));
        let chord = Hotkey::parse("Control+Shift+space").unwrap();
        assert!(chord.pressed_by("Space", &["RightCtrl".into(), "LeftShift".into()]));
    }

    #[test]
    fn a_keys_file_reads_in_order_and_refuses_what_it_cannot_mean() {
        let s = parse_script("# a tap\n400 down RightCommand\n520 up RightCommand # 120 ms\n\n")
            .unwrap();
        assert_eq!(
            s,
            vec![
                Scripted {
                    ms: 400,
                    down: true,
                    key: "RightCommand".into()
                },
                Scripted {
                    ms: 520,
                    down: false,
                    key: "RightCommand".into()
                },
            ]
        );
        for bad in [
            "400 press A",
            "x down A",
            "400 down",
            "400 down A B",
            "500 down A\n400 up A",
        ] {
            assert!(parse_script(bad).is_err(), "{bad}");
        }
    }
}
