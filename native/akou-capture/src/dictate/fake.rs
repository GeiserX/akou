//! A fake clipboard, event sink and screen sharing one record (DC-N10): what the unit tests and
//! `--inserter fake` / `--clipboard fake` / `--ax fake` insert into instead of the OS. Never in a
//! shipping build.

use std::cell::RefCell;
use std::io::Write;
use std::path::PathBuf;
use std::rc::Rc;

use super::insert::{Clipboard, Key, Sink, Snapshot, Targets};
use super::protocol::Target;
use crate::json::Json;

#[derive(Default)]
pub struct World {
    /// The clipboard's types, and the text while it is akou's transient promise.
    pub board: Snapshot,
    pub promise: Option<String>,
    pub transient: bool,
    pub count: u64,
    /// Reads of the promise not yet collected, with their time.
    pub pending_reads: Vec<u64>,
    /// Without `--clipboard fake` there is no clipboard at all.
    pub no_clipboard: bool,
    /// Every key event posted, in order: `RightOption up`, `Command+Code(9)`, `type hello`.
    pub posted: Vec<String>,
    pub held: Vec<String>,
    /// The layout: which code types which character.
    pub layout: Vec<(char, u16)>,
    /// The window under the cursor, and the scripted ones by time (`--ax fake FILE`).
    pub target: Target,
    pub script: Vec<(u64, Target)>,
    pub secure_input: bool,
    pub elevated: bool,
    pub focused: Vec<Target>,
    pub restores: usize,
    /// The target reads the promise the moment a paste chord arrives (the simulate run's app).
    pub auto_read: bool,
    pub now: u64,
    /// Where `--inserter fake:FILE` appends what happened, one JSON line each.
    pub log: Option<PathBuf>,
}

pub type Shared = Rc<RefCell<World>>;

impl World {
    /// A US layout (V is code 9), the text "old" and an image on the clipboard, and an editable
    /// field in Slack.
    pub fn new() -> Shared {
        Rc::new(RefCell::new(World {
            board: vec![
                ("text".into(), b"old".to_vec()),
                ("image".into(), vec![0x89, b'P', b'N', b'G']),
            ],
            count: 1,
            layout: vec![('v', 9)],
            target: slack(),
            ..World::default()
        }))
    }

    fn note(&self, fields: Vec<(&'static str, Json)>) {
        if let Some(path) = &self.log {
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .expect("the fake inserter's log opens");
            writeln!(f, "{}", Json::obj(fields).to_line())
                .expect("the fake inserter's log is written");
        }
    }

    fn set_board(&mut self, text: &str, transient: bool) -> Result<(), String> {
        if self.no_clipboard {
            return Err("no-clipboard".into());
        }
        self.board = vec![("text".into(), text.as_bytes().to_vec())];
        self.promise = transient.then(|| text.to_string());
        self.transient = transient;
        self.count += 1;
        self.note(vec![
            (
                "type",
                Json::str(if transient { "publish" } else { "write" }),
            ),
            ("text", Json::str(text)),
        ]);
        Ok(())
    }
}

pub fn slack() -> Target {
    Target {
        app: "Slack".into(),
        pid: 9,
        window: "w".into(),
        field: "editable".into(),
    }
}

pub struct Board(pub Shared);

impl Clipboard for Board {
    fn snapshot(&mut self) -> Snapshot {
        self.0.borrow().board.clone()
    }
    fn publish(&mut self, text: &str) -> Result<u64, String> {
        let mut w = self.0.borrow_mut();
        w.set_board(text, true)?;
        Ok(w.count)
    }
    fn write(&mut self, text: &str) -> Result<(), String> {
        self.0.borrow_mut().set_board(text, false)
    }
    fn change_count(&mut self) -> u64 {
        self.0.borrow().count
    }
    fn restore(&mut self, s: &Snapshot) {
        let mut w = self.0.borrow_mut();
        w.board = s.clone();
        w.promise = None;
        w.transient = false;
        w.count += 1;
        w.restores += 1;
        w.note(vec![("type", Json::str("restore"))]);
    }
    fn reads(&mut self) -> Vec<u64> {
        std::mem::take(&mut self.0.borrow_mut().pending_reads)
    }
}

pub struct Keys(pub Shared);

impl Keys {
    fn post(&self, event: String) {
        let mut w = self.0.borrow_mut();
        w.note(vec![
            ("type", Json::str("key")),
            ("event", Json::str(&event)),
        ]);
        w.posted.push(event);
    }
}

impl Sink for Keys {
    fn held_modifiers(&mut self) -> Vec<String> {
        self.0.borrow().held.clone()
    }
    fn modifier(&mut self, name: &str, down: bool) -> Result<(), String> {
        self.post(format!("{name} {}", if down { "down" } else { "up" }));
        Ok(())
    }
    fn press(&mut self, mods: &[&str], key: Key) -> Result<(), String> {
        let mut s: Vec<String> = mods.iter().map(|m| m.to_string()).collect();
        s.push(format!("{key:?}"));
        self.post(s.join("+"));
        let mut w = self.0.borrow_mut();
        if w.auto_read && w.promise.is_some() && key != Key::Named("Return") {
            let now = w.now;
            w.pending_reads.push(now);
        }
        Ok(())
    }
    fn keycode(&mut self, ch: char) -> Option<u16> {
        let w = self.0.borrow();
        w.layout.iter().find(|(c, _)| *c == ch).map(|(_, k)| *k)
    }
    fn type_text(&mut self, text: &str) -> Result<(), String> {
        self.post(format!("type {text}"));
        Ok(())
    }
}

pub struct Screen(pub Shared);

impl Targets for Screen {
    /// The last scripted target at or before `t_ns`, else the one set on the world.
    fn target(&mut self, t_ns: u64) -> Target {
        let w = self.0.borrow();
        w.script
            .iter()
            .rev()
            .find(|(ms, _)| ms * 1_000_000 <= t_ns)
            .map_or_else(|| w.target.clone(), |(_, t)| t.clone())
    }
    fn secure_input(&mut self) -> bool {
        self.0.borrow().secure_input
    }
    fn elevated(&mut self, _: &Target) -> bool {
        self.0.borrow().elevated
    }
    fn focus(&mut self, t: &Target) {
        let mut w = self.0.borrow_mut();
        w.note(vec![
            ("type", Json::str("focus")),
            ("app", Json::str(&t.app)),
            ("pid", Json::Int(t.pid)),
        ]);
        w.focused.push(t.clone());
        w.script.clear();
        w.target = t.clone();
    }
}
