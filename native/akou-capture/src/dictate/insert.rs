//! The insert (docs/ux/DICTATION.md DC-N6, DC-N7) and the two guards in front of it (DC-N8,
//! DC-N9). The OS parts (the clipboard, the event sink, the window under the cursor) are the
//! traits below; per OS backends implement them, and the tests and `--from-wav` use fakes.
//!
//! An `insert` from the app goes through, in this order:
//!
//! 1. `method: clipboard` (`dictation.insert: clipboard`): write the clipboard, restore nothing.
//! 2. The secure-field guard (DC-N8): the session's field was `secure`, Secure Input was on when
//!    it started or is on now, or the field under the cursor is `secure`. Clipboard only, answered
//!    `inserted {method: clipboard, reason: secure}`: nothing is ever typed or pasted into a
//!    password field.
//! 3. The focus guard (DC-N9): the app, pid or window under the cursor is not the one the session
//!    captured (`focus-changed`), or the field is `not-editable` or `unknown`. Nothing is inserted;
//!    `insert.failed` says why, and the app opens the draft box on the original target. After the
//!    box, the app sends `focus {target}` and then the `insert` again.
//! 4. A Windows target running elevated drops a paste from a normal process (UIPI): clipboard
//!    only, `reason: elevated`.
//! 5. `method: type` (DC-N7): Unicode key events at most `TYPE_CHUNK` UTF-16 units at a time, each
//!    newline a real Return.
//! 6. `method: paste` (DC-N6), the receipt paste: snapshot every clipboard type, publish the text
//!    as a promise marked transient and concealed, release the modifiers still held, post the
//!    chord (the V key resolved through the active layout, Ctrl+Shift+V in a Windows terminal,
//!    Shift+Insert in a Linux one), press the modifiers again. A read of the promise counts only
//!    after the chord (an earlier one is a clipboard manager). The old clipboard comes back
//!    `QUIET_MS` after the last read, `RECEIPT_TIMEOUT_MS` after the chord at the latest, or
//!    `FAILED_INJECTION_MS` after a chord that could not be posted, and only while the promise
//!    still owns the clipboard (the change count is the one publishing left). `restore: false`
//!    leaves the text there as a lasting copy, since a promise dies with the process that made
//!    it. So does an empty snapshot: the clipboard was empty, or this process may not read it
//!    (macOS pasteboard privacy set to deny), and restoring nothing would clear the clipboard,
//!    the dictation with it. The send key (DC-S2) is pressed only once the target read.
//!
//! A clipboard-only write the helper chose for the user (`secure`, `elevated`) is marked
//! concealed, so a clipboard manager does not keep what was meant for a password field; one the
//! user chose (`method: clipboard`) is an ordinary copy.
//!
//! Nothing here waits: `insert` posts and returns, and `tick` decides from the reads the
//! clipboard reported. The key tap never calls in here (DC-N1).
//!
//! The receipt rules (count only reads after the chord, a quiet period after the last read, a
//! bounded timeout, a short one after a failed chord, restore only while still the owner) are
//! ported from Handy's `paste_tx` (https://github.com/cjpais/Handy,
//! `src-tauri/src/paste_tx/mod.rs`), under this notice:
//!
//! > MIT License
//! >
//! > Copyright (c) 2025 CJ Pais
//! >
//! > Permission is hereby granted, free of charge, to any person obtaining a copy of this software
//! > and associated documentation files (the "Software"), to deal in the Software without
//! > restriction, including without limitation the rights to use, copy, modify, merge, publish,
//! > distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
//! > Software is furnished to do so, subject to the following conditions:
//! >
//! > The above copyright notice and this permission notice shall be included in all copies or
//! > substantial portions of the Software.
//! >
//! > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
//! > BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
//! > NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
//! > DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//! > OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

use super::protocol::Target;

/// The old clipboard comes back this long after the last read: some apps read twice per paste
/// (Chromium probes, then reads).
pub const QUIET_MS: u64 = 200;
/// The longest the text holds the clipboard after the chord when no read comes.
pub const RECEIPT_TIMEOUT_MS: u64 = 8_000;
/// After a chord that could not be posted no read can come, so restore soon.
pub const FAILED_INJECTION_MS: u64 = 500;
/// The typed path's chunk, in UTF-16 units (macOS `CGEventKeyboardSetUnicodeString` takes 20).
pub const TYPE_CHUNK: usize = 20;

const MS: u64 = 1_000_000;

/// Every type on the clipboard with its bytes: text, an image, a file list.
pub type Snapshot = Vec<(String, Vec<u8>)>;

pub trait Clipboard {
    fn snapshot(&mut self) -> Snapshot;
    /// Publishes `text` as a promise (handed over when a reader asks), marked transient and
    /// concealed so clipboard managers skip it. Returns the change count it left.
    fn publish(&mut self, text: &str) -> Result<u64, String>;
    /// Writes `text` for the user to paste by hand (clipboard-only mode), a lasting copy.
    /// `concealed` marks it for clipboard managers to skip (macOS
    /// `org.nspasteboard.ConcealedType`, Windows `ExcludeClipboardContentFromMonitorProcessing`).
    fn write(&mut self, text: &str, concealed: bool) -> Result<(), String>;
    /// macOS `changeCount`, the Windows sequence number, a count of ownership changes on Linux.
    fn change_count(&mut self) -> u64;
    fn restore(&mut self, snapshot: &Snapshot);
    /// When the promise was read since the last call: macOS `provideDataForType`, Windows
    /// `WM_RENDERFORMAT`, an X11 `SelectionRequest`, a Wayland `wl_data_source.send`.
    fn reads(&mut self) -> Vec<u64>;
    /// Answers the reads waiting now, on every tick, paste or not: on Linux the owner serves the
    /// clipboard itself, so after a restore akou must keep answering for the old contents. A
    /// clipboard the OS serves (macOS, Windows) has nothing to do.
    fn serve(&mut self) {}
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    /// A virtual key code the layout resolved.
    Code(u16),
    /// A key that is the same on every layout: `Return`, `Insert`.
    Named(&'static str),
}

/// Posts key events from the helper's private event source.
pub trait Sink {
    /// The modifiers down now (a hotkey still held), by key name.
    fn held_modifiers(&mut self) -> Vec<String>;
    fn modifier(&mut self, name: &str, down: bool) -> Result<(), String>;
    /// Presses and releases `key` with `mods` held.
    fn press(&mut self, mods: &[&str], key: Key) -> Result<(), String>;
    /// The key code that types `ch` on the active layout (`UCKeyTranslate` on macOS), never an
    /// assumed QWERTY code.
    fn keycode(&mut self, ch: char) -> Option<u16>;
    /// Types `text`, at most `TYPE_CHUNK` UTF-16 units and no newline, as Unicode key events.
    fn type_text(&mut self, text: &str) -> Result<(), String>;
}

/// What has the keyboard.
pub trait Targets {
    /// The app, window and field under the cursor now.
    fn target(&mut self, t_ns: u64) -> Target;
    /// The frame of the window that has the keyboard now, for the pill's display (DC-O1); none
    /// where the backend cannot tell (Linux).
    fn frame(&mut self) -> Option<super::protocol::Frame> {
        None
    }
    /// macOS Secure Input: a password field somewhere holds the keyboard. False elsewhere.
    fn secure_input(&mut self) -> bool;
    /// Windows: the target runs at a higher integrity level than the helper. False elsewhere.
    fn elevated(&mut self, target: &Target) -> bool;
    /// Brings the target back to the front (after the draft box, DC-N9).
    fn focus(&mut self, target: &Target);
    /// Reads the field the insert went into (DC-L2): macOS `AXValue` and `AXSelectedTextRange` of
    /// the element focused at the insert, Windows UI Automation, Linux AT-SPI; at most 200 ms.
    /// There is deliberately no way here to write to another process: a dormant accessibility
    /// tree is `Unreadable`, never woken by setting a flag on the app.
    fn read_field(&mut self, target: &Target) -> super::readback::Field;
    /// The non-prompting trust check (macOS `AXIsProcessTrusted`, never the prompting variant).
    /// True where no grant exists.
    fn trusted(&mut self) -> bool;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

/// Terminals by executable (Windows) or window class (Linux), lowercase.
const WINDOWS_TERMINALS: [&str; 5] = [
    "windowsterminal.exe",
    "conhost.exe",
    "wezterm-gui.exe",
    "alacritty.exe",
    "mintty.exe",
];
const LINUX_TERMINALS: [&str; 14] = [
    "gnome-terminal-server",
    "kgx",
    "org.gnome.console",
    "konsole",
    "xterm",
    "uxterm",
    "urxvt",
    "kitty",
    "alacritty",
    "foot",
    "footclient",
    "tilix",
    "wezterm",
    "com.mitchellh.ghostty",
];

/// Terminals by bundle id or name (macOS), lowercase. A paste there needs no other chord; the
/// list keeps the field read-back (DC-L2) away from a shell.
const MAC_TERMINALS: [&str; 7] = [
    "com.apple.terminal",
    "com.googlecode.iterm2",
    "dev.warp.warp-stable",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "com.github.wez.wezterm",
    "com.mitchellh.ghostty",
];

pub fn is_terminal(os: Os, app: &str) -> bool {
    let a = app.to_ascii_lowercase();
    match os {
        Os::Mac => MAC_TERMINALS.contains(&a.as_str()) || a == "terminal" || a == "iterm2",
        Os::Windows => WINDOWS_TERMINALS.contains(&a.as_str()),
        Os::Linux => LINUX_TERMINALS.contains(&a.as_str()) || a.contains("terminal"),
    }
}

/// One piece of the typed path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Piece {
    Text(String),
    Return,
}

/// The text as the typed path sends it: runs of at most `TYPE_CHUNK` UTF-16 units, a surrogate
/// pair never split, and one `Return` per newline (`\r\n` is one). A tab becomes a space and every
/// other control character is dropped: typed into an app, a tab moves the focus, and a backspace,
/// an escape or a delete edits or dismisses instead of writing.
pub fn pieces(text: &str) -> Vec<Piece> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut units = 0;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            if !cur.is_empty() {
                out.push(Piece::Text(std::mem::take(&mut cur)));
                units = 0;
            }
            out.push(Piece::Return);
            continue;
        }
        let c = match c {
            '\t' => ' ',
            c if c.is_control() => continue,
            c => c,
        };
        if units + c.len_utf16() > TYPE_CHUNK {
            out.push(Piece::Text(std::mem::take(&mut cur)));
            units = 0;
        }
        cur.push(c);
        units += c.len_utf16();
    }
    if !cur.is_empty() {
        out.push(Piece::Text(cur));
    }
    out
}

/// The modifiers of a send key (DC-S2); `None` for `none`.
fn send_mods(send_key: &str) -> Option<&'static [&'static str]> {
    match send_key {
        "Enter" => Some(&[]),
        "Ctrl+Enter" => Some(&["Control"]),
        "Cmd+Enter" => Some(&["Command"]),
        "Shift+Enter" => Some(&["Shift"]),
        _ => None,
    }
}

/// One `insert` from the app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub id: String,
    pub text: String,
    /// `paste`, `type` or `clipboard`.
    pub method: String,
    pub send_key: String,
    /// `dictation.restoreClipboard`.
    pub restore: bool,
}

/// What the session saw at key-down.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Captured {
    pub target: Target,
    pub secure_input: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// `inserted {method, receipt_ms, reason}`; `reason` says why a clipboard-only insert was
    /// chosen for the user (`secure`, `elevated`).
    Inserted {
        method: &'static str,
        receipt_ms: u64,
        reason: Option<&'static str>,
    },
    /// `insert.failed {reason}`.
    Failed(String),
}

/// A paste waiting for its receipt.
struct Tx {
    id: String,
    send_key: String,
    chord_ns: u64,
    count: u64,
    snapshot: Option<Snapshot>,
    /// `restore: false`, or nothing to restore: the text, written as a lasting copy when the
    /// paste settles.
    keep: Option<String>,
    first_read: Option<u64>,
    last_read: Option<u64>,
    failed: Option<String>,
}

pub struct Inserter {
    os: Os,
    clip: Box<dyn Clipboard>,
    sink: Box<dyn Sink>,
    tx: Option<Tx>,
}

impl Inserter {
    pub fn new(os: Os, clip: Box<dyn Clipboard>, sink: Box<dyn Sink>) -> Inserter {
        Inserter {
            os,
            clip,
            sink,
            tx: None,
        }
    }

    /// A paste is waiting for its receipt.
    pub fn busy(&self) -> bool {
        self.tx.is_some()
    }

    /// Runs an insert; what is decided now goes to `done` as `(id, outcome)`. A paste reports
    /// from `tick`. A paste still waiting settles first, since the newer text is about to take
    /// the clipboard.
    pub fn insert(
        &mut self,
        req: &Request,
        cap: &Captured,
        targets: &mut dyn Targets,
        t_ns: u64,
        done: &mut Vec<(String, Outcome)>,
    ) {
        self.finish(t_ns, done);
        if let Some(o) = self.start(req, cap, targets, t_ns) {
            done.push((req.id.clone(), o));
        }
    }

    fn clipboard_only(&mut self, text: &str, reason: Option<&'static str>) -> Outcome {
        match self.clip.write(text, reason.is_some()) {
            Ok(()) => Outcome::Inserted {
                method: "clipboard",
                receipt_ms: 0,
                reason,
            },
            Err(e) => Outcome::Failed(e),
        }
    }

    fn start(
        &mut self,
        req: &Request,
        cap: &Captured,
        targets: &mut dyn Targets,
        t_ns: u64,
    ) -> Option<Outcome> {
        if req.method == "clipboard" {
            return Some(self.clipboard_only(&req.text, None));
        }
        let now = targets.target(t_ns);
        if cap.target.field == "secure"
            || cap.secure_input
            || now.field == "secure"
            || targets.secure_input()
        {
            return Some(self.clipboard_only(&req.text, Some("secure")));
        }
        let t = &cap.target;
        if (t.app.as_str(), t.pid, t.window.as_str()) != (now.app.as_str(), now.pid, &now.window) {
            return Some(Outcome::Failed("focus-changed".into()));
        }
        match now.field.as_str() {
            "editable" => {}
            "not-editable" => return Some(Outcome::Failed("not-editable".into())),
            _ => return Some(Outcome::Failed("field-unknown".into())),
        }
        if targets.elevated(&now) {
            return Some(self.clipboard_only(&req.text, Some("elevated")));
        }
        // A hotkey modifier still down would turn the chord into another shortcut.
        let held = self.sink.held_modifiers();
        for m in &held {
            let _ = self.sink.modifier(m, false);
        }
        let out = if req.method == "type" {
            Some(match self.type_text(&req.text) {
                Ok(()) => {
                    self.send(&req.send_key);
                    Outcome::Inserted {
                        method: "type",
                        receipt_ms: 0,
                        reason: None,
                    }
                }
                Err(e) => Outcome::Failed(e),
            })
        } else {
            self.paste(req, &now.app, t_ns)
        };
        for m in &held {
            let _ = self.sink.modifier(m, true);
        }
        out
    }

    fn type_text(&mut self, text: &str) -> Result<(), String> {
        for p in pieces(text) {
            match p {
                Piece::Text(s) => self.sink.type_text(&s)?,
                Piece::Return => self.sink.press(&[], Key::Named("Return"))?,
            }
        }
        Ok(())
    }

    fn send(&mut self, send_key: &str) {
        if let Some(mods) = send_mods(send_key) {
            let _ = self.sink.press(mods, Key::Named("Return"));
        }
    }

    fn chord(&mut self, app: &str) -> Result<(&'static [&'static str], Key), String> {
        let terminal = is_terminal(self.os, app);
        if self.os == Os::Linux && terminal {
            return Ok((&["Shift"], Key::Named("Insert")));
        }
        let v = Key::Code(self.sink.keycode('v').ok_or("no-v-key")?);
        Ok(match self.os {
            Os::Mac => (&["Command"], v),
            Os::Windows if terminal => (&["Control", "Shift"], v),
            _ => (&["Control"], v),
        })
    }

    fn paste(&mut self, req: &Request, app: &str, t_ns: u64) -> Option<Outcome> {
        let snapshot = req
            .restore
            .then(|| self.clip.snapshot())
            .filter(|s| !s.is_empty());
        let count = match self.clip.publish(&req.text) {
            Ok(c) => c,
            Err(e) => return Some(Outcome::Failed(e)),
        };
        // A read before the chord is a clipboard manager reacting to the change, not the target.
        self.clip.reads();
        let failed = match self.chord(app) {
            Ok((mods, key)) => self.sink.press(mods, key).err(),
            Err(e) => Some(e),
        };
        self.tx = Some(Tx {
            id: req.id.clone(),
            send_key: req.send_key.clone(),
            chord_ns: t_ns,
            count,
            keep: snapshot.is_none().then(|| req.text.clone()),
            snapshot,
            first_read: None,
            last_read: None,
            failed,
        });
        None
    }

    fn collect(&mut self) {
        let Some(tx) = self.tx.as_mut() else { return };
        let reads = self.clip.reads();
        // A chord that never posted pasted nothing: a read now is a poller, never the target.
        if tx.failed.is_some() {
            return;
        }
        for r in reads {
            if r >= tx.chord_ns {
                tx.first_read.get_or_insert(r);
                tx.last_read = Some(tx.last_read.map_or(r, |l| l.max(r)));
            }
        }
    }

    /// Time passes: a paste whose target read and went quiet, or whose time ran out, settles.
    pub fn tick(&mut self, t_ns: u64, done: &mut Vec<(String, Outcome)>) {
        self.clip.serve();
        self.collect();
        let Some(tx) = self.tx.as_ref() else { return };
        let owned = self.clip.change_count() == tx.count;
        let limit = if tx.failed.is_some() {
            FAILED_INJECTION_MS
        } else {
            RECEIPT_TIMEOUT_MS
        };
        if !owned
            || tx.last_read.is_some_and(|l| t_ns >= l + QUIET_MS * MS)
            || t_ns >= tx.chord_ns + limit * MS
        {
            self.finish(t_ns, done);
        }
    }

    /// Settles a waiting paste now: restore if still the owner, then report.
    pub fn finish(&mut self, _t_ns: u64, done: &mut Vec<(String, Outcome)>) {
        self.collect();
        let Some(tx) = self.tx.take() else { return };
        let owned = self.clip.change_count() == tx.count;
        let outcome = match (tx.first_read, tx.failed) {
            (_, Some(e)) => Outcome::Failed(e),
            (Some(first), None) => {
                self.send(&tx.send_key);
                Outcome::Inserted {
                    method: "paste",
                    receipt_ms: (first - tx.chord_ns) / MS,
                    reason: None,
                }
            }
            (None, None) if !owned => Outcome::Failed("clipboard-changed".into()),
            (None, None) => Outcome::Failed("no-receipt".into()),
        };
        if owned {
            match (&tx.snapshot, &tx.keep) {
                (Some(s), _) => self.clip.restore(s),
                (None, Some(text)) => {
                    let _ = self.clip.write(text, false);
                }
                (None, None) => {}
            }
        }
        done.push((tx.id, outcome));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictate::fake::*;

    const T0: u64 = 1_000 * MS;

    fn req(method: &str, send_key: &str) -> Request {
        Request {
            id: "1".into(),
            text: "hello".into(),
            method: method.into(),
            send_key: send_key.into(),
            restore: true,
        }
    }

    fn cap() -> Captured {
        Captured {
            target: slack(),
            secure_input: false,
        }
    }

    struct Rig {
        w: Shared,
        ins: Inserter,
        screen: Screen,
        done: Vec<(String, Outcome)>,
    }

    impl Rig {
        fn new(os: Os) -> Rig {
            let w = World::new();
            Rig {
                ins: Inserter::new(os, Box::new(Board(w.clone())), Box::new(Keys(w.clone()))),
                screen: Screen(w.clone()),
                w,
                done: Vec::new(),
            }
        }
        fn insert(&mut self, r: &Request, c: &Captured) {
            self.ins.insert(r, c, &mut self.screen, T0, &mut self.done);
        }
        /// Ticks every 10 ms up to `ms` after T0.
        fn until(&mut self, ms: u64) {
            let mut t = T0;
            while t <= T0 + ms * MS {
                self.ins.tick(t, &mut self.done);
                t += 10 * MS;
            }
        }
        fn read_at(&mut self, ms: u64) {
            self.w.borrow_mut().pending_reads.push(T0 + ms * MS);
        }
        fn board_text(&self) -> String {
            String::from_utf8(self.w.borrow().board[0].1.clone()).unwrap()
        }
        fn posted(&self) -> Vec<String> {
            self.w.borrow().posted.clone()
        }
    }

    /// DC-N6: the old contents, text and image, come back only after the target's read and the
    /// quiet period; the send key comes after the read, never before.
    #[test]
    fn dc_n6_the_old_clipboard_comes_back_only_after_the_targets_read() {
        let mut r = Rig::new(Os::Mac);
        r.insert(&req("paste", "Enter"), &cap());
        assert!(r.done.is_empty(), "a paste reports once the target read");
        assert!(r.w.borrow().transient, "the published item is transient");
        assert_eq!(r.w.borrow().promise.as_deref(), Some("hello"));
        assert_eq!(r.posted(), ["Command+Code(9)"]);
        r.until(1_000);
        assert_eq!(r.board_text(), "hello", "no read yet: the text stays");
        assert!(!r.posted().iter().any(|p| p.contains("Return")));
        r.read_at(1_000);
        r.until(1_150);
        assert_eq!(r.board_text(), "hello", "inside the quiet period");
        r.until(1_200);
        let w = r.w.borrow();
        assert_eq!(w.board.len(), 2, "every type comes back");
        assert_eq!(w.board[1].0, "image");
        assert_eq!(w.board[0].1, b"old");
        drop(w);
        assert_eq!(r.posted(), ["Command+Code(9)", "Named(\"Return\")"]);
        assert_eq!(
            r.done,
            [(
                "1".into(),
                Outcome::Inserted {
                    method: "paste",
                    receipt_ms: 1_000,
                    reason: None
                }
            )]
        );
    }

    /// A read before the chord is a clipboard manager: it does not count, so with no read after
    /// the chord the restore waits for the 8 s timeout and the insert fails.
    #[test]
    fn dc_n6_a_read_before_the_chord_does_not_count_and_8_s_is_the_limit() {
        let mut r = Rig::new(Os::Mac);
        // A clipboard manager reads as the text is published, before the chord, at the same ms.
        r.read_at(0);
        r.insert(&req("paste", "Enter"), &cap());
        // A read that happened before the chord but is reported late still does not count.
        r.w.borrow_mut().pending_reads.push(T0 - MS);
        r.until(7_990);
        assert!(r.done.is_empty(), "{:?}", r.done);
        assert_eq!(r.board_text(), "hello");
        r.until(8_000);
        assert_eq!(r.board_text(), "old", "restored at 8 s");
        assert_eq!(r.done, [("1".into(), Outcome::Failed("no-receipt".into()))]);
        assert!(
            !r.posted().iter().any(|p| p.contains("Return")),
            "no send key without a read"
        );
    }

    /// The V key comes from the layout: on Dvorak it is the key a QWERTY board calls period.
    #[test]
    fn dc_n6_the_chord_uses_the_layouts_v() {
        let mut r = Rig::new(Os::Mac);
        r.w.borrow_mut().layout = vec![('v', 47)];
        r.insert(&req("paste", "none"), &cap());
        assert_eq!(r.posted(), ["Command+Code(47)"]);
        let mut none = Rig::new(Os::Mac);
        none.w.borrow_mut().layout.clear();
        none.insert(&req("paste", "none"), &cap());
        none.until(500);
        assert!(
            none.posted().is_empty(),
            "no V on the layout: no guessed code"
        );
        assert_eq!(
            none.done,
            [("1".into(), Outcome::Failed("no-v-key".into()))]
        );
        assert_eq!(
            none.board_text(),
            "old",
            "restored 500 ms after the failed chord"
        );
    }

    /// A chord that never posted pasted nothing, so a stray read after it (a clipboard manager,
    /// a poller) is not a receipt: no send key, and the answer is the chord's failure.
    #[test]
    fn dc_n6_a_read_after_a_failed_chord_presses_no_send_key() {
        let mut r = Rig::new(Os::Mac);
        r.w.borrow_mut().layout.clear();
        r.insert(&req("paste", "Enter"), &cap());
        r.read_at(50);
        r.until(600);
        assert!(!r.posted().iter().any(|p| p.contains("Return")));
        assert_eq!(r.done, [("1".into(), Outcome::Failed("no-v-key".into()))]);
    }

    /// A held Right Option is released before the chord and pressed again after it.
    #[test]
    fn dc_n6_held_modifiers_are_released_around_the_chord() {
        let mut r = Rig::new(Os::Mac);
        r.w.borrow_mut().held = vec!["RightOption".into()];
        r.insert(&req("paste", "none"), &cap());
        assert_eq!(
            r.posted(),
            ["RightOption up", "Command+Code(9)", "RightOption down"]
        );
    }

    /// Another writer bumped the change count: its contents win and nothing is restored.
    /// Positive control: with the ownership guard removed this test sees "old" and fails.
    #[test]
    fn dc_n6_a_newer_clipboard_is_never_overwritten() {
        let mut r = Rig::new(Os::Mac);
        r.insert(&req("paste", "Enter"), &cap());
        r.read_at(50);
        r.until(60);
        {
            let mut w = r.w.borrow_mut();
            w.board = vec![("text".into(), b"newer".to_vec())];
            w.count += 1;
        }
        r.until(1_000);
        assert_eq!(r.board_text(), "newer");
        assert_eq!(r.w.borrow().restores, 0);
        assert!(
            matches!(r.done[0].1, Outcome::Inserted { .. }),
            "it was read"
        );

        let mut lost = Rig::new(Os::Mac);
        lost.insert(&req("paste", "Enter"), &cap());
        lost.w.borrow_mut().count += 1;
        lost.until(10);
        assert_eq!(
            lost.done,
            [("1".into(), Outcome::Failed("clipboard-changed".into()))]
        );
    }

    #[test]
    fn dc_n6_restore_clipboard_false_leaves_the_text() {
        let mut r = Rig::new(Os::Mac);
        let mut q = req("paste", "none");
        q.restore = false;
        r.insert(&q, &cap());
        r.read_at(10);
        r.until(9_000);
        assert_eq!(r.board_text(), "hello");
        assert_eq!(r.w.borrow().restores, 0);
        assert!(matches!(r.done[0].1, Outcome::Inserted { .. }));
        let w = r.w.borrow();
        assert!(
            w.promise.is_none() && !w.transient,
            "the promise became a lasting copy, or the text would vanish with the helper"
        );
        assert!(!w.concealed, "the user asked to keep it: an ordinary copy");
    }

    /// A clipboard this process read as empty (empty, or pasteboard privacy set to deny): the
    /// paste settles by leaving the dictation as a lasting copy, never by clearing the clipboard.
    #[test]
    fn dc_n6_an_unreadable_clipboard_keeps_the_dictation_instead_of_clearing_it() {
        let mut r = Rig::new(Os::Mac);
        r.w.borrow_mut().board.clear();
        r.insert(&req("paste", "none"), &cap());
        r.read_at(10);
        r.until(1_000);
        assert!(matches!(r.done[0].1, Outcome::Inserted { .. }));
        let w = r.w.borrow();
        assert_eq!(w.restores, 0, "nothing to restore");
        assert_eq!(w.board.len(), 1, "{:?}", w.board);
        assert_eq!(w.board[0].1, b"hello");
        assert!(w.promise.is_none(), "a lasting copy, not the dying promise");
    }

    /// Terminals get the terminal's paste: Ctrl+Shift+V on Windows, Shift+Insert on Linux.
    #[test]
    fn dc_n6_terminals_get_their_own_chord() {
        for (os, app, want) in [
            (Os::Windows, "WindowsTerminal.exe", "Control+Shift+Code(9)"),
            (Os::Windows, "notepad.exe", "Control+Code(9)"),
            (
                Os::Linux,
                "gnome-terminal-server",
                "Shift+Named(\"Insert\")",
            ),
            (Os::Linux, "xfce4-terminal", "Shift+Named(\"Insert\")"),
            (Os::Linux, "firefox", "Control+Code(9)"),
            (Os::Mac, "Terminal", "Command+Code(9)"),
        ] {
            let mut r = Rig::new(os);
            let t = Target {
                app: app.into(),
                ..slack()
            };
            r.w.borrow_mut().target = t.clone();
            r.insert(
                &req("paste", "none"),
                &Captured {
                    target: t,
                    secure_input: false,
                },
            );
            assert_eq!(r.posted(), [want], "{os:?} {app}");
        }
    }

    /// A Windows window running as administrator drops the paste: no chord, the clipboard, and a
    /// reason for the pill.
    #[test]
    fn dc_n6_an_elevated_target_gets_the_clipboard_and_no_chord() {
        let mut r = Rig::new(Os::Windows);
        r.w.borrow_mut().elevated = true;
        r.insert(&req("paste", "Enter"), &cap());
        assert!(r.posted().is_empty());
        assert_eq!(r.board_text(), "hello");
        assert!(
            r.w.borrow().concealed,
            "a copy the helper chose is concealed"
        );
        assert_eq!(
            r.done,
            [(
                "1".into(),
                Outcome::Inserted {
                    method: "clipboard",
                    receipt_ms: 0,
                    reason: Some("elevated")
                }
            )]
        );
    }

    /// `dictation.insert: clipboard` writes and restores nothing, and presses no send key.
    #[test]
    fn dc_n6_clipboard_mode_writes_and_sends_nothing() {
        let mut r = Rig::new(Os::Mac);
        r.insert(&req("clipboard", "Enter"), &cap());
        r.until(9_000);
        assert!(r.posted().is_empty());
        assert_eq!(r.board_text(), "hello");
        assert!(
            !r.w.borrow().transient,
            "a hand paste needs a lasting write"
        );
        assert!(
            !r.w.borrow().concealed,
            "the user chose the clipboard: an ordinary copy"
        );
    }

    /// A newer insert settles a paste still waiting, so two quick dictations both land.
    #[test]
    fn dc_n6_a_second_insert_settles_the_first() {
        let mut r = Rig::new(Os::Mac);
        r.insert(&req("paste", "none"), &cap());
        r.read_at(0);
        let mut second = req("paste", "none");
        second.id = "2".into();
        r.insert(&second, &cap());
        assert_eq!(r.done.len(), 1);
        assert_eq!(r.done[0].0, "1");
        assert!(r.ins.busy(), "the second waits for its own read");
    }

    /// DC-N8: a secure field, or Secure Input at the start or now, gets the clipboard and no key
    /// event. Positive control: the same insert on an editable field posts the chord.
    #[test]
    fn dc_n8_nothing_is_typed_or_pasted_into_a_password_field() {
        let secure = Target {
            field: "secure".into(),
            ..slack()
        };
        // (the session's field, Secure Input at its start, the field now, Secure Input now):
        // each alone is enough.
        for (at_start, input_at_start, now, input_now) in [
            (secure.clone(), false, slack(), false),
            (slack(), true, slack(), false),
            (slack(), false, secure.clone(), false),
            (slack(), false, slack(), true),
        ] {
            for method in ["paste", "type"] {
                let mut r = Rig::new(Os::Mac);
                r.w.borrow_mut().target = now.clone();
                r.w.borrow_mut().secure_input = input_now;
                let c = Captured {
                    target: at_start.clone(),
                    secure_input: input_at_start,
                };
                r.insert(&req(method, "Enter"), &c);
                assert!(r.posted().is_empty(), "{method} {c:?}: {:?}", r.posted());
                assert_eq!(r.board_text(), "hello");
                assert!(
                    r.w.borrow().concealed && !r.w.borrow().transient,
                    "a lasting copy clipboard managers skip"
                );
                assert_eq!(
                    r.done[0].1,
                    Outcome::Inserted {
                        method: "clipboard",
                        receipt_ms: 0,
                        reason: Some("secure")
                    }
                );
            }
        }
        let mut control = Rig::new(Os::Mac);
        control.insert(&req("paste", "none"), &cap());
        assert_eq!(control.posted(), ["Command+Code(9)"]);
    }

    /// DC-N9: the window changed between the key-down and the insert, or the field cannot take
    /// text: nothing is posted and the reason goes back. After `focus` on the original target the
    /// same insert posts the chord; with the target unchanged it posts at once (positive control).
    #[test]
    fn dc_n9_nothing_lands_in_the_wrong_window() {
        let mut r = Rig::new(Os::Mac);
        r.w.borrow_mut().target = Target {
            app: "Mail".into(),
            pid: 4,
            ..slack()
        };
        r.insert(&req("paste", "Enter"), &cap());
        assert!(r.posted().is_empty());
        assert_eq!(r.board_text(), "old", "the clipboard is untouched");
        assert_eq!(
            r.done,
            [("1".into(), Outcome::Failed("focus-changed".into()))]
        );

        r.screen.focus(&slack());
        r.done.clear();
        r.insert(&req("paste", "none"), &cap());
        assert_eq!(r.posted(), ["Command+Code(9)"]);

        for (field, reason) in [
            ("not-editable", "not-editable"),
            ("unknown", "field-unknown"),
        ] {
            let mut f = Rig::new(Os::Mac);
            f.w.borrow_mut().target.field = field.into();
            let c = Captured {
                target: Target {
                    field: field.into(),
                    ..slack()
                },
                secure_input: false,
            };
            f.insert(&req("type", "none"), &c);
            assert!(f.posted().is_empty());
            assert_eq!(f.done, [("1".into(), Outcome::Failed(reason.into()))]);
        }
    }

    /// DC-N7: the typed path sends at most 20 units per event and one Return per newline; a
    /// 2,000-character text arrives whole and in order.
    #[test]
    fn dc_n7_typing_goes_in_20_unit_chunks_with_real_returns() {
        assert_eq!(
            pieces("ab\ncd\r\nef"),
            [
                Piece::Text("ab".into()),
                Piece::Return,
                Piece::Text("cd".into()),
                Piece::Return,
                Piece::Text("ef".into()),
            ]
        );
        assert_eq!(
            pieces("a\tb\u{8}c\u{1b}d\u{7f}e\u{85}f\u{0}"),
            [Piece::Text("a bcdef".into())],
            "a tab is a space; no other control character is typed"
        );
        let emoji = "😀".repeat(11);
        let p = pieces(&emoji);
        assert_eq!(p.len(), 2, "a pair is never split: 10 fit in 20 units");
        assert_eq!(p[0], Piece::Text("😀".repeat(10)));

        let long: String = (0..2_000)
            .map(|i| char::from(b'a' + (i % 26) as u8))
            .collect();
        let mut r = Rig::new(Os::Mac);
        r.insert(
            &Request {
                text: format!("{long}\n"),
                ..req("type", "Enter")
            },
            &cap(),
        );
        let posted = r.posted();
        let typed: String = posted
            .iter()
            .filter_map(|p| p.strip_prefix("type "))
            .inspect(|s| assert!(s.encode_utf16().count() <= TYPE_CHUNK))
            .collect();
        assert_eq!(typed, long);
        assert_eq!(
            posted.len(),
            100 + 2,
            "100 chunks, the newline, the send key"
        );
        assert_eq!(posted[100], "Named(\"Return\")");
        assert_eq!(
            r.done,
            [(
                "1".into(),
                Outcome::Inserted {
                    method: "type",
                    receipt_ms: 0,
                    reason: None
                }
            )]
        );
    }
}
