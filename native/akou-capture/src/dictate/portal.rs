//! The GlobalShortcuts portal, the dictation key on Linux where the desktop has it (docs/ux/
//! DICTATION.md DC-N1): KDE, GNOME 48 and later, Hyprland.
//!
//! The desktop, not akou, owns the key. The helper asks `org.freedesktop.portal.GlobalShortcuts`
//! on the session bus to bind one shortcut, `dictate`, with the chord as its preferred trigger;
//! the desktop may show a dialog and may let the user pick another trigger. From then on it sends
//! `Activated` when the shortcut goes down and `Deactivated` when it comes up, and those two run
//! the session through `tap::Gate` like a key would (`TapEvent::Portal`). Nothing under
//! `/dev/input` is read and no udev rule is needed.
//!
//! - **Chords only.** The portal names a trigger as modifiers and a key symbol (`CTRL+SHIFT+space`,
//!   the XDG shortcuts format). It cannot bind a modifier alone, a left or right side, `Fn` or a
//!   mouse button, so those bindings go to evdev (`linux`) instead, and `trigger` says which is
//!   which. A key symbol is what the layout types, so on a German layout `Control+Shift+Z` is the
//!   key labelled Z, not the place evdev would name.
//! - **Nothing is swallowed.** The desktop takes the chord from the apps itself, but no other key:
//!   `ready.swallow_keys` is false, as on evdev (DC-A4).
//! - **The app id.** A program outside a sandbox has no app id the portal can see, and GNOME binds
//!   nothing for an empty one, so the helper registers `APP_ID` first through the host registry
//!   (`org.freedesktop.host.portal.Registry`, xdg-desktop-portal 1.19.1 and later). An older
//!   portal has no registry; the call fails and binding goes on without it.
//! - **One session per binding.** A rebind closes the portal session and opens a new one, so a
//!   late `Activated` from the old binding names a session that no longer counts. Until the new
//!   one is bound, `Shared::owns` is false and evdev serves the binding if it can read a keyboard.
//! - **Threads.** The signal thread reads every signal under the portal's object path and hands
//!   `Activated` and `Deactivated` to the gate at once; it never waits on anything else. The bind
//!   thread makes the calls and waits for the portal's answers, which may be a dialog the user
//!   takes a minute to read, so it never runs on the worker. A newer binding abandons the wait.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use zbus::MatchRule;
use zbus::blocking::{Connection, MessageIterator};
use zbus::message::Type;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};

use super::keys::{Hotkey, Mod, Side};
use super::tap::{Gate, TapEvent};
use crate::clock;

pub const BACKEND: &str = "portal";
pub const DEST: &str = "org.freedesktop.portal.Desktop";
pub const PATH: &str = "/org/freedesktop/portal/desktop";
pub const SHORTCUTS: &str = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST: &str = "org.freedesktop.portal.Request";
const SESSION: &str = "org.freedesktop.portal.Session";
const REGISTRY: &str = "org.freedesktop.host.portal.Registry";
/// The desktop app's id (its bundle id, `src/main/app-info.ts`).
pub const APP_ID: &str = "io.github.geiserx.akou";
/// The one shortcut the helper binds.
pub const SHORTCUT_ID: &str = "dictate";
/// A method call gives up after this; starting the portal on the first call takes most of it.
pub const CALL_MS: u64 = 2_000;
/// A bind waits this long for the portal's answer, which may be a dialog the user reads.
pub const ANSWER_MS: u64 = 120_000;

/// The key symbol the XDG shortcuts format names a key by, for the keys a chord may end in.
fn keysym(key: &str) -> Option<String> {
    let k = key.to_ascii_lowercase();
    if k.len() == 1 && k.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Some(k);
    }
    if let Some(n) = k.strip_prefix('f')
        && let Ok(n) = n.parse::<u8>()
        && (1..=24).contains(&n)
    {
        return Some(format!("F{n}"));
    }
    if let Some(d) = k.strip_prefix("keypad")
        && d.len() == 1
        && d.chars().all(|c| c.is_ascii_digit())
    {
        return Some(format!("KP_{d}"));
    }
    let s = match k.as_str() {
        "space" => "space",
        "return" | "enter" => "Return",
        "tab" => "Tab",
        "escape" => "Escape",
        "backspace" => "BackSpace",
        "delete" => "Delete",
        "insert" => "Insert",
        "home" => "Home",
        "end" => "End",
        "pageup" => "Page_Up",
        "pagedown" => "Page_Down",
        "up" => "Up",
        "down" => "Down",
        "left" => "Left",
        "right" => "Right",
        "minus" => "minus",
        "equal" => "equal",
        "leftbracket" => "bracketleft",
        "rightbracket" => "bracketright",
        "semicolon" => "semicolon",
        "quote" => "apostrophe",
        "grave" => "grave",
        "backslash" => "backslash",
        "comma" => "comma",
        "period" => "period",
        "slash" => "slash",
        "printscreen" => "Print",
        "pause" => "Pause",
        "keypadenter" => "KP_Enter",
        "keypadplus" => "KP_Add",
        "keypadminus" => "KP_Subtract",
        "keypadmultiply" => "KP_Multiply",
        "keypaddivide" => "KP_Divide",
        "keypaddecimal" => "KP_Decimal",
        _ => return None,
    };
    Some(s.to_string())
}

/// The portal's trigger for a binding (`Control+Shift+Space` is `CTRL+SHIFT+space`), or `None`
/// when the portal cannot bind it: a modifier alone, a side-specific modifier, `Fn`, a mouse
/// button, or a key with no symbol here.
pub fn trigger(h: &Hotkey) -> Option<String> {
    let Hotkey::Chord { mods, key } = h else {
        return None;
    };
    if mods.is_empty() {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    for (m, side) in mods {
        if *side != Side::Either {
            return None;
        }
        parts.push(
            match m {
                Mod::Control => "CTRL",
                Mod::Shift => "SHIFT",
                Mod::Option => "ALT",
                Mod::Command => "LOGO",
                Mod::Fn => return None,
            }
            .into(),
        );
    }
    parts.push(keysym(key)?);
    Some(parts.join("+"))
}

/// Whether the portal backend takes a binding: a chord the portal can name goes to the portal;
/// anything else goes to evdev, which needs a readable keyboard, or it is refused and the chord
/// that works stays.
pub fn admit(h: &Hotkey, keyboard_readable: bool) -> Result<(), String> {
    if trigger(h).is_some() || keyboard_readable {
        return Ok(());
    }
    Err(format!(
        "the GlobalShortcuts portal binds a chord of Control, Shift, Alt or Super and a key, not {}; any other key needs a keyboard under /dev/input this user can read (a udev rule tagging them uaccess, or the input group)",
        h.trigger()
    ))
}

/// Whether the evdev reader reads keyboards: always without the portal, and with it only while
/// the portal does not hold the binding or the recorder is open, so a desktop that binds the key
/// never has every keystroke read as well.
pub fn evdev_reads_keyboards(recording: bool, portal: Option<&Shared>) -> bool {
    recording || portal.is_none_or(|p| !p.owns())
}

/// What the bind thread is told.
enum Ask {
    Bind { epoch: u64, trigger: String },
    Unbind,
}

/// What the helper's other threads read.
#[derive(Default)]
pub struct Shared {
    owns: AtomicBool,
    /// Bumped by every binding, so an answer to an older one is dropped.
    epoch: AtomicU64,
    /// The portal session whose `Activated` and `Deactivated` count.
    session: Mutex<Option<String>>,
    /// Every `Activated` and `Deactivated` the signal thread has handled, counted or not.
    seen: AtomicU64,
    /// The newest binding whose bind has finished, bound or not.
    settled: AtomicU64,
}

impl Shared {
    /// The portal holds the binding now: evdev hands no key to the gate.
    pub fn owns(&self) -> bool {
        self.owns.load(Ordering::SeqCst)
    }

    /// How many `Activated` and `Deactivated` signals have been handled.
    pub fn seen(&self) -> u64 {
        self.seen.load(Ordering::SeqCst)
    }

    fn counts(&self, session: &str) -> bool {
        self.lock().as_deref() == Some(session)
    }

    /// The lock that orders a binding against a bind that finishes: the epoch is bumped and
    /// checked under it, so an older bind never takes over from a newer binding.
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        self.session.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The portal, bound or binding, with its two threads.
pub struct Portal {
    tx: Sender<Ask>,
    pub shared: Arc<Shared>,
    /// The trigger last asked for.
    asked: Option<String>,
}

/// A connection with the portal's call timeout.
pub fn connect(address: Option<&str>) -> Result<Connection, String> {
    let b = match address {
        Some(a) => zbus::blocking::connection::Builder::address(a),
        None => zbus::blocking::connection::Builder::session(),
    }
    .map_err(|e| e.to_string())?;
    b.method_timeout(Duration::from_millis(CALL_MS))
        .build()
        .map_err(|e| e.to_string())
}

/// The portal's GlobalShortcuts version, or `None` where the desktop has no GlobalShortcuts.
/// Registers `APP_ID` first, since the registry must be the connection's first portal call.
pub fn version(conn: &Connection) -> Option<u32> {
    let options: HashMap<&str, Value> = HashMap::new();
    let _ = conn.call_method(
        Some(DEST),
        PATH,
        Some(REGISTRY),
        "Register",
        &(APP_ID, options),
    );
    let reply = conn
        .call_method(
            Some(DEST),
            PATH,
            Some("org.freedesktop.DBus.Properties"),
            "Get",
            &(SHORTCUTS, "version"),
        )
        .ok()?;
    let v: OwnedValue = reply.body().deserialize().ok()?;
    u32::try_from(v).ok().filter(|v| *v >= 1)
}

/// `:1.42` as the portal writes it into a request or session path: `1_42`.
fn sender_token(conn: &Connection) -> String {
    conn.unique_name()
        .map(|n| n.as_str().trim_start_matches(':').replace('.', "_"))
        .unwrap_or_default()
}

fn text(e: zbus::Error) -> String {
    e.to_string()
}

impl Portal {
    /// Starts the signal and bind threads on `conn`, which `version` has already found a
    /// GlobalShortcuts portal on. `say` writes a protocol line (a warning) from the bind thread.
    pub fn start(
        conn: Connection,
        gate: Gate,
        say: Box<dyn Fn(String) + Send>,
    ) -> Result<Portal, String> {
        let shared = Arc::new(Shared::default());
        // The match is in place before the first call, so no answer can come before it.
        let rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .path_namespace(PATH)
            .map_err(text)?
            .build();
        let signals = MessageIterator::for_match_rule(rule, &conn, None).map_err(text)?;
        let (answers_tx, answers) = mpsc::channel::<(String, u32)>();
        {
            let shared = shared.clone();
            std::thread::Builder::new()
                .name("akou-dictate-portal-signals".into())
                .spawn(move || listen(signals, &gate, &shared, &answers_tx))
                .map_err(|e| e.to_string())?;
        }
        let (tx, rx) = mpsc::channel::<Ask>();
        {
            let shared = shared.clone();
            std::thread::Builder::new()
                .name("akou-dictate-portal".into())
                .spawn(move || serve(&conn, &rx, &answers, &shared, &*say))
                .map_err(|e| e.to_string())?;
        }
        Ok(Portal {
            tx,
            shared,
            asked: None,
        })
    }

    /// A new binding. The portal stops counting at once, so evdev serves it until the portal has
    /// bound it; a binding the portal cannot take (`trigger` is `None`) only closes the old one.
    /// The same chord again, bound or still binding, changes nothing: the app rebinds right after
    /// `ready`, and a second session could mean a second dialog.
    pub fn bind(&mut self, h: &Hotkey) {
        let t = trigger(h);
        let binding =
            self.shared.settled.load(Ordering::SeqCst) < self.shared.epoch.load(Ordering::SeqCst);
        if t.is_some() && t == self.asked && (self.shared.owns() || binding) {
            return;
        }
        self.asked = t.clone();
        let mut s = self.shared.lock();
        let epoch = self.shared.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        *s = None;
        self.shared.owns.store(false, Ordering::SeqCst);
        drop(s);
        let _ = self.tx.send(match t {
            Some(trigger) => Ask::Bind { epoch, trigger },
            None => Ask::Unbind,
        });
    }
}

/// The signal thread.
fn listen(signals: MessageIterator, gate: &Gate, shared: &Shared, answers: &Sender<(String, u32)>) {
    for msg in signals {
        let Ok(msg) = msg else { continue };
        let h = msg.header();
        let (Some(iface), Some(member), Some(path)) = (h.interface(), h.member(), h.path()) else {
            continue;
        };
        match (iface.as_str(), member.as_str()) {
            (SHORTCUTS, m @ ("Activated" | "Deactivated")) => {
                type Args = (OwnedObjectPath, String, u64, HashMap<String, OwnedValue>);
                let Ok((session, id, _, _)) = msg.body().deserialize::<Args>() else {
                    continue;
                };
                if id == SHORTCUT_ID && shared.counts(session.as_str()) {
                    gate.event(TapEvent::Portal {
                        active: m == "Activated",
                        t_ns: clock::now().awake_ns,
                    });
                }
                shared.seen.fetch_add(1, Ordering::SeqCst);
            }
            (REQUEST, "Response") => {
                if let Ok((code, _)) = msg
                    .body()
                    .deserialize::<(u32, HashMap<String, OwnedValue>)>()
                {
                    let _ = answers.send((path.to_string(), code));
                }
            }
            (SESSION, "Closed") => {
                // The portal ended the session (it restarted, or the user revoked it): evdev
                // serves the binding again if it can.
                let mut s = shared.lock();
                if s.as_deref() == Some(path.as_str()) {
                    *s = None;
                    shared.owns.store(false, Ordering::SeqCst);
                }
            }
            _ => {}
        }
    }
}

/// How one request ended.
enum Answer {
    Ok,
    Refused(u32),
    /// A newer binding came first.
    Stale,
    TimedOut,
}

struct Calls<'a> {
    conn: &'a Connection,
    answers: &'a Receiver<(String, u32)>,
    shared: &'a Shared,
    sender: String,
    next: u64,
}

impl Calls<'_> {
    fn token(&mut self) -> String {
        self.next += 1;
        format!("akou{}_{}", std::process::id(), self.next)
    }

    /// Waits for the `Response` on `request`, giving up for a newer binding or after `ANSWER_MS`.
    fn wait(&self, request: &str, epoch: u64) -> Answer {
        let until = Instant::now() + Duration::from_millis(ANSWER_MS);
        loop {
            if self.shared.epoch.load(Ordering::SeqCst) != epoch {
                return Answer::Stale;
            }
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Answer::TimedOut;
            }
            match self
                .answers
                .recv_timeout(left.min(Duration::from_millis(100)))
            {
                Ok((path, 0)) if path == request => return Answer::Ok,
                Ok((path, code)) if path == request => return Answer::Refused(code),
                Ok(_) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Answer::TimedOut,
            }
        }
    }

    /// Calls `method` with a fresh `handle_token` and waits for its answer.
    fn request<B>(
        &mut self,
        method: &str,
        epoch: u64,
        body: impl FnOnce(Value<'static>) -> B,
    ) -> Result<Answer, String>
    where
        B: zbus::export::serde::ser::Serialize + zbus::zvariant::DynamicType,
    {
        let token = self.token();
        let request = format!("{PATH}/request/{}/{token}", self.sender);
        self.conn
            .call_method(
                Some(DEST),
                PATH,
                Some(SHORTCUTS),
                method,
                &body(Value::from(token)),
            )
            .map_err(text)?;
        Ok(self.wait(&request, epoch))
    }

    fn close(&self, session: &str) {
        let _ = self
            .conn
            .call_method(Some(DEST), session, Some(SESSION), "Close", &());
    }

    /// A new session with the shortcut bound to `trigger`: its path, or why not.
    fn bind(&mut self, epoch: u64, trigger: &str) -> Result<Option<String>, String> {
        let session_token = self.token();
        let session = format!("{PATH}/session/{}/{session_token}", self.sender);
        let created = self.request("CreateSession", epoch, |handle| {
            let mut o: HashMap<&str, Value> = HashMap::new();
            o.insert("handle_token", handle);
            o.insert("session_handle_token", Value::from(session_token.clone()));
            (o,)
        })?;
        match created {
            Answer::Ok => {}
            Answer::Stale => {
                self.close(&session);
                return Ok(None);
            }
            Answer::Refused(c) => return Err(format!("CreateSession answered {c}")),
            Answer::TimedOut => return Err("CreateSession never answered".into()),
        }
        let path = ObjectPath::try_from(session.as_str()).map_err(|e| e.to_string())?;
        let bound = self.request("BindShortcuts", epoch, |handle| {
            let mut shortcut: HashMap<&str, Value> = HashMap::new();
            shortcut.insert("description", Value::from("Dictate"));
            shortcut.insert("preferred_trigger", Value::from(trigger.to_string()));
            let mut o: HashMap<&str, Value> = HashMap::new();
            o.insert("handle_token", handle);
            (path.clone(), vec![(SHORTCUT_ID, shortcut)], "", o)
        });
        let why = match bound {
            Ok(Answer::Ok) => return Ok(Some(session)),
            Ok(Answer::Stale) => None,
            Ok(Answer::Refused(1)) => Some("the user cancelled the dialog".to_string()),
            Ok(Answer::Refused(c)) => Some(format!("BindShortcuts answered {c}")),
            Ok(Answer::TimedOut) => Some("BindShortcuts never answered".to_string()),
            Err(e) => Some(e),
        };
        self.close(&session);
        why.map_or(Ok(None), Err)
    }
}

/// The bind thread: one binding at a time, the newest one asked for.
fn serve(
    conn: &Connection,
    rx: &Receiver<Ask>,
    answers: &Receiver<(String, u32)>,
    shared: &Shared,
    say: &dyn Fn(String),
) {
    let mut calls = Calls {
        conn,
        answers,
        shared,
        sender: sender_token(conn),
        next: 0,
    };
    let mut mine: Option<String> = None;
    while let Ok(mut ask) = rx.recv() {
        while let Ok(newer) = rx.try_recv() {
            ask = newer;
        }
        if let Some(old) = mine.take() {
            calls.close(&old);
        }
        let Ask::Bind { epoch, trigger } = ask else {
            continue;
        };
        match calls.bind(epoch, &trigger) {
            Ok(Some(session)) => {
                let mut s = shared.lock();
                if shared.epoch.load(Ordering::SeqCst) == epoch {
                    *s = Some(session.clone());
                    shared.owns.store(true, Ordering::SeqCst);
                    mine = Some(session);
                } else {
                    drop(s);
                    calls.close(&session);
                }
            }
            Ok(None) => {}
            Err(e) => {
                if shared.epoch.load(Ordering::SeqCst) == epoch {
                    say(super::protocol::warn(
                        "portal-bind",
                        &format!(
                            "the GlobalShortcuts portal did not bind {trigger}: {e}; the key works only where a keyboard under /dev/input is readable"
                        ),
                    ));
                }
            }
        }
        shared.settled.fetch_max(epoch, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictate::activation::{Action, Activation, Mode};
    use crate::dictate::insert::Os;
    use crate::dictate::tap::Note;
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};

    /// The trigger the portal is asked for, and every binding it cannot take.
    #[test]
    fn dc_n1_only_a_chord_of_plain_modifiers_goes_to_the_portal() {
        let t = |s: &str| trigger(&Hotkey::parse(s).unwrap());
        assert_eq!(
            t("Control+Shift+Space").as_deref(),
            Some("CTRL+SHIFT+space")
        );
        assert_eq!(t("Alt+Super+D").as_deref(), Some("ALT+LOGO+d"));
        assert_eq!(t("Control+F5").as_deref(), Some("CTRL+F5"));
        assert_eq!(t("Ctrl+Keypad0").as_deref(), Some("CTRL+KP_0"));
        assert_eq!(t("Shift+PageUp").as_deref(), Some("SHIFT+Page_Up"));
        for evdev in [
            "RightControl",
            "Fn",
            "Mouse4",
            "RightControl+Space",
            "Control+Mouse4",
        ] {
            assert_eq!(t(evdev), None, "{evdev}");
        }
    }

    /// On the portal backend a binding the portal cannot take is refused unless evdev can read a
    /// keyboard; a chord is taken either way.
    #[test]
    fn dc_n1_the_portal_backend_refuses_what_neither_it_nor_evdev_can_hear() {
        let h = |s: &str| Hotkey::parse(s).unwrap();
        assert!(admit(&h("Control+Shift+Space"), false).is_ok());
        assert!(admit(&h("RightControl"), true).is_ok());
        let e = admit(&h("RightControl"), false).unwrap_err();
        assert!(e.contains("RightControl") && e.contains("uaccess"), "{e}");
        assert!(admit(&h("Mouse4"), false).is_err());
    }

    /// While the portal holds the binding evdev reads no keyboard, except for the recorder.
    #[test]
    fn dc_n1_evdev_reads_no_keyboard_while_the_portal_holds_the_key() {
        let p = Shared::default();
        assert!(
            evdev_reads_keyboards(false, None),
            "no portal: evdev is the backend"
        );
        assert!(
            evdev_reads_keyboards(false, Some(&p)),
            "the portal holds nothing yet"
        );
        p.owns.store(true, Ordering::SeqCst);
        assert!(!evdev_reads_keyboards(false, Some(&p)));
        assert!(
            evdev_reads_keyboards(true, Some(&p)),
            "the recorder still hears keys"
        );
    }

    /// A private bus for one test, gone with it (as in `mpris`).
    struct Bus {
        child: Child,
        address: String,
    }

    impl Bus {
        fn start() -> Bus {
            let mut child = Command::new("dbus-daemon")
                .args(["--session", "--nofork", "--nopidfile", "--print-address=1"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("dbus-daemon runs (the dbus package); the portal tests need a bus");
            let mut address = String::new();
            BufReader::new(child.stdout.take().unwrap())
                .read_line(&mut address)
                .unwrap();
            Bus {
                child,
                address: address.trim().to_string(),
            }
        }
    }

    impl Drop for Bus {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    /// Everything the fake portal was asked.
    #[derive(Default)]
    struct Seen {
        registered: Vec<String>,
        /// `(session, shortcut id, preferred trigger)` per BindShortcuts.
        binds: Vec<(String, String, String)>,
        closed: Vec<String>,
    }

    type Log = Arc<Mutex<Seen>>;

    fn sender_of(hdr: &zbus::message::Header<'_>) -> String {
        hdr.sender()
            .map(|s| s.as_str().trim_start_matches(':').replace('.', "_"))
            .unwrap_or_default()
    }

    fn token(o: &HashMap<String, OwnedValue>, key: &str) -> String {
        o.get(key)
            .and_then(|v| String::try_from(v.try_clone().ok()?).ok())
            .unwrap_or_default()
    }

    async fn respond(conn: &zbus::Connection, request: &str, code: u32) {
        let results: HashMap<&str, Value> = HashMap::new();
        conn.emit_signal(None::<&str>, request, REQUEST, "Response", &(code, results))
            .await
            .unwrap();
    }

    /// The portal's GlobalShortcuts, answering BindShortcuts with `bind_answer`.
    struct FakeShortcuts {
        log: Log,
        bind_answer: Arc<std::sync::atomic::AtomicU32>,
    }

    #[zbus::interface(name = "org.freedesktop.portal.GlobalShortcuts")]
    impl FakeShortcuts {
        async fn create_session(
            &self,
            #[zbus(header)] hdr: zbus::message::Header<'_>,
            #[zbus(connection)] conn: &zbus::Connection,
            options: HashMap<String, OwnedValue>,
        ) -> OwnedObjectPath {
            let sender = sender_of(&hdr);
            let request = format!(
                "{PATH}/request/{sender}/{}",
                token(&options, "handle_token")
            );
            respond(conn, &request, 0).await;
            OwnedObjectPath::try_from(request).unwrap()
        }

        async fn bind_shortcuts(
            &self,
            #[zbus(header)] hdr: zbus::message::Header<'_>,
            #[zbus(connection)] conn: &zbus::Connection,
            session: OwnedObjectPath,
            shortcuts: Vec<(String, HashMap<String, OwnedValue>)>,
            _parent: String,
            options: HashMap<String, OwnedValue>,
        ) -> OwnedObjectPath {
            for (id, o) in &shortcuts {
                self.log.lock().unwrap().binds.push((
                    session.to_string(),
                    id.clone(),
                    token(o, "preferred_trigger"),
                ));
            }
            let request = format!(
                "{PATH}/request/{}/{}",
                sender_of(&hdr),
                token(&options, "handle_token")
            );
            respond(conn, &request, self.bind_answer.load(Ordering::SeqCst)).await;
            OwnedObjectPath::try_from(request).unwrap()
        }

        #[zbus(property, name = "version")]
        fn version(&self) -> u32 {
            1
        }
    }

    struct FakeRegistry {
        log: Log,
    }

    #[zbus::interface(name = "org.freedesktop.host.portal.Registry")]
    impl FakeRegistry {
        fn register(&self, app_id: String, _options: HashMap<String, OwnedValue>) {
            self.log.lock().unwrap().registered.push(app_id);
        }
    }

    struct Fake {
        conn: Connection,
        log: Log,
        bind_answer: Arc<std::sync::atomic::AtomicU32>,
    }

    impl Fake {
        fn start(bus: &Bus, answer: u32) -> Fake {
            let log: Log = Arc::default();
            let bind_answer = Arc::new(std::sync::atomic::AtomicU32::new(answer));
            let conn = zbus::blocking::connection::Builder::address(bus.address.as_str())
                .unwrap()
                .name(DEST)
                .unwrap()
                .serve_at(
                    PATH,
                    FakeShortcuts {
                        log: log.clone(),
                        bind_answer: bind_answer.clone(),
                    },
                )
                .unwrap()
                .serve_at(PATH, FakeRegistry { log: log.clone() })
                .unwrap()
                .build()
                .unwrap();
            // `Session.Close` on any session path, read from the fake's own inbound messages
            // rather than served by an object per session (the object server answers it with an
            // error, which the helper ignores).
            let watch = conn.clone();
            let closes = log.clone();
            let rule = MatchRule::builder()
                .msg_type(Type::MethodCall)
                .interface(SESSION)
                .unwrap()
                .member("Close")
                .unwrap()
                .build();
            let calls = MessageIterator::for_match_rule(rule, &watch, None).unwrap();
            std::thread::spawn(move || {
                for m in calls.flatten() {
                    let h = m.header();
                    if let Some(p) = h.path() {
                        closes.lock().unwrap().closed.push(p.to_string());
                    }
                }
            });
            Fake {
                conn,
                log,
                bind_answer,
            }
        }

        fn signal(&self, member: &str, session: &str, id: &str) {
            let opts: HashMap<&str, Value> = HashMap::new();
            let path = ObjectPath::try_from(session).unwrap();
            self.conn
                .emit_signal(
                    None::<&str>,
                    PATH,
                    SHORTCUTS,
                    member,
                    &(path, id, 0u64, opts),
                )
                .unwrap();
        }
    }

    /// Polls `f` until it holds; the tests wait on what happened, never on a time bound.
    fn until(what: &str, mut f: impl FnMut() -> bool) {
        for _ in 0..500 {
            if f() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("never: {what}");
    }

    fn gate() -> Gate {
        Gate::new(
            Activation::new(Hotkey::parse("Control+Shift+Space").unwrap(), Mode::Hold),
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

    fn started(bus: &Bus, g: &Gate, said: Arc<Mutex<Vec<String>>>) -> Portal {
        let conn = connect(Some(&bus.address)).unwrap();
        assert_eq!(version(&conn), Some(1));
        Portal::start(
            conn,
            g.clone(),
            Box::new(move |l| said.lock().unwrap().push(l)),
        )
        .unwrap()
    }

    /// DC-N1 on a real bus: the helper registers its app id, binds `dictate` to the chord, and
    /// the portal's `Activated` and `Deactivated` for that session run a push-to-talk session.
    /// The same signals for another shortcut or another session start nothing.
    #[test]
    fn dc_n1_the_portal_binds_the_chord_and_its_signals_run_a_session() {
        let bus = Bus::start();
        let fake = Fake::start(&bus, 0);
        let g = gate();
        let mut p = started(&bus, &g, Arc::default());
        assert_eq!(fake.log.lock().unwrap().registered, [APP_ID]);
        assert!(!p.shared.owns(), "nothing is bound before a binding");
        p.bind(&Hotkey::parse("Control+Shift+Space").unwrap());
        until("the portal owns the binding", || p.shared.owns());
        let (session, id, trigger) = fake.log.lock().unwrap().binds[0].clone();
        assert_eq!(
            (id.as_str(), trigger.as_str()),
            (SHORTCUT_ID, "CTRL+SHIFT+space")
        );

        // A press and release of another shortcut, and of another session's, would end in a
        // session and leave the gate waiting for its insert, so the next press would start none.
        for (s, id) in [
            (session.as_str(), "other"),
            (&format!("{PATH}/session/x/y"), SHORTCUT_ID),
        ] {
            fake.signal("Activated", s, id);
            fake.signal("Deactivated", s, id);
        }
        fake.signal("Activated", &session, SHORTCUT_ID);
        until("five signals handled", || p.shared.seen() == 5);
        let down = acts(&g);
        assert!(
            matches!(down.as_slice(), [Action::Arm { .. }, Action::Start { .. }]),
            "one press, only from our session and shortcut: {down:?}"
        );
        fake.signal("Deactivated", &session, SHORTCUT_ID);
        until("the release reached the gate", || {
            !g.lock().queue.is_empty()
        });
        assert_eq!(acts(&g), [Action::End { reason: "release" }]);
    }

    /// A rebind closes the old session at once, so its signals stop counting, and binds the new
    /// chord in a new session; a binding the portal cannot take closes it and binds nothing.
    #[test]
    fn dc_n1_a_rebind_closes_the_old_portal_session() {
        let bus = Bus::start();
        let fake = Fake::start(&bus, 0);
        let g = gate();
        let mut p = started(&bus, &g, Arc::default());
        p.bind(&Hotkey::parse("Control+Shift+Space").unwrap());
        until("bound", || p.shared.owns());
        let first = fake.log.lock().unwrap().binds[0].0.clone();
        // The app rebinds the same chord right after `ready`: nothing changes.
        p.bind(&Hotkey::parse("Control+Shift+Space").unwrap());
        assert!(p.shared.owns(), "the same chord again unbound it");

        p.bind(&Hotkey::parse("Control+Alt+D").unwrap());
        assert!(!p.shared.owns(), "the old binding stops counting at once");
        until("the second bind", || {
            fake.log.lock().unwrap().binds.len() == 2 && p.shared.owns()
        });
        let (second, _, trigger) = fake.log.lock().unwrap().binds[1].clone();
        assert_eq!(trigger, "CTRL+ALT+d");
        assert_ne!(first, second);
        until("the first session closed", || {
            fake.log.lock().unwrap().closed.contains(&first)
        });
        fake.signal("Activated", &first, SHORTCUT_ID);
        fake.signal("Deactivated", &first, SHORTCUT_ID);
        fake.signal("Activated", &second, SHORTCUT_ID);
        until("three signals handled", || p.shared.seen() == 3);
        let down = acts(&g);
        assert!(
            matches!(down.as_slice(), [Action::Arm { .. }, Action::Start { .. }]),
            "only the new session's press: {down:?}"
        );

        p.bind(&Hotkey::parse("RightControl").unwrap());
        until("the second session closed", || {
            fake.log.lock().unwrap().closed.contains(&second)
        });
        assert!(!p.shared.owns());
        assert_eq!(
            fake.log.lock().unwrap().binds.len(),
            2,
            "nothing bound for a lone modifier"
        );
    }

    /// A dialog the user cancels binds nothing, says so once, and leaves the key to evdev.
    #[test]
    fn dc_n1_a_cancelled_portal_dialog_binds_nothing_and_says_so() {
        let bus = Bus::start();
        let fake = Fake::start(&bus, 1);
        let g = gate();
        let said: Arc<Mutex<Vec<String>>> = Arc::default();
        let mut p = started(&bus, &g, said.clone());
        p.bind(&Hotkey::parse("Control+Shift+Space").unwrap());
        until("the warning", || !said.lock().unwrap().is_empty());
        let w = said.lock().unwrap()[0].clone();
        assert!(
            w.contains("\"code\":\"portal-bind\"") && w.contains("cancelled"),
            "{w}"
        );
        assert!(!p.shared.owns());
        let refused = fake.log.lock().unwrap().binds[0].0.clone();
        until("the refused session closed", || {
            fake.log.lock().unwrap().closed.contains(&refused)
        });
        // The next dialog is accepted; the refused session's press, sent first, still counts for
        // nothing, and the accepted one's press is the only one the gate sees.
        fake.bind_answer.store(0, Ordering::SeqCst);
        p.bind(&Hotkey::parse("Control+Shift+Space").unwrap());
        until("bound", || p.shared.owns());
        let accepted = fake.log.lock().unwrap().binds[1].0.clone();
        fake.signal("Activated", &refused, SHORTCUT_ID);
        fake.signal("Deactivated", &refused, SHORTCUT_ID);
        fake.signal("Activated", &accepted, SHORTCUT_ID);
        until("three signals handled", || p.shared.seen() == 3);
        let down = acts(&g);
        assert!(
            matches!(down.as_slice(), [Action::Arm { .. }, Action::Start { .. }]),
            "the refused session's press counted: {down:?}"
        );
        assert_eq!(
            said.lock().unwrap().len(),
            1,
            "an accepted bind says nothing"
        );
    }

    /// A bus with no portal on it has no GlobalShortcuts: the helper uses evdev.
    #[test]
    fn dc_n1_no_portal_means_no_version() {
        let bus = Bus::start();
        let conn = connect(Some(&bus.address)).unwrap();
        assert_eq!(version(&conn), None);
    }
}
