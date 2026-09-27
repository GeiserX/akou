//! The Linux clipboard for the insert (docs/ux/DICTATION.md DC-N6): the X11 `CLIPBOARD` selection
//! and the Wayland data device, as one `Clipboard` the receipt paste (`insert::Inserter`) drives.
//!
//! Neither X11 nor Wayland keeps a copy of the clipboard: the client that owns it serves every
//! read itself, one request at a time. X11 sends the owner a `SelectionRequest` and waits for its
//! `SelectionNotify`; Wayland sends `wl_data_source.send` with a file descriptor to write into.
//! So on Linux the receipt is exact: a request for the text after the chord is the target reading
//! it, the same rule `provideDataForType` gives on macOS. This module holds what akou serves and
//! turns the connection's events into the insert's receipts; the connection itself (`Conn`) is
//! per display server.
//!
//! - **A read** is a request for one of the text types. A request for `TARGETS` (X11's question
//!   of which types are offered) or for the password-manager hint is answered and not counted:
//!   a paste in a GTK or Qt app asks for `TARGETS` first, and counting it would restore the old
//!   clipboard before the text was read.
//! - **Transient and concealed**: the published text also offers `x-kde-passwordManagerHint` set
//!   to `secret`, which clipboard managers that honour it (Klipper, CopyQ) take as "do not keep".
//!   A lasting copy the helper chose (`secure`, `elevated`) carries it; one the user chose does
//!   not.
//! - **The change count** moves every time akou takes the clipboard (publish, write, restore) and
//!   every time it loses it (X11 `SelectionClear`, Wayland `cancelled`): another writer took over,
//!   so the insert never restores over it.
//! - **The snapshot** asks the current owner for every type it offers (`Conn::fetch`); a restore
//!   takes the clipboard back and serves those bytes.
//!
//! Nothing here waits: every call first handles the events that arrived (`pump`), answering each
//! request from what is served now.

use super::insert::{Clipboard, Snapshot};

/// The types the text is offered as: X11 target names and Wayland MIME types.
pub const TEXT_TYPES: [&str; 5] = [
    "UTF8_STRING",
    "text/plain;charset=utf-8",
    "text/plain",
    "STRING",
    "TEXT",
];
/// The type clipboard managers read as "a password, do not keep" (KDE's convention).
pub const HINT: &str = "x-kde-passwordManagerHint";
/// X11's question of which types the owner offers.
pub const TARGETS: &str = "TARGETS";
/// X11 types that describe the selection rather than hold it; never snapshotted.
const META: [&str; 4] = [TARGETS, "TIMESTAMP", "MULTIPLE", "SAVE_TARGETS"];

/// What the display server told the owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// A reader asks for `kind`: an X11 `SelectionRequest` for that target, or a Wayland
    /// `wl_data_source.send` for that MIME type. `id` names the reply; `at_ns` is when it came.
    Request { id: u64, kind: String, at_ns: u64 },
    /// Another client took the clipboard: X11 `SelectionClear`, Wayland `cancelled`.
    Lost,
}

/// The owner's answer to one request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    Data(Vec<u8>),
    /// The types offered, for `TARGETS`.
    Types(Vec<String>),
    /// Not a type akou offers: X11 `property None`, a Wayland fd closed empty.
    Refuse,
}

/// The display server connection, per backend (X11 or Wayland).
pub trait Conn {
    /// Takes the clipboard, offering these types (X11 `SetSelectionOwner`, Wayland
    /// `set_selection` with a new data source).
    fn own(&mut self, types: &[String]) -> Result<(), String>;
    /// The events that arrived since the last call.
    fn events(&mut self) -> Vec<Event>;
    fn answer(&mut self, id: u64, answer: Answer);
    /// Every type the current owner offers, with its bytes. Empty when there is none or it does
    /// not answer.
    fn fetch(&mut self) -> Snapshot;
}

/// What akou serves while it owns the clipboard.
struct Serving {
    types: Snapshot,
    /// The paste's promise: a text read counts as the receipt.
    counted: bool,
}

pub struct Selection<C: Conn> {
    conn: C,
    serving: Option<Serving>,
    count: u64,
    reads: Vec<u64>,
}

fn text_types(text: &str, concealed: bool) -> Snapshot {
    let mut types: Snapshot = TEXT_TYPES
        .iter()
        .map(|t| (t.to_string(), text.as_bytes().to_vec()))
        .collect();
    if concealed {
        types.push((HINT.into(), b"secret".to_vec()));
    }
    types
}

impl<C: Conn> Selection<C> {
    pub fn new(conn: C) -> Selection<C> {
        Selection {
            conn,
            serving: None,
            count: 0,
            reads: Vec::new(),
        }
    }

    /// Answers every request that arrived and notes the receipts and a lost clipboard.
    fn pump(&mut self) {
        for e in self.conn.events() {
            match e {
                Event::Lost => {
                    if self.serving.take().is_some() {
                        self.count += 1;
                    }
                }
                Event::Request { id, kind, at_ns } => {
                    let answer = match &self.serving {
                        None => Answer::Refuse,
                        Some(s) if kind == TARGETS => {
                            Answer::Types(s.types.iter().map(|(t, _)| t.clone()).collect())
                        }
                        Some(s) => match s.types.iter().find(|(t, _)| *t == kind) {
                            Some((_, bytes)) => {
                                if s.counted && TEXT_TYPES.contains(&kind.as_str()) {
                                    self.reads.push(at_ns);
                                }
                                Answer::Data(bytes.clone())
                            }
                            None => Answer::Refuse,
                        },
                    };
                    self.conn.answer(id, answer);
                }
            }
        }
    }

    fn take(&mut self, types: Snapshot, counted: bool) -> Result<(), String> {
        self.pump();
        let names: Vec<String> = types.iter().map(|(t, _)| t.clone()).collect();
        self.conn.own(&names)?;
        self.serving = Some(Serving { types, counted });
        self.count += 1;
        Ok(())
    }
}

impl<C: Conn> Clipboard for Selection<C> {
    fn snapshot(&mut self) -> Snapshot {
        self.pump();
        let all = match &self.serving {
            Some(s) => s.types.clone(),
            None => self.conn.fetch(),
        };
        all.into_iter()
            .filter(|(t, _)| !META.contains(&t.as_str()))
            .collect()
    }

    fn publish(&mut self, text: &str) -> Result<u64, String> {
        self.take(text_types(text, true), true)?;
        Ok(self.count)
    }

    fn write(&mut self, text: &str, concealed: bool) -> Result<(), String> {
        self.take(text_types(text, concealed), false)
    }

    fn change_count(&mut self) -> u64 {
        self.pump();
        self.count
    }

    fn restore(&mut self, snapshot: &Snapshot) {
        let _ = self.take(snapshot.clone(), false);
    }

    fn reads(&mut self) -> Vec<u64> {
        self.pump();
        std::mem::take(&mut self.reads)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictate::fake::{Keys, Screen, World, slack};
    use crate::dictate::insert::{Captured, Inserter, Os, Outcome, Request};
    use std::cell::RefCell;
    use std::rc::Rc;

    const MS: u64 = 1_000_000;
    const T0: u64 = 1_000 * MS;

    /// A display server with one other client that owned the clipboard before akou.
    #[derive(Default)]
    struct Server {
        /// What the other client offers.
        theirs: Snapshot,
        /// What akou offered at each `own`.
        owned: Vec<Vec<String>>,
        pending: Vec<Event>,
        answers: Vec<(u64, Answer)>,
        next_id: u64,
    }

    #[derive(Clone)]
    struct Fake(Rc<RefCell<Server>>);

    impl Conn for Fake {
        fn own(&mut self, types: &[String]) -> Result<(), String> {
            self.0.borrow_mut().owned.push(types.to_vec());
            Ok(())
        }
        fn events(&mut self) -> Vec<Event> {
            std::mem::take(&mut self.0.borrow_mut().pending)
        }
        fn answer(&mut self, id: u64, answer: Answer) {
            self.0.borrow_mut().answers.push((id, answer));
        }
        fn fetch(&mut self) -> Snapshot {
            self.0.borrow().theirs.clone()
        }
    }

    impl Fake {
        fn new() -> Fake {
            Fake(Rc::new(RefCell::new(Server {
                theirs: vec![
                    ("TARGETS".into(), Vec::new()),
                    ("UTF8_STRING".into(), b"old".to_vec()),
                    ("image/png".into(), vec![0x89, b'P', b'N', b'G']),
                ],
                ..Server::default()
            })))
        }
        /// A reader asks for `kind` at `ms` after T0 (negative: before it).
        fn request(&self, kind: &str, ms: i64) -> u64 {
            let mut s = self.0.borrow_mut();
            s.next_id += 1;
            let id = s.next_id;
            s.pending.push(Event::Request {
                id,
                kind: kind.into(),
                at_ns: (T0 as i64 + ms * MS as i64) as u64,
            });
            id
        }
        fn answer_to(&self, id: u64) -> Option<Answer> {
            let s = self.0.borrow();
            s.answers
                .iter()
                .find(|(i, _)| *i == id)
                .map(|(_, a)| a.clone())
        }
    }

    struct Rig {
        x: Fake,
        ins: Inserter,
        screen: Screen,
        done: Vec<(String, Outcome)>,
    }

    impl Rig {
        fn new() -> Rig {
            let w = World::new();
            let x = Fake::new();
            Rig {
                ins: Inserter::new(
                    Os::Linux,
                    Box::new(Selection::new(x.clone())),
                    Box::new(Keys(w.clone())),
                ),
                screen: Screen(w),
                x,
                done: Vec::new(),
            }
        }
        fn insert(&mut self, restore: bool) {
            let req = Request {
                id: "1".into(),
                text: "hello".into(),
                method: "paste".into(),
                send_key: "none".into(),
                restore,
            };
            let cap = Captured {
                target: slack(),
                secure_input: false,
            };
            self.ins
                .insert(&req, &cap, &mut self.screen, T0, &mut self.done);
        }
        /// Ticks every 10 ms up to `ms` after T0.
        fn until(&mut self, ms: u64) {
            let mut t = T0;
            while t <= T0 + ms * MS {
                self.ins.tick(t, &mut self.done);
                t += 10 * MS;
            }
        }
        fn owned(&self) -> Vec<Vec<String>> {
            self.x.0.borrow().owned.clone()
        }
    }

    fn names(types: &[&str]) -> Vec<String> {
        types.iter().map(|t| t.to_string()).collect()
    }

    /// DC-N6 on Linux: a `SelectionRequest` for the text after the chord is the target's read.
    /// The `TARGETS` probe before it is answered and does not count, so the receipt is the text
    /// read at 1 s and the old clipboard (text and image) is served again 200 ms after it.
    #[test]
    fn dc_n6_on_linux_a_selection_request_after_the_chord_is_the_read() {
        let mut r = Rig::new();
        r.insert(true);
        let published = &r.owned()[0];
        assert!(
            published.contains(&"UTF8_STRING".to_string()),
            "{published:?}"
        );
        assert!(
            published.contains(&HINT.to_string()),
            "the promise is marked for clipboard managers to skip"
        );
        let probe = r.x.request(TARGETS, 500);
        r.until(900);
        assert!(
            matches!(r.x.answer_to(probe), Some(Answer::Types(t)) if t.contains(&"text/plain".to_string()))
        );
        assert!(r.done.is_empty(), "a TARGETS probe is not the read");
        assert_eq!(r.owned().len(), 1, "nothing restored yet");

        let read = r.x.request("UTF8_STRING", 1_000);
        r.until(1_150);
        assert_eq!(r.x.answer_to(read), Some(Answer::Data(b"hello".to_vec())));
        assert_eq!(r.owned().len(), 1, "inside the quiet period");
        r.until(1_200);
        assert_eq!(
            r.owned().last().unwrap(),
            &names(&["UTF8_STRING", "image/png"]),
            "every old type comes back, and TARGETS is not one"
        );
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
        // After the restore akou serves the old text, and a read of it is no receipt.
        let later = r.x.request("UTF8_STRING", 1_300);
        r.until(1_310);
        assert_eq!(r.x.answer_to(later), Some(Answer::Data(b"old".to_vec())));
    }

    /// A request that came before the chord (a clipboard manager answering the new owner, even
    /// when reported late) is no receipt: the old clipboard comes back at 8 s and the insert fails.
    /// The hint is answered `secret` and is not a read either.
    #[test]
    fn dc_n6_on_linux_a_request_before_the_chord_does_not_count() {
        let mut r = Rig::new();
        r.insert(true);
        r.x.request("UTF8_STRING", -1);
        let hint = r.x.request(HINT, 100);
        r.until(7_990);
        assert!(r.done.is_empty(), "{:?}", r.done);
        assert_eq!(r.x.answer_to(hint), Some(Answer::Data(b"secret".to_vec())));
        r.until(8_000);
        assert_eq!(r.done, [("1".into(), Outcome::Failed("no-receipt".into()))]);
        assert_eq!(r.owned().len(), 2, "restored at 8 s");
    }

    /// Another client took the clipboard after the read (X11 `SelectionClear`): its contents win
    /// and akou takes nothing back. Positive control: without the loss the old clipboard is
    /// served again.
    #[test]
    fn dc_n6_on_linux_a_lost_selection_is_never_taken_back() {
        let mut r = Rig::new();
        r.insert(true);
        r.x.request("text/plain;charset=utf-8", 50);
        r.until(60);
        r.x.0.borrow_mut().pending.push(Event::Lost);
        r.until(1_000);
        assert_eq!(r.owned().len(), 1, "no restore over the newer owner");
        assert!(
            matches!(r.done[0].1, Outcome::Inserted { .. }),
            "it was read"
        );

        let mut control = Rig::new();
        control.insert(true);
        control.x.request("text/plain;charset=utf-8", 50);
        control.until(1_000);
        assert_eq!(control.owned().len(), 2);

        let mut lost = Rig::new();
        lost.insert(true);
        lost.x.0.borrow_mut().pending.push(Event::Lost);
        lost.until(10);
        assert_eq!(
            lost.done,
            [("1".into(), Outcome::Failed("clipboard-changed".into()))]
        );
    }

    /// `restoreClipboard: false` leaves the text as a lasting copy the user chose: an ordinary
    /// offer with no hint, whose reads are not receipts.
    #[test]
    fn dc_n6_on_linux_a_kept_copy_carries_no_hint() {
        let mut r = Rig::new();
        r.insert(false);
        r.x.request("UTF8_STRING", 10);
        r.until(1_000);
        assert!(matches!(r.done[0].1, Outcome::Inserted { .. }));
        let kept = r.owned().last().unwrap().clone();
        assert_eq!(kept, names(&TEXT_TYPES));
        assert!(!kept.contains(&HINT.to_string()));
    }
}
