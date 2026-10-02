//! The helper's half of activation (docs/ux/DICTATION.md DC-A1 and DC-A4): which key events are a
//! dictation press, when a session starts and ends, and which keys are swallowed.
//!
//! This runs on the thread that answers the OS key tap or hook (DC-N1), so it decides from memory
//! alone and returns at once: it never waits on the mic, the clipboard or an insert. What it
//! decides comes out as `Action`s for the caller to carry out elsewhere.
//!
//! - **Hold-or-toggle** (the default): a press held `HOLD_MS` or longer is push-to-talk and ends
//!   at release; a shorter tap latches, and the next press ends it. **Hold** always ends at
//!   release; **toggle** always latches.
//! - **The interrupt rule**, for a modifier-only key: a press counts only when no other key goes
//!   down while it is held. Another key cancels at once, passes through unchanged and never
//!   latches, so Right Command + C stays a copy. The modifier itself is never swallowed.
//! - **Keys during a session**: from the press until the insert settles (`settled`, or
//!   `SETTLE_MS` after the last session end or insert), Escape, Enter and Shift+Enter are
//!   swallowed and reported. Outside a session nothing is swallowed. On a backend that cannot
//!   swallow (evdev, the portal: `ready.swallow_keys` false) they would reach the app as well, so
//!   there they are plain keys: no key but the hotkey does anything in a session.
//! - **Which rule wins**: before a press is a session (a modifier-only key held under `HOLD_MS`)
//!   every other key, Enter included, is the interrupt rule, since nothing is swallowed outside a
//!   session. Once it is a session, Escape, Enter and Shift+Enter are DC-A4's even while the
//!   modifier is still held, so Enter during a push-to-talk hold ends it and sends instead of
//!   reaching the app as Command+Enter; any other key is still the interrupt rule.

use super::keys::{self, Hotkey};

/// A press held this long is push-to-talk (Handy's `HoldOrToggle` threshold).
pub const HOLD_MS: u64 = 300;
/// The longest the keys stay swallowed after a session ends without the insert settling: the
/// paste receipt timeout of DC-N6.
pub const SETTLE_MS: u64 = 8_000;

const MS: u64 = 1_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    HoldOrToggle,
    Hold,
    Toggle,
}

impl Mode {
    pub fn parse(s: &str) -> Result<Mode, String> {
        match s {
            "hold-or-toggle" => Ok(Mode::HoldOrToggle),
            "hold" => Ok(Mode::Hold),
            "toggle" => Ok(Mode::Toggle),
            _ => Err(format!(
                "activation must be hold-or-toggle, hold or toggle, not {s}"
            )),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// The hotkey went down at `t_ns`: open a cold mic now and keep the ring from here, since the
    /// press may yet become a session.
    Arm { t_ns: u64 },
    /// The press was not a dictation after all.
    Disarm,
    /// A session starts; its audio begins at `t_ns` minus the ring.
    Start { t_ns: u64 },
    /// The session ends now. `cancel` drops it; any other reason runs the post-roll.
    End { reason: &'static str },
    /// The session is latched now (tapped on, a chord released before `HOLD_MS`, or the app's
    /// `session.start`), so the app may end it after silence (DC-A3). A held session never is.
    Latched,
    /// Report `key {name}` to the app.
    Key(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Idle,
    /// A modifier-only hotkey is down and no other key went down yet.
    Pending {
        down_ns: u64,
    },
    /// A session runs. `held`: the press that started it is still down.
    Listening {
        down_ns: u64,
        held: bool,
    },
    /// The session ended; its text is not inserted yet.
    Awaiting {
        until_ns: u64,
    },
}

pub struct Activation {
    hotkey: Hotkey,
    mode: Mode,
    state: State,
    /// Keys down now, in the order they went down.
    held: Vec<String>,
    /// Keys whose down was swallowed, so their up is swallowed too.
    swallowed: Vec<String>,
    record: bool,
    /// The backend can keep a key from the app (`ready.swallow_keys`); without that DC-A4's keys
    /// are plain keys, or Enter would end the session and also land in the app.
    swallows: bool,
}

impl Activation {
    pub fn new(hotkey: Hotkey, mode: Mode) -> Activation {
        Activation {
            hotkey,
            mode,
            state: State::Idle,
            held: Vec::new(),
            swallowed: Vec::new(),
            record: false,
            swallows: true,
        }
    }

    /// Whether the backend can swallow a key (`ready.swallow_keys`, DC-A4).
    pub fn set_swallows(&mut self, on: bool) {
        self.swallows = on;
    }

    /// A new binding (DC-A7). A press in progress is dropped; a running session keeps running.
    pub fn rebind(&mut self, hotkey: Hotkey, mode: Mode, out: &mut Vec<Action>) {
        if matches!(self.state, State::Pending { .. }) {
            self.state = State::Idle;
            out.push(Action::Disarm);
        }
        self.hotkey = hotkey;
        self.mode = mode;
    }

    pub fn hotkey(&self) -> &Hotkey {
        &self.hotkey
    }

    /// `record_keys`: while on, every key is reported and none starts a session.
    pub fn record_keys(&mut self, on: bool) {
        self.record = on;
    }

    /// The recorder is open (`record_keys`).
    pub fn recording(&self) -> bool {
        self.record
    }

    /// A mouse button is the binding, or the recorder is open (DC-A6): only then does a backend
    /// need the mouse buttons, and the Windows one installs its mouse hook.
    pub fn wants_mouse(&self) -> bool {
        self.record
            || self
                .hotkey
                .trigger()
                .get(..5)
                .is_some_and(|p| p.eq_ignore_ascii_case("mouse"))
    }

    /// The keys down now, as the tap saw them.
    pub fn held(&self) -> &[String] {
        &self.held
    }

    pub fn is_listening(&self) -> bool {
        matches!(self.state, State::Listening { .. })
    }

    /// One key event. Returns whether the key is swallowed.
    pub fn key(&mut self, down: bool, name: &str, t_ns: u64, out: &mut Vec<Action>) -> bool {
        if !down {
            self.held.retain(|k| !keys::same(k, name));
            let swallowed = self.swallowed.iter().position(|k| keys::same(k, name));
            if let Some(i) = swallowed {
                self.swallowed.remove(i);
            }
            return self.key_up(name, t_ns, out) || swallowed.is_some();
        }
        if self.held.iter().any(|k| keys::same(k, name)) {
            // Auto-repeat: the first down already decided.
            return self.swallowed.iter().any(|k| keys::same(k, name));
        }
        let press = self.hotkey.pressed_by(name, &self.held);
        self.held.push(name.to_string());
        if self.record {
            out.push(Action::Key(name.to_string()));
            return false;
        }
        let swallow = self.key_down(name, press, t_ns, out);
        if swallow {
            self.swallowed.push(name.to_string());
        }
        swallow
    }

    /// Escape, Enter or Shift+Enter as DC-A4 names them, on a backend that can swallow them.
    fn enter_name(&self, name: &str) -> Option<&'static str> {
        if !self.swallows {
            return None;
        }
        match name {
            "Escape" => Some("Escape"),
            "Enter" | "Return" | "KeypadEnter" => Some(if self.shift_held() {
                "Shift+Enter"
            } else {
                "Enter"
            }),
            _ => None,
        }
    }

    /// A Shift other than the hotkey's own: a `RightShift` hotkey held, or the Shift of a chord
    /// such as `Control+Shift+Space` while its press is still down, is not Shift+Enter (DC-A1).
    fn shift_held(&self) -> bool {
        let chord_down = matches!(self.state, State::Listening { held: true, .. });
        self.held.iter().any(|k| {
            matches!(keys::modifier(k), Some((keys::Mod::Shift, _)))
                && !keys::same(k, self.hotkey.trigger())
                && !(chord_down && self.hotkey.holds(k))
        })
    }

    fn key_down(&mut self, name: &str, press: bool, t_ns: u64, out: &mut Vec<Action>) -> bool {
        let chord = !self.hotkey.is_modifier_only();
        match self.state {
            State::Idle => {
                if !press {
                    return false;
                }
                out.push(Action::Arm { t_ns });
                if chord {
                    out.push(Action::Start { t_ns });
                    self.state = State::Listening {
                        down_ns: t_ns,
                        held: true,
                    };
                    return true;
                }
                self.state = State::Pending { down_ns: t_ns };
                false
            }
            State::Pending { .. } => {
                // The interrupt rule: another key while the modifier is held.
                self.state = State::Idle;
                out.push(Action::Disarm);
                false
            }
            State::Listening { held, .. } => {
                if press {
                    if held {
                        return chord;
                    }
                    out.push(Action::End { reason: "tap" });
                    self.state = self.awaiting(t_ns);
                    return chord;
                }
                match self.enter_name(name) {
                    Some("Escape") => {
                        out.push(Action::Key("Escape".into()));
                        out.push(Action::End { reason: "cancel" });
                        self.state = State::Idle;
                        true
                    }
                    // DC-A4 wins over the interrupt rule once the press is a session.
                    Some(k) => {
                        out.push(Action::Key(k.into()));
                        out.push(Action::End { reason: "key" });
                        self.state = self.awaiting(t_ns);
                        true
                    }
                    _ => {
                        if held && !chord {
                            // The interrupt rule during a confirmed hold: cancel, pass through.
                            out.push(Action::End { reason: "cancel" });
                            self.state = State::Idle;
                        }
                        false
                    }
                }
            }
            State::Awaiting { .. } => {
                if press {
                    // Still transcribing: refused, never queued; the app flashes the pill.
                    out.push(Action::Key(self.hotkey.trigger().to_string()));
                    return chord;
                }
                match self.enter_name(name) {
                    Some(k) => {
                        out.push(Action::Key(k.into()));
                        true
                    }
                    None => false,
                }
            }
        }
    }

    /// The hotkey itself went down or up, from a source that reports the binding and not its
    /// keys: the GlobalShortcuts portal's `Activated` and `Deactivated` (DC-N1). The held
    /// modifiers are the portal's to check, so a chord is not matched against them here.
    pub fn trigger(&mut self, down: bool, t_ns: u64, out: &mut Vec<Action>) -> bool {
        let name = self.hotkey.trigger().to_string();
        if down {
            self.key_down(&name, true, t_ns, out)
        } else {
            self.key_up(&name, t_ns, out)
        }
    }

    fn key_up(&mut self, name: &str, t_ns: u64, out: &mut Vec<Action>) -> bool {
        if !keys::same(name, self.hotkey.trigger()) {
            return false;
        }
        match self.state {
            State::Pending { down_ns } => {
                out.push(Action::Start { t_ns: down_ns });
                let tap = t_ns.saturating_sub(down_ns) < HOLD_MS * MS;
                match self.mode {
                    Mode::Toggle => self.latch(down_ns, out),
                    Mode::HoldOrToggle if tap => self.latch(down_ns, out),
                    _ => {
                        out.push(Action::End { reason: "release" });
                        self.state = self.awaiting(t_ns);
                    }
                }
            }
            State::Listening {
                down_ns,
                held: true,
            } => {
                let tap = t_ns.saturating_sub(down_ns) < HOLD_MS * MS;
                match self.mode {
                    Mode::Toggle => self.latch(down_ns, out),
                    Mode::HoldOrToggle if tap => self.latch(down_ns, out),
                    _ => {
                        out.push(Action::End { reason: "release" });
                        self.state = self.awaiting(t_ns);
                    }
                }
            }
            _ => {}
        }
        false
    }

    fn latch(&mut self, down_ns: u64, out: &mut Vec<Action>) {
        self.state = State::Listening {
            down_ns,
            held: false,
        };
        out.push(Action::Latched);
    }

    fn awaiting(&self, t_ns: u64) -> State {
        State::Awaiting {
            until_ns: t_ns + SETTLE_MS * MS,
        }
    }

    /// Time passes: a modifier held `HOLD_MS` becomes a push-to-talk session, and an unsettled
    /// insert stops holding the keys after `SETTLE_MS`.
    pub fn tick(&mut self, t_ns: u64, out: &mut Vec<Action>) {
        match self.state {
            State::Pending { down_ns }
                if self.mode != Mode::Toggle && t_ns.saturating_sub(down_ns) >= HOLD_MS * MS =>
            {
                out.push(Action::Start { t_ns: down_ns });
                self.state = State::Listening {
                    down_ns,
                    held: true,
                };
            }
            State::Awaiting { until_ns } if t_ns >= until_ns => self.state = State::Idle,
            _ => {}
        }
    }

    /// The session ended by itself (silence, maximum length) or by the app's `session.stop`.
    pub fn end(&mut self, reason: &'static str, t_ns: u64, out: &mut Vec<Action>) {
        if self.is_listening() {
            out.push(Action::End { reason });
            self.state = if reason == "cancel" {
                State::Idle
            } else {
                self.awaiting(t_ns)
            };
        }
    }

    /// `session.start` from the app: a latched session, as if the key had been tapped.
    pub fn start(&mut self, t_ns: u64, out: &mut Vec<Action>) {
        if self.state == State::Idle {
            out.push(Action::Arm { t_ns });
            out.push(Action::Start { t_ns });
            self.latch(t_ns, out);
        }
    }

    /// An insert began: the keys stay swallowed until it settles or `SETTLE_MS` passes.
    pub fn insert_started(&mut self, t_ns: u64) {
        if matches!(self.state, State::Awaiting { .. }) {
            self.state = self.awaiting(t_ns);
        }
    }

    /// The session's text was inserted, failed, or will not be inserted.
    pub fn settled(&mut self) {
        if matches!(self.state, State::Awaiting { .. }) {
            self.state = State::Idle;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A key event: `(ms, down, key)`.
    type KeyAt = (u64, bool, String);

    /// Runs a script of `(ms, down, key)` with a tick every 10 ms; returns the actions with the
    /// time they happened, and every key that was swallowed.
    fn play(
        hotkey: &str,
        mode: Mode,
        script: &[(u64, bool, &str)],
        until_ms: u64,
    ) -> (Vec<(u64, Action)>, Vec<KeyAt>) {
        let mut a = Activation::new(Hotkey::parse(hotkey).unwrap(), mode);
        let mut acts = Vec::new();
        let mut swallowed = Vec::new();
        let mut i = 0;
        for ms in (0..=until_ms).step_by(10) {
            let mut out = Vec::new();
            while i < script.len() && script[i].0 <= ms {
                let (at, down, k) = script[i];
                if a.key(down, k, at * MS, &mut out) {
                    swallowed.push((at, down, k.to_string()));
                }
                i += 1;
            }
            a.tick(ms * MS, &mut out);
            acts.extend(out.into_iter().map(|x| (ms, x)));
        }
        (acts, swallowed)
    }

    fn only(acts: &[(u64, Action)], keep: fn(&Action) -> bool) -> Vec<(u64, Action)> {
        acts.iter().filter(|(_, a)| keep(a)).cloned().collect()
    }

    fn sessions(acts: &[(u64, Action)]) -> Vec<(u64, Action)> {
        only(acts, |a| {
            matches!(a, Action::Start { .. } | Action::End { .. })
        })
    }

    /// DC-A1: down and up at 800 ms is one push-to-talk session ending at the up.
    #[test]
    fn dc_a1_a_long_press_is_push_to_talk_ending_at_release() {
        let (acts, swallowed) = play(
            "RightCommand",
            Mode::HoldOrToggle,
            &[(0, true, "RightCommand"), (800, false, "RightCommand")],
            1000,
        );
        assert_eq!(
            sessions(&acts),
            vec![
                (300, Action::Start { t_ns: 0 }),
                (800, Action::End { reason: "release" })
            ]
        );
        assert!(swallowed.is_empty(), "a modifier is never swallowed");
    }

    /// DC-A1: a 120 ms tap latches; a second tap at 3 s ends the one session.
    #[test]
    fn dc_a1_a_short_tap_latches_until_the_next_tap() {
        let (acts, _) = play(
            "RightCommand",
            Mode::HoldOrToggle,
            &[
                (0, true, "RightCommand"),
                (120, false, "RightCommand"),
                (3000, true, "RightCommand"),
                (3080, false, "RightCommand"),
            ],
            3200,
        );
        assert_eq!(
            sessions(&acts),
            vec![
                (120, Action::Start { t_ns: 0 }),
                (3000, Action::End { reason: "tap" })
            ]
        );
    }

    /// DC-A1, the interrupt rule: Right Command + C within 120 ms is a copy, not a session, and C
    /// passes through; the same presses without C latch (the positive control).
    #[test]
    fn dc_a1_another_key_during_the_press_is_a_shortcut_not_a_session() {
        let (acts, swallowed) = play(
            "RightCommand",
            Mode::HoldOrToggle,
            &[
                (0, true, "RightCommand"),
                (40, true, "C"),
                (80, false, "C"),
                (120, false, "RightCommand"),
            ],
            500,
        );
        assert_eq!(sessions(&acts), vec![]);
        assert!(acts.contains(&(40, Action::Disarm)));
        assert!(swallowed.is_empty(), "C and the modifier pass through");
        let (control, _) = play(
            "RightCommand",
            Mode::HoldOrToggle,
            &[(0, true, "RightCommand"), (120, false, "RightCommand")],
            500,
        );
        assert_eq!(sessions(&control), vec![(120, Action::Start { t_ns: 0 })]);
    }

    /// DC-A1: a 1 s hold with C at 800 ms ends as cancelled and passes C through.
    #[test]
    fn dc_a1_another_key_during_a_hold_cancels_and_passes_through() {
        let (acts, swallowed) = play(
            "RightCommand",
            Mode::HoldOrToggle,
            &[
                (0, true, "RightCommand"),
                (800, true, "C"),
                (850, false, "C"),
                (1000, false, "RightCommand"),
            ],
            1200,
        );
        assert_eq!(
            sessions(&acts),
            vec![
                (300, Action::Start { t_ns: 0 }),
                (800, Action::End { reason: "cancel" })
            ]
        );
        assert!(swallowed.is_empty());
    }

    /// DC-A1 and DC-A4 together: Enter during a confirmed push-to-talk hold ends the session as
    /// `key` and is swallowed, so the app never sees Right Command + Enter; the same Enter while
    /// the press is still under `HOLD_MS` is the interrupt rule and passes (positive control).
    #[test]
    fn enter_during_a_confirmed_hold_is_dc_a4_and_before_it_the_interrupt_rule() {
        let (acts, swallowed) = play(
            "RightCommand",
            Mode::HoldOrToggle,
            &[
                (0, true, "RightCommand"),
                (800, true, "Enter"),
                (850, false, "Enter"),
                (1000, false, "RightCommand"),
            ],
            1200,
        );
        assert_eq!(
            sessions(&acts),
            vec![
                (300, Action::Start { t_ns: 0 }),
                (800, Action::End { reason: "key" })
            ]
        );
        assert!(acts.contains(&(800, Action::Key("Enter".into()))));
        assert_eq!(
            swallowed,
            vec![(800, true, "Enter".into()), (850, false, "Enter".into())]
        );
        let (acts, swallowed) = play(
            "RightCommand",
            Mode::HoldOrToggle,
            &[
                (0, true, "RightCommand"),
                (100, true, "Enter"),
                (150, false, "Enter"),
                (200, false, "RightCommand"),
            ],
            500,
        );
        assert_eq!(sessions(&acts), vec![]);
        assert!(
            swallowed.is_empty(),
            "a shortcut, not a session: {swallowed:?}"
        );
    }

    /// A `RightShift` hotkey held is not Shift for Enter: Enter during its hold is Enter.
    #[test]
    fn the_hotkeys_own_shift_does_not_make_enter_shift_enter() {
        let (acts, _) = play(
            "RightShift",
            Mode::HoldOrToggle,
            &[(0, true, "RightShift"), (800, true, "Enter")],
            900,
        );
        assert!(
            acts.contains(&(800, Action::Key("Enter".into()))),
            "{acts:?}"
        );
    }

    /// DC-A1: Enter during a held `Control+Shift+Space` is Enter, since its Shift is the chord's,
    /// so it ends the session and sends instead of opening the draft box; once the chord was
    /// tapped and let go, a Shift pressed again with Enter is Shift+Enter (the positive control).
    #[test]
    fn dc_a1_the_shift_of_a_held_chord_does_not_make_enter_shift_enter() {
        let (acts, _) = play(
            "Control+Shift+Space",
            Mode::HoldOrToggle,
            &[
                (0, true, "LeftControl"),
                (10, true, "LeftShift"),
                (20, true, "Space"),
                (800, true, "Enter"),
            ],
            900,
        );
        assert!(
            acts.contains(&(800, Action::Key("Enter".into()))),
            "{acts:?}"
        );
        assert!(acts.contains(&(800, Action::End { reason: "key" })));
        let (acts, _) = play(
            "Control+Shift+Space",
            Mode::HoldOrToggle,
            &[
                (0, true, "LeftControl"),
                (10, true, "LeftShift"),
                (20, true, "Space"),
                (100, false, "Space"),
                (110, false, "LeftShift"),
                (120, false, "LeftControl"),
                (500, true, "LeftShift"),
                (520, true, "Enter"),
            ],
            600,
        );
        assert!(
            acts.contains(&(520, Action::Key("Shift+Enter".into()))),
            "{acts:?}"
        );
        // A chord whose Shift has a side leaves the other Shift a Shift.
        let (acts, _) = play(
            "Control+RightShift+Space",
            Mode::HoldOrToggle,
            &[
                (0, true, "LeftControl"),
                (10, true, "RightShift"),
                (20, true, "Space"),
                (500, true, "LeftShift"),
                (520, true, "Enter"),
            ],
            600,
        );
        assert!(
            acts.contains(&(520, Action::Key("Shift+Enter".into()))),
            "{acts:?}"
        );
    }

    /// DC-A3: the helper says `Latched` when a session latches (a tap, toggle, a chord let go
    /// before `HOLD_MS`, the app's start), right after its `Start`; a push-to-talk hold never.
    #[test]
    fn dc_a3_a_latched_session_says_so_and_a_hold_never_does() {
        let latched = |acts: &[(u64, Action)]| {
            only(acts, |a| {
                matches!(a, Action::Start { .. } | Action::Latched)
            })
        };
        let tap = [(0, true, "RightCommand"), (120, false, "RightCommand")];
        let (acts, _) = play("RightCommand", Mode::HoldOrToggle, &tap, 500);
        assert_eq!(
            latched(&acts),
            vec![(120, Action::Start { t_ns: 0 }), (120, Action::Latched)]
        );
        let (acts, _) = play(
            "RightCommand",
            Mode::HoldOrToggle,
            &[(0, true, "RightCommand"), (800, false, "RightCommand")],
            1000,
        );
        assert!(!acts.iter().any(|(_, a)| *a == Action::Latched), "{acts:?}");
        let (acts, _) = play("RightCommand", Mode::Hold, &tap, 500);
        assert!(!acts.iter().any(|(_, a)| *a == Action::Latched), "{acts:?}");
        let (acts, _) = play(
            "RightCommand",
            Mode::Toggle,
            &[(0, true, "RightCommand"), (900, false, "RightCommand")],
            1000,
        );
        assert!(acts.contains(&(900, Action::Latched)), "{acts:?}");
        let chord = |up: u64| {
            play(
                "Control+Space",
                Mode::HoldOrToggle,
                &[
                    (0, true, "LeftControl"),
                    (10, true, "Space"),
                    (up, false, "Space"),
                ],
                1000,
            )
            .0
        };
        assert!(chord(100).contains(&(100, Action::Latched)));
        assert!(!chord(900).iter().any(|(_, a)| *a == Action::Latched));
        let mut a = Activation::new(Hotkey::parse("RightCommand").unwrap(), Mode::Hold);
        let mut out = Vec::new();
        a.start(0, &mut out);
        assert_eq!(
            out,
            vec![
                Action::Arm { t_ns: 0 },
                Action::Start { t_ns: 0 },
                Action::Latched
            ]
        );
    }

    /// A chord held past `HOLD_MS` ends at its key's release however the OS spells the key, so a
    /// hold never runs on because the up said `space` and the binding `Space`.
    #[test]
    fn a_chord_hold_ends_at_release_whatever_the_case_of_the_key() {
        let (acts, swallowed) = play(
            "Control+Shift+Space",
            Mode::HoldOrToggle,
            &[
                (0, true, "LeftCtrl"),
                (10, true, "LeftShift"),
                (20, true, "space"),
                (900, false, "SPACE"),
            ],
            1000,
        );
        assert_eq!(
            sessions(&acts),
            vec![
                (20, Action::Start { t_ns: 20 * MS }),
                (900, Action::End { reason: "release" })
            ]
        );
        assert_eq!(swallowed.len(), 2, "down and up: {swallowed:?}");
    }

    /// DC-A6: a mouse button runs a session like a key: held, it ends at the button-up.
    #[test]
    fn dc_a6_a_mouse_button_down_and_up_runs_a_session() {
        let (acts, swallowed) = play(
            "Mouse4",
            Mode::HoldOrToggle,
            &[(0, true, "Mouse4"), (900, false, "Mouse4")],
            1000,
        );
        assert_eq!(
            sessions(&acts),
            vec![
                (0, Action::Start { t_ns: 0 }),
                (900, Action::End { reason: "release" })
            ]
        );
        assert_eq!(swallowed.len(), 2, "back is not also a page back");
    }

    /// DC-A6 on Windows: the mouse hook, which sees every move on the machine, is wanted only
    /// while a button is the binding or the recorder is open, and not once a key is bound again.
    #[test]
    fn dc_a6_the_mouse_is_wanted_only_for_a_button_binding_or_the_recorder() {
        let mut a = Activation::new(Hotkey::parse("RightControl").unwrap(), Mode::HoldOrToggle);
        assert!(!a.wants_mouse());
        a.record_keys(true);
        assert!(a.wants_mouse(), "the recorder may be given Mouse4");
        a.record_keys(false);
        a.rebind(
            Hotkey::parse("mouse5").unwrap(),
            Mode::Hold,
            &mut Vec::new(),
        );
        assert!(a.wants_mouse());
        a.rebind(
            Hotkey::parse("Control+Shift+M").unwrap(),
            Mode::Hold,
            &mut Vec::new(),
        );
        assert!(!a.wants_mouse(), "a chord ending in M is no mouse button");
    }

    /// The portal reports the binding, not its keys: `trigger` runs a hold with no modifier seen.
    #[test]
    fn the_portal_trigger_runs_a_chord_with_no_modifier_seen() {
        let mut a = Activation::new(
            Hotkey::parse("Control+Shift+Space").unwrap(),
            Mode::HoldOrToggle,
        );
        let mut out = Vec::new();
        a.trigger(true, 0, &mut out);
        a.tick(500 * MS, &mut out);
        a.trigger(false, 900 * MS, &mut out);
        assert_eq!(
            out,
            vec![
                Action::Arm { t_ns: 0 },
                Action::Start { t_ns: 0 },
                Action::End { reason: "release" }
            ]
        );
    }

    #[test]
    fn hold_mode_never_latches_and_toggle_mode_always_does() {
        let tap = [(0, true, "RightShift"), (100, false, "RightShift")];
        let (hold, _) = play("RightShift", Mode::Hold, &tap, 300);
        assert_eq!(
            sessions(&hold),
            vec![
                (100, Action::Start { t_ns: 0 }),
                (100, Action::End { reason: "release" })
            ]
        );
        let long = [(0, true, "RightShift"), (900, false, "RightShift")];
        let (toggle, _) = play("RightShift", Mode::Toggle, &long, 1000);
        assert_eq!(sessions(&toggle), vec![(900, Action::Start { t_ns: 0 })]);
    }

    /// A chord starts at once and swallows its own key, down and up; other keys during it pass.
    #[test]
    fn a_chord_starts_at_key_down_and_swallows_only_its_own_key() {
        let (acts, swallowed) = play(
            "Control+Shift+Space",
            Mode::HoldOrToggle,
            &[
                (0, true, "LeftControl"),
                (10, true, "LeftShift"),
                (20, true, "Space"),
                (500, true, "A"),
                (520, false, "A"),
                (900, false, "Space"),
            ],
            1000,
        );
        assert_eq!(
            sessions(&acts),
            vec![
                (20, Action::Start { t_ns: 20 * MS }),
                (900, Action::End { reason: "release" })
            ]
        );
        assert_eq!(
            swallowed,
            vec![(20, true, "Space".into()), (900, false, "Space".into())]
        );
    }

    /// DC-A4: while listening Escape cancels, Enter ends the session, Shift+Enter is reported as
    /// such, and all three are swallowed; with no session the same keys pass (positive control).
    #[test]
    fn dc_a4_escape_enter_and_shift_enter_are_swallowed_only_in_a_session() {
        let latch = [(0, true, "RightCommand"), (100, false, "RightCommand")];
        let with = |extra: &[(u64, bool, &'static str)]| {
            let mut s = latch.to_vec();
            s.extend_from_slice(extra);
            play("RightCommand", Mode::HoldOrToggle, &s, 2000)
        };
        let (acts, sw) = with(&[(500, true, "Escape"), (550, false, "Escape")]);
        assert!(acts.contains(&(500, Action::Key("Escape".into()))));
        assert!(acts.contains(&(500, Action::End { reason: "cancel" })));
        assert_eq!(sw.len(), 2, "down and up swallowed: {sw:?}");
        let (acts, _) = with(&[(500, true, "Enter"), (550, false, "Enter")]);
        assert!(acts.contains(&(500, Action::End { reason: "key" })));
        let (acts, sw) = with(&[
            (500, true, "LeftShift"),
            (520, true, "Enter"),
            (540, false, "Enter"),
            (560, false, "LeftShift"),
        ]);
        assert!(acts.contains(&(520, Action::Key("Shift+Enter".into()))));
        assert_eq!(
            sw,
            vec![(520, true, "Enter".into()), (540, false, "Enter".into())]
        );
        let (acts, sw) = play(
            "RightCommand",
            Mode::HoldOrToggle,
            &[
                (0, true, "Escape"),
                (10, false, "Escape"),
                (20, true, "Enter"),
                (30, false, "Enter"),
            ],
            100,
        );
        assert!(acts.is_empty() && sw.is_empty(), "{acts:?} {sw:?}");
    }

    /// DC-A4: after the release, until the insert settles, Enter is still swallowed (the natural
    /// release-then-Enter), a hotkey press starts nothing and is reported, and after `SETTLE_MS`
    /// with no answer the keys pass again.
    #[test]
    fn dc_a4_keys_stay_swallowed_while_transcribing_and_are_released_after_the_timeout() {
        let (acts, sw) = play(
            "RightCommand",
            Mode::HoldOrToggle,
            &[
                (0, true, "RightCommand"),
                (800, false, "RightCommand"),
                (1000, true, "Enter"),
                (1010, false, "Enter"),
                (1500, true, "RightCommand"),
                (1600, false, "RightCommand"),
                (9000, true, "Enter"),
                (9010, false, "Enter"),
            ],
            9100,
        );
        assert!(acts.contains(&(1000, Action::Key("Enter".into()))));
        assert!(acts.contains(&(1500, Action::Key("RightCommand".into()))));
        assert_eq!(sessions(&acts).len(), 2, "one session: {acts:?}");
        assert_eq!(
            sw,
            vec![(1000, true, "Enter".into()), (1010, false, "Enter".into())],
            "the Enter at 9 s, after the 8 s timeout, passes"
        );
    }

    #[test]
    fn settled_releases_the_keys_at_once() {
        let mut a = Activation::new(Hotkey::parse("RightCommand").unwrap(), Mode::HoldOrToggle);
        let mut out = Vec::new();
        a.start(0, &mut out);
        a.end("tap", MS, &mut out);
        assert!(a.key(true, "Enter", 2 * MS, &mut out));
        assert!(a.key(false, "Enter", 3 * MS, &mut out));
        a.settled();
        assert!(!a.key(true, "Enter", 4 * MS, &mut out));
    }

    /// DC-A4 on a backend that cannot swallow (evdev): Escape and Enter would reach the app as
    /// well, so they neither end the session nor are reported, and during a confirmed hold Enter
    /// is the interrupt rule like any key. The same keys with `swallows` on are the control.
    #[test]
    fn dc_a4_keys_do_nothing_on_a_backend_that_cannot_swallow() {
        for swallows in [true, false] {
            let mut a = Activation::new(Hotkey::parse("RightCommand").unwrap(), Mode::HoldOrToggle);
            a.set_swallows(swallows);
            let mut out = Vec::new();
            a.start(0, &mut out);
            out.clear();
            let enter = a.key(true, "Enter", MS, &mut out);
            a.key(false, "Enter", 2 * MS, &mut out);
            if swallows {
                assert!(enter);
                assert_eq!(
                    out,
                    vec![Action::Key("Enter".into()), Action::End { reason: "key" }]
                );
                a.settled();
            } else {
                assert!(!enter, "Enter is not claimed as swallowed");
                assert_eq!(out, vec![], "Enter neither sends nor ends the session");
                assert!(!a.key(true, "Escape", 3 * MS, &mut out));
                a.key(false, "Escape", 4 * MS, &mut out);
                assert_eq!(out, vec![], "Escape does not cancel");
                assert!(a.is_listening());
                a.end("tap", 5 * MS, &mut out);
                out.clear();
                assert!(!a.key(true, "Enter", 6 * MS, &mut out));
                a.key(false, "Enter", 7 * MS, &mut out);
                assert_eq!(out, vec![], "Enter while transcribing asks nothing");
                a.settled();
            }
            // A confirmed push-to-talk hold, then Enter.
            out.clear();
            a.key(true, "RightCommand", 100 * MS, &mut out);
            a.tick(500 * MS, &mut out);
            out.clear();
            let enter = a.key(true, "Enter", 600 * MS, &mut out);
            assert_eq!(enter, swallows);
            if swallows {
                assert_eq!(
                    out,
                    vec![Action::Key("Enter".into()), Action::End { reason: "key" }]
                );
            } else {
                assert_eq!(out, vec![Action::End { reason: "cancel" }]);
            }
        }
    }

    #[test]
    fn record_keys_reports_every_key_and_starts_nothing() {
        let mut a = Activation::new(Hotkey::parse("RightCommand").unwrap(), Mode::HoldOrToggle);
        a.record_keys(true);
        let mut out = Vec::new();
        assert!(!a.key(true, "RightCommand", 0, &mut out));
        a.tick(500 * MS, &mut out);
        assert!(!a.key(true, "Fn", 600 * MS, &mut out));
        assert_eq!(
            out,
            vec![Action::Key("RightCommand".into()), Action::Key("Fn".into())]
        );
    }
}
