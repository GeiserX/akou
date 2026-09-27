//! The dictate process on a real OS: the worker loop every backend shares (DC-N1, DC-N4).
//!
//! A backend brings three things: the key tap, which runs on its own thread and only calls
//! `tap::Gate::event`; the `Targets` (what has the keyboard); and a `Device`, the microphone. This
//! module runs everything else on the worker thread: the app's commands from stdin, the device
//! stream opened and closed as `mic::Mic` asks, the device's samples stamped and resampled to
//! 16 kHz, and time passing for the post-roll, the warm hold and the paste receipts.
//!
//! - **One clock.** Every time here is the awake clock (`clock::now().awake_ns`): the tap stamps a
//!   key when its callback runs, the device stamps a buffer with its host time. A buffer's samples
//!   are stamped by counting them from the stream's first buffer, never by when each buffer
//!   arrived, because `Mic::push` treats a jump of more than 1 ms as a skip and clears the
//!   pre-roll ring. When the count and the device's own stamp drift more than `REANCHOR_MS` apart
//!   (dropped buffers), the count starts again from the device's stamp.
//! - **Wake.** A machine that slept may come back without the Accessibility grant (reset by a
//!   re-signed build, or revoked), which kills the tap without a word. Sleep shows as the
//!   continuous clock running ahead of the awake clock; after a sleep the worker re-checks the
//!   grant (`grant.lost`) and reopens an open stream.
//! - **A device that will not open** is said once (`warn mic-open`) and tried again after
//!   `RETRY_MS`; a session waiting for its first sample never starts, and ends with nothing
//!   reported when its key goes up (`mic::MicEvent::Vanished`). The grant is re-checked, as for
//!   any session that fails to start.

use std::io::{BufRead, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};

use super::protocol::{self as p, Command};
use super::session::{Dictate, Out};
use crate::clock::Now;
use crate::protocol::exit;
use crate::resample::StreamResampler;
use crate::source::{Chunk, Event};

const MS: u64 = 1_000_000;
/// The worker's step when nothing arrives: the post-roll and the receipts are timed to it.
pub const STEP_MS: u64 = 10;
/// A count this far from the device's own stamp starts again from the stamp.
pub const REANCHOR_MS: u64 = 20;
/// The continuous clock ahead of the awake clock by this much more than last step: the machine
/// slept.
pub const SLEPT_MS: u64 = 1_000;
/// A device that failed to open is tried again after this.
pub const RETRY_MS: u64 = 2_000;
const RATE: u32 = 16_000;

/// The microphone, per OS. `open` starts delivering `Event::Chunk` on `events` and says whether
/// the device is Bluetooth (never kept warm, DC-N4).
pub trait Device {
    fn open(&mut self, device: &str, events: SyncSender<Event>) -> Result<bool, String>;
    fn close(&mut self);
}

/// What reaches the worker.
pub enum Msg {
    /// A line from the app; `None` when stdin closed.
    Line(Option<String>),
    Mic(Event),
    /// The tap queued something.
    Tap,
}

/// Sleep, seen from two clocks: the awake clock stops while the machine sleeps, the continuous
/// one does not.
#[derive(Default)]
pub struct Sleep {
    gap: Option<u64>,
}

impl Sleep {
    pub fn woke(&mut self, now: Now) -> bool {
        let gap = now.cont_ns.saturating_sub(now.awake_ns);
        let woke = self.gap.is_some_and(|g| gap > g + SLEPT_MS * MS);
        self.gap = Some(gap);
        woke
    }
}

/// A device stream's buffers as 16 kHz samples, each stamped by counting from the first.
#[derive(Default)]
pub struct Feed {
    anchor: Option<u64>,
    rate: u32,
    /// Input samples since the anchor.
    fed: u64,
    /// Output samples since the anchor, after the resampler's startup.
    sent: u64,
    /// Resampler outputs still to drop (its startup).
    skip: usize,
    rs: Option<StreamResampler>,
}

impl Feed {
    fn restart(&mut self, c: &Chunk) {
        self.anchor = Some(c.awake_ns);
        self.rate = c.rate;
        self.fed = 0;
        self.sent = 0;
        self.rs = (c.rate != RATE)
            .then(|| StreamResampler::new(c.rate, RATE).ok())
            .flatten();
        self.skip = self.rs.as_ref().map_or(0, StreamResampler::delay);
    }

    /// The samples of `c` ready now, with the time of the first.
    pub fn push(&mut self, c: &Chunk) -> Option<(u64, Vec<f32>)> {
        let expected = self
            .anchor
            .map(|a| a + self.fed * 1_000_000_000 / u64::from(self.rate.max(1)));
        if c.rate != self.rate || expected.is_none_or(|e| e.abs_diff(c.awake_ns) > REANCHOR_MS * MS)
        {
            self.restart(c);
        }
        self.fed += c.samples.len() as u64;
        let mut out = Vec::new();
        match self.rs.as_mut() {
            Some(rs) => rs.push(&c.samples, &mut out),
            None if c.rate == RATE => out.extend_from_slice(&c.samples),
            // A rate the resampler refused: nothing usable.
            None => return None,
        }
        let drop = self.skip.min(out.len());
        self.skip -= drop;
        out.drain(..drop);
        if out.is_empty() {
            return None;
        }
        let t = self.anchor? + self.sent * 1_000_000_000 / u64::from(RATE);
        self.sent += out.len() as u64;
        Some((t, out))
    }
}

/// JSON lines to stderr, packets to stdout.
pub struct Stdio<W: Write, E: Write> {
    pub stdout: W,
    pub stderr: E,
}

impl<W: Write, E: Write> Out for Stdio<W, E> {
    fn line(&mut self, line: String) {
        let _ = writeln!(self.stderr, "{line}");
        let _ = self.stderr.flush();
    }
    fn packet(&mut self, bytes: Vec<u8>) {
        let _ = self.stdout.write_all(&bytes);
        let _ = self.stdout.flush();
    }
}

/// Reads the app's lines on their own thread.
pub fn read_lines(input: Box<dyn BufRead + Send>, tx: Sender<Msg>) {
    std::thread::spawn(move || {
        for line in input.lines() {
            match line {
                Ok(l) if l.trim().is_empty() => {}
                Ok(l) => {
                    if tx.send(Msg::Line(Some(l))).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(Msg::Line(None));
    });
}

/// Forwards the tap's wake-ups to the worker.
pub fn forward_wakes(tx: Sender<Msg>) -> mpsc::Sender<()> {
    let (wtx, wrx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        for () in wrx {
            if tx.send(Msg::Tap).is_err() {
                return;
            }
        }
    });
    wtx
}

struct Mic<'a> {
    dev: &'a mut dyn Device,
    events: SyncSender<Event>,
    device: String,
    open: bool,
    feed: Feed,
    retry_at: u64,
    failing: bool,
}

impl Mic<'_> {
    fn close(&mut self) {
        if self.open {
            self.dev.close();
            self.open = false;
        }
    }

    /// Opens or closes the device to match what the session wants.
    fn follow(&mut self, d: &mut Dictate, t: u64, out: &mut dyn Out) {
        let want = d.mic_open();
        if !want {
            self.close();
            self.retry_at = 0;
            return;
        }
        if self.open || t < self.retry_at {
            return;
        }
        match self.dev.open(&self.device, self.events.clone()) {
            Ok(bluetooth) => {
                self.open = true;
                self.failing = false;
                self.feed = Feed::default();
                d.set_bluetooth(bluetooth, t, out);
                if !d.mic_open() {
                    self.close();
                }
            }
            Err(e) => {
                self.retry_at = t + RETRY_MS * MS;
                if !self.failing {
                    self.failing = true;
                    out.line(p::warn("mic-open", &e));
                    d.recheck_grant(out);
                }
            }
        }
    }

    fn reopen(&mut self) {
        self.close();
        self.retry_at = 0;
    }
}

/// Runs the worker until `stop` or the end of stdin; returns the exit code.
pub fn serve(
    d: &mut Dictate,
    dev: &mut dyn Device,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
    now: &mut dyn FnMut() -> Now,
    out: &mut dyn Out,
) -> i32 {
    let (mic_tx, mic_rx) = mpsc::sync_channel::<Event>(256);
    std::thread::spawn(move || {
        for e in mic_rx {
            if tx.send(Msg::Mic(e)).is_err() {
                return;
            }
        }
    });
    let mut mic = Mic {
        dev,
        events: mic_tx,
        device: "default".into(),
        open: false,
        feed: Feed::default(),
        retry_at: 0,
        failing: false,
    };
    let mut sleep = Sleep::default();
    loop {
        let msg = rx.recv_timeout(std::time::Duration::from_millis(STEP_MS));
        let n = now();
        let t = n.awake_ns;
        if sleep.woke(n) {
            d.recheck_grant(out);
            mic.reopen();
        }
        match msg {
            Ok(Msg::Line(Some(l))) => match Command::parse(&l) {
                Ok(Command::RebuildMic { device }) => {
                    mic.device = device;
                    mic.reopen();
                }
                Ok(c) => {
                    if !d.command(c, t, out) {
                        break;
                    }
                }
                Err(e) => out.line(p::warn("bad-command", &format!("{e}: {l}"))),
            },
            Ok(Msg::Line(None)) | Err(RecvTimeoutError::Disconnected) => {
                d.command(Command::Stop, t, out);
                break;
            }
            Ok(Msg::Mic(Event::Chunk(c))) => {
                if mic.open
                    && let Some((at, samples)) = mic.feed.push(&c)
                {
                    d.audio(at, &samples, out);
                }
            }
            Ok(Msg::Mic(Event::Lost { detail, .. })) => {
                out.line(p::warn("mic-lost", &detail));
                mic.reopen();
            }
            Ok(Msg::Mic(Event::Warn { code, msg })) => out.line(p::warn(code, &msg)),
            Ok(Msg::Mic(_) | Msg::Tap) | Err(RecvTimeoutError::Timeout) => {}
        }
        d.pump(t, out);
        d.tick(t, out);
        mic.follow(d, t, out);
    }
    mic.close();
    out.line(p::stopped("stop"));
    exit::OK
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictate::activation::Mode;
    use crate::dictate::fake::{Screen, World};
    use crate::dictate::insert::Os;
    use crate::dictate::keys::Hotkey;
    use crate::dictate::mic::Warm;
    use crate::dictate::session::Config;
    use crate::dictate::tap::TapEvent;
    use crate::protocol::Ch;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn chunk(awake_ns: u64, rate: u32, n: usize) -> Chunk {
        Chunk {
            ch: Ch::Mic,
            awake_ns,
            rate,
            samples: vec![0.25; n],
            heard: true,
        }
    }

    /// DC-N4's trap for a device backend: a buffer that arrives late is still stamped where its
    /// samples belong, so the ring never sees a gap; a real skip starts the count again.
    #[test]
    fn samples_are_stamped_by_count_not_by_arrival() {
        let mut f = Feed::default();
        let (t0, s0) = f.push(&chunk(1_000 * MS, 16_000, 160)).unwrap();
        assert_eq!((t0, s0.len()), (1_000 * MS, 160));
        // The next buffer's own stamp is 3 ms late (scheduling): the count wins.
        let (t1, _) = f.push(&chunk(1_013 * MS, 16_000, 160)).unwrap();
        assert_eq!(t1, 1_010 * MS);
        // 200 ms of buffers were dropped: the stamp wins, once.
        let (t2, _) = f.push(&chunk(1_220 * MS, 16_000, 160)).unwrap();
        assert_eq!(t2, 1_220 * MS);
        let (t3, _) = f.push(&chunk(1_231 * MS, 16_000, 160)).unwrap();
        assert_eq!(t3, 1_230 * MS);
    }

    #[test]
    fn a_48_khz_device_is_resampled_and_stamped_continuously() {
        let mut f = Feed::default();
        let mut got = Vec::new();
        for i in 0..100u64 {
            if let Some(x) = f.push(&chunk(5_000 * MS + i * 10 * MS, 48_000, 480)) {
                got.push(x);
            }
        }
        assert!(!got.is_empty());
        for w in got.windows(2) {
            let (a, sa) = (&w[0].0, w[0].1.len() as u64);
            assert_eq!(
                w[1].0,
                a + sa * 1_000_000_000 / 16_000,
                "no gap, no overlap"
            );
        }
        let total: usize = got.iter().map(|g| g.1.len()).sum();
        assert!(
            (15_000..=16_000).contains(&total),
            "{total} samples for 1 s"
        );
    }

    /// The resampler lags its input; its startup is dropped, so a sound is stamped when it
    /// happened, not a few milliseconds late.
    #[test]
    fn a_resampled_sound_is_stamped_when_it_happened() {
        let mut f = Feed::default();
        let start = 5_000 * MS;
        let mut onset = None;
        for i in 0..100u64 {
            let mut c = chunk(start + i * 10 * MS, 48_000, 480);
            // Silence, then a steady tone from 500 ms.
            c.samples = (0..480u64)
                .map(|k| if i * 480 + k >= 24_000 { 0.5 } else { 0.0 })
                .collect();
            if let Some((t, s)) = f.push(&c)
                && onset.is_none()
                && let Some(k) = s.iter().position(|x| x.abs() > 0.25)
            {
                onset = Some(t + k as u64 * 1_000_000_000 / 16_000);
            }
        }
        let onset = onset.expect("the tone came out");
        assert!(
            onset.abs_diff(start + 500 * MS) <= MS,
            "stamped {} us off",
            (onset as i64 - (start + 500 * MS) as i64) / 1_000
        );
    }

    #[test]
    fn sleep_is_the_continuous_clock_running_ahead() {
        let mut s = Sleep::default();
        let at = |awake: u64, cont: u64| Now {
            awake_ns: awake * MS,
            cont_ns: cont * MS,
        };
        assert!(!s.woke(at(100, 5_100)));
        assert!(!s.woke(at(110, 5_110)), "both clocks moved together");
        assert!(
            !s.woke(at(120, 5_620)),
            "half a second is scheduling, not sleep"
        );
        assert!(s.woke(at(130, 65_630)), "a minute asleep");
        assert!(!s.woke(at(140, 65_640)));
    }

    struct Rec(Rc<RefCell<Vec<String>>>);
    impl Out for Rec {
        fn line(&mut self, l: String) {
            self.0.borrow_mut().push(l);
        }
        fn packet(&mut self, _: Vec<u8>) {}
    }

    /// A device that fails to open, or opens and hands out its channel.
    struct Dev {
        fail: bool,
        opens: Rc<RefCell<Vec<String>>>,
        events: Rc<RefCell<Option<SyncSender<Event>>>>,
    }
    impl Device for Dev {
        fn open(&mut self, device: &str, events: SyncSender<Event>) -> Result<bool, String> {
            self.opens.borrow_mut().push(device.to_string());
            if self.fail {
                return Err("no input device".into());
            }
            *self.events.borrow_mut() = Some(events);
            Ok(false)
        }
        fn close(&mut self) {
            self.opens.borrow_mut().push("close".into());
        }
    }

    fn dictate(w: &crate::dictate::fake::Shared, warm: Warm) -> Dictate {
        Dictate::new(
            Config {
                hotkey: Hotkey::parse("RightCommand").unwrap(),
                mode: Mode::HoldOrToggle,
                warm,
                bluetooth: false,
                ring_ms: crate::dictate::mic::RING_MS,
                os: Os::current(),
            },
            Box::new(Screen(w.clone())),
            None,
        )
    }

    /// DC-N1: the machine slept and came back without the grant, so the tap is dead; the worker
    /// says `grant.lost` without any key reaching it.
    #[test]
    fn dc_n1_a_wake_rechecks_the_grant() {
        let w = World::new();
        let mut d = dictate(&w, Warm::Off);
        let lines = Rc::new(RefCell::new(Vec::new()));
        let mut out = Rec(lines.clone());
        d.begin("test", true, ("granted", "granted"), &mut out);
        w.borrow_mut().trusted = false;
        let (tx, rx) = mpsc::channel();
        let clock = RefCell::new(vec![
            (100, 5_100),
            (110, 5_110),
            (120, 65_120),
            (130, 65_130),
        ]);
        let mut now = || {
            let mut c = clock.borrow_mut();
            let (a, b) = if c.len() > 1 { c.remove(0) } else { c[0] };
            let _ = tx.send(Msg::Tap);
            if c.len() == 1 {
                let _ = tx.send(Msg::Line(None));
            }
            Now {
                awake_ns: a * MS,
                cont_ns: b * MS,
            }
        };
        let mut dev = Dev {
            fail: false,
            opens: Rc::default(),
            events: Rc::default(),
        };
        let fwd = tx.clone();
        assert_eq!(serve(&mut d, &mut dev, fwd, rx, &mut now, &mut out), 0);
        let l = lines.borrow();
        assert_eq!(
            l.iter().filter(|x| x.contains("grant.lost")).count(),
            1,
            "{l:?}"
        );
        assert!(l.last().unwrap().contains("stopped"));
    }

    /// A press with no microphone: said once, the grant re-checked, the session never starts and
    /// its key-up reports nothing; the device is tried again, not every step.
    #[test]
    fn a_device_that_will_not_open_is_said_once_and_retried_later() {
        let w = World::new();
        let mut d = dictate(&w, Warm::Off);
        let lines = Rc::new(RefCell::new(Vec::new()));
        let mut out = Rec(lines.clone());
        d.begin("test", true, ("granted", "granted"), &mut out);
        let gate = d.gate();
        let (tx, rx) = mpsc::channel();
        let step = RefCell::new(0u64);
        let mut now = || {
            let mut s = step.borrow_mut();
            *s += 1;
            let t = *s * 10 * MS;
            // Every step has something to read, so the loop never waits out its step.
            let _ = tx.send(Msg::Tap);
            match *s {
                2 => {
                    gate.event(TapEvent::Key {
                        down: true,
                        name: "RightCommand",
                        t_ns: t,
                    });
                }
                // Held 3 s, then up.
                302 => {
                    gate.event(TapEvent::Key {
                        down: false,
                        name: "RightCommand",
                        t_ns: t,
                    });
                }
                400 => {
                    let _ = tx.send(Msg::Line(None));
                }
                _ => {}
            }
            Now {
                awake_ns: t,
                cont_ns: t,
            }
        };
        let opens = Rc::new(RefCell::new(Vec::new()));
        let mut dev = Dev {
            fail: true,
            opens: opens.clone(),
            events: Rc::default(),
        };
        let fwd = tx.clone();
        serve(&mut d, &mut dev, fwd, rx, &mut now, &mut out);
        let l = lines.borrow();
        assert_eq!(
            l.iter().filter(|x| x.contains("mic-open")).count(),
            1,
            "{l:?}"
        );
        assert!(!l.iter().any(|x| x.contains("session.")), "{l:?}");
        let tries = opens.borrow().len();
        assert!((2..=3).contains(&tries), "tried {tries} times in 3 s");
    }

    /// The whole loop with a device that delivers: a hold becomes a session whose audio starts at
    /// the first sample and ends after the post-roll; stop closes the device.
    #[test]
    fn a_hold_with_a_working_device_runs_a_session() {
        let w = World::new();
        let mut d = dictate(&w, Warm::Off);
        let lines = Rc::new(RefCell::new(Vec::new()));
        let mut out = Rec(lines.clone());
        d.begin("test", true, ("granted", "granted"), &mut out);
        let gate = d.gate();
        let events: Rc<RefCell<Option<SyncSender<Event>>>> = Rc::default();
        let ev = events.clone();
        let (tx, rx) = mpsc::channel();
        let step = RefCell::new(0u64);
        let mut now = || {
            let mut s = step.borrow_mut();
            *s += 1;
            let t = *s * 10 * MS;
            if let Some(e) = ev.borrow().as_ref() {
                let _ = e.try_send(Event::Chunk(chunk(t - 10 * MS, 16_000, 160)));
            }
            match *s {
                2 => {
                    gate.event(TapEvent::Key {
                        down: true,
                        name: "RightCommand",
                        t_ns: t,
                    });
                }
                102 => {
                    gate.event(TapEvent::Key {
                        down: false,
                        name: "RightCommand",
                        t_ns: t,
                    });
                }
                200 => {
                    let _ = tx.send(Msg::Line(None));
                }
                _ => {}
            }
            Now {
                awake_ns: t,
                cont_ns: t,
            }
        };
        let opens = Rc::new(RefCell::new(Vec::new()));
        let mut dev = Dev {
            fail: false,
            opens: opens.clone(),
            events,
        };
        let fwd = tx.clone();
        serve(&mut d, &mut dev, fwd, rx, &mut now, &mut out);
        let l = lines.borrow();
        let kinds: Vec<&str> = l
            .iter()
            .filter_map(|x| x.split('"').nth(3))
            .filter(|k| k.starts_with("session") || *k == "mic")
            .collect();
        assert_eq!(
            kinds,
            ["mic", "session.started", "session.ended", "mic"],
            "{l:?}"
        );
        assert_eq!(opens.borrow().first().map(String::as_str), Some("default"));
        assert!(opens.borrow().contains(&"close".to_string()));
    }
}
