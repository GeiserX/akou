//! The dictate process's core: key events through `activation`, audio through `mic`, commands
//! from the app, and every `akou-dictate/1` message out. The OS parts (the key tap, the device,
//! the inserter, the accessibility read) are behind the small traits below, so the same core runs
//! under `--from-wav` with fakes and, per OS, with the real backends.

use super::activation::{Action, Activation, Mode};
use super::keys::Hotkey;
use super::mic::{Mic, MicEvent, Warm};
use super::protocol::{self as p, Command, Target};
use crate::protocol::{Ch, encode_packet};

/// Where the protocol goes: JSON lines to stderr, packets to stdout.
pub trait Out {
    fn line(&mut self, line: String);
    fn packet(&mut self, bytes: Vec<u8>);
}

/// What has the keyboard, read when a session starts (DC-N9).
pub trait Targets {
    fn target(&mut self, t_ns: u64) -> Target;
}

/// Puts text into the target app (DC-N6, DC-N7), or records that it would have.
pub trait Inserter {
    /// Returns the method used and the receipt time in ms, or why it failed.
    fn insert(
        &mut self,
        id: &str,
        text: &str,
        method: &str,
        send_key: &str,
        target: &Target,
    ) -> Result<(String, u64), String>;
    fn focus(&mut self, target: &Target);
}

pub struct Config {
    pub hotkey: Hotkey,
    pub mode: Mode,
    pub warm: Warm,
    pub bluetooth: bool,
    pub ring_ms: u64,
}

pub struct Dictate {
    act: Activation,
    mic: Mic,
    warm: Warm,
    targets: Box<dyn Targets>,
    inserter: Box<dyn Inserter>,
    next_id: u64,
    /// The live session: its id and target.
    live: Option<(String, Target)>,
    /// The last ended session, whose text the app inserts next.
    last: Option<(String, Target)>,
}

impl Dictate {
    pub fn new(cfg: Config, targets: Box<dyn Targets>, inserter: Box<dyn Inserter>) -> Dictate {
        Dictate {
            act: Activation::new(cfg.hotkey, cfg.mode),
            mic: Mic::new(cfg.warm, cfg.bluetooth, cfg.ring_ms),
            warm: cfg.warm,
            targets,
            inserter,
            next_id: 1,
            live: None,
            last: None,
        }
    }

    /// Writes `ready` and applies the warm policy (an `always` stream opens now).
    pub fn begin(
        &mut self,
        backend: &str,
        swallow_keys: bool,
        grants: (&str, &str),
        out: &mut dyn Out,
    ) {
        out.line(p::ready(backend, swallow_keys, grants.0, grants.1));
        let mut ev = Vec::new();
        self.mic.set_warm(self.warm, 0, &mut ev);
        self.mic_events(ev, out);
    }

    /// Whether the device stream should be open.
    pub fn mic_open(&self) -> bool {
        self.mic.is_open()
    }

    /// One key event from the tap; returns whether it is swallowed.
    pub fn key(&mut self, down: bool, name: &str, t_ns: u64, out: &mut dyn Out) -> bool {
        let mut acts = Vec::new();
        let swallow = self.act.key(down, name, t_ns, &mut acts);
        self.apply(acts, t_ns, out);
        swallow
    }

    pub fn tick(&mut self, t_ns: u64, out: &mut dyn Out) {
        let mut acts = Vec::new();
        self.act.tick(t_ns, &mut acts);
        self.apply(acts, t_ns, out);
        let mut ev = Vec::new();
        self.mic.tick(t_ns, &mut ev);
        self.mic_events(ev, out);
    }

    /// Mic samples, 16 kHz mono, the first at `t_ns`.
    pub fn audio(&mut self, t_ns: u64, samples: &[f32], out: &mut dyn Out) {
        let mut ev = Vec::new();
        self.mic.push(t_ns, samples, &mut ev);
        self.mic_events(ev, out);
    }

    /// One command from the app. Returns false on `stop`.
    pub fn command(&mut self, cmd: Command, t_ns: u64, out: &mut dyn Out) -> bool {
        let mut acts = Vec::new();
        match cmd {
            Command::Stop => {
                self.act.end("stop", t_ns, &mut acts);
                self.apply(acts, t_ns, out);
                return false;
            }
            Command::Rebind { hotkey, activation } => {
                let parsed = Hotkey::parse(&hotkey).and_then(|h| {
                    let mode = activation
                        .as_deref()
                        .map_or(Ok(Mode::HoldOrToggle), Mode::parse)?;
                    Ok((h, mode))
                });
                match parsed {
                    Ok((h, mode)) => {
                        self.act.rebind(h, mode, &mut acts);
                        out.line(p::rebound(&hotkey));
                    }
                    Err(e) => out.line(p::rebind_failed(&hotkey, &e)),
                }
            }
            Command::Insert {
                id,
                text,
                method,
                send_key,
                target,
            } => {
                self.act.insert_started(t_ns);
                let target = target
                    .or_else(|| {
                        self.last
                            .as_ref()
                            .filter(|(l, _)| *l == id)
                            .map(|(_, t)| t.clone())
                    })
                    .unwrap_or_else(Target::unknown);
                match self
                    .inserter
                    .insert(&id, &text, &method, &send_key, &target)
                {
                    Ok((m, ms)) => out.line(p::inserted(&id, &m, ms)),
                    Err(reason) => out.line(p::insert_failed(&id, &reason)),
                }
                self.act.settled();
            }
            Command::Settled { .. } => self.act.settled(),
            Command::Focus { target } => self.inserter.focus(&target),
            Command::SessionStart => self.act.start(t_ns, &mut acts),
            Command::SessionStop => self.act.end("tap", t_ns, &mut acts),
            Command::SessionCancel => self.act.end("cancel", t_ns, &mut acts),
            Command::Warm { mode } => match Warm::parse(&mode) {
                Ok(w) => {
                    self.warm = w;
                    let mut ev = Vec::new();
                    self.mic.set_warm(w, t_ns, &mut ev);
                    self.mic_events(ev, out);
                }
                Err(e) => out.line(p::warn("bad-command", &e)),
            },
            Command::RecordKeys { on } => self.act.record_keys(on),
            // The device is chosen per OS (DC-N5); a file mic has nothing to rebuild.
            Command::RebuildMic { .. } => {}
        }
        self.apply(acts, t_ns, out);
        true
    }

    fn apply(&mut self, acts: Vec<Action>, t_ns: u64, out: &mut dyn Out) {
        for a in acts {
            let mut ev = Vec::new();
            match a {
                Action::Arm { t_ns: at } => self.mic.arm(at, &mut ev),
                Action::Disarm => self.mic.disarm(t_ns, &mut ev),
                Action::Start { t_ns: at } => {
                    let id = self.next_id.to_string();
                    self.next_id += 1;
                    self.live = Some((id, self.targets.target(at)));
                    self.mic.start(at, &mut ev);
                }
                Action::End { reason } => self.mic.end(t_ns, reason, &mut ev),
                Action::Key(name) => out.line(p::key(&name)),
            }
            self.mic_events(ev, out);
        }
    }

    fn mic_events(&mut self, ev: Vec<MicEvent>, out: &mut dyn Out) {
        for e in ev {
            match e {
                MicEvent::Stream(open) => out.line(p::mic(open)),
                MicEvent::Started { capture_ns } => {
                    if let Some((id, target)) = &self.live {
                        out.line(p::session_started(id, target, capture_ns));
                    }
                }
                MicEvent::Audio {
                    capture_ns,
                    file_seconds,
                    samples,
                } => {
                    let mut bytes = Vec::new();
                    encode_packet(
                        &mut bytes,
                        Ch::Mic,
                        false,
                        capture_ns,
                        file_seconds,
                        &samples,
                    );
                    out.packet(bytes);
                }
                MicEvent::Level(rms) => out.line(p::level(rms)),
                MicEvent::Ended { reason } => {
                    if let Some((id, target)) = self.live.take() {
                        out.line(p::session_ended(&id, reason));
                        self.last = Some((id, target));
                    }
                }
                MicEvent::Vanished => {
                    self.live = None;
                    self.act.settled();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::decode_packets;
    use std::cell::RefCell;
    use std::rc::Rc;

    const MS: u64 = 1_000_000;

    #[derive(Default)]
    struct Rec {
        lines: Vec<String>,
        packets: Vec<u8>,
    }
    impl Out for Rec {
        fn line(&mut self, line: String) {
            self.lines.push(line);
        }
        fn packet(&mut self, bytes: Vec<u8>) {
            self.packets.extend(bytes);
        }
    }

    struct Fixed(Target);
    impl Targets for Fixed {
        fn target(&mut self, _: u64) -> Target {
            self.0.clone()
        }
    }

    type Log = Rc<RefCell<Vec<(String, String, Target)>>>;
    struct Recorder(Log);
    impl Inserter for Recorder {
        fn insert(
            &mut self,
            id: &str,
            text: &str,
            method: &str,
            _: &str,
            target: &Target,
        ) -> Result<(String, u64), String> {
            self.0
                .borrow_mut()
                .push((id.into(), text.into(), target.clone()));
            Ok((method.into(), 0))
        }
        fn focus(&mut self, _: &Target) {}
    }

    fn slack() -> Target {
        Target {
            app: "Slack".into(),
            pid: 9,
            window: "w".into(),
            field: "editable".into(),
        }
    }

    fn dictate(log: &Log) -> Dictate {
        Dictate::new(
            Config {
                hotkey: Hotkey::parse("RightCommand").unwrap(),
                mode: Mode::HoldOrToggle,
                warm: Warm::Always,
                bluetooth: false,
                ring_ms: 500,
            },
            Box::new(Fixed(slack())),
            Box::new(Recorder(log.clone())),
        )
    }

    /// Runs `ms` of a constant mic signal through the core in 10 ms steps from `from`.
    fn run(d: &mut Dictate, out: &mut Rec, from: u64, to: u64) {
        for ms in (from..to).step_by(10) {
            if d.mic_open() {
                d.audio(ms * MS, &[0.1; 160], out);
            }
            d.tick(ms * MS, out);
        }
    }

    fn types(out: &Rec) -> Vec<String> {
        out.lines
            .iter()
            .map(|l| {
                p::Value::parse(l)
                    .unwrap()
                    .get("type")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .filter(|t| t != "level")
            .collect()
    }

    /// A push-to-talk press end to end: `ready`, the warm stream, `session.started` with the
    /// target, packets covering the ring through the post-roll, `session.ended`, then the app's
    /// `insert` reaching the inserter with that target and answered by `inserted`.
    #[test]
    fn a_hold_runs_one_session_and_its_insert_goes_to_the_captured_target() {
        let log: Log = Rc::default();
        let mut d = dictate(&log);
        let mut out = Rec::default();
        d.begin("simulate", true, ("granted", "granted"), &mut out);
        run(&mut d, &mut out, 0, 1000);
        assert!(!d.key(true, "RightCommand", 1000 * MS, &mut out));
        run(&mut d, &mut out, 1000, 2000);
        assert!(!d.key(false, "RightCommand", 2000 * MS, &mut out));
        run(&mut d, &mut out, 2000, 2500);
        assert_eq!(
            types(&out),
            ["ready", "mic", "session.started", "session.ended"]
        );
        assert!(
            out.lines[2].contains(r#""target":{"app":"Slack""#),
            "{}",
            out.lines[2]
        );
        assert!(
            out.lines[2].contains(r#""capture_ns":"500000000""#),
            "{}",
            out.lines[2]
        );
        let ended = out
            .lines
            .iter()
            .find(|l| l.contains("session.ended"))
            .unwrap();
        assert!(ended.contains(r#""id":"1","reason":"release""#), "{ended}");
        let (packets, _) = decode_packets(&out.packets).unwrap();
        let frames: usize = packets.iter().map(|p| p.samples.len()).sum();
        assert_eq!(frames, (2250 - 500) * 16, "ring + hold + post-roll");
        assert!(packets.iter().all(|p| p.ch == Ch::Mic));
        assert_eq!(packets[0].file_seconds, 0.0);

        // Enter before the insert settles is swallowed (DC-A4), then the insert lands.
        assert!(d.key(true, "Enter", 2600 * MS, &mut out));
        let cmd = Command::parse(r#"{"type":"insert","id":"1","text":"hello","method":"paste"}"#)
            .unwrap();
        assert!(d.command(cmd, 2700 * MS, &mut out));
        assert_eq!(
            log.borrow().as_slice(),
            &[("1".into(), "hello".into(), slack())]
        );
        assert!(out.lines.last().unwrap().contains(r#""type":"inserted""#));
        assert!(
            !d.key(true, "Escape", 2800 * MS, &mut out),
            "settled: keys pass again"
        );
    }

    #[test]
    fn rebind_answers_and_a_refused_binding_keeps_the_old_one() {
        let log: Log = Rc::default();
        let mut d = dictate(&log);
        let mut out = Rec::default();
        let bad = Command::parse(r#"{"type":"rebind","hotkey":"LeftOption+RightOption"}"#).unwrap();
        d.command(bad, 0, &mut out);
        assert!(out.lines[0].contains("rebind.failed"), "{}", out.lines[0]);
        d.key(true, "RightCommand", 0, &mut out);
        d.key(false, "RightCommand", 100 * MS, &mut out);
        run(&mut d, &mut out, 0, 200);
        assert!(
            types(&out).contains(&"session.started".to_string()),
            "old key still works"
        );
        let good = Command::parse(r#"{"type":"rebind","hotkey":"RightShift","activation":"hold"}"#)
            .unwrap();
        d.command(good, 300 * MS, &mut out);
        assert!(out.lines.last().unwrap().contains(r#""type":"rebound""#));
    }

    /// The tray's and the CLI's door: `session.start` then `session.stop` is one latched session;
    /// `stop` ends a live session at once and says so.
    #[test]
    fn the_session_commands_drive_a_session_and_stop_ends_it() {
        let log: Log = Rc::default();
        let mut d = dictate(&log);
        let mut out = Rec::default();
        d.begin("simulate", true, ("granted", "granted"), &mut out);
        run(&mut d, &mut out, 0, 100);
        d.command(Command::SessionStart, 100 * MS, &mut out);
        run(&mut d, &mut out, 100, 300);
        d.command(Command::SessionStop, 300 * MS, &mut out);
        run(&mut d, &mut out, 300, 700);
        d.command(Command::Settled { id: "1".into() }, 700 * MS, &mut out);
        d.command(Command::SessionStart, 800 * MS, &mut out);
        run(&mut d, &mut out, 800, 900);
        assert!(!d.command(Command::Stop, 900 * MS, &mut out));
        let ended: Vec<&String> = out
            .lines
            .iter()
            .filter(|l| l.contains("session.ended"))
            .collect();
        assert_eq!(ended.len(), 2);
        assert!(
            ended[0].contains(r#""id":"1","reason":"tap""#),
            "{}",
            ended[0]
        );
        assert!(
            ended[1].contains(r#""id":"2","reason":"stop""#),
            "{}",
            ended[1]
        );
    }
}
