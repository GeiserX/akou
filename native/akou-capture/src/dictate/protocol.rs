//! `akou-dictate/1` (docs/ux/DICTATION.md section 9), the helper's side. The TypeScript side is
//! `src/main/dictation/protocol.ts`; the two must agree on every name below.
//!
//! - **stdout**: the same `AKP1` packets as `akou-capture/1`, channel 0 (mic) only, while a
//!   session runs. `capture_ns` is the host clock of the first sample (the file timeline under
//!   `--from-wav`); `file_seconds` is the position in the session's audio, 0 at its first sample.
//! - **stderr**: one JSON object per line, tagged by `type`. A `capture_ns` is a decimal string.
//! - **stdin**: one JSON object per line, tagged by `type`. Closing stdin means stop.
//!
//! Helper to app:
//!
//! | `type` | fields |
//! |---|---|
//! | `ready` | `protocol`, `version`, `backend`, `swallow_keys`, `grants: {mic, accessibility}` (`granted`, `denied` or `not-needed`) |
//! | `session.started` | `id`, `target: {app, pid, window, field}`, `capture_ns` (of the session's first sample) |
//! | `level` | `rms` (linear, 0 to 1), 20 per second while a session runs |
//! | `key` | `name`: `Escape`, `Enter` or `Shift+Enter` during a session and until its insert settles; the hotkey's name when it is pressed while a session is still transcribing; any key while `record_keys` is on |
//! | `grant.lost` | `name` |
//! | `session.ended` | `id`, `reason`: `release`, `tap`, `key` (Enter or Shift+Enter ended it), `cancel`, `silence`, `max`, `stop` |
//! | `inserted` | `id`, `method` (`paste`, `type`, `clipboard`), `receipt_ms` (chord to the target's first read; 0 when nothing was pasted), and `reason` only when the helper chose clipboard-only for the user: `secure` (DC-N8) or `elevated` (a Windows admin window) |
//! | `insert.failed` | `id`, `reason`: `focus-changed`, `not-editable`, `field-unknown` (DC-N9: the app opens the draft box), `no-receipt` (the target never read in 8 s), `clipboard-changed` (another writer took the clipboard before the target read), `no-v-key`, `no-inserter`, or the backend's error |
//! | `edit` / `edit.unreadable` | `id`, `hunks` / `reason` |
//! | `secure_input` | `on` |
//! | `mic` | `open`: the stream opened or closed (the warm mic of DC-N4) |
//! | `rebound` / `rebind.failed` | `hotkey` / `hotkey`, `reason` (the answer to `rebind`, DC-A7) |
//! | `warn` | `code`, `msg` |
//! | `stopped` | `reason` |
//!
//! App to helper: `rebind {hotkey, activation, draft, fixLast, pasteLast}`, `insert {id, text,
//! method, send_key, target, restore}` (`method` `paste`, `type` or `clipboard`, default `paste`;
//! `send_key` `Enter`, `Ctrl+Enter`, `Cmd+Enter`, `Shift+Enter` or `none`, the default; `restore`
//! is `dictation.restoreClipboard`, default true; any other value is refused), `settled {id}` (the session will not be inserted: empty, drafted or
//! cancelled while transcribing), `focus {target}`, `session.start`, `session.stop`,
//! `session.cancel` (the tray's and the CLI's door), `rebuild_mic {device}`, `warm {mode}`,
//! `record_keys {on}`, `stop`.

use crate::json::Json;

pub const PROTOCOL: &str = "akou-dictate/1";

/// Where the text goes, as the session saw it at key-down (DC-N9).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Target {
    pub app: String,
    pub pid: i64,
    pub window: String,
    /// `editable`, `not-editable`, `unknown` or `secure`.
    pub field: String,
}

impl Target {
    pub fn unknown() -> Target {
        Target {
            field: "unknown".into(),
            ..Target::default()
        }
    }

    fn json(&self) -> Json {
        Json::obj(vec![
            ("app", Json::str(&self.app)),
            ("pid", Json::Int(self.pid)),
            ("window", Json::str(&self.window)),
            ("field", Json::str(&self.field)),
        ])
    }

    pub fn from_value(v: &Value) -> Result<Target, String> {
        let field = v.str_or("field", "unknown");
        if !matches!(
            field.as_str(),
            "editable" | "not-editable" | "unknown" | "secure"
        ) {
            return Err(format!("unknown field kind {field}"));
        }
        Ok(Target {
            app: v.str_or("app", ""),
            pid: v.get("pid").and_then(Value::as_i64).unwrap_or(0),
            window: v.str_or("window", ""),
            field,
        })
    }
}

fn line(kind: &str, mut fields: Vec<(&'static str, Json)>) -> String {
    fields.insert(0, ("type", Json::str(kind)));
    Json::obj(fields).to_line()
}

pub fn ready(backend: &str, swallow_keys: bool, mic: &str, accessibility: &str) -> String {
    line(
        "ready",
        vec![
            ("protocol", Json::str(PROTOCOL)),
            ("version", Json::str(crate::protocol::VERSION)),
            ("backend", Json::str(backend)),
            ("swallow_keys", Json::Bool(swallow_keys)),
            (
                "grants",
                Json::obj(vec![
                    ("mic", Json::str(mic)),
                    ("accessibility", Json::str(accessibility)),
                ]),
            ),
        ],
    )
}

pub fn session_started(id: &str, target: &Target, capture_ns: u64) -> String {
    line(
        "session.started",
        vec![
            ("id", Json::str(id)),
            ("target", target.json()),
            ("capture_ns", Json::Str(capture_ns.to_string())),
        ],
    )
}

pub fn session_ended(id: &str, reason: &str) -> String {
    line(
        "session.ended",
        vec![("id", Json::str(id)), ("reason", Json::str(reason))],
    )
}

pub fn level(rms: f64) -> String {
    line("level", vec![("rms", Json::Num(rms))])
}

pub fn key(name: &str) -> String {
    line("key", vec![("name", Json::str(name))])
}

pub fn mic(open: bool) -> String {
    line("mic", vec![("open", Json::Bool(open))])
}

pub fn inserted(id: &str, method: &str, receipt_ms: u64, reason: Option<&str>) -> String {
    let mut f = vec![
        ("id", Json::str(id)),
        ("method", Json::str(method)),
        ("receipt_ms", Json::Int(receipt_ms as i64)),
    ];
    if let Some(r) = reason {
        f.push(("reason", Json::str(r)));
    }
    line("inserted", f)
}

/// The insert methods and send keys `insert` takes (DC-N6, DC-N7, DC-S2).
pub const METHODS: [&str; 3] = ["paste", "type", "clipboard"];
pub const SEND_KEYS: [&str; 5] = ["Enter", "Ctrl+Enter", "Cmd+Enter", "Shift+Enter", "none"];

pub fn insert_failed(id: &str, reason: &str) -> String {
    line(
        "insert.failed",
        vec![("id", Json::str(id)), ("reason", Json::str(reason))],
    )
}

pub fn rebound(hotkey: &str) -> String {
    line("rebound", vec![("hotkey", Json::str(hotkey))])
}

pub fn rebind_failed(hotkey: &str, reason: &str) -> String {
    line(
        "rebind.failed",
        vec![("hotkey", Json::str(hotkey)), ("reason", Json::str(reason))],
    )
}

pub fn stopped(reason: &str) -> String {
    line("stopped", vec![("reason", Json::str(reason))])
}

pub use crate::protocol::warn;

// ---------------------------------------------------------------------------
// stdin commands

#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    Rebind {
        hotkey: String,
        activation: Option<String>,
    },
    Insert {
        id: String,
        text: String,
        method: String,
        send_key: String,
        target: Option<Target>,
        restore: bool,
    },
    Settled {
        id: String,
    },
    Focus {
        target: Target,
    },
    SessionStart,
    SessionStop,
    SessionCancel,
    RebuildMic {
        device: String,
    },
    Warm {
        mode: String,
    },
    RecordKeys {
        on: bool,
    },
    Stop,
}

impl Command {
    pub fn parse(text: &str) -> Result<Command, String> {
        let v = Value::parse(text)?;
        let kind = v.get("type").and_then(Value::as_str).ok_or("no type")?;
        let need = |k: &str| {
            v.get(k)
                .and_then(Value::as_str)
                .map(String::from)
                .ok_or_else(|| format!("{kind} needs {k}"))
        };
        Ok(match kind {
            "rebind" => Command::Rebind {
                hotkey: need("hotkey")?,
                activation: v
                    .get("activation")
                    .and_then(Value::as_str)
                    .map(String::from),
            },
            "insert" => {
                let method = v.str_or("method", "paste");
                if !METHODS.contains(&method.as_str()) {
                    return Err(format!("insert method {method} is not one of {METHODS:?}"));
                }
                // The key pressed after the insert; anything else (Command+Q) never reaches a sink.
                let send_key = v.str_or("send_key", "none");
                if !SEND_KEYS.contains(&send_key.as_str()) {
                    return Err(format!("send_key {send_key} is not one of {SEND_KEYS:?}"));
                }
                Command::Insert {
                    id: need("id")?,
                    text: need("text")?,
                    method,
                    send_key,
                    target: v.get("target").map(Target::from_value).transpose()?,
                    restore: match v.get("restore") {
                        None => true,
                        Some(r) => r.as_bool().ok_or("restore must be true or false")?,
                    },
                }
            }
            "settled" => Command::Settled { id: need("id")? },
            "focus" => Command::Focus {
                target: Target::from_value(v.get("target").ok_or("focus needs target")?)?,
            },
            "session.start" => Command::SessionStart,
            "session.stop" => Command::SessionStop,
            "session.cancel" => Command::SessionCancel,
            "rebuild_mic" => Command::RebuildMic {
                device: v.str_or("device", "default"),
            },
            "warm" => Command::Warm {
                mode: need("mode")?,
            },
            "record_keys" => Command::RecordKeys {
                on: v
                    .get("on")
                    .and_then(Value::as_bool)
                    .ok_or("record_keys needs on")?,
            },
            "stop" => Command::Stop,
            other => return Err(format!("unknown command {other}")),
        })
    }
}

// ---------------------------------------------------------------------------
// A JSON reader for the commands. `crate::json` only writes; the commands are small objects from
// the app, so a recursive reader of the whole grammar is shorter than a dependency.

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(f) => f.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Num(n) if n.fract() == 0.0 && n.abs() < 9.0e15 => Some(*n as i64),
            _ => None,
        }
    }
    fn str_or(&self, key: &str, default: &str) -> String {
        self.get(key)
            .and_then(Value::as_str)
            .unwrap_or(default)
            .to_string()
    }

    pub fn parse(text: &str) -> Result<Value, String> {
        let mut r = Reader {
            b: text.as_bytes(),
            i: 0,
        };
        let v = r.value(0)?;
        r.ws();
        if r.i != r.b.len() {
            return Err(format!("trailing bytes at {}", r.i));
        }
        Ok(v)
    }
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn ws(&mut self) {
        while self.b.get(self.i).is_some_and(|c| c.is_ascii_whitespace()) {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) -> Result<(), String> {
        self.ws();
        if self.b.get(self.i) == Some(&c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("expected {} at {}", c as char, self.i))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, String> {
        if depth > 32 {
            return Err("nested too deep".into());
        }
        self.ws();
        match self.b.get(self.i).copied() {
            Some(b'{') => {
                self.i += 1;
                let mut fields = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(Value::Obj(fields));
                }
                loop {
                    self.ws();
                    let k = self.string()?;
                    self.eat(b':')?;
                    fields.push((k, self.value(depth + 1)?));
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Value::Obj(fields));
                        }
                        _ => return Err(format!("expected , or }} at {}", self.i)),
                    }
                }
            }
            Some(b'[') => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(Value::Arr(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Value::Arr(items));
                        }
                        _ => return Err(format!("expected , or ] at {}", self.i)),
                    }
                }
            }
            Some(b'"') => Ok(Value::Str(self.string()?)),
            Some(b't') => self.word("true", Value::Bool(true)),
            Some(b'f') => self.word("false", Value::Bool(false)),
            Some(b'n') => self.word("null", Value::Null),
            Some(c) if c == b'-' || c.is_ascii_digit() => {
                let start = self.i;
                while self
                    .b
                    .get(self.i)
                    .is_some_and(|c| c.is_ascii_digit() || b"+-.eE".contains(c))
                {
                    self.i += 1;
                }
                let s = std::str::from_utf8(&self.b[start..self.i]).expect("ascii");
                s.parse::<f64>()
                    .ok()
                    .filter(|n| n.is_finite())
                    .map(Value::Num)
                    .ok_or_else(|| format!("bad number {s}"))
            }
            _ => Err(format!("unexpected byte at {}", self.i)),
        }
    }

    fn word(&mut self, w: &str, v: Value) -> Result<Value, String> {
        if self.b[self.i..].starts_with(w.as_bytes()) {
            self.i += w.len();
            Ok(v)
        } else {
            Err(format!("bad literal at {}", self.i))
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let h = self
            .b
            .get(self.i..self.i + 4)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u32::from_str_radix(h, 16).ok())
            .ok_or_else(|| format!("bad \\u escape at {}", self.i))?;
        self.i += 4;
        Ok(h)
    }

    fn string(&mut self) -> Result<String, String> {
        if self.b.get(self.i) != Some(&b'"') {
            return Err(format!("expected a string at {}", self.i));
        }
        self.i += 1;
        let mut out = Vec::new();
        loop {
            let c = *self.b.get(self.i).ok_or("unterminated string")?;
            self.i += 1;
            match c {
                b'"' => return String::from_utf8(out).map_err(|_| "string is not UTF-8".into()),
                b'\\' => {
                    let e = *self.b.get(self.i).ok_or("unterminated escape")?;
                    self.i += 1;
                    let ch = match e {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let hi = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&hi)
                                && self.b[self.i..].starts_with(b"\\u")
                            {
                                self.i += 2;
                                let lo = self.hex4()?;
                                0x10000 + ((hi - 0xD800) << 10) + (lo.wrapping_sub(0xDC00) & 0x3FF)
                            } else {
                                hi
                            };
                            char::from_u32(code).unwrap_or('\u{FFFD}')
                        }
                        _ => return Err(format!("bad escape at {}", self.i)),
                    };
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
                c if c < 0x20 => return Err("control byte in a string".into()),
                c => out.push(c),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_of_the_table_parses() {
        let cases = [
            (
                r#"{"type":"rebind","hotkey":"RightShift","activation":"hold"}"#,
                Command::Rebind {
                    hotkey: "RightShift".into(),
                    activation: Some("hold".into()),
                },
            ),
            (
                r#"{"type":"insert","id":"3","text":"héllo \"q\"\n😀","method":"paste","send_key":"Enter","target":{"app":"Slack","pid":42,"window":"w","field":"editable"}}"#,
                Command::Insert {
                    id: "3".into(),
                    text: "héllo \"q\"\n😀".into(),
                    method: "paste".into(),
                    send_key: "Enter".into(),
                    target: Some(Target {
                        app: "Slack".into(),
                        pid: 42,
                        window: "w".into(),
                        field: "editable".into(),
                    }),
                    restore: true,
                },
            ),
            (
                r#"{"type":"insert","id":"4","text":"x","restore":false}"#,
                Command::Insert {
                    id: "4".into(),
                    text: "x".into(),
                    method: "paste".into(),
                    send_key: "none".into(),
                    target: None,
                    restore: false,
                },
            ),
            (
                r#"{"type":"settled","id":"3"}"#,
                Command::Settled { id: "3".into() },
            ),
            (r#" {"type" : "session.start"} "#, Command::SessionStart),
            (r#"{"type":"session.stop"}"#, Command::SessionStop),
            (r#"{"type":"session.cancel"}"#, Command::SessionCancel),
            (
                r#"{"type":"rebuild_mic","device":"usb"}"#,
                Command::RebuildMic {
                    device: "usb".into(),
                },
            ),
            (
                r#"{"type":"warm","mode":"always"}"#,
                Command::Warm {
                    mode: "always".into(),
                },
            ),
            (
                r#"{"type":"record_keys","on":true}"#,
                Command::RecordKeys { on: true },
            ),
            (r#"{"type":"stop","extra":[1,2.5,null,{}]}"#, Command::Stop),
        ];
        for (text, want) in cases {
            assert_eq!(Command::parse(text).as_ref(), Ok(&want), "{text}");
        }
        assert!(matches!(
            Command::parse(
                r#"{"type":"focus","target":{"app":"A","pid":1,"window":"","field":"secure"}}"#
            ),
            Ok(Command::Focus { .. })
        ));
    }

    #[test]
    fn malformed_commands_are_refused_not_guessed() {
        for bad in [
            "stop",
            r#"{"type":"dance"}"#,
            r#"{"type":"insert","id":"1"}"#,
            r#"{"type":"record_keys"}"#,
            r#"{"type":"stop"} x"#,
            r#"{"type":"stop""#,
            r#"{"type":"focus","target":{"field":"password"}}"#,
            r#"{"type":"rebind","hotkey":"x\u00"}"#,
            r#"{"type":"insert","id":"1","text":"x","send_key":"Command+Q"}"#,
            r#"{"type":"insert","id":"1","text":"x","method":"drop"}"#,
            r#"{"type":"insert","id":"1","text":"x","restore":"no"}"#,
            "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]",
        ] {
            assert!(Command::parse(bad).is_err(), "{bad}");
        }
    }

    /// Every message the helper writes parses back as the object it meant, through the same reader
    /// the commands use, so a field name typo on either side shows up here.
    #[test]
    fn helper_lines_round_trip_through_the_reader() {
        let t = Target {
            app: "Slack".into(),
            pid: 7,
            window: "w1".into(),
            field: "editable".into(),
        };
        let started = Value::parse(&session_started("1", &t, 123_456_789_012_345_678)).unwrap();
        assert_eq!(
            started.get("type").unwrap().as_str(),
            Some("session.started")
        );
        assert_eq!(
            started.get("capture_ns").unwrap().as_str(),
            Some("123456789012345678")
        );
        assert_eq!(
            Target::from_value(started.get("target").unwrap()).unwrap(),
            t
        );
        let r = Value::parse(&ready("simulate", true, "granted", "not-needed")).unwrap();
        assert_eq!(r.get("protocol").unwrap().as_str(), Some(PROTOCOL));
        assert_eq!(r.get("swallow_keys").unwrap().as_bool(), Some(true));
        assert_eq!(
            r.get("grants")
                .unwrap()
                .get("accessibility")
                .unwrap()
                .as_str(),
            Some("not-needed")
        );
        for (l, kind) in [
            (session_ended("1", "release"), "session.ended"),
            (level(0.25), "level"),
            (key("Shift+Enter"), "key"),
            (mic(true), "mic"),
            (inserted("1", "paste", 12, None), "inserted"),
            (inserted("1", "clipboard", 0, Some("secure")), "inserted"),
            (insert_failed("1", "focus-changed"), "insert.failed"),
            (rebound("RightShift"), "rebound"),
            (
                rebind_failed("LeftOption+RightOption", "x"),
                "rebind.failed",
            ),
            (stopped("stop"), "stopped"),
            (warn("usage", "m"), "warn"),
        ] {
            let v = Value::parse(&l).unwrap();
            assert_eq!(v.get("type").unwrap().as_str(), Some(kind), "{l}");
        }
    }

    /// The lines both sides are held to, in `tests/fixtures/akou-dictate/`: every line this file
    /// writes is exactly the fixture's, and every command the app writes parses here. The Bun test
    /// `tests/dictation-protocol.test.ts` checks the same two files from the app's side, so a name
    /// changed on one side only fails one of the two.
    #[test]
    fn the_shared_fixture_lines_match_the_app() {
        let t = Target {
            app: "Slack".into(),
            pid: 7,
            window: "w1".into(),
            field: "editable".into(),
        };
        let mut written = vec![
            ready("simulate", true, "granted", "not-needed"),
            session_started("1", &t, 123_456_789_012_345_678),
            level(0.25),
            key("Shift+Enter"),
            mic(true),
        ];
        for reason in ["release", "tap", "key", "cancel", "silence", "max", "stop"] {
            written.push(session_ended("1", reason));
        }
        written.extend([
            inserted("1", "paste", 12),
            insert_failed("1", "focus-changed"),
            rebound("RightShift"),
            rebind_failed("LeftOption+RightOption", "x"),
            warn("usage", "m"),
            stopped("stop"),
        ]);
        let want: Vec<String> =
            include_str!("../../../../tests/fixtures/akou-dictate/helper-lines.jsonl")
                .lines()
                .map(|l| l.replace("@VERSION@", crate::protocol::VERSION))
                .collect();
        assert_eq!(written, want);

        let secure = Target {
            field: "secure".into(),
            ..t.clone()
        };
        let parsed: Vec<Command> =
            include_str!("../../../../tests/fixtures/akou-dictate/app-lines.jsonl")
                .lines()
                .map(|l| Command::parse(l).unwrap_or_else(|e| panic!("{l}: {e}")))
                .collect();
        assert_eq!(
            parsed,
            vec![
                Command::Rebind {
                    hotkey: "RightCommand".into(),
                    activation: Some("hold-or-toggle".into()),
                },
                Command::Insert {
                    id: "1".into(),
                    text: "hello".into(),
                    method: "paste".into(),
                    send_key: "none".into(),
                    target: Some(t),
                },
                Command::Settled { id: "1".into() },
                Command::Focus { target: secure },
                Command::SessionStart,
                Command::SessionStop,
                Command::SessionCancel,
                Command::RebuildMic {
                    device: "default".into(),
                },
                Command::Warm {
                    mode: "auto".into(),
                },
                Command::RecordKeys { on: true },
                Command::Stop,
            ]
        );
    }
}
