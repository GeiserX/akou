//! The tap front (docs/ux/DICTATION.md DC-N1): the only code that runs on the thread answering the
//! OS key tap or hook.
//!
//! A macOS event tap that misses its timeout is disabled, and until it is enabled again every
//! keystroke on the machine waits on it; a Windows low-level hook that is slow is dropped the same
//! way. So this thread decides swallow-or-pass from `Activation`'s in-memory state, queues what it
//! decided, wakes the worker and returns. It never waits on the mic, the clipboard, an
//! accessibility read or a paste receipt: those run on the worker (`session::Dictate`), which
//! takes the queue under the same short lock before each of its own steps, so the tap's actions
//! and the worker's are carried out in the order they happened.
//!
//! Three more things are decided here, because only this thread sees them in time:
//!
//! - **Tap disabled** (macOS `TapDisabledByTimeout` or `ByUserInput`): the callback enables the
//!   tap again at once (never a timer that polls it, the voucher leak of Handy #1827). Key-ups
//!   that happened while it was off were never seen, so every key the gate thinks is down and the
//!   OS says is not goes up now; a hotkey released in the gap ends its hold instead of sticking.
//!   The worker re-checks the Accessibility grant, since a revoked grant disables the tap too.
//! - **The mask key** (Windows): a Win or Alt key released with nothing typed while it was down
//!   opens the Start menu or the menu bar. When that key was the dictation key, or a key swallowed
//!   for dictation went down while it was held, the hook posts the unassigned key 0xE8 before the
//!   release passes, so Windows sees a chord and opens nothing (AutoHotkey's `#MenuMaskKey`).
//! - **Commit keys**: Return, keypad Enter or Tab passed to the app is where the field read-back
//!   (DC-L2) reads, before a chat app clears the field.

use std::sync::{Arc, Mutex, MutexGuard, mpsc};

use super::activation::{Action, Activation};
use super::insert::Os;
use super::keys::{self, Mod};

/// What the tap decided, for the worker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Note {
    Act(Action),
    /// A key that commits a field went to the app (DC-L2 reads now).
    Commit,
    /// The tap was disabled and enabled again: re-check the Accessibility grant.
    Disabled,
}

pub struct Shared {
    pub act: Activation,
    /// Every note with the time it happened, in order, until the worker takes them.
    pub queue: Vec<(u64, Note)>,
    /// Windows: the Win and Alt keys down now.
    menu_keys: Vec<MenuKey>,
}

struct MenuKey {
    name: String,
    /// A key went to the app while it was down: Windows sees a chord already.
    passed: bool,
    /// It is the dictation key, or a key was swallowed for dictation while it was down.
    ours: bool,
}

/// The answer to one tap event.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Verdict {
    /// Drop the event: the app under the cursor never sees it.
    pub swallow: bool,
    /// Windows: post the mask key before this release passes.
    pub mask: bool,
    /// macOS: enable the tap again.
    pub reenable: bool,
}

#[derive(Clone, Copy, Debug)]
pub enum TapEvent<'a> {
    Key {
        down: bool,
        name: &'a str,
        t_ns: u64,
    },
    /// The tap was disabled; `held` is every key the OS says is down now.
    Disabled { t_ns: u64, held: &'a [String] },
    /// The GlobalShortcuts portal's `Activated` (`active`) or `Deactivated` for the binding.
    Portal { active: bool, t_ns: u64 },
}

/// The tap's handle. Cheap to clone; one per tap thread.
#[derive(Clone)]
pub struct Gate {
    shared: Arc<Mutex<Shared>>,
    os: Os,
    wake: Option<mpsc::Sender<()>>,
}

fn is_menu_key(name: &str) -> bool {
    matches!(keys::modifier(name), Some((Mod::Command | Mod::Option, _)))
}

fn is_commit(name: &str) -> bool {
    ["Return", "Enter", "KeypadEnter", "Tab"]
        .iter()
        .any(|k| keys::same(k, name))
}

impl Gate {
    pub fn new(act: Activation, os: Os) -> Gate {
        Gate {
            shared: Arc::new(Mutex::new(Shared {
                act,
                queue: Vec::new(),
                menu_keys: Vec::new(),
            })),
            os,
            wake: None,
        }
    }

    /// The worker's wake-up: one `()` per event that queued something.
    pub fn set_wake(&mut self, wake: mpsc::Sender<()>) {
        self.wake = Some(wake);
    }

    /// The lock both threads take. Held only while `Activation` decides, never across I/O. A
    /// panic elsewhere cannot leave it unusable: the state is plain data.
    pub fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn event(&self, e: TapEvent) -> Verdict {
        let mut v = Verdict::default();
        let queued = {
            let mut s = self.lock();
            let mut acts = Vec::new();
            let (t_ns, extra) = match e {
                TapEvent::Key { down, name, t_ns } => {
                    v.swallow = s.act.key(down, name, t_ns, &mut acts);
                    if self.os == Os::Windows {
                        v.mask = s.menu(down, name, v.swallow);
                    }
                    let commit = down && !v.swallow && is_commit(name);
                    (t_ns, commit.then_some(Note::Commit))
                }
                TapEvent::Disabled { t_ns, held } => {
                    v.reenable = true;
                    let gone: Vec<String> = s
                        .act
                        .held()
                        .iter()
                        .filter(|k| !held.iter().any(|h| keys::same(h, k)))
                        .cloned()
                        .collect();
                    for k in gone {
                        s.act.key(false, &k, t_ns, &mut acts);
                    }
                    s.menu_keys
                        .retain(|m| held.iter().any(|h| keys::same(h, &m.name)));
                    (t_ns, Some(Note::Disabled))
                }
                TapEvent::Portal { active, t_ns } => {
                    s.act.trigger(active, t_ns, &mut acts);
                    (t_ns, None)
                }
            };
            let n = acts.len() + usize::from(extra.is_some());
            s.queue.extend(
                acts.into_iter()
                    .map(Note::Act)
                    .chain(extra)
                    .map(|n| (t_ns, n)),
            );
            n > 0
        };
        if queued && let Some(w) = &self.wake {
            let _ = w.send(());
        }
        v
    }
}

impl Shared {
    /// Tracks Win and Alt; returns whether this release needs the mask key.
    fn menu(&mut self, down: bool, name: &str, swallowed: bool) -> bool {
        if is_menu_key(name) {
            if down {
                if !self.menu_keys.iter().any(|m| keys::same(&m.name, name)) {
                    let h = self.act.hotkey();
                    let ours = h.is_modifier_only() && keys::same(h.trigger(), name);
                    self.menu_keys.push(MenuKey {
                        name: name.to_string(),
                        passed: false,
                        ours,
                    });
                }
                return false;
            }
            let i = self
                .menu_keys
                .iter()
                .position(|m| keys::same(&m.name, name));
            return i.is_some_and(|i| {
                let m = self.menu_keys.remove(i);
                m.ours && !m.passed
            });
        }
        if down {
            for m in &mut self.menu_keys {
                if swallowed {
                    m.ours = true;
                } else {
                    m.passed = true;
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictate::activation::Mode;
    use crate::dictate::keys::Hotkey;

    const MS: u64 = 1_000_000;

    fn gate(hotkey: &str, os: Os) -> Gate {
        Gate::new(
            Activation::new(Hotkey::parse(hotkey).unwrap(), Mode::HoldOrToggle),
            os,
        )
    }

    fn key(g: &Gate, down: bool, name: &str, ms: u64) -> Verdict {
        g.event(TapEvent::Key {
            down,
            name,
            t_ns: ms * MS,
        })
    }

    fn drain(g: &Gate) -> Vec<(u64, Note)> {
        std::mem::take(&mut g.lock().queue)
    }

    /// DC-N1 on Windows: a lone Right Win tap bound to dictation is followed by the mask key, so
    /// the Start menu stays shut; Right Win + E passes as the shortcut with no mask (positive
    /// control); and on macOS no mask is ever asked for.
    #[test]
    fn dc_n1_a_lone_win_press_for_dictation_is_masked() {
        let g = gate("RightWin", Os::Windows);
        assert!(!key(&g, true, "RightWin", 0).mask);
        let up = key(&g, false, "RightWin", 100);
        assert!(
            up.mask && !up.swallow,
            "the modifier passes, masked: {up:?}"
        );

        let g = gate("RightWin", Os::Windows);
        key(&g, true, "RightWin", 0);
        key(&g, true, "E", 50);
        key(&g, false, "E", 80);
        assert!(!key(&g, false, "RightWin", 100).mask, "Win+E is the app's");

        let g = gate("RightWin", Os::Mac);
        key(&g, true, "RightWin", 0);
        assert!(!key(&g, false, "RightWin", 100).mask);
    }

    /// A chord swallowed while Alt is held leaves Alt alone to Windows: masked. A lone Alt that
    /// has nothing to do with dictation is Windows' own menu key and is left alone.
    #[test]
    fn dc_n1_alt_is_masked_only_when_dictation_took_a_key_under_it() {
        let g = gate("Alt+Space", Os::Windows);
        key(&g, true, "LeftAlt", 0);
        assert!(key(&g, true, "Space", 20).swallow);
        assert!(key(&g, false, "Space", 900).swallow);
        assert!(key(&g, false, "LeftAlt", 950).mask);

        let g = gate("Alt+Space", Os::Windows);
        key(&g, true, "LeftAlt", 0);
        assert!(!key(&g, false, "LeftAlt", 100).mask);
    }

    /// DC-N1 on macOS: a disabled tap is enabled again, and a hotkey released while it was off
    /// ends its hold at once instead of sticking; the next press starts a new session. Without
    /// the resync the next press is taken for auto-repeat and starts nothing (the trap this
    /// guards).
    #[test]
    fn dc_n1_a_disabled_tap_reenables_and_a_release_in_the_gap_does_not_stick() {
        let g = gate("RightCommand", Os::Mac);
        key(&g, true, "RightCommand", 0);
        g.lock().act.tick(400 * MS, &mut Vec::new());
        drain(&g);
        let v = g.event(TapEvent::Disabled {
            t_ns: 900 * MS,
            held: &[],
        });
        assert!(v.reenable);
        let q = drain(&g);
        assert!(
            q.contains(&(900 * MS, Note::Act(Action::End { reason: "release" }))),
            "{q:?}"
        );
        assert!(q.contains(&(900 * MS, Note::Disabled)));
        g.lock().act.settled();
        key(&g, true, "RightCommand", 2000);
        g.lock().act.tick(2400 * MS, &mut Vec::new());
        assert!(g.lock().act.is_listening(), "the next press is a press");

        // A key the OS still reports down stays down.
        let g = gate("RightCommand", Os::Mac);
        key(&g, true, "RightCommand", 0);
        g.event(TapEvent::Disabled {
            t_ns: 100 * MS,
            held: &["RightCmd".into()],
        });
        assert_eq!(g.lock().act.held(), ["RightCommand"]);
    }

    /// DC-N1 on Linux: the portal's `Activated` and `Deactivated` run a push-to-talk session, and
    /// `Deactivated` is what ends it.
    #[test]
    fn dc_n1_a_portal_deactivated_ends_the_session() {
        let g = gate("Control+Shift+Space", Os::Linux);
        g.event(TapEvent::Portal {
            active: true,
            t_ns: 0,
        });
        g.lock().act.tick(500 * MS, &mut Vec::new());
        assert!(g.lock().act.is_listening());
        g.event(TapEvent::Portal {
            active: false,
            t_ns: 900 * MS,
        });
        let q = drain(&g);
        assert_eq!(
            q.last(),
            Some(&(900 * MS, Note::Act(Action::End { reason: "release" })))
        );
        assert!(!g.lock().act.is_listening());
    }

    /// DC-L2: Return, keypad Enter and Tab that reach the app are commit notes; an Enter
    /// swallowed for a session is not (it never reached the field).
    #[test]
    fn commit_keys_are_noted_only_when_they_reach_the_app() {
        let g = gate("RightCommand", Os::Mac);
        for k in ["Return", "KeypadEnter", "tab"] {
            key(&g, true, k, 0);
            key(&g, false, k, 10);
        }
        let commits = drain(&g).iter().filter(|(_, n)| *n == Note::Commit).count();
        assert_eq!(commits, 3);
        g.lock().act.start(100 * MS, &mut Vec::new());
        assert!(key(&g, true, "Enter", 200).swallow);
        assert!(!drain(&g).iter().any(|(_, n)| *n == Note::Commit));
    }

    /// The worker is woken once per event that queued a note, and never for one that did not.
    #[test]
    fn the_worker_is_woken_only_when_there_is_work() {
        let mut g = gate("RightCommand", Os::Mac);
        let (tx, rx) = mpsc::channel();
        g.set_wake(tx);
        key(&g, true, "A", 0);
        key(&g, false, "A", 10);
        assert!(rx.try_recv().is_err(), "a key that decided nothing");
        key(&g, true, "RightCommand", 20);
        assert!(rx.try_recv().is_ok(), "the press arms the mic");
    }
}
