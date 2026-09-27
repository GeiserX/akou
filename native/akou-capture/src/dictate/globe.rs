//! Fn or Globe as the dictation key on macOS (docs/ux/DICTATION.md DC-N2).
//!
//! A press of Fn alone also runs the key's own action (the emoji picker, the input source switch
//! or Apple's dictation, System Settings, Keyboard, "Press fn key to"), and the tap never
//! swallows a modifier (DC-A1). So while `Fn` is the dictation key the helper sets that action to
//! "Do Nothing" (`com.apple.HIToolbox AppleFnUsageType = 0`) and puts the user's value back when
//! the key is rebound, on `stop`, and, after a crash, at the next start: the value is saved first
//! in akou's own preferences domain, a file on disk that outlives the process.
//!
//! The value goes back only while it is still the one akou wrote: a choice the user made in System
//! Settings meanwhile stays.

use super::keys::{Hotkey, Mod, modifier};

/// A per-user preferences store: macOS `CFPreferences` (current user, any host, the domain
/// `defaults` reads), a map in the tests.
pub trait Prefs {
    fn get(&mut self, domain: &str, key: &str) -> Option<i64>;
    /// `None` removes the key.
    fn set(&mut self, domain: &str, key: &str, value: Option<i64>);
}

pub const HITOOLBOX: &str = "com.apple.HIToolbox";
pub const FN_USAGE: &str = "AppleFnUsageType";
/// "Press fn key to: Do Nothing".
pub const DO_NOTHING: i64 = 0;
/// Where the user's value waits while akou owns the key.
pub const OWN: &str = "io.github.geiserx.akou.dictate";
pub const SAVED: &str = "globeSavedFnUsageType";
/// The saved value when the user had none (the system default applies).
const UNSET: i64 = -1;

/// The binding is Fn alone.
pub fn is_fn(hotkey: &Hotkey) -> bool {
    matches!(hotkey, Hotkey::Modifier(m) if matches!(modifier(m), Some((Mod::Fn, _))))
}

pub struct Globe {
    prefs: Box<dyn Prefs>,
}

impl Globe {
    pub fn new(prefs: Box<dyn Prefs>) -> Globe {
        Globe { prefs }
    }

    /// The binding is now `hotkey`, at start or on `rebind`. At start this is also the crash
    /// repair: a value a crashed run saved goes back, or stays saved while Fn is still the key.
    pub fn follow(&mut self, hotkey: &Hotkey) {
        if is_fn(hotkey) {
            self.own();
        } else {
            self.release();
        }
    }

    fn own(&mut self) {
        // Saved before the write, so a crash between the two loses nothing. A value that is
        // still akou's own is never saved (a rebind to Fn, a restart after a crash); one the user
        // chose after a crash replaces the value that crashed run saved.
        let now = self.prefs.get(HITOOLBOX, FN_USAGE);
        if self.prefs.get(OWN, SAVED).is_none() || now != Some(DO_NOTHING) {
            self.prefs.set(OWN, SAVED, Some(now.unwrap_or(UNSET)));
        }
        self.prefs.set(HITOOLBOX, FN_USAGE, Some(DO_NOTHING));
    }

    /// Puts the user's value back, if akou saved one.
    pub fn release(&mut self) {
        let Some(saved) = self.prefs.get(OWN, SAVED) else {
            return;
        };
        if self.prefs.get(HITOOLBOX, FN_USAGE) == Some(DO_NOTHING) {
            self.prefs
                .set(HITOOLBOX, FN_USAGE, (saved != UNSET).then_some(saved));
        }
        self.prefs.set(OWN, SAVED, None);
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use std::rc::Rc;

    /// A preferences store that outlives the helper using it, as the one on disk does.
    #[derive(Clone, Default)]
    pub struct Store(pub Rc<RefCell<BTreeMap<(String, String), i64>>>);

    impl Store {
        pub fn fn_usage(&self) -> Option<i64> {
            self.0
                .borrow()
                .get(&(HITOOLBOX.into(), FN_USAGE.into()))
                .copied()
        }
        pub fn user_chose(&self, v: i64) {
            self.0
                .borrow_mut()
                .insert((HITOOLBOX.into(), FN_USAGE.into()), v);
        }
    }

    impl Prefs for Store {
        fn get(&mut self, domain: &str, key: &str) -> Option<i64> {
            self.0.borrow().get(&(domain.into(), key.into())).copied()
        }
        fn set(&mut self, domain: &str, key: &str, value: Option<i64>) {
            let k = (domain.to_string(), key.to_string());
            match value {
                Some(v) => self.0.borrow_mut().insert(k, v),
                None => self.0.borrow_mut().remove(&k),
            };
        }
    }

    fn key(s: &str) -> Hotkey {
        Hotkey::parse(s).unwrap()
    }

    /// DC-N2: binding Fn sets the Globe action to Do Nothing; rebinding away puts the user's
    /// value back (the emoji picker, 2 here).
    #[test]
    fn dc_n2_fn_as_the_key_silences_the_globe_action_and_gives_it_back() {
        let store = Store::default();
        store.user_chose(2);
        let mut g = Globe::new(Box::new(store.clone()));
        g.follow(&key("RightCommand"));
        assert_eq!(store.fn_usage(), Some(2), "not bound to Fn: untouched");
        g.follow(&key("Fn"));
        assert_eq!(store.fn_usage(), Some(DO_NOTHING));
        g.follow(&key("Control+Shift+Space"));
        assert_eq!(store.fn_usage(), Some(2));
        assert_eq!(store.0.borrow().len(), 1, "nothing of akou's left behind");
    }

    /// DC-N2: the helper crashed while it owned Fn. Restarted on Fn it owns the key again with the
    /// user's value still the one saved; crashed again and restarted on another key, the value
    /// goes back.
    #[test]
    fn dc_n2_a_crash_is_repaired_at_the_next_start() {
        let store = Store::default();
        store.user_chose(1);
        let mut crashed = Globe::new(Box::new(store.clone()));
        crashed.follow(&key("Fn"));
        assert_eq!(store.fn_usage(), Some(DO_NOTHING));
        // No release: the process died.
        drop(crashed);
        let mut on_fn = Globe::new(Box::new(store.clone()));
        on_fn.follow(&key("Fn"));
        on_fn.follow(&key("Fn"));
        assert_eq!(store.fn_usage(), Some(DO_NOTHING));
        drop(on_fn);
        let mut next = Globe::new(Box::new(store.clone()));
        next.follow(&key("RightCommand"));
        assert_eq!(store.fn_usage(), Some(1));
    }

    /// A user with no value of their own gets none back (the system default applies again); a
    /// value the user picked in System Settings while akou owned the key stays.
    #[test]
    fn dc_n2_the_restore_never_overrides_the_user() {
        let store = Store::default();
        let mut g = Globe::new(Box::new(store.clone()));
        g.follow(&key("Fn"));
        assert_eq!(store.fn_usage(), Some(DO_NOTHING));
        g.release();
        assert_eq!(store.fn_usage(), None);

        g.follow(&key("Fn"));
        store.user_chose(3);
        g.release();
        assert_eq!(store.fn_usage(), Some(3), "the user's newer choice stays");
    }

    /// DC-N2: the helper crashed while it owned Fn (the user's 2 saved), then the user picked 1 in
    /// System Settings. The next start on Fn owns the key again and saves the 1, so a later
    /// release gives back the newer choice, not the crashed run's 2.
    #[test]
    fn dc_n2_a_choice_made_after_a_crash_is_the_one_given_back() {
        let store = Store::default();
        store.user_chose(2);
        let mut crashed = Globe::new(Box::new(store.clone()));
        crashed.follow(&key("Fn"));
        drop(crashed);
        store.user_chose(1);
        let mut next = Globe::new(Box::new(store.clone()));
        next.follow(&key("Fn"));
        assert_eq!(store.fn_usage(), Some(DO_NOTHING));
        next.release();
        assert_eq!(store.fn_usage(), Some(1), "the choice made after the crash");
    }
}
