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
//! - **A device that is slow to open** (a USB mic waking from idle, T4.39) is waited for: `open`
//!   only starts the open and the worker asks `opened` each step, so the key tap and the receipts
//!   go on meanwhile, and the stream is used the moment it arrives, for as long as the session
//!   still wants it. The worker runs one open at a time: a new one starts only once the last one
//!   answered, failed, or was given up. It gives one up when the mic is no longer wanted, when the
//!   stream is rebuilt or the Mac woke, when the stream posts `Lost` before the answer (a failed
//!   open), and when a new press finds it already `MIC_WAIT_MS` old (it may be stuck, not slow).
//!   A given-up open is not waited for: its backend thread finishes it, drops the stream it gets,
//!   and ends; one stuck in the OS stays behind. A press that has waited `MIC_WAIT_MS` for a device
//!   not open yet, or whose open failed, is told so (`mic.failed`, the pill's "The microphone
//!   didn't open"); so is a session that ends before the device opened.
//! - **A device that will not open** is said once (`warn mic-open`) and tried again after
//!   `RETRY_MS`; a session waiting for its first sample never starts (`mic::MicEvent::Vanished`).
//!   The grant is re-checked, as for any session that fails to start.
//! - **Which device** is `inputs::choose` over the backend's list at each open (DC-N5): pinned,
//!   or the built-in mic over a Bluetooth default, or the default. A stream that dies is reopened
//!   at once on the next device, the dead one skipped until the stream next closes, so a session
//!   in progress goes on with a gap of about one step.

use std::io::{BufRead, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::time::Duration;

use super::inputs::{self, Choice, Input, Policy, Transport};
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
/// A press that has waited this long for a device still opening is told (T4.39); the open goes on.
pub const MIC_WAIT_MS: u64 = 3_000;
const RATE: u32 = 16_000;

/// The microphone, per OS.
pub trait Device {
    /// The inputs listed now, with their transport (DC-N5). Empty when the backend cannot list
    /// them: the system default is opened.
    fn inputs(&mut self) -> Vec<Input>;
    /// A laptop's lid is closed, where the OS reports it: its built-in mic hears nothing.
    fn lid_closed(&mut self) -> bool;
    /// Starts opening the device with this id (or `default`), which delivers `Event::Chunk` on
    /// `events` once it is open. Returns at once: a device slow to open must not hold the worker
    /// (T4.39). An error here is one known without waiting; `opened` gives the outcome.
    fn open(&mut self, device: &str, events: SyncSender<Event>) -> Result<(), String>;
    /// How the last `open` went: `None` while it is still under way, then its outcome.
    fn opened(&mut self) -> Option<Result<(), String>>;
    /// Stops the stream, or gives up an open still under way without waiting for it.
    fn close(&mut self);
}

/// What reaches the worker.
pub enum Msg {
    /// A line from the app; `None` when stdin closed.
    Line(Option<String>),
    /// From the device stream of this open (`Mic::stream`); an older stream's events are stale.
    Mic(u64, Event),
    /// The tap queued something.
    Tap,
    /// A line a backend thread has for the app (the portal's `warn portal-bind`).
    Say(String),
    /// The key tap came up after `ready` (the Accessibility grant arrived while the helper ran,
    /// akou-qpn): the backend's name and the microphone grant now, for the fresh `ready`. Only
    /// the macOS tap thread sends it.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Tapped {
        backend: &'static str,
        mic: &'static str,
    },
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
    tx: Sender<Msg>,
    /// Counts the opens, so a dead stream's late error or buffer never reaches the next one.
    stream: u64,
    policy: Policy,
    /// The device open now, or last opened.
    current: Option<Choice>,
    /// Devices whose stream died, skipped until the stream next closes.
    avoid: Vec<String>,
    open: bool,
    /// An open under way since this time, with the device it is for; nothing else opens meanwhile.
    pending: Option<(u64, Choice)>,
    /// The pending open was said slow (`warn mic-open`), so its late success is said too.
    slow: bool,
    /// Since when a press has waited for a device not open (T4.39).
    waited: Option<u64>,
    feed: Feed,
    retry_at: u64,
    failing: bool,
}

impl Mic<'_> {
    fn close(&mut self) {
        if self.open || self.pending.is_some() {
            self.dev.close();
            self.open = false;
            self.pending = None;
        }
    }

    /// The device to open now (DC-N5).
    fn choose(&mut self) -> Result<Choice, String> {
        let list = self.dev.inputs();
        if list.is_empty() {
            // Nothing to check the pin against: it goes straight to `open`, as before DC-N5.
            let pinned = !(self.policy.pinned.is_empty() || self.policy.pinned == "default");
            return Ok(Choice {
                id: if pinned {
                    self.policy.pinned.clone()
                } else {
                    "default".into()
                },
                transport: Transport::Other,
                why: if pinned { "pinned" } else { "default" },
            });
        }
        let lid = self.dev.lid_closed();
        inputs::choose(&list, &self.policy, lid, &self.avoid).ok_or_else(|| {
            if self.avoid.is_empty() {
                "no input device".to_string()
            } else {
                "no input device left after the stream died".to_string()
            }
        })
    }

    /// Opens or closes the device to match what the session wants.
    fn follow(&mut self, d: &mut Dictate, t: u64, out: &mut dyn Out) {
        let want = d.mic_open();
        if !want {
            self.close();
            self.retry_at = 0;
            self.avoid.clear();
            self.waited = None;
            d.set_mic_down(false);
            return;
        }
        // A new press does not wait on an open that has already run `MIC_WAIT_MS`: it may be
        // stuck rather than slow, so it is given up and a fresh one started (T4.39).
        if let Some((since, _)) = &self.pending
            && self.waited.is_none()
            && d.mic_waiting()
            && t >= *since + MIC_WAIT_MS * MS
        {
            self.reopen();
        }
        if self.pending.is_some() {
            self.settle(d, t, out);
        } else if !self.open && t >= self.retry_at {
            self.start(d, t, out);
        }
        self.tell(d, t, out);
    }

    /// Starts an open on the device chosen now; `settle` takes its outcome.
    fn start(&mut self, d: &mut Dictate, t: u64, out: &mut dyn Out) {
        self.stream += 1;
        let (stream, tx) = (self.stream, self.tx.clone());
        let (events, rx) = mpsc::sync_channel::<Event>(256);
        std::thread::spawn(move || {
            for e in rx {
                if tx.send(Msg::Mic(stream, e)).is_err() {
                    return;
                }
            }
        });
        match self
            .choose()
            .and_then(|c| self.dev.open(&c.id, events).map(|()| c))
        {
            Ok(choice) => {
                self.pending = Some((t, choice));
                self.slow = false;
                d.set_mic_down(true);
                self.settle(d, t, out);
            }
            Err(e) => self.failed(d, t, &e, out),
        }
    }

    /// The pending open's outcome, if it has one: the stream is used from now on, or the open
    /// failed. While it has none, a wait past `MIC_WAIT_MS` is said once.
    fn settle(&mut self, d: &mut Dictate, t: u64, out: &mut dyn Out) {
        let Some((since, _)) = &self.pending else {
            return;
        };
        let since = *since;
        match self.dev.opened() {
            None => {
                if !self.slow && t >= since + MIC_WAIT_MS * MS {
                    self.slow = true;
                    out.line(p::warn(
                        "mic-open",
                        &format!(
                            "the microphone did not open in {} s; still waiting",
                            MIC_WAIT_MS / 1_000
                        ),
                    ));
                }
            }
            Some(Ok(())) => {
                let (_, choice) = self.pending.take().expect("pending");
                if self.slow {
                    out.line(p::warn(
                        "mic-late",
                        &format!("the microphone opened after {} ms", (t - since) / MS),
                    ));
                }
                self.open = true;
                self.failing = false;
                self.feed = Feed::default();
                self.current = Some(choice.clone());
                d.set_mic_down(false);
                d.set_mic(choice, t, out);
                if !d.mic_open() {
                    self.close();
                }
            }
            Some(Err(e)) => {
                self.pending = None;
                // The backend gave up the stream it was opening; nothing is left to close.
                self.failed(d, t, &e, out);
            }
        }
    }

    fn failed(&mut self, d: &mut Dictate, t: u64, e: &str, out: &mut dyn Out) {
        self.retry_at = t + RETRY_MS * MS;
        d.set_mic_down(true);
        if !self.failing {
            self.failing = true;
            out.line(p::warn("mic-open", e));
            d.recheck_grant(out);
        }
    }

    /// A press waiting for its first sample is told when the device failed to open, or has been
    /// opening for `MIC_WAIT_MS` (T4.39): the session still starts if the device opens later.
    fn tell(&mut self, d: &mut Dictate, t: u64, out: &mut dyn Out) {
        if self.open || !d.mic_waiting() {
            self.waited = None;
            return;
        }
        let since = *self.waited.get_or_insert(t);
        let slow = self.pending.is_some() && t >= since + MIC_WAIT_MS * MS;
        let failed = self.pending.is_none() && self.failing;
        if slow || failed {
            d.mic_failed(out);
        }
    }

    fn reopen(&mut self) {
        self.close();
        self.retry_at = 0;
    }

    /// The stream died before its open answered: a failed open of that device, whatever the
    /// answer says later (T4.39). The next open skips it, as for a stream that dies (DC-N5).
    fn lost_opening(&mut self, d: &mut Dictate, t: u64, e: &str, out: &mut dyn Out) {
        if let Some((_, c)) = &self.pending {
            self.avoid.push(c.id.clone());
        }
        self.close();
        self.failed(d, t, e, out);
    }

    /// The stream died: the next open skips this device (DC-N5).
    fn died(&mut self) {
        if self.open
            && let Some(c) = &self.current
        {
            self.avoid.push(c.id.clone());
        }
        self.reopen();
    }
}

/// How the worker waits up to one step for its next message.
pub type Wait<'a> = &'a mut dyn FnMut(&Receiver<Msg>, Duration) -> Result<Msg, RecvTimeoutError>;

/// Runs the worker until `stop` or the end of stdin; returns the exit code.
pub fn serve(
    d: &mut Dictate,
    dev: &mut dyn Device,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
    now: &mut dyn FnMut() -> Now,
    out: &mut dyn Out,
) -> i32 {
    serve_with(
        d,
        dev,
        tx,
        rx,
        now,
        &mut |rx, step| rx.recv_timeout(step),
        out,
    )
}

/// `serve` with the backend's own wait: macOS turns the main run loop in it, where AppKit
/// serves the paste's pasteboard promise (`mac_insert::wait`).
pub fn serve_with(
    d: &mut Dictate,
    dev: &mut dyn Device,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
    now: &mut dyn FnMut() -> Now,
    wait: Wait,
    out: &mut dyn Out,
) -> i32 {
    let mut mic = Mic {
        dev,
        tx,
        stream: 0,
        policy: Policy::default(),
        current: None,
        avoid: Vec::new(),
        open: false,
        pending: None,
        slow: false,
        waited: None,
        feed: Feed::default(),
        retry_at: 0,
        failing: false,
    };
    let mut sleep = Sleep::default();
    // A tap that came up late, until no session or paste is in flight to say so (akou-qpn).
    let mut tapped: Option<(&'static str, &'static str)> = None;
    loop {
        let msg = wait(&rx, Duration::from_millis(STEP_MS));
        let n = now();
        let t = n.awake_ns;
        // A buffer of the stream still opening: its outcome first, so the buffer is used.
        if let Ok(Msg::Mic(stream, _)) = &msg
            && *stream == mic.stream
            && mic.pending.is_some()
        {
            mic.settle(d, t, out);
        }
        if sleep.woke(n) {
            d.recheck_grant(out);
            mic.avoid.clear();
            mic.reopen();
        }
        match msg {
            Ok(Msg::Line(Some(l))) => match Command::parse(&l) {
                Ok(Command::RebuildMic {
                    device,
                    prefer_built_in,
                }) => {
                    mic.policy = Policy {
                        pinned: device,
                        prefer_built_in,
                    };
                    mic.avoid.clear();
                    mic.reopen();
                }
                Ok(c) => {
                    if !d.command(c, t, out) {
                        break;
                    }
                }
                Err(e) => out.line(p::warn("bad-command", &e)),
            },
            Ok(Msg::Line(None)) | Err(RecvTimeoutError::Disconnected) => {
                d.command(Command::Stop, t, out);
                break;
            }
            Ok(Msg::Mic(stream, _))
                if stream != mic.stream || !(mic.open || mic.pending.is_some()) => {}
            Ok(Msg::Mic(_, Event::Chunk(c))) if mic.open => {
                if let Some((at, samples)) = mic.feed.push(&c) {
                    d.audio(at, &samples, out);
                }
            }
            Ok(Msg::Mic(_, Event::Lost { detail, .. })) => {
                out.line(p::warn("mic-lost", &detail));
                if mic.pending.is_some() {
                    mic.lost_opening(d, t, &detail, out);
                } else {
                    mic.died();
                }
            }
            Ok(Msg::Mic(_, Event::Warn { code, msg })) => out.line(p::warn(code, &msg)),
            Ok(Msg::Say(l)) => out.line(l),
            Ok(Msg::Tapped { backend, mic }) => tapped = Some((backend, mic)),
            Ok(Msg::Mic(..) | Msg::Tap) | Err(RecvTimeoutError::Timeout) => {}
        }
        d.pump(t, out);
        d.tick(t, out);
        if let Some((backend, mic)) = tapped
            && d.tap_started(backend, mic, out)
        {
            tapped = None;
        }
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
        fn inputs(&mut self) -> Vec<Input> {
            Vec::new()
        }
        fn lid_closed(&mut self) -> bool {
            false
        }
        fn open(&mut self, device: &str, events: SyncSender<Event>) -> Result<(), String> {
            self.opens.borrow_mut().push(device.to_string());
            if self.fail {
                return Err("no input device".into());
            }
            *self.events.borrow_mut() = Some(events);
            Ok(())
        }
        fn opened(&mut self) -> Option<Result<(), String>> {
            Some(Ok(()))
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

    /// A malformed `insert` is refused without its dictated text reaching stderr (the app logs it).
    #[test]
    fn a_bad_command_does_not_echo_the_dictated_text() {
        let w = World::new();
        let mut d = dictate(&w, Warm::Off);
        let lines = Rc::new(RefCell::new(Vec::new()));
        let mut out = Rec(lines.clone());
        d.begin("test", true, ("granted", "granted"), &mut out);
        let (tx, rx) = mpsc::channel();
        let bad = r#"{"type":"insert","id":"s1","text":"private words","method":"shout"}"#;
        let _ = tx.send(Msg::Line(Some(bad.into())));
        let _ = tx.send(Msg::Line(None));
        let mut now = || Now {
            awake_ns: 10 * MS,
            cont_ns: 10 * MS,
        };
        let mut dev = Dev {
            fail: false,
            opens: Rc::default(),
            events: Rc::default(),
        };
        let fwd = tx.clone();
        serve(&mut d, &mut dev, fwd, rx, &mut now, &mut out);
        let l = lines.borrow();
        assert!(l.iter().any(|x| x.contains("bad-command")), "{l:?}");
        assert!(!l.iter().any(|x| x.contains("private words")), "{l:?}");
    }

    /// akou-qpn: the tap thread's late tap reaches the worker, which says `ready` again with keys
    /// swallowed and Accessibility granted.
    #[test]
    fn a_late_tap_says_ready_again() {
        let w = World::new();
        let mut d = dictate(&w, Warm::Off);
        let lines = Rc::new(RefCell::new(Vec::new()));
        let mut out = Rec(lines.clone());
        d.begin("test", false, ("granted", "denied"), &mut out);
        let (tx, rx) = mpsc::channel();
        let _ = tx.send(Msg::Tapped {
            backend: "test",
            mic: "granted",
        });
        let _ = tx.send(Msg::Line(None));
        let mut now = || Now {
            awake_ns: 10 * MS,
            cont_ns: 10 * MS,
        };
        let mut dev = Dev {
            fail: false,
            opens: Rc::default(),
            events: Rc::default(),
        };
        let fwd = tx.clone();
        serve(&mut d, &mut dev, fwd, rx, &mut now, &mut out);
        let l = lines.borrow();
        let ready: Vec<&String> = l
            .iter()
            .filter(|x| x.contains(r#""type":"ready""#))
            .collect();
        assert_eq!(ready.len(), 2, "{l:?}");
        assert!(ready[1].contains(r#""swallow_keys":true"#), "{}", ready[1]);
        assert!(
            ready[1].contains(r#""accessibility":"granted""#),
            "{}",
            ready[1]
        );
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
        assert_eq!(
            l.iter()
                .filter(|x| x.contains(r#""type":"mic.failed""#))
                .count(),
            1,
            "the press is told once that the microphone did not open (T4.39): {l:?}"
        );
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

    /// Lines and packets, for the audio's timeline.
    struct Tape {
        lines: Rc<RefCell<Vec<String>>>,
        packets: Rc<RefCell<Vec<u8>>>,
    }
    impl Out for Tape {
        fn line(&mut self, l: String) {
            self.lines.borrow_mut().push(l);
        }
        fn packet(&mut self, b: Vec<u8>) {
            self.packets.borrow_mut().extend(b);
        }
    }

    /// DC-N5's fake inputs: the open device delivers 10 ms a step until its stream dies; a dead
    /// device stays listed and opens, but never delivers (a stream that keeps failing).
    #[derive(Default)]
    struct Desk {
        list: Vec<Input>,
        lid: bool,
        opens: Rc<RefCell<Vec<String>>>,
        live: Rc<RefCell<Option<Stream>>>,
    }
    /// The open device and its channel.
    type Stream = (String, SyncSender<Event>);
    impl Device for Desk {
        fn inputs(&mut self) -> Vec<Input> {
            self.list.clone()
        }
        fn lid_closed(&mut self) -> bool {
            self.lid
        }
        fn open(&mut self, device: &str, events: SyncSender<Event>) -> Result<(), String> {
            self.opens.borrow_mut().push(device.to_string());
            *self.live.borrow_mut() = Some((device.to_string(), events));
            Ok(())
        }
        fn opened(&mut self) -> Option<Result<(), String>> {
            Some(Ok(()))
        }
        fn close(&mut self) {
            *self.live.borrow_mut() = None;
        }
    }

    fn desk(lid: bool) -> Desk {
        let input = |id: &str, transport, default| Input {
            id: id.into(),
            transport,
            default,
        };
        Desk {
            list: vec![
                input("headset", Transport::Bluetooth, true),
                input("mac", Transport::BuiltIn, false),
                input("usb", Transport::Other, false),
            ],
            lid,
            ..Desk::default()
        }
    }

    const RELEASE_STEP: u64 = 102;

    /// The app's `lines` first, then the dictation key held from step 2 to `RELEASE_STEP` (1 s),
    /// then stdin closes. At step `die` the open device's stream dies and says so twice, as a
    /// stream error callback does once per failed buffer. Returns the lines, the audio packets and
    /// the devices opened.
    fn hold_on(
        mut desk: Desk,
        lines: &[&str],
        die: Option<u64>,
    ) -> (Vec<String>, Vec<crate::protocol::Packet>, Vec<String>) {
        let w = World::new();
        let mut d = dictate(&w, Warm::Off);
        let tape = Tape {
            lines: Rc::default(),
            packets: Rc::default(),
        };
        let (got, bytes) = (tape.lines.clone(), tape.packets.clone());
        let mut out = tape;
        d.begin("test", true, ("granted", "granted"), &mut out);
        let gate = d.gate();
        let (live, opens) = (desk.live.clone(), desk.opens.clone());
        let dead: RefCell<Vec<String>> = RefCell::default();
        // Device messages sent and not yet taken by the worker.
        let flying = Rc::new(std::cell::Cell::new(0i64));
        let sent = flying.clone();
        let (tx, rx) = mpsc::channel();
        for l in lines {
            let _ = tx.send(Msg::Line(Some((*l).into())));
        }
        let step = RefCell::new(0u64);
        let mut now = || {
            let mut s = step.borrow_mut();
            *s += 1;
            let t = *s * 10 * MS;
            if let Some((id, e)) = live.borrow().as_ref() {
                if Some(*s) == die {
                    dead.borrow_mut().push(id.clone());
                    for _ in 0..2 {
                        let lost = Event::Lost {
                            ch: Ch::Mic,
                            detail: "the device went away".into(),
                        };
                        if e.try_send(lost).is_ok() {
                            sent.set(sent.get() + 1);
                        }
                    }
                } else if !dead.borrow().contains(id)
                    && e.try_send(Event::Chunk(chunk(t - 10 * MS, 16_000, 160)))
                        .is_ok()
                {
                    sent.set(sent.get() + 1);
                }
            }
            // One message a step at most (the chunk), so nothing queues up behind the steps.
            match *s {
                2 | RELEASE_STEP => {
                    gate.event(TapEvent::Key {
                        down: *s == 2,
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
        // A device message on its way (a chunk, the stream's error) is waited for, so a busy
        // machine never lets the fake clock run past it; otherwise a step is a short real wait.
        let mut wait = |rx: &Receiver<Msg>, step: Duration| {
            let long = flying.get() > 0;
            let m = rx.recv_timeout(if long { Duration::from_secs(2) } else { step });
            if let Ok(Msg::Mic(..)) = m {
                flying.set(flying.get() - 1);
            }
            m
        };
        let fwd = tx.clone();
        serve_with(&mut d, &mut desk, fwd, rx, &mut now, &mut wait, &mut out);
        let (packets, _) = crate::protocol::decode_packets(&bytes.borrow()).unwrap();
        let lines = got.borrow().clone();
        let opens = opens.borrow().clone();
        (lines, packets, opens)
    }

    fn started(lines: &[String]) -> Vec<&String> {
        lines
            .iter()
            .filter(|l| l.contains("\"session.started\""))
            .collect()
    }

    /// DC-N5: with a Bluetooth default and a built-in mic the built-in one is opened and the
    /// session says so; with the setting off the default is opened (the positive control); with
    /// the lid closed the Bluetooth default is opened.
    #[test]
    fn dc_n5_the_worker_opens_the_chosen_mic_and_the_session_names_it() {
        let (l, _, opens) = hold_on(desk(false), &[], None);
        assert_eq!(opens.first().map(String::as_str), Some("mac"), "{opens:?}");
        let s = started(&l);
        assert_eq!(s.len(), 1, "{l:?}");
        assert!(
            s[0].contains(r#""mic":{"transport":"built-in","why":"built-in"}"#),
            "{}",
            s[0]
        );

        let off = r#"{"type":"rebuild_mic","device":"","prefer_built_in":false}"#;
        let (l, _, opens) = hold_on(desk(false), &[off], None);
        assert_eq!(opens.first().map(String::as_str), Some("headset"));
        assert!(
            started(&l)[0].contains(r#""mic":{"transport":"bluetooth","why":"default"}"#),
            "{l:?}"
        );

        let (_, _, opens) = hold_on(desk(true), &[], None);
        assert_eq!(
            opens.first().map(String::as_str),
            Some("headset"),
            "a closed lid hides the built-in mic"
        );
    }

    /// DC-N5: a backend that cannot list its inputs still opens the pinned device, and the
    /// default when nothing is pinned (the positive control).
    #[test]
    fn dc_n5_an_unlisted_backend_still_opens_the_pinned_device() {
        let pin = r#"{"type":"rebuild_mic","device":"usb"}"#;
        let (l, _, opens) = hold_on(Desk::default(), &[pin], None);
        assert_eq!(opens.first().map(String::as_str), Some("usb"), "{l:?}");
        assert!(started(&l)[0].contains(r#""why":"pinned""#), "{l:?}");
        let (_, _, opens) = hold_on(Desk::default(), &[], None);
        assert_eq!(opens.first().map(String::as_str), Some("default"));
    }

    /// DC-N5: the pinned device's stream dies mid-session: the session goes on, reopened on the
    /// next device (the built-in mic, not the dead one again), and its audio has no gap longer
    /// than 100 ms. The dead stream's second error is stale and moves nothing.
    #[test]
    fn dc_n5_a_stream_that_dies_mid_session_is_reopened_without_a_gap() {
        let pin = r#"{"type":"rebuild_mic","device":"usb"}"#;
        let (l, packets, opens) = hold_on(desk(false), &[pin], Some(50));
        assert_eq!(opens, ["usb", "mac"], "{l:?}");
        assert_eq!(started(&l).len(), 1, "{l:?}");
        let ended: Vec<&String> = l.iter().filter(|x| x.contains("session.ended")).collect();
        assert_eq!(ended.len(), 1, "{l:?}");
        assert!(ended[0].contains(r#""reason":"release""#), "{l:?}");
        assert!(l.iter().any(|x| x.contains("mic-lost")), "{l:?}");
        let ns_per_frame = 1_000_000_000 / 16_000;
        let end =
            |p: &crate::protocol::Packet| p.capture_ns + p.samples.len() as u64 * ns_per_frame;
        let widest = packets
            .windows(2)
            .map(|w| w[1].capture_ns.saturating_sub(end(&w[0])))
            .max()
            .unwrap_or(0);
        assert!(widest <= 100 * MS, "a gap of {} ms", widest / MS);
        let last = packets.last().map(end).unwrap_or(0);
        assert!(
            last >= RELEASE_STEP * 10 * MS,
            "audio up to the release, got {} ms",
            last / MS
        );
    }

    /// T4.39's device: its open answers when the test says (or at once, from the `quick_from`th
    /// open on), and it delivers 10 ms a step only once it answered yes. With `lost`, its first
    /// open posts `Event::Lost` before it answers. Every open and close is logged, with the step.
    #[derive(Default)]
    struct Late {
        log: Rc<RefCell<Vec<String>>>,
        steps: Rc<RefCell<Vec<u64>>>,
        at: Rc<std::cell::Cell<u64>>,
        answer: Rc<RefCell<Option<Result<(), String>>>>,
        events: Rc<RefCell<Option<SyncSender<Event>>>>,
        up: Rc<std::cell::Cell<bool>>,
        /// Messages sent and not yet read by the worker, so the test's wait knows to block.
        flying: Rc<std::cell::Cell<i64>>,
        quick_from: Option<usize>,
        lost: bool,
        /// The open under way posted `Lost`: its stream never delivers.
        dead: bool,
    }
    impl Late {
        fn note(&mut self, what: String) {
            self.log.borrow_mut().push(what);
            self.steps.borrow_mut().push(self.at.get());
        }
    }
    impl Device for Late {
        fn inputs(&mut self) -> Vec<Input> {
            Vec::new()
        }
        fn lid_closed(&mut self) -> bool {
            false
        }
        fn open(&mut self, device: &str, events: SyncSender<Event>) -> Result<(), String> {
            self.note(format!("open {device}"));
            let opens = self
                .log
                .borrow()
                .iter()
                .filter(|x| x.starts_with("open"))
                .count();
            if self.lost && opens == 1 {
                events
                    .try_send(Event::Lost {
                        ch: Ch::Mic,
                        detail: "the device went away while opening".into(),
                    })
                    .unwrap();
                self.flying.set(self.flying.get() + 1);
                self.dead = true;
            }
            if self.quick_from.is_some_and(|n| opens >= n) {
                *self.answer.borrow_mut() = Some(Ok(()));
            }
            *self.events.borrow_mut() = Some(events);
            Ok(())
        }
        fn opened(&mut self) -> Option<Result<(), String>> {
            let r = self.answer.borrow_mut().take();
            if r == Some(Ok(())) && !self.dead {
                self.up.set(true);
            }
            r
        }
        fn close(&mut self) {
            self.note("close".into());
            *self.events.borrow_mut() = None;
            *self.answer.borrow_mut() = None;
            self.up.set(false);
            self.dead = false;
        }
    }

    /// How a T4.39 run goes: the dictation key held over each `(down, up)` step pair, the
    /// device's open answering yes at step `answer` (never when `None`); with `early` the device
    /// also sends its first buffer the step before, so the worker reads it before the answer.
    struct Hold {
        answer: Option<u64>,
        presses: Vec<(u64, u64)>,
        warm: Warm,
        early: bool,
        lost: bool,
        quick_from: Option<usize>,
    }

    impl Hold {
        fn new(answer: Option<u64>, release: u64) -> Hold {
            Hold {
                answer,
                presses: vec![(2, release)],
                warm: Warm::Off,
                early: false,
                lost: false,
                quick_from: None,
            }
        }
    }

    /// What a T4.39 run gave: the lines, the packets, the device's log with the step of each
    /// entry, and the step the worker reached.
    struct Run {
        lines: Vec<String>,
        packets: Vec<crate::protocol::Packet>,
        log: Vec<String>,
        steps: Vec<u64>,
        at: u64,
    }

    /// Runs `h`; stdin closes 100 steps after the last release.
    fn late_run(h: Hold) -> Run {
        let w = World::new();
        let mut d = dictate(&w, h.warm);
        let tape = Tape {
            lines: Rc::default(),
            packets: Rc::default(),
        };
        let (got, bytes) = (tape.lines.clone(), tape.packets.clone());
        let mut out = tape;
        d.begin("test", true, ("granted", "granted"), &mut out);
        let gate = d.gate();
        let mut dev = Late {
            quick_from: h.quick_from,
            lost: h.lost,
            ..Late::default()
        };
        let (log, steps, clock, ans, events, up) = (
            dev.log.clone(),
            dev.steps.clone(),
            dev.at.clone(),
            dev.answer.clone(),
            dev.events.clone(),
            dev.up.clone(),
        );
        let end = h.presses.iter().map(|p| p.1).max().unwrap() + 100;
        let flying = dev.flying.clone();
        let sent = flying.clone();
        let (tx, rx) = mpsc::channel();
        let step = Rc::new(RefCell::new(0u64));
        let reached = step.clone();
        let mut now = || {
            let mut s = step.borrow_mut();
            *s += 1;
            clock.set(*s);
            let t = *s * 10 * MS;
            // The first buffer of a stream whose answer comes next step: the worker reads the
            // buffer first, as with a real backend whose callback beats its open reply.
            if h.early
                && Some(*s + 1) == h.answer
                && let Some(e) = events.borrow().as_ref()
                && e.try_send(Event::Chunk(chunk(t - 10 * MS, 16_000, 160)))
                    .is_ok()
            {
                sent.set(sent.get() + 1);
            }
            if Some(*s) == h.answer {
                *ans.borrow_mut() = Some(Ok(()));
            }
            if up.get()
                && let Some(e) = events.borrow().as_ref()
                && e.try_send(Event::Chunk(chunk(t - 10 * MS, 16_000, 160)))
                    .is_ok()
            {
                sent.set(sent.get() + 1);
            }
            for &(down, release) in &h.presses {
                if *s == down || *s == release {
                    gate.event(TapEvent::Key {
                        down: *s == down,
                        name: "RightCommand",
                        t_ns: t,
                    });
                }
            }
            if *s == end {
                let _ = tx.send(Msg::Line(None));
            }
            Now {
                awake_ns: t,
                cont_ns: t,
            }
        };
        // Nothing but the device sends a message here, so a step with none in flight is short.
        let mut wait = |rx: &Receiver<Msg>, _: Duration| {
            let long = flying.get() > 0;
            let m = rx.recv_timeout(if long {
                Duration::from_secs(2)
            } else {
                Duration::from_micros(200)
            });
            if let Ok(Msg::Mic(..)) = m {
                flying.set(flying.get() - 1);
            }
            m
        };
        let fwd = tx.clone();
        serve_with(&mut d, &mut dev, fwd, rx, &mut now, &mut wait, &mut out);
        let (packets, _) = crate::protocol::decode_packets(&bytes.borrow()).unwrap();
        let lines = got.borrow().clone();
        let log = log.borrow().clone();
        let steps = steps.borrow().clone();
        let at = *reached.borrow();
        Run {
            lines,
            packets,
            log,
            steps,
            at,
        }
    }

    /// The key held from step 2 to `release`, the device answering yes at step `answer`.
    fn late_hold(
        answer: Option<u64>,
        release: u64,
    ) -> (Vec<String>, Vec<crate::protocol::Packet>, Vec<String>, u64) {
        let r = late_run(Hold::new(answer, release));
        (r.lines, r.packets, r.log, r.at)
    }

    fn told(lines: &[String]) -> usize {
        lines
            .iter()
            .filter(|l| l.contains(r#""type":"mic.failed""#))
            .count()
    }

    /// T4.39: a microphone that opens 4 s after the key-down, past the old 3 s budget, is kept:
    /// it is opened once, never given up and opened again, and the held session records from the
    /// moment it arrives to the release. The press is told at 3 s, and the session starts anyway.
    #[test]
    fn t4_39_a_microphone_that_opens_late_is_kept_and_records() {
        let (l, packets, log, _) = late_hold(Some(402), 602);
        assert_eq!(
            log,
            ["open default", "close"],
            "one open, no second stream: {l:?}"
        );
        let s = started(&l);
        assert_eq!(s.len(), 1, "the late stream starts the session: {l:?}");
        let ended: Vec<&String> = l.iter().filter(|x| x.contains("session.ended")).collect();
        assert_eq!(ended.len(), 1, "{l:?}");
        assert_eq!(told(&l), 1, "{l:?}");
        assert!(l.iter().any(|x| x.contains("mic-late")), "{l:?}");
        let first = packets.first().expect("audio").capture_ns;
        assert!(
            first >= 4_000 * MS,
            "nothing before the open: first at {} ms",
            first / MS
        );
        let ns_per_frame = 1_000_000_000 / 16_000;
        let last = packets
            .last()
            .map(|p| p.capture_ns + p.samples.len() as u64 * ns_per_frame)
            .unwrap();
        assert!(
            last >= 6_000 * MS,
            "audio up to the release, got {} ms",
            last / MS
        );
    }

    /// T4.39's control for unchanged behaviour: a device that answers at once starts the session
    /// at the press with its pre-roll, and nobody is told anything.
    #[test]
    fn t4_39_a_microphone_that_opens_at_once_is_unchanged() {
        let (l, packets, log, _) = late_hold(Some(1), 102);
        assert_eq!(log, ["open default", "close"], "{l:?}");
        assert_eq!(started(&l).len(), 1, "{l:?}");
        assert_eq!(told(&l), 0, "{l:?}");
        assert!(
            !l.iter()
                .any(|x| x.contains("mic-open") || x.contains("mic-late")),
            "{l:?}"
        );
        let first = packets.first().expect("audio").capture_ns;
        assert!(
            first <= 30 * MS,
            "audio from the press, first at {} ms",
            first / MS
        );
    }

    /// T4.39: a microphone that never opens while the key is held 4 s: the open is not abandoned
    /// and retried (one open), the press is told once, no session starts, the key-up still
    /// reaches the worker, which gives the open up at once and runs to the end of stdin.
    #[test]
    fn t4_39_a_microphone_that_never_opens_tells_the_press_once() {
        let r = late_run(Hold::new(None, 402));
        let (l, packets, log, at) = (r.lines, r.packets, r.log, r.at);
        assert_eq!(log, ["open default", "close"], "{l:?}");
        assert!(
            r.steps[1] <= 403,
            "the open is given up at the key-up (402), not at the end: step {}",
            r.steps[1]
        );
        assert_eq!(told(&l), 1, "{l:?}");
        assert!(started(&l).is_empty(), "{l:?}");
        assert!(packets.is_empty());
        assert!(l.iter().any(|x| x.contains("still waiting")), "{l:?}");
        assert!(at >= 502, "the worker ran on to step {at}");
        assert!(l.last().unwrap().contains("stopped"), "{l:?}");
    }

    /// T4.39: a session that ends before its microphone opened (held 1 s, the device answering
    /// at 2 s) is told so at the key-up; the late answer opens nothing for a session gone.
    #[test]
    fn t4_39_a_session_that_ends_before_the_mic_opens_is_told() {
        let r = late_run(Hold::new(Some(202), 102));
        let (l, packets, log) = (r.lines, r.packets, r.log);
        assert_eq!(told(&l), 1, "{l:?}");
        assert!(started(&l).is_empty(), "{l:?}");
        assert!(packets.is_empty());
        assert_eq!(log, ["open default", "close"], "{l:?}");
        assert!(
            r.steps[1] <= 103,
            "the open is given up at the key-up (102), before its answer (202): step {}",
            r.steps[1]
        );
        let up = l
            .iter()
            .position(|x| x.contains(r#""type":"mic.failed""#))
            .unwrap();
        assert!(
            !l[..up].iter().any(|x| x.contains("still waiting")),
            "told at the key-up, before the 3 s mark: {l:?}"
        );
    }

    /// T4.39: the stream's first buffer reaching the worker before the open's answer is read
    /// (a real backend's callback can beat its reply) is used: the outcome is taken first.
    #[test]
    fn t4_39_a_buffer_ahead_of_the_open_answer_is_kept() {
        let r = late_run(Hold {
            early: true,
            ..Hold::new(Some(402), 602)
        });
        let first = r.packets.first().expect("audio").capture_ns;
        assert_eq!(
            first / MS,
            4_000,
            "the buffer that came before the answer is the first audio: {:?}",
            r.lines
        );
    }

    /// T4.39: a stream that posts `Lost` while it is still opening is a failed open, even when
    /// its answer then says yes: the press is told, and a fresh open is tried, which records.
    #[test]
    fn t4_39_a_stream_lost_while_opening_is_a_failed_open() {
        let r = late_run(Hold {
            lost: true,
            quick_from: Some(2),
            ..Hold::new(Some(10), 300)
        });
        let l = &r.lines;
        assert!(l.iter().any(|x| x.contains("mic-lost")), "{l:?}");
        assert_eq!(
            &r.log[..3],
            ["open default", "close", "open default"],
            "the dead stream is closed and a new one opened: {l:?}"
        );
        assert_eq!(told(l), 1, "{l:?}");
        assert_eq!(started(l).len(), 1, "the fresh open records: {l:?}");
    }

    /// T4.39: an open that never answers is not waited on by the next press. With the warm hold
    /// keeping the mic wanted between presses, a press 24 s later gives up the stuck open and
    /// starts a fresh one, which records; only the first press is told.
    #[test]
    fn t4_39_a_stuck_open_is_given_up_by_the_next_press() {
        let r = late_run(Hold {
            presses: vec![(2, 402), (2_402, 2_602)],
            warm: Warm::Auto,
            quick_from: Some(2),
            ..Hold::new(None, 0)
        });
        let l = &r.lines;
        assert_eq!(
            r.log.iter().filter(|x| x.starts_with("open")).count(),
            2,
            "the second press opens again: {:?} {l:?}",
            r.log
        );
        assert!(
            r.steps[1] >= 2_402,
            "the first open is kept while its own press lasts: {:?}",
            r.steps
        );
        assert_eq!(started(l).len(), 1, "the second press records: {l:?}");
        assert_eq!(told(l), 1, "{l:?}");
    }
}
