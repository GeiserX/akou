//! The dictate process's core: key events through `activation`, audio through `mic`, commands
//! from the app, and every `akou-dictate/1` message out. The OS parts (the key tap, the device,
//! the inserter, the accessibility read) are behind the small traits below, so the same core runs
//! under `--from-wav` with fakes and, per OS, with the real backends.
//!
//! Two threads share it (DC-N1). The tap thread holds a `tap::Gate` and only decides
//! swallow-or-pass; everything else (the mic, the insert, the accessibility reads, every line
//! out) runs here, on the worker, which takes the tap's queue under the gate's lock before each
//! of its own activation steps and carries it out after the lock is released. So a stalled
//! insert or a slow field read never delays the tap's answer.

use super::activation::{Action, Activation, Mode};
use super::globe::Globe;
use super::inputs::{Choice, Transport};
pub use super::insert::Targets;
use super::insert::{Captured, Inserter, Os, Outcome, QUIET_MS, Request, is_terminal};
use super::keys::Hotkey;
use super::media::Media;
use super::mic::{Mic, MicEvent, Warm};
use super::protocol::{self as p, Command, Target};
use super::readback::Watch;
use super::tap::{Gate, Note, TapEvent};
use crate::protocol::{Ch, encode_packet};

const MS: u64 = 1_000_000;
/// How often Secure Input is polled for `secure_input {on}`.
pub const SECURE_POLL_MS: u64 = 250;

/// Where the protocol goes: JSON lines to stderr, packets to stdout.
pub trait Out {
    fn line(&mut self, line: String);
    fn packet(&mut self, bytes: Vec<u8>);
}

pub struct Config {
    pub hotkey: Hotkey,
    pub mode: Mode,
    pub warm: Warm,
    pub bluetooth: bool,
    pub ring_ms: u64,
    pub os: Os,
}

/// An insert the app asked to read back (DC-L2), until its outcome.
struct Reading {
    id: String,
    text: String,
    target: Target,
    secure_input: bool,
}

pub struct Dictate {
    gate: Gate,
    os: Os,
    mic: Mic,
    warm: Warm,
    /// The device the stream opened on, which `session.started` reports (DC-N5).
    device: Option<Choice>,
    /// The dictation key now, and the Globe action it may own (DC-N2, macOS only).
    hotkey: Hotkey,
    globe: Option<Globe>,
    targets: Box<dyn Targets>,
    /// None: this process has no inserter (a simulate run without `--inserter`), never a real one.
    inserter: Option<Inserter>,
    next_id: u64,
    /// The live session: its id and what it saw at key-down.
    live: Option<(String, Captured)>,
    /// The last ended session, whose text the app inserts next.
    last: Option<(String, Captured)>,
    /// The Accessibility grant as `ready` reported it, until `grant.lost`.
    accessibility: String,
    secure_on: bool,
    next_secure_poll: u64,
    reading: Option<Reading>,
    /// A typed insert has no receipt: its snapshot waits `QUIET_MS` for the app to take the
    /// events, as a paste's waits for the quiet after the last read.
    snapshot_at: Option<(Reading, u64)>,
    watch: Option<Watch>,
    /// The OS's media players (DC-U8); none where the backend has no way to reach them.
    media: Option<Box<dyn Media>>,
    /// `pause_media {on}`: `dictation.muteMedia`, off until the app turns it on.
    pause_media: bool,
    /// A session paused the players and they have not been given back yet.
    media_held: bool,
}

impl Dictate {
    pub fn new(cfg: Config, targets: Box<dyn Targets>, inserter: Option<Inserter>) -> Dictate {
        Dictate {
            hotkey: cfg.hotkey.clone(),
            globe: None,
            gate: Gate::new(Activation::new(cfg.hotkey, cfg.mode), cfg.os),
            os: cfg.os,
            mic: Mic::new(cfg.warm, cfg.bluetooth, cfg.ring_ms),
            warm: cfg.warm,
            device: None,
            targets,
            inserter,
            next_id: 1,
            live: None,
            last: None,
            accessibility: "not-needed".into(),
            secure_on: false,
            next_secure_poll: 0,
            reading: None,
            snapshot_at: None,
            watch: None,
            media: None,
            pause_media: false,
            media_held: false,
        }
    }

    /// The tap thread's handle (DC-N1).
    pub fn gate(&self) -> Gate {
        self.gate.clone()
    }

    /// The backend owns the Fn key's own action while Fn is the dictation key (DC-N2).
    pub fn set_globe(&mut self, globe: Globe) {
        self.globe = Some(globe);
    }

    /// The OS's media players, which a session pauses while `pause_media` is on (DC-U8).
    pub fn set_media(&mut self, media: Box<dyn Media>) {
        self.media = Some(media);
    }

    /// A session starts: the players that play now are paused, if the app asked for it.
    fn media_pause(&mut self) {
        if self.pause_media
            && let Some(m) = self.media.as_mut()
        {
            m.pause();
            self.media_held = true;
        }
    }

    /// The session ended, or the setting went off: what akou paused plays again.
    fn media_resume(&mut self) {
        if self.media_held
            && let Some(m) = self.media.as_mut()
        {
            m.resume();
        }
        self.media_held = false;
    }

    /// Writes `ready` and applies the warm policy (an `always` stream opens now).
    pub fn begin(
        &mut self,
        backend: &str,
        swallow_keys: bool,
        grants: (&str, &str),
        out: &mut dyn Out,
    ) {
        // Before `ready`, so a helper that says it is ready owns the Fn key's action (DC-N2).
        if let Some(g) = self.globe.as_mut() {
            g.follow(&self.hotkey);
        }
        self.gate.lock().act.set_swallows(swallow_keys);
        out.line(p::ready(backend, swallow_keys, grants.0, grants.1));
        self.accessibility = grants.1.to_string();
        let mut ev = Vec::new();
        self.mic.set_warm(self.warm, 0, &mut ev);
        self.mic_events(ev, out);
    }

    /// The device the stream just opened on (DC-N5): a Bluetooth one is never kept warm (DC-N4),
    /// and the next `session.started` names its transport and why it was chosen.
    pub fn set_mic(&mut self, device: Choice, t_ns: u64, out: &mut dyn Out) {
        let bluetooth = device.transport == Transport::Bluetooth;
        self.device = Some(device);
        let mut ev = Vec::new();
        self.mic.set_bluetooth(bluetooth, t_ns, &mut ev);
        self.mic_events(ev, out);
    }

    /// Whether the device stream should be open.
    pub fn mic_open(&self) -> bool {
        self.mic.is_open()
    }

    /// A paste is waiting for its receipt, so time must keep passing.
    pub fn busy(&self) -> bool {
        self.inserter.as_ref().is_some_and(Inserter::busy)
    }

    /// One activation step on the worker: the tap's queue first, then `f`'s own actions, all
    /// taken under the lock and carried out after it is released.
    fn act<R>(
        &mut self,
        t_ns: u64,
        out: &mut dyn Out,
        f: impl FnOnce(&mut Activation, &mut Vec<Action>) -> R,
    ) -> R {
        let (r, queued) = {
            let mut s = self.gate.lock();
            let mut queued = std::mem::take(&mut s.queue);
            let mut acts = Vec::new();
            let r = f(&mut s.act, &mut acts);
            queued.extend(acts.into_iter().map(|a| (t_ns, Note::Act(a))));
            (r, queued)
        };
        self.apply(queued, out);
        r
    }

    /// Carries out what the tap queued since the last step.
    pub fn pump(&mut self, t_ns: u64, out: &mut dyn Out) {
        self.act(t_ns, out, |_, _| ());
    }

    /// One key event, tap and worker on one thread (the simulate run and the tests); returns
    /// whether it is swallowed.
    pub fn key(&mut self, down: bool, name: &str, t_ns: u64, out: &mut dyn Out) -> bool {
        let v = self.gate.event(TapEvent::Key { down, name, t_ns });
        self.pump(t_ns, out);
        v.swallow
    }

    /// The machine woke, or a session could not start: a grant present at `ready` may be gone
    /// (revoked, or reset by a re-signed build), which silently kills the tap. Asks the
    /// non-prompting check and says `grant.lost` once.
    pub fn recheck_grant(&mut self, out: &mut dyn Out) {
        if self.accessibility == "granted" && !self.targets.trusted() {
            self.accessibility = "denied".into();
            out.line(p::grant_lost("accessibility"));
        }
    }

    pub fn tick(&mut self, t_ns: u64, out: &mut dyn Out) {
        self.act(t_ns, out, |a, acts| a.tick(t_ns, acts));
        let mut ev = Vec::new();
        self.mic.tick(t_ns, &mut ev);
        self.mic_events(ev, out);
        let mut done = Vec::new();
        if let Some(ins) = self.inserter.as_mut() {
            ins.tick(t_ns, &mut done);
        }
        self.report(done, t_ns, out);
        if t_ns >= self.next_secure_poll {
            self.next_secure_poll = t_ns + SECURE_POLL_MS * MS;
            let on = self.targets.secure_input();
            if on != self.secure_on {
                self.secure_on = on;
                out.line(p::secure_input(on));
            }
        }
        if let Some((r, _)) = self.snapshot_at.take_if(|(_, at)| t_ns >= *at) {
            self.start_watch(r, t_ns, out);
        }
        if let Some(w) = self.watch.as_mut() {
            let left = w.poll_due(t_ns) && {
                let (a, b) = (self.targets.target(t_ns), &w.target);
                (a.app.as_str(), a.pid, a.window.as_str()) != (b.app.as_str(), b.pid, &b.window)
            };
            if left || w.expired(t_ns) {
                self.finish_watch(out);
            }
        }
    }

    /// `inserted` or `insert.failed`; the session's keys pass again once its insert settled, and
    /// an insert the app asked to read back takes its snapshot.
    fn report(&mut self, done: Vec<(String, Outcome)>, t_ns: u64, out: &mut dyn Out) {
        for (id, o) in done {
            out.line(match &o {
                Outcome::Inserted {
                    method,
                    receipt_ms,
                    reason,
                } => p::inserted(&id, method, *receipt_ms, *reason),
                Outcome::Failed(reason) => p::insert_failed(&id, reason),
            });
            if self.last.as_ref().is_some_and(|(l, _)| *l == id) {
                self.act(t_ns, out, |a, _| a.settled());
            }
            let Some(r) = self.reading.take_if(|r| r.id == id) else {
                continue;
            };
            match o {
                Outcome::Inserted {
                    method: "paste",
                    reason: None,
                    ..
                } => self.start_watch(r, t_ns, out),
                Outcome::Inserted {
                    method: "type",
                    reason: None,
                    ..
                } => self.snapshot_at = Some((r, t_ns + QUIET_MS * MS)),
                _ => {}
            }
        }
    }

    /// DC-L2's snapshot. Every insert the app asked to read back that landed gets exactly one
    /// `edit` or `edit.unreadable`; this one says `not-read` where the helper will not read.
    fn start_watch(&mut self, r: Reading, t_ns: u64, out: &mut dyn Out) {
        let readable = self.accessibility != "denied"
            && r.target.field == "editable"
            && !r.secure_input
            && !self.targets.secure_input()
            && !is_terminal(self.os, &r.target.app);
        if !readable {
            out.line(p::edit_unreadable(&r.id, "not-read"));
            return;
        }
        let field = self.targets.read_field(&r.target);
        match Watch::start(&r.id, &r.text, r.target, field, t_ns) {
            Ok(w) => self.watch = Some(w),
            Err(reason) => out.line(p::edit_unreadable(&r.id, reason)),
        }
    }

    /// DC-L2's second read, and the hunks out.
    fn finish_watch(&mut self, out: &mut dyn Out) {
        let Some(w) = self.watch.take() else { return };
        let field = self.targets.read_field(&w.target);
        out.line(match w.finish(field) {
            Ok(hunks) => p::edit(&w.id, &hunks),
            Err(reason) => p::edit_unreadable(&w.id, reason),
        });
    }

    /// Mic samples, 16 kHz mono, the first at `t_ns`.
    pub fn audio(&mut self, t_ns: u64, samples: &[f32], out: &mut dyn Out) {
        let mut ev = Vec::new();
        self.mic.push(t_ns, samples, &mut ev);
        self.mic_events(ev, out);
    }

    /// One command from the app. Returns false on `stop`.
    pub fn command(&mut self, cmd: Command, t_ns: u64, out: &mut dyn Out) -> bool {
        match cmd {
            Command::Stop => {
                if let Some(g) = self.globe.as_mut() {
                    g.release();
                }
                self.act(t_ns, out, |a, acts| a.end("stop", t_ns, acts));
                // A session in its post-roll ends now too, and says so.
                let mut ev = Vec::new();
                self.mic.end(t_ns, "stop", &mut ev);
                self.mic_events(ev, out);
                let mut done = Vec::new();
                if let Some(ins) = self.inserter.as_mut() {
                    ins.finish(t_ns, &mut done);
                }
                self.report(done, t_ns, out);
                self.watch = None;
                self.snapshot_at = None;
                self.media_resume();
                if let Some(m) = self.media.as_mut() {
                    m.finish();
                }
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
                        if let Some(g) = self.globe.as_mut() {
                            g.follow(&h);
                        }
                        self.hotkey = h.clone();
                        self.act(t_ns, out, |a, acts| a.rebind(h, mode, acts));
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
                restore,
                read_field,
            } => {
                // A paste still waiting settles first, so its answer (and its read-back) is not
                // lost when this insert takes the slot.
                let mut done = Vec::new();
                if let Some(ins) = self.inserter.as_mut() {
                    ins.finish(t_ns, &mut done);
                }
                self.report(done, t_ns, out);
                // A field still watched is read now: the new text is about to land.
                if let Some((r, _)) = self.snapshot_at.take() {
                    self.start_watch(r, t_ns, out);
                }
                self.finish_watch(out);
                // Only the session's own insert holds the keys; a stale id must not restart the
                // swallow window, as only the session's own answer settles it.
                if self.last.as_ref().is_some_and(|(l, _)| *l == id) {
                    self.act(t_ns, out, |a, _| a.insert_started(t_ns));
                }
                // The session's own record, with the app's target when it names one (the draft
                // box inserts where the session began).
                let mut cap = self.last.as_ref().filter(|(l, _)| *l == id).map_or_else(
                    || Captured {
                        target: Target::unknown(),
                        secure_input: false,
                    },
                    |(_, c)| c.clone(),
                );
                if let Some(t) = target {
                    cap.target = t;
                }
                self.reading = read_field.then(|| Reading {
                    id: id.clone(),
                    text: text.clone(),
                    target: cap.target.clone(),
                    secure_input: cap.secure_input,
                });
                let req = Request {
                    id: id.clone(),
                    text,
                    method,
                    send_key,
                    restore,
                };
                let mut done = Vec::new();
                match self.inserter.as_mut() {
                    Some(ins) => ins.insert(&req, &cap, &mut *self.targets, t_ns, &mut done),
                    None => done.push((id, Outcome::Failed("no-inserter".into()))),
                }
                self.report(done, t_ns, out);
            }
            Command::Settled { .. } => self.act(t_ns, out, |a, _| a.settled()),
            Command::Focus { target } => self.targets.focus(&target),
            Command::SessionStart => self.act(t_ns, out, |a, acts| a.start(t_ns, acts)),
            Command::SessionStop => self.act(t_ns, out, |a, acts| a.end("tap", t_ns, acts)),
            Command::SessionCancel => self.act(t_ns, out, |a, acts| a.end("cancel", t_ns, acts)),
            Command::Warm { mode } => match Warm::parse(&mode) {
                Ok(w) => {
                    self.warm = w;
                    let mut ev = Vec::new();
                    self.mic.set_warm(w, t_ns, &mut ev);
                    self.mic_events(ev, out);
                }
                Err(e) => out.line(p::warn("bad-command", &e)),
            },
            Command::RecordKeys { on } => self.act(t_ns, out, |a, _| a.record_keys(on)),
            Command::PauseMedia { on } => {
                self.pause_media = on;
                if !on {
                    self.media_resume();
                }
            }
            // The device is chosen per OS (DC-N5); a file mic has nothing to rebuild.
            Command::RebuildMic { .. } => {}
        }
        self.pump(t_ns, out);
        true
    }

    fn apply(&mut self, notes: Vec<(u64, Note)>, out: &mut dyn Out) {
        for (t_ns, note) in notes {
            let mut ev = Vec::new();
            match note {
                Note::Act(Action::Arm { t_ns: at }) => self.mic.arm(at, &mut ev),
                Note::Act(Action::Disarm) => self.mic.disarm(t_ns, &mut ev),
                Note::Act(Action::Start { t_ns: at }) => {
                    let id = self.next_id.to_string();
                    self.next_id += 1;
                    let cap = Captured {
                        target: self.targets.target(at),
                        secure_input: self.targets.secure_input(),
                    };
                    self.live = Some((id, cap));
                    self.mic.start(at, &mut ev);
                    self.media_pause();
                }
                Note::Act(Action::End { reason }) => self.mic.end(t_ns, reason, &mut ev),
                Note::Act(Action::Key(name)) => out.line(p::key(&name)),
                Note::Commit => self.finish_watch(out),
                Note::Disabled => self.recheck_grant(out),
            }
            self.mic_events(ev, out);
        }
    }

    fn mic_events(&mut self, ev: Vec<MicEvent>, out: &mut dyn Out) {
        for e in ev {
            match e {
                MicEvent::Stream(open) => out.line(p::mic(open)),
                MicEvent::Started { capture_ns } => {
                    if let Some((id, cap)) = &self.live {
                        out.line(p::session_started(
                            id,
                            &cap.target,
                            capture_ns,
                            self.device.as_ref(),
                        ));
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
                    self.media_resume();
                    if let Some((id, cap)) = self.live.take() {
                        out.line(p::session_ended(&id, reason));
                        self.last = Some((id, cap));
                    }
                }
                MicEvent::Vanished => {
                    self.media_resume();
                    self.live = None;
                    self.act(0, out, |a, _| a.settled());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictate::fake::{Board, Keys, Screen, Shared, World};
    use crate::dictate::readback::Field;
    use crate::protocol::decode_packets;

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

    fn dictate(w: &Shared) -> Dictate {
        Dictate::new(
            Config {
                hotkey: Hotkey::parse("RightCommand").unwrap(),
                mode: Mode::HoldOrToggle,
                warm: Warm::Always,
                bluetooth: false,
                ring_ms: 500,
                os: Os::Mac,
            },
            Box::new(Screen(w.clone())),
            Some(Inserter::new(
                Os::Mac,
                Box::new(Board(w.clone())),
                Box::new(Keys(w.clone())),
            )),
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

    /// `ready` with `swallow_keys` false (evdev) makes Escape and Enter plain keys during a
    /// session (DC-A4): not swallowed, not reported, and the session runs on to the hotkey. The
    /// test above, with `swallow_keys` true, is the control.
    #[test]
    fn without_swallow_keys_enter_neither_ends_nor_is_reported() {
        let w = World::new();
        let mut d = dictate(&w);
        let mut out = Rec::default();
        d.begin("evdev", false, ("granted", "granted"), &mut out);
        run(&mut d, &mut out, 0, 1000);
        d.key(true, "RightCommand", 1000 * MS, &mut out);
        d.key(false, "RightCommand", 1100 * MS, &mut out);
        run(&mut d, &mut out, 1100, 1500);
        assert!(!d.key(true, "Enter", 1500 * MS, &mut out));
        assert!(!d.key(false, "Enter", 1510 * MS, &mut out));
        assert!(!d.key(true, "Escape", 1600 * MS, &mut out));
        assert!(!d.key(false, "Escape", 1610 * MS, &mut out));
        run(&mut d, &mut out, 1610, 2000);
        assert_eq!(types(&out), ["ready", "mic", "session.started"]);
        d.key(true, "RightCommand", 2000 * MS, &mut out);
        d.key(false, "RightCommand", 2100 * MS, &mut out);
        run(&mut d, &mut out, 2100, 2500);
        let ended = out
            .lines
            .iter()
            .find(|l| l.contains("session.ended"))
            .unwrap();
        assert!(ended.contains(r#""reason":"tap""#), "{ended}");
    }

    /// A push-to-talk press end to end: `ready`, the warm stream, `session.started` with the
    /// target, packets covering the ring through the post-roll, `session.ended`, then the app's
    /// `insert` reaching the inserter with that target and answered by `inserted`.
    #[test]
    fn a_hold_runs_one_session_and_its_insert_goes_to_the_captured_target() {
        let w = World::new();
        let mut d = dictate(&w);
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

        // Enter before the insert settles is swallowed (DC-A4); the paste is posted to Slack,
        // and Enter stays swallowed until the target read the clipboard.
        assert!(d.key(true, "Enter", 2600 * MS, &mut out));
        d.key(false, "Enter", 2610 * MS, &mut out);
        let cmd = Command::parse(
            r#"{"type":"insert","id":"1","text":"hello","method":"paste","send_key":"Enter"}"#,
        )
        .unwrap();
        assert!(d.command(cmd, 2700 * MS, &mut out));
        assert_eq!(w.borrow().posted, ["Command+Code(9)"]);
        assert!(d.busy());
        run(&mut d, &mut out, 2700, 3000);
        assert!(
            d.key(true, "Escape", 3000 * MS, &mut out),
            "not settled yet"
        );
        d.key(false, "Escape", 3010 * MS, &mut out);
        w.borrow_mut().pending_reads.push(3000 * MS);
        run(&mut d, &mut out, 3010, 3300);
        assert!(!d.busy());
        assert!(
            out.lines
                .iter()
                .any(|l| l == r#"{"type":"inserted","id":"1","method":"paste","receipt_ms":300}"#),
            "{:?}",
            out.lines
        );
        assert_eq!(
            w.borrow().posted,
            ["Command+Code(9)", "Named(\"Return\")"],
            "the send key after the read"
        );
        assert!(
            !d.key(true, "Escape", 3400 * MS, &mut out),
            "settled: keys pass again"
        );
    }

    /// DC-N9 through the core: the session captured Slack; the insert comes while Mail has the
    /// keyboard, so nothing is posted and the app hears why. DC-N8: a session that began under
    /// Secure Input goes to the clipboard.
    #[test]
    fn the_insert_goes_where_the_session_began_or_nowhere() {
        let w = World::new();
        let mut d = dictate(&w);
        let mut out = Rec::default();
        d.begin("simulate", true, ("granted", "granted"), &mut out);
        d.command(Command::SessionStart, 0, &mut out);
        run(&mut d, &mut out, 0, 100);
        d.command(Command::SessionStop, 100 * MS, &mut out);
        run(&mut d, &mut out, 100, 400);
        w.borrow_mut().target.app = "Mail".into();
        let insert = r#"{"type":"insert","id":"1","text":"hi","send_key":"Enter"}"#;
        d.command(Command::parse(insert).unwrap(), 400 * MS, &mut out);
        assert!(w.borrow().posted.is_empty());
        assert_eq!(
            out.lines.last().unwrap(),
            r#"{"type":"insert.failed","id":"1","reason":"focus-changed"}"#
        );
        let focus =
            r#"{"type":"focus","target":{"app":"Slack","pid":9,"window":"w","field":"editable"}}"#;
        d.command(Command::parse(focus).unwrap(), 500 * MS, &mut out);
        d.command(Command::parse(insert).unwrap(), 600 * MS, &mut out);
        assert_eq!(
            w.borrow().posted,
            ["Command+Code(9)"],
            "after focus it lands"
        );

        let w = World::new();
        w.borrow_mut().secure_input = true;
        let mut d = dictate(&w);
        let mut out = Rec::default();
        d.command(Command::SessionStart, 0, &mut out);
        w.borrow_mut().secure_input = false;
        run(&mut d, &mut out, 0, 100);
        d.command(Command::SessionStop, 100 * MS, &mut out);
        run(&mut d, &mut out, 100, 400);
        d.command(Command::parse(insert).unwrap(), 400 * MS, &mut out);
        assert!(w.borrow().posted.is_empty());
        assert_eq!(
            out.lines.last().unwrap(),
            r#"{"type":"inserted","id":"1","method":"clipboard","receipt_ms":0,"reason":"secure"}"#
        );
    }

    /// `stop` during the post-roll still ends the session, and a paste still waiting settles.
    #[test]
    fn stop_in_the_post_roll_ends_the_session() {
        let w = World::new();
        let mut d = dictate(&w);
        let mut out = Rec::default();
        d.begin("simulate", true, ("granted", "granted"), &mut out);
        run(&mut d, &mut out, 0, 600);
        d.key(true, "RightCommand", 600 * MS, &mut out);
        run(&mut d, &mut out, 600, 1200);
        d.key(false, "RightCommand", 1200 * MS, &mut out);
        run(&mut d, &mut out, 1200, 1300);
        assert!(!types(&out).contains(&"session.ended".to_string()));
        assert!(!d.command(Command::Stop, 1300 * MS, &mut out));
        assert!(
            out.lines
                .iter()
                .any(|l| l.contains(r#""type":"session.ended","id":"1","reason":"stop""#)),
            "{:?}",
            out.lines
        );
    }

    #[test]
    fn rebind_answers_and_a_refused_binding_keeps_the_old_one() {
        let w = World::new();
        let mut d = dictate(&w);
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
        let w = World::new();
        let mut d = dictate(&w);
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

    /// DC-N1: the tap answers while the worker is stuck inside an insert. The fake sink blocks in
    /// the paste chord until the test lets it go; meanwhile a key reaches the gate on another
    /// thread and must be answered (Escape, swallowed: the insert has not settled). The 10 s
    /// limit only turns a hang into a failure; it is not a speed bound.
    #[test]
    fn dc_n1_a_stalled_inserter_does_not_delay_the_taps_answer() {
        use crate::dictate::insert::{Key, Sink};
        use std::sync::mpsc;
        use std::time::Duration;

        struct Stall {
            stalled: mpsc::Sender<()>,
            release: mpsc::Receiver<()>,
        }
        impl Sink for Stall {
            fn held_modifiers(&mut self) -> Vec<String> {
                Vec::new()
            }
            fn modifier(&mut self, _: &str, _: bool) -> Result<(), String> {
                Ok(())
            }
            fn press(&mut self, _: &[&str], _: Key) -> Result<(), String> {
                self.stalled.send(()).unwrap();
                self.release.recv().unwrap();
                Ok(())
            }
            fn keycode(&mut self, _: char) -> Option<u16> {
                Some(9)
            }
            fn type_text(&mut self, _: &str) -> Result<(), String> {
                Ok(())
            }
        }

        let (gate_tx, gate_rx) = mpsc::channel();
        let (stalled_tx, stalled_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let w = World::new();
            let sink = Stall {
                stalled: stalled_tx,
                release: release_rx,
            };
            let mut d = Dictate::new(
                Config {
                    hotkey: Hotkey::parse("RightCommand").unwrap(),
                    mode: Mode::HoldOrToggle,
                    warm: Warm::Always,
                    bluetooth: false,
                    ring_ms: 500,
                    os: Os::Mac,
                },
                Box::new(Screen(w.clone())),
                Some(Inserter::new(
                    Os::Mac,
                    Box::new(Board(w.clone())),
                    Box::new(sink),
                )),
            );
            let mut out = Rec::default();
            gate_tx.send(d.gate()).unwrap();
            d.command(Command::SessionStart, 0, &mut out);
            run(&mut d, &mut out, 0, 100);
            d.command(Command::SessionStop, 100 * MS, &mut out);
            run(&mut d, &mut out, 100, 400);
            let insert = r#"{"type":"insert","id":"1","text":"hi"}"#;
            d.command(Command::parse(insert).unwrap(), 400 * MS, &mut out);
        });
        let gate = gate_rx.recv().unwrap();
        stalled_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the insert reached the sink");
        let (answer_tx, answer_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let v = gate.event(TapEvent::Key {
                down: true,
                name: "Escape",
                t_ns: 500 * MS,
            });
            answer_tx.send(v).unwrap();
        });
        let v = answer_rx.recv_timeout(Duration::from_secs(10));
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        let v = v.expect("the tap answered while the insert was stalled");
        assert!(
            v.swallow,
            "the insert has not settled: Escape is still dictation's"
        );
    }

    /// DC-N1: a grant present at `ready` that the non-prompting check no longer confirms is
    /// `grant.lost`, once, on wake or when the tap was disabled; a grant never given is never
    /// lost (positive control).
    #[test]
    fn dc_n1_a_trust_check_turning_false_is_grant_lost_once() {
        let w = World::new();
        let mut d = dictate(&w);
        let mut out = Rec::default();
        d.begin("simulate", true, ("granted", "granted"), &mut out);
        d.recheck_grant(&mut out);
        assert!(!types(&out).contains(&"grant.lost".to_string()));
        w.borrow_mut().trusted = false;
        d.gate().event(TapEvent::Disabled {
            t_ns: MS,
            held: &[],
        });
        d.pump(MS, &mut out);
        let lost = |out: &Rec| {
            out.lines
                .iter()
                .filter(|l| l.contains("grant.lost"))
                .cloned()
                .collect::<Vec<String>>()
        };
        assert_eq!(
            lost(&out),
            [r#"{"type":"grant.lost","name":"accessibility"}"#],
            "the disabled tap re-checked"
        );
        d.recheck_grant(&mut out);
        assert_eq!(lost(&out).len(), 1, "once");

        let w = World::new();
        w.borrow_mut().trusted = false;
        let mut d = dictate(&w);
        let mut out = Rec::default();
        d.begin("simulate", true, ("granted", "not-needed"), &mut out);
        d.recheck_grant(&mut out);
        assert!(!types(&out).contains(&"grant.lost".to_string()));
    }

    /// DC-N1: Secure Input turning on and off is reported once each way.
    #[test]
    fn secure_input_changes_are_reported_once_each_way() {
        let w = World::new();
        let mut d = dictate(&w);
        let mut out = Rec::default();
        run(&mut d, &mut out, 0, 300);
        w.borrow_mut().secure_input = true;
        run(&mut d, &mut out, 300, 1000);
        w.borrow_mut().secure_input = false;
        run(&mut d, &mut out, 1000, 1500);
        let lines: Vec<&String> = out
            .lines
            .iter()
            .filter(|l| l.contains("secure_input"))
            .collect();
        assert_eq!(
            lines,
            [
                r#"{"type":"secure_input","on":true}"#,
                r#"{"type":"secure_input","on":false}"#
            ]
        );
    }

    /// A session that captured the fake Slack and ended at 100 ms; the app's commands follow.
    fn ended_session(w: &Shared) -> (Dictate, Rec) {
        let mut d = dictate(w);
        let mut out = Rec::default();
        d.begin("simulate", true, ("granted", "granted"), &mut out);
        d.command(Command::SessionStart, 0, &mut out);
        run(&mut d, &mut out, 0, 100);
        d.command(Command::SessionStop, 100 * MS, &mut out);
        run(&mut d, &mut out, 100, 400);
        (d, out)
    }

    /// DC-N9: the draft box inserts where the app says (the `target` of its `insert`), not where
    /// the session began. Positive control: the same insert without `target` is refused.
    #[test]
    fn dc_n9_an_insert_that_names_its_target_goes_there() {
        let mail = r#"{"app":"Mail","pid":4,"window":"m","field":"editable"}"#;
        for (named, want) in [(true, "inserted"), (false, "focus-changed")] {
            let w = World::new();
            let (mut d, mut out) = ended_session(&w);
            w.borrow_mut().target = Target::from_value(&p::Value::parse(mail).unwrap()).unwrap();
            let insert = if named {
                format!(r#"{{"type":"insert","id":"1","text":"hi","target":{mail}}}"#)
            } else {
                r#"{"type":"insert","id":"1","text":"hi"}"#.to_string()
            };
            d.command(Command::parse(&insert).unwrap(), 400 * MS, &mut out);
            w.borrow_mut().pending_reads.push(410 * MS);
            run(&mut d, &mut out, 400, 700);
            let answer = out
                .lines
                .iter()
                .find(|l| l.contains(r#""id":"1""#) && l.contains("insert"))
                .unwrap();
            assert!(answer.contains(want), "named {named}: {answer}");
            assert_eq!(w.borrow().posted.is_empty(), !named);
        }
    }

    /// DC-A4: only the session's own insert holds Escape and Enter; an insert with another id (a
    /// retry from history, a stale draft) must not restart the 8 s swallow window, since only
    /// the session's own answer ends it. Positive control: the session's own insert does.
    #[test]
    fn dc_a4_an_insert_for_another_id_does_not_hold_the_keys() {
        for (id, held) in [("old", false), ("1", true)] {
            let w = World::new();
            let (mut d, mut out) = ended_session(&w);
            // The target never reads, so the session's own paste waits out its receipt; the
            // stale id has no session record and is refused, which settles nothing.
            run(&mut d, &mut out, 400, 7000);
            let insert = format!(r#"{{"type":"insert","id":"{id}","text":"hi"}}"#);
            d.command(Command::parse(&insert).unwrap(), 7000 * MS, &mut out);
            run(&mut d, &mut out, 7000, 9000);
            assert_eq!(
                d.key(true, "Escape", 9000 * MS, &mut out),
                held,
                "insert id {id}"
            );
        }
    }

    /// DC-L2: a second insert while the first paste still waits for its quiet period settles
    /// the first, and the first still gets its read-back answer.
    #[test]
    fn dc_l2_a_second_insert_does_not_lose_the_first_ones_answer() {
        let w = World::new();
        let (mut d, mut out) = ended_session(&w);
        w.borrow_mut().field = Some(Field::Text {
            value: PASTED.into(),
            caret: PASTED.chars().count(),
        });
        let first = format!(r#"{{"type":"insert","id":"1","text":"{PASTED}","read_field":true}}"#);
        d.command(Command::parse(&first).unwrap(), 400 * MS, &mut out);
        w.borrow_mut().pending_reads.push(410 * MS);
        run(&mut d, &mut out, 400, 450);
        let second = r#"{"type":"insert","id":"2","text":"more","read_field":true}"#;
        d.command(Command::parse(second).unwrap(), 450 * MS, &mut out);
        let answers: Vec<&String> = out
            .lines
            .iter()
            .filter(|l| l.contains(r#""type":"edit"#) && l.contains(r#""id":"1""#))
            .collect();
        assert_eq!(answers.len(), 1, "{:?}", out.lines);
    }

    const BEFORE: &str = "Hi team, ";
    const PASTED: &str = "tell the cooper netties team the rollout";
    const AFTER: &str = " is on Thursday. Thanks";

    /// A latched session, its paste into the fake Slack at 400 ms with `read_field`, and the
    /// target's read of the clipboard; the field then holds the pasted text at the caret.
    fn pasted(w: &Shared, read_field: bool, grants: (&str, &str)) -> (Dictate, Rec) {
        pasted_before(w, read_field, grants, AFTER)
    }

    /// The same with `after` as the field's text after the paste ("" is the end of a chat box).
    fn pasted_before(
        w: &Shared,
        read_field: bool,
        grants: (&str, &str),
        after: &str,
    ) -> (Dictate, Rec) {
        let mut d = dictate(w);
        let mut out = Rec::default();
        d.begin("simulate", true, grants, &mut out);
        d.command(Command::SessionStart, 0, &mut out);
        run(&mut d, &mut out, 0, 100);
        d.command(Command::SessionStop, 100 * MS, &mut out);
        run(&mut d, &mut out, 100, 400);
        let value = format!("{BEFORE}{PASTED}{after}");
        let caret = BEFORE.chars().count() + PASTED.chars().count();
        w.borrow_mut().field = Some(Field::Text { value, caret });
        let insert =
            format!(r#"{{"type":"insert","id":"1","text":"{PASTED}","read_field":{read_field}}}"#);
        d.command(Command::parse(&insert).unwrap(), 400 * MS, &mut out);
        w.borrow_mut().pending_reads.push(410 * MS);
        run(&mut d, &mut out, 400, 700);
        (d, out)
    }

    fn edited(w: &Shared) {
        let value = format!("{BEFORE}tell the Kubernetes team the rollout{AFTER}");
        w.borrow_mut().field = Some(Field::Text { value, caret: 0 });
    }

    fn edits(out: &Rec) -> Vec<&String> {
        out.lines
            .iter()
            .filter(|l| l.contains(r#""type":"edit"#))
            .collect()
    }

    /// DC-L2: the value changes 1.2 s after the paste, then a Return reaches the app: one `edit`
    /// with the changed words, and nothing else from the field (not its other text, not the
    /// words the user left alone).
    #[test]
    fn dc_l2_an_edit_then_return_yields_the_hunks_and_only_the_hunks() {
        let w = World::new();
        let (mut d, mut out) = pasted(&w, true, ("granted", "granted"));
        assert_eq!(w.borrow().field_reads.len(), 1, "the snapshot");
        run(&mut d, &mut out, 700, 1600);
        edited(&w);
        run(&mut d, &mut out, 1600, 1700);
        assert!(edits(&out).is_empty(), "nothing before the commit key");
        assert!(!d.key(true, "Return", 1700 * MS, &mut out));
        d.key(false, "Return", 1710 * MS, &mut out);
        let e = edits(&out);
        assert_eq!(
            e,
            [
                r#"{"type":"edit","id":"1","hunks":[{"inserted":"cooper netties","now":"Kubernetes","at":2}]}"#
            ]
        );
        for private in ["Hi team", "Thursday", "Thanks", "rollout", "tell"] {
            assert!(
                !e[0].contains(private),
                "{private} left the helper: {}",
                e[0]
            );
        }
        assert_eq!(w.borrow().field_reads.len(), 2);
        run(&mut d, &mut out, 1710, 3000);
        assert_eq!(edits(&out).len(), 1, "one answer per insert");

        // At the end of the field there is no anchor after the paste: what the user types on
        // after the dictation is theirs, not a correction, and stays in the helper.
        let w = World::new();
        let (mut d, mut out) = pasted_before(&w, true, ("granted", "granted"), "");
        let value =
            format!("Dear all, {BEFORE}tell the Kubernetes team the rollout and my pin is 4321");
        w.borrow_mut().field = Some(Field::Text { value, caret: 0 });
        d.key(true, "Return", 1700 * MS, &mut out);
        let e = edits(&out);
        assert_eq!(
            e,
            [
                r#"{"type":"edit","id":"1","hunks":[{"inserted":"cooper netties","now":"Kubernetes","at":2}]}"#
            ]
        );
        for private in ["Dear all", "pin", "4321"] {
            assert!(
                !e[0].contains(private),
                "{private} left the helper: {}",
                e[0]
            );
        }
    }

    /// DC-L2: with `read_field` off, a secure field, a terminal or the grant missing, no read
    /// call is made; a dormant tree is read once and yields `unreadable`.
    #[test]
    fn dc_l2_nothing_is_read_where_the_rules_say_not_to() {
        let w = World::new();
        let (mut d, mut out) = pasted(&w, false, ("granted", "granted"));
        edited(&w);
        d.key(true, "Return", 800 * MS, &mut out);
        run(&mut d, &mut out, 800, 1000);
        assert!(w.borrow().field_reads.is_empty() && edits(&out).is_empty());

        let w = World::new();
        w.borrow_mut().target.field = "secure".into();
        let (_, out) = pasted(&w, true, ("granted", "granted"));
        assert!(w.borrow().field_reads.is_empty() && edits(&out).is_empty());
        assert!(out.lines.iter().any(|l| l.contains(r#""reason":"secure""#)));

        for (app, grants) in [
            ("com.apple.Terminal", ("granted", "granted")),
            ("Slack", ("granted", "denied")),
        ] {
            let w = World::new();
            w.borrow_mut().target.app = app.into();
            let (_, out) = pasted(&w, true, grants);
            assert!(w.borrow().field_reads.is_empty(), "{app}");
            assert_eq!(
                edits(&out),
                [r#"{"type":"edit.unreadable","id":"1","reason":"not-read"}"#],
                "{app}"
            );
        }

        let w = World::new();
        let mut d = dictate(&w);
        let mut out = Rec::default();
        d.begin("simulate", true, ("granted", "granted"), &mut out);
        d.command(Command::SessionStart, 0, &mut out);
        run(&mut d, &mut out, 0, 100);
        d.command(Command::SessionStop, 100 * MS, &mut out);
        run(&mut d, &mut out, 100, 400);
        let insert = r#"{"type":"insert","id":"1","text":"hi","read_field":true}"#;
        d.command(Command::parse(insert).unwrap(), 400 * MS, &mut out);
        w.borrow_mut().pending_reads.push(410 * MS);
        run(&mut d, &mut out, 400, 700);
        assert_eq!(w.borrow().field_reads.len(), 1);
        assert_eq!(
            edits(&out),
            [r#"{"type":"edit.unreadable","id":"1","reason":"unreadable"}"#]
        );
    }

    /// DC-L2: the target losing the keyboard ends the watch once the grace passed, reading the
    /// original field; a typed insert's snapshot waits for the app to take the events.
    #[test]
    fn dc_l2_leaving_the_field_reads_it_and_a_typed_insert_snapshots_after_the_quiet() {
        let w = World::new();
        let (mut d, mut out) = pasted(&w, true, ("granted", "not-needed"));
        edited(&w);
        w.borrow_mut().target.app = "Mail".into();
        run(&mut d, &mut out, 700, 1200);
        assert_eq!(edits(&out).len(), 1, "{:?}", out.lines);
        assert_eq!(w.borrow().field_reads[1].app, "Slack", "the original field");

        let w = World::new();
        let mut d = dictate(&w);
        let mut out = Rec::default();
        d.command(Command::SessionStart, 0, &mut out);
        run(&mut d, &mut out, 0, 100);
        d.command(Command::SessionStop, 100 * MS, &mut out);
        run(&mut d, &mut out, 100, 400);
        w.borrow_mut().field = Some(Field::Text {
            value: "hi".into(),
            caret: 2,
        });
        let insert = r#"{"type":"insert","id":"1","text":"hi","method":"type","read_field":true}"#;
        d.command(Command::parse(insert).unwrap(), 400 * MS, &mut out);
        run(&mut d, &mut out, 400, 590);
        assert!(w.borrow().field_reads.is_empty(), "not before the quiet");
        run(&mut d, &mut out, 590, 620);
        assert_eq!(w.borrow().field_reads.len(), 1);
    }

    /// DC-N2 through the protocol: a helper started on Fn silences the Globe action; `rebind`
    /// away gives it back, `rebind` to Fn takes it again, and `stop` gives it back.
    #[test]
    fn dc_n2_the_globe_action_follows_the_dictation_key() {
        use crate::dictate::globe::{DO_NOTHING, Globe, tests::Store};
        let store = Store::default();
        store.user_chose(2);
        let w = World::new();
        let mut d = Dictate::new(
            Config {
                hotkey: Hotkey::parse("Fn").unwrap(),
                mode: Mode::HoldOrToggle,
                warm: Warm::Off,
                bluetooth: false,
                ring_ms: 500,
                os: Os::Mac,
            },
            Box::new(Screen(w.clone())),
            None,
        );
        d.set_globe(Globe::new(Box::new(store.clone())));
        let mut out = Rec::default();
        d.begin("test", true, ("granted", "granted"), &mut out);
        assert_eq!(store.fn_usage(), Some(DO_NOTHING));
        let rebind =
            |k: &str| Command::parse(&format!(r#"{{"type":"rebind","hotkey":"{k}"}}"#)).unwrap();
        d.command(rebind("RightCommand"), 0, &mut out);
        assert_eq!(store.fn_usage(), Some(2));
        d.command(rebind("Fn"), 0, &mut out);
        assert_eq!(store.fn_usage(), Some(DO_NOTHING));
        assert!(!d.command(Command::Stop, 0, &mut out));
        assert_eq!(store.fn_usage(), Some(2));
    }

    /// A dictate over a fake player list, one playing and one paused, `pause_media` sent as
    /// `on` (never when `None`), and a second of warm mic behind it.
    fn with_players(on: Option<bool>) -> (Dictate, Rec, crate::dictate::media::fake::Board) {
        use crate::dictate::media::{Pauser, Status, fake::Board};
        let w = World::new();
        let board = Board::with(&[("music", Status::Playing), ("podcast", Status::Paused)]);
        let mut d = dictate(&w);
        d.set_media(Box::new(Pauser::new(Box::new(board.clone()))));
        let mut out = Rec::default();
        d.begin("simulate", true, ("granted", "granted"), &mut out);
        if let Some(on) = on {
            d.command(Command::PauseMedia { on }, 0, &mut out);
        }
        run(&mut d, &mut out, 0, 1000);
        (d, out, board)
    }

    /// A push-to-talk hold from `at` for 600 ms.
    fn hold(d: &mut Dictate, out: &mut Rec, at: u64) {
        d.key(true, "RightCommand", at * MS, out);
        run(d, out, at, at + 600);
        d.key(false, "RightCommand", (at + 600) * MS, out);
    }

    /// DC-U8 through the protocol: with `pause_media` on, a session pauses what plays and its
    /// end, after the post-roll, plays it again; the player already paused is never started.
    #[test]
    fn dc_u8_a_session_pauses_the_players_and_its_end_gives_back_only_those() {
        use crate::dictate::media::Status;
        let (mut d, mut out, board) = with_players(Some(true));
        hold(&mut d, &mut out, 1000);
        assert_eq!(board.calls(), ["pause music"], "paused while listening");
        run(&mut d, &mut out, 1600, 1700);
        assert_eq!(
            board.calls(),
            ["pause music"],
            "not before the post-roll ends"
        );
        run(&mut d, &mut out, 1700, 2200);
        assert!(types(&out).contains(&"session.ended".to_string()));
        assert_eq!(board.calls(), ["pause music", "play music"]);
        assert_eq!(board.status("podcast"), Some(Status::Paused));
    }

    /// The positive control of the test above: with the setting never sent (the default) or sent
    /// off, the same session touches no player.
    #[test]
    fn dc_u8_with_the_setting_off_no_player_is_touched() {
        for on in [None, Some(false)] {
            let (mut d, mut out, board) = with_players(on);
            hold(&mut d, &mut out, 1000);
            run(&mut d, &mut out, 1600, 2200);
            assert!(board.calls().is_empty(), "{on:?}: {:?}", board.calls());
        }
    }

    /// Turning the setting off during a session gives the players back at once, and the
    /// session's end does not give them back a second time.
    #[test]
    fn dc_u8_turning_it_off_during_a_session_gives_the_players_back() {
        let (mut d, mut out, board) = with_players(Some(true));
        hold(&mut d, &mut out, 1000);
        d.command(Command::PauseMedia { on: false }, 1610 * MS, &mut out);
        assert_eq!(board.calls(), ["pause music", "play music"], "back now");
        run(&mut d, &mut out, 1610, 2200);
        assert_eq!(board.calls().len(), 2, "and not twice");
    }

    /// `stop` in the middle of a session gives the players back before the process exits.
    #[test]
    fn dc_u8_stop_during_a_session_gives_the_players_back() {
        let (mut d, mut out, board) = with_players(Some(true));
        d.key(true, "RightCommand", 1000 * MS, &mut out);
        run(&mut d, &mut out, 1000, 1500);
        assert_eq!(board.calls(), ["pause music"]);
        assert!(!d.command(Command::Stop, 1500 * MS, &mut out));
        assert_eq!(board.calls(), ["pause music", "play music"]);
    }
}
