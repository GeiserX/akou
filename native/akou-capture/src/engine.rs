//! The helper's run loop: one front end in, the Opus file and `akou-capture/1` out.
//!
//! Threads: a stdin reader (commands), a stdout writer (packets, behind a bounded queue so a slow
//! reader never stalls capture: excess packets are dropped and counted, and the app reads that
//! span back from the file), the front end's own threads, and this loop, which owns the aligner,
//! the file, the monitors and stderr.
//!
//! Stop is bounded: the file is finished and `stopped` is written first, then the front end is
//! torn down on its own thread with a deadline. A teardown that hangs (a stale permission once
//! blocked Core Audio forever) cannot keep the file open or the process alive.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::aligner::{Aligner, RATE as TIMELINE_RATE, SLOT, Slot};
use crate::clock::{self, Now};
use crate::health::dead_call::{self, DeadCallMonitor, PermissionSuspect};
use crate::health::device_watch::{Change, DeviceWatch};
use crate::health::stall::{NoBuffers, StallAction, StallMonitor};
use crate::opus_writer::OpusWriter;
use crate::protocol::{self, Ch, Command, exit};
use crate::resample::Decimator3;
use crate::simulate::Faults;
use crate::source::{CallMode, ClockKind, Event, Frontend, Status};

/// Emission latency with devices: their buffers and the resampler lookahead arrive within this.
const DEVICE_LATENCY_NS: u64 = 100_000_000;
/// Emission latency with the file source: only the resampler lookahead.
const DRIVEN_LATENCY_NS: u64 = 20_000_000;
/// The emit latency grows to fit a source whose buffers arrive later than that (a Bluetooth or
/// virtual input), up to this bound: how late a buffer arrived, plus the resampler lookahead.
const MAX_LATENCY_NS: u64 = 400_000_000;
/// Late audio is reported when it starts, then at most once a minute, and in total at stop.
const LATE_WARN_EVERY: Duration = Duration::from_secs(60);
/// Packets waiting for stdout: 5 s of both channels.
const STDOUT_QUEUE: usize = 500;
/// Source events waiting for the loop.
pub const EVENT_QUEUE: usize = 1024;
const TEARDOWN_BUDGET: Duration = Duration::from_secs(2);
const WRITER_DRAIN_BUDGET: Duration = Duration::from_secs(1);
/// Level lines: four a second.
const LEVEL_FRAMES: usize = TIMELINE_RATE as usize / 4;
const STATUS_EVERY: Duration = Duration::from_secs(1);
/// A mic rebuild that failed is tried again after 1 s, doubling up to this.
const MIC_RETRY_MAX: Duration = Duration::from_secs(30);

pub struct RunConfig {
    pub out: PathBuf,
    /// `--mic default`: a changed default input moves the mic to it.
    pub mic_default: bool,
    pub call: CallMode,
    pub faults: Faults,
}

/// Set by SIGINT or SIGTERM: stop as if `stop` had arrived on stdin.
pub static SIGNALLED: AtomicBool = AtomicBool::new(false);

/// How a run ends. `Hang` is the `hang-on-stop` fault: the caller must never exit.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Exit(i32),
    Hang,
}

/// stderr, one JSON line at a time.
#[derive(Clone)]
pub struct Say(Arc<Mutex<Box<dyn Write + Send>>>);

impl Say {
    pub fn new(w: Box<dyn Write + Send>) -> Self {
        Say(Arc::new(Mutex::new(w)))
    }

    pub fn line(&self, s: &str) {
        if let Ok(mut w) = self.0.lock() {
            let _ = w.write_all(s.as_bytes());
            let _ = w.write_all(b"\n");
            let _ = w.flush();
        }
    }
}

enum Input {
    Cmd(Command),
    Unknown(String),
    Eof,
}

fn spawn_stdin(r: Box<dyn Read + Send>) -> Receiver<Input> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut lines = BufReader::new(r);
        let mut line = Vec::new();
        loop {
            line.clear();
            // Bytes, not `read_line`: a line that is not UTF-8 is an unknown command, and only
            // the real end of input (or a pipe that cannot be read) means stop.
            match lines.read_until(b'\n', &mut line) {
                Ok(0) => {
                    let _ = tx.send(Input::Eof);
                    return;
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    let _ = tx.send(Input::Eof);
                    return;
                }
                Ok(_) => {
                    let text = String::from_utf8_lossy(&line);
                    let t = text.trim();
                    if t.is_empty() {
                        continue;
                    }
                    let msg = match Command::parse(t) {
                        Some(c) => Input::Cmd(c),
                        None => Input::Unknown(t.to_string()),
                    };
                    if tx.send(msg).is_err() {
                        return;
                    }
                }
            }
        }
    });
    rx
}

struct Writer {
    tx: Option<SyncSender<Vec<u8>>>,
    handle: Option<JoinHandle<()>>,
    closed: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    warned: bool,
}

impl Writer {
    fn spawn(mut w: Box<dyn Write + Send>) -> Writer {
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(STDOUT_QUEUE);
        let closed = Arc::new(AtomicBool::new(false));
        let c = closed.clone();
        let handle = std::thread::spawn(move || {
            for buf in rx {
                if w.write_all(&buf).and_then(|_| w.flush()).is_err() {
                    c.store(true, Ordering::Relaxed);
                    return;
                }
            }
        });
        Writer {
            tx: Some(tx),
            handle: Some(handle),
            closed,
            dropped: Arc::new(AtomicU64::new(0)),
            warned: false,
        }
    }

    /// Queues packets; never blocks. Returns false when the queue was full.
    fn send(&mut self, buf: Vec<u8>) -> bool {
        let Some(tx) = &self.tx else {
            return false;
        };
        match tx.try_send(buf) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                false
            }
            Err(TrySendError::Disconnected(_)) => {
                self.closed.store(true, Ordering::Relaxed);
                false
            }
        }
    }

    fn closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    /// Lets queued packets out, within a deadline.
    fn finish(&mut self) {
        drop(self.tx.take());
        if let Some(h) = self.handle.take() {
            let (done_tx, done_rx) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = h.join();
                let _ = done_tx.send(());
            });
            let _ = done_rx.recv_timeout(WRITER_DRAIN_BUDGET);
        }
    }
}

/// Everything the loop holds for one part.
struct Part {
    say: Say,
    out: Writer,
    aligner: Aligner,
    opus: OpusWriter,
    dec: [Decimator3; 2],
    on: [bool; 2],
    anchor: Now,
    now: Now,
    muted: bool,
    first: [bool; 2],
    level_sum: [f64; 2],
    level_n: usize,
    dead: Option<DeadCallMonitor>,
    suspect: Option<PermissionSuspect>,
    /// The mic's stall rule; the call side has the dead-call rule instead.
    stall: StallMonitor,
    no_buffers: NoBuffers,
    watch_in: DeviceWatch,
    watch_out: DeviceWatch,
    status: Status,
    faults: Faults,
    /// The simulated stall: nothing more goes out.
    stalled: bool,
    probe_by_command: bool,
    /// When the dead-call monitor's probe started; a verdict that never comes counts as silence.
    probe_since: Option<f64>,
    /// `cont - awake` offsets and the awake time each took effect: a sleep changes it, and a slot
    /// captured before the sleep keeps the old one even if it is emitted after.
    offsets: Vec<(u64, u64)>,
    rebuilds: [u32; 2],
    /// Mic rebuilds failed in a row, and when to try again. Nothing else would look at a lost
    /// mic whose rebuild failed: a pinned mic has no default to watch, and the stall rule waits
    /// for a running device.
    mic_fails: u32,
    mic_retry: Option<Instant>,
    /// How long after slot time a slot goes out; grows to fit a slow source.
    latency: u64,
    /// Late frames per channel already reported, and when.
    late_reported: [u64; 2],
    late_warned_at: [Option<Instant>; 2],
    pkt: Vec<u8>,
    out16: Vec<f32>,
}

enum Flow {
    Continue,
    Stop(&'static str),
    Crash,
}

impl Part {
    /// Moves the clock; a change of `cont - awake` is a sleep, effective from the last reading.
    fn set_now(&mut self, n: Now) {
        let off = n.cont_ns.wrapping_sub(n.awake_ns);
        let last = self.offsets.last().map_or(0, |o| o.1);
        if off.abs_diff(last) > 1_000_000 {
            self.offsets.push((self.now.awake_ns, off));
            if self.offsets.len() > 8 {
                self.offsets.remove(0);
            }
        }
        self.now = n;
    }

    fn offset_at(&self, awake_ns: u64) -> u64 {
        self.offsets
            .iter()
            .rev()
            .find(|(from, _)| awake_ns >= *from)
            .or(self.offsets.first())
            .map_or(0, |o| o.1)
    }

    /// A buffer that arrived `lag_ns` after its first sample: the emit latency must cover it.
    fn fit_latency(&mut self, lag_ns: u64) {
        let need = lag_ns.saturating_add(DRIVEN_LATENCY_NS).min(MAX_LATENCY_NS);
        if need > self.latency {
            self.latency = need;
        }
    }

    /// Audio that arrived after its slot went out is dropped and that slot is zero-filled, which
    /// the app cannot tell from a silent device; so it is said on stderr.
    fn report_late(&mut self, at_stop: bool) {
        for ch in Ch::BOTH {
            let i = ch.index();
            let late = self.aligner.stats(ch).late;
            if late <= self.late_reported[i] {
                continue;
            }
            let due =
                at_stop || self.late_warned_at[i].is_none_or(|w| w.elapsed() >= LATE_WARN_EVERY);
            if !due {
                continue;
            }
            self.late_reported[i] = late;
            self.late_warned_at[i] = Some(Instant::now());
            self.say.line(&protocol::warn(
                "late-audio",
                &format!(
                    "{}: {late} frames ({:.0} ms) arrived after their slot went out and were dropped; emit latency now {} ms",
                    ch.name(),
                    late as f64 * 1000.0 / TIMELINE_RATE as f64,
                    self.latency / 1_000_000
                ),
            ));
        }
    }

    fn t_of(&self, awake_ns: u64) -> f64 {
        awake_ns.saturating_sub(self.anchor.awake_ns) as f64 / 1e9
    }

    fn rebuild(&mut self, fe: &mut dyn Frontend, ch: Ch, why: &str) -> Option<Vec<String>> {
        self.rebuilds[ch.index()] += 1;
        match fe.rebuild(ch) {
            Ok(names) => {
                if ch == Ch::Mic {
                    self.mic_fails = 0;
                    self.mic_retry = None;
                }
                self.say.line(&protocol::device(ch, "rebuilt", why));
                Some(names)
            }
            Err(e) => {
                if ch == Ch::Mic {
                    let wait = Duration::from_secs(1 << self.mic_fails.min(5)).min(MIC_RETRY_MAX);
                    self.mic_fails += 1;
                    self.mic_retry = Some(Instant::now() + wait);
                }
                self.say.line(&protocol::warn(
                    "rebuild-failed",
                    &format!("{}: {e}", ch.name()),
                ));
                None
            }
        }
    }

    fn dead_actions(&mut self, fe: &mut dyn Frontend, actions: Vec<dead_call::Action>) {
        let mut health: Vec<(&'static str, f64, u32, String)> = vec![];
        let mut names: Option<Vec<String>> = None;
        for a in actions {
            match a {
                dead_call::Action::Probe => {
                    self.probe_since = Some(self.t_of(self.now.awake_ns));
                    fe.probe_call();
                }
                dead_call::Action::Health {
                    state,
                    silent_for,
                    rebuilds,
                    detail,
                } => health.push((state, silent_for, rebuilds, detail.to_string())),
                dead_call::Action::Rebuild { .. } => {
                    names = self.rebuild(fe, Ch::Call, "dead call side");
                }
            }
        }
        for (state, silent_for, rebuilds, mut detail) in health {
            if let Some(n) = names.as_ref().filter(|n| !n.is_empty()) {
                detail = format!("{detail}; excluding {}", n.join(", "));
            }
            self.say.line(&protocol::health(
                Ch::Call,
                state,
                silent_for.max(0.0),
                rebuilds,
                &detail,
            ));
        }
    }

    /// Writes one slot to the file and the app, and runs the per-slot monitors.
    fn emit(&mut self, fe: &mut dyn Frontend, mut slot: Slot, last: bool) -> Flow {
        let t = slot.file_seconds();
        if let Some(at) = self.faults.crash_at()
            && t >= at
        {
            return Flow::Crash;
        }
        if let Some(at) = self.faults.stall_at()
            && t >= at
        {
            self.stalled = true;
        }
        if self.stalled {
            return Flow::Continue;
        }
        if self.muted {
            slot.ch[0].samples.iter_mut().for_each(|v| *v = 0.0);
            slot.ch[0].heard = false;
        }
        let write = if last && slot.len() < SLOT {
            Ok(())
        } else {
            self.opus.write(&slot.ch[0].samples, &slot.ch[1].samples)
        };
        if let Err(e) = write {
            self.say.line(&protocol::warn(
                "io",
                &format!("writing the audio file: {e}"),
            ));
            return Flow::Stop("io");
        }
        let capture_ns = slot.awake_ns.wrapping_add(self.offset_at(slot.awake_ns));
        self.pkt.clear();
        for ch in Ch::BOTH {
            let c = &slot.ch[ch.index()];
            self.out16.clear();
            self.dec[ch.index()].process(&c.samples, &mut self.out16);
            if !self.on[ch.index()] || (ch == Ch::Call && self.faults.call_omit()) {
                continue;
            }
            if !c.delivered {
                self.out16.iter_mut().for_each(|v| *v = 0.0);
            }
            protocol::encode_packet(&mut self.pkt, ch, !c.delivered, capture_ns, t, &self.out16);
            if c.delivered && !self.first[ch.index()] {
                self.first[ch.index()] = true;
                self.say.line(&protocol::first_audio(ch, capture_ns));
            }
        }
        if !self.pkt.is_empty() && !self.out.send(std::mem::take(&mut self.pkt)) && !self.out.warned
        {
            self.out.warned = true;
            self.say.line(&protocol::warn(
                "stdout-backpressure",
                "the app is not reading packets; dropping them (the file has everything)",
            ));
        }

        // Levels, four a second.
        for ch in Ch::BOTH {
            self.level_sum[ch.index()] += slot.ch[ch.index()]
                .samples
                .iter()
                .map(|v| (*v as f64) * (*v as f64))
                .sum::<f64>();
        }
        self.level_n += slot.len();
        if self.level_n >= LEVEL_FRAMES {
            let db = |s: f64| {
                let rms = (s / self.level_n as f64).sqrt();
                if rms > 1e-6 {
                    ((20.0 * rms.log10()) * 10.0).round() / 10.0
                } else {
                    -120.0
                }
            };
            self.say.line(&protocol::level(
                db(self.level_sum[0]),
                db(self.level_sum[1]),
            ));
            self.level_sum = [0.0; 2];
            self.level_n = 0;
        }

        // Monitors, on the slot's own time.
        let on = self.on;
        let st = self.t_of(slot.awake_ns);
        let any = (self.on[0] && slot.ch[0].delivered) || (self.on[1] && slot.ch[1].delivered);
        if self.no_buffers.tick(st, any) {
            for ch in Ch::BOTH.into_iter().filter(|c| on[c.index()]) {
                self.say.line(&protocol::health(
                    ch,
                    "no-buffers",
                    st,
                    0,
                    "no audio from this source since capturing started",
                ));
            }
        }
        // The stall rule owns the mic only. The call side's "nothing while output runs" is the
        // dead-call rule's, end to end (probe, backoff, cap): a tap-only aggregate delivers
        // nothing when it dies, and a quiet tapped app delivers nothing while other apps play,
        // so a 3 s rebuild there would pre-empt the probe and never stop (DESIGN 2.5).
        if self.on[0] {
            let running = self.status.mic_running;
            for a in self.stall.tick(st, slot.ch[0].delivered, running, false) {
                match a {
                    StallAction::Stalled { silent_for } => self.say.line(&protocol::health(
                        Ch::Mic,
                        "stalled",
                        silent_for,
                        self.stall.rebuilds,
                        "the source stopped delivering while its device is running; rebuilding",
                    )),
                    StallAction::Rebuild { .. } => {
                        self.rebuild(fe, Ch::Mic, "stalled");
                    }
                    StallAction::Recovered { rebuilds } => self.say.line(&protocol::health(
                        Ch::Mic,
                        "ok",
                        0.0,
                        rebuilds,
                        "the source is delivering again",
                    )),
                }
            }
        }
        if self.on[1] {
            let tick = dead_call::Tick {
                t: st,
                output_running: self.status.output_running.unwrap_or(false),
                heard: slot.ch[1].heard,
                paused: false,
            };
            if let Some(d) = self.dead.as_mut() {
                let mut actions = vec![];
                // A probe whose verdict never arrived is taken as "heard nothing". Checked before
                // the tick, so a probe the tick starts is never timed against an older one.
                if d.probing()
                    && self
                        .probe_since
                        .is_some_and(|s| st - s > dead_call::PROBE_S + 2.0)
                {
                    self.probe_since = None;
                    actions.extend(d.probe_result(st, false));
                }
                actions.extend(d.tick(tick));
                self.dead_actions(fe, actions);
            }
            if let Some(s) = self.suspect.as_mut()
                && s.tick(tick)
            {
                self.say.line(&protocol::warn(
                    "permission-suspect",
                    dead_call::PERMISSION_PANE,
                ));
            }
        }
        Flow::Continue
    }

    /// Tells the monitors that time passed paused, so it is never counted as silence.
    fn paused_tick(&mut self) {
        let t = self.t_of(self.now.awake_ns);
        if let Some(d) = self.dead.as_mut() {
            d.tick(dead_call::Tick {
                t,
                output_running: false,
                heard: false,
                paused: true,
            });
        }
        self.stall.tick(t, false, false, true);
    }

    fn poll_status(&mut self, fe: &mut dyn Frontend, call: &CallMode, mic_default: bool) {
        self.status = fe.status();
        if self.on[0] && self.mic_retry.is_some_and(|at| Instant::now() >= at) {
            self.mic_retry = None;
            self.rebuild(fe, Ch::Mic, "retrying a failed rebuild");
        }
        if self.on[0] && mic_default {
            match self.watch_in.observe(self.status.default_input.as_ref()) {
                Some(Change::Changed(d)) => {
                    self.say
                        .line(&protocol::device(Ch::Mic, "changed", &d.name));
                    self.rebuild(fe, Ch::Mic, "default input changed");
                }
                Some(Change::Lost) => self.say.line(&protocol::device(Ch::Mic, "lost", "")),
                None => {}
            }
        }
        if self.on[1] && *call == CallMode::System {
            match self.watch_out.observe(self.status.default_output.as_ref()) {
                Some(Change::Changed(d)) => {
                    self.say
                        .line(&protocol::device(Ch::Call, "changed", &d.name));
                    self.rebuild(fe, Ch::Call, "default output changed");
                }
                Some(Change::Lost) => self.say.line(&protocol::device(Ch::Call, "lost", "")),
                None => {}
            }
        }
    }
}

/// Runs one part to its end. `stdin`, `stdout` and `stderr` are the process's own in the binary
/// and pipes in the tests.
pub fn run(
    cfg: RunConfig,
    mut fe: Box<dyn Frontend>,
    stdin: Box<dyn Read + Send>,
    stdout: Box<dyn Write + Send>,
    stderr: Box<dyn Write + Send>,
) -> Outcome {
    let say = Say::new(stderr);
    let mut caps = fe.caps();
    if crate::simulate::AVAILABLE {
        caps.push("simulate");
    }
    say.line(&protocol::hello(&caps));
    let cmds = spawn_stdin(stdin);
    let hang = cfg.faults.hang_on_stop();

    // A stop before `capturing` cancels the part: nothing was opened, nothing to finish. Any
    // other line is kept for the part, so a `mute` sent during a slow open still mutes it.
    let mut early = Vec::new();
    let mut stop_requested = |cmds: &Receiver<Input>| -> bool {
        loop {
            match cmds.try_recv() {
                Ok(Input::Cmd(Command::Stop)) | Ok(Input::Eof) => return !hang,
                Ok(i) => early.push(i),
                Err(TryRecvError::Empty) => return false,
                Err(TryRecvError::Disconnected) => return !hang,
            }
        }
    };
    if let Some(ms) = cfg.faults.capturing_delay_ms() {
        let end = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < end {
            if stop_requested(&cmds) {
                say.line(&protocol::stopped(0.0, "stop"));
                return Outcome::Exit(exit::OK);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    if let Some(code) = cfg.faults.exit_before_capturing() {
        let kind = if code == exit::PERMISSION {
            "permission"
        } else {
            "open"
        };
        say.line(&protocol::warn(kind, "simulated open failure"));
        return Outcome::Exit(code);
    }
    if stop_requested(&cmds) {
        say.line(&protocol::stopped(0.0, "stop"));
        return Outcome::Exit(exit::OK);
    }

    let (tx, events) = mpsc::sync_channel::<Event>(EVENT_QUEUE);
    let opened = match fe.open(tx) {
        Ok(o) => o,
        Err(e) => {
            say.line(&protocol::warn(e.code, &e.msg));
            teardown(fe, &say);
            return Outcome::Exit(e.exit);
        }
    };
    let serial = (clock::now().cont_ns as u32) | 1;
    let vendor = format!("akou-capture {}", protocol::VERSION);
    let opus = match OpusWriter::create(&cfg.out, serial, &vendor) {
        Ok(w) => w,
        Err(e) => {
            say.line(&protocol::warn(
                "io",
                &format!("cannot create {}: {e}", cfg.out.display()),
            ));
            teardown(fe, &say);
            return Outcome::Exit(exit::IO);
        }
    };
    let driven = fe.clock() == ClockKind::Driven;
    let latency = if driven {
        DRIVEN_LATENCY_NS
    } else {
        DEVICE_LATENCY_NS
    };
    let anchor = clock::now();
    fe.start(anchor);
    say.line(&protocol::capturing(
        opened.mic.as_ref(),
        opened.call.as_ref(),
        &opened.exclude,
        anchor.cont_ns,
    ));

    let on = [opened.mic.is_some(), opened.call.is_some()];
    let mut p = Part {
        say: say.clone(),
        out: Writer::spawn(stdout),
        aligner: Aligner::new(anchor.awake_ns),
        opus,
        dec: [Decimator3::new(), Decimator3::new()],
        on,
        anchor,
        now: anchor,
        muted: false,
        first: [false; 2],
        level_sum: [0.0; 2],
        level_n: 0,
        dead: on[1].then(|| DeadCallMonitor::new(0.0)),
        suspect: (on[1] && fe.permission_suspect()).then(PermissionSuspect::new),
        stall: StallMonitor::new(),
        no_buffers: NoBuffers::default(),
        watch_in: DeviceWatch::starting_at(opened.devices[0].as_ref()),
        watch_out: DeviceWatch::starting_at(opened.devices[1].as_ref()),
        status: Status::default(),
        faults: cfg.faults.clone(),
        stalled: false,
        probe_by_command: false,
        probe_since: None,
        offsets: vec![(0, anchor.cont_ns.wrapping_sub(anchor.awake_ns))],
        rebuilds: [0; 2],
        mic_fails: 0,
        mic_retry: None,
        latency,
        late_reported: [0; 2],
        late_warned_at: [None; 2],
        pkt: Vec::new(),
        out16: Vec::new(),
    };
    let mic_default = on[0] && cfg.mic_default;
    p.poll_status(fe.as_mut(), &cfg.call, mic_default);
    let mut last_status = Instant::now();
    let mut early = early.into_iter();

    let reason: &'static str = 'run: loop {
        // Source events: wait briefly for one, then take whatever else is queued.
        let mut first = match events.recv_timeout(Duration::from_millis(5)) {
            Ok(e) => Some(e),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => break 'run "source-closed",
        };
        let mut handled = 0;
        while let Some(ev) = first.take().or_else(|| events.try_recv().ok()) {
            handled += 1;
            if p.stalled {
                continue;
            }
            match ev {
                Event::Chunk(c) => {
                    if p.on[c.ch.index()] {
                        // Buffers from before the anchor (a mic that ran while the call side
                        // opened) are dropped by the timeline and say nothing about lateness.
                        if c.awake_ns >= p.anchor.awake_ns {
                            let now = if driven { p.now } else { clock::now() };
                            p.fit_latency(now.awake_ns.saturating_sub(c.awake_ns));
                        }
                        p.aligner
                            .push(c.ch, c.awake_ns, c.rate, &c.samples, c.heard);
                    }
                }
                Event::Tick(n) => p.set_now(n),
                Event::Probe { heard } => {
                    let t = p.t_of(p.now.awake_ns);
                    let by_dead = p.dead.as_ref().is_some_and(|d| d.probing());
                    if by_dead {
                        p.probe_since = None;
                        let actions = p
                            .dead
                            .as_mut()
                            .map(|d| d.probe_result(t, heard))
                            .unwrap_or_default();
                        p.dead_actions(fe.as_mut(), actions);
                    }
                    if p.probe_by_command {
                        p.probe_by_command = false;
                        let detail = if heard {
                            "probe heard audio"
                        } else {
                            "probe heard nothing"
                        };
                        p.say.line(&protocol::health(
                            Ch::Call,
                            "probe",
                            0.0,
                            p.rebuilds[1],
                            detail,
                        ));
                    }
                }
                Event::Lost { ch, detail } => {
                    p.say.line(&protocol::device(ch, "lost", &detail));
                    p.rebuild(fe.as_mut(), ch, "stream failed");
                }
                Event::Health { ch, state, detail } => {
                    p.say.line(&protocol::health(
                        ch,
                        state,
                        0.0,
                        p.rebuilds[ch.index()],
                        &detail,
                    ));
                }
                Event::Warn { code, msg } => p.say.line(&protocol::warn(code, &msg)),
                Event::Devices => {
                    last_status = Instant::now();
                    p.poll_status(fe.as_mut(), &cfg.call, mic_default);
                }
                Event::Eof => break 'run "eof",
            }
            // With the file source, keep the queue moving: emit after every tick.
            if driven && handled >= 64 {
                break;
            }
        }

        // Commands, those that came before `capturing` first.
        loop {
            match early.next().map_or_else(|| cmds.try_recv(), Ok) {
                Ok(Input::Cmd(Command::Stop)) | Ok(Input::Eof) => {
                    if hang {
                        // A teardown that never returns: no more audio, no exit.
                        return Outcome::Hang;
                    }
                    break 'run "stop";
                }
                Ok(Input::Cmd(Command::Pause)) => {
                    let now = if driven { p.now } else { clock::now() };
                    p.now = now;
                    while let Some(s) = p.aligner.pop_due(now.awake_ns, p.latency) {
                        match p.emit(fe.as_mut(), s, false) {
                            Flow::Continue => {}
                            Flow::Stop(r) => break 'run r,
                            Flow::Crash => return Outcome::Exit(exit::SOFTWARE),
                        }
                    }
                    p.aligner.pause(now.awake_ns);
                }
                Ok(Input::Cmd(Command::Resume)) => {
                    let now = if driven { p.now } else { clock::now() };
                    p.now = now;
                    p.paused_tick();
                    p.aligner.resume(now.awake_ns);
                }
                Ok(Input::Cmd(Command::Mute)) => p.muted = true,
                Ok(Input::Cmd(Command::Unmute)) => p.muted = false,
                Ok(Input::Cmd(Command::RebuildCall)) if p.on[1] => {
                    p.rebuild(fe.as_mut(), Ch::Call, "requested");
                }
                Ok(Input::Cmd(Command::RebuildMic)) if p.on[0] => {
                    p.rebuild(fe.as_mut(), Ch::Mic, "requested");
                }
                Ok(Input::Cmd(Command::ProbeCall)) if p.on[1] => {
                    p.probe_by_command = true;
                    fe.probe_call();
                }
                Ok(Input::Cmd(_)) => {}
                Ok(Input::Unknown(s)) => {
                    p.say.line(&protocol::warn("unknown-command", &s));
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    if hang {
                        return Outcome::Hang;
                    }
                    break 'run "stop";
                }
            }
        }

        if p.out.closed() {
            break 'run "stdout-closed";
        }
        if SIGNALLED.load(Ordering::Relaxed) {
            if hang {
                return Outcome::Hang;
            }
            break 'run "signal";
        }

        if !driven {
            p.set_now(clock::now());
        }
        if last_status.elapsed() >= STATUS_EVERY {
            last_status = Instant::now();
            p.poll_status(fe.as_mut(), &cfg.call, mic_default);
        }
        while let Some(s) = p.aligner.pop_due(p.now.awake_ns, p.latency) {
            match p.emit(fe.as_mut(), s, false) {
                Flow::Continue => {}
                Flow::Stop(r) => break 'run r,
                Flow::Crash => return Outcome::Exit(exit::SOFTWARE),
            }
        }
        p.report_late(false);
    };

    // Finish: the rest of the timeline, the file, the packets, `stopped`, then teardown.
    let now = if driven { p.now } else { clock::now() };
    p.now = now;
    let mut tail: Option<Slot> = None;
    if !p.stalled {
        for s in p.aligner.flush(now.awake_ns) {
            if s.len() < SLOT {
                // `emit` mutes its own copy; the tail goes to the file through `finish`.
                let mut t = s.clone();
                if p.muted {
                    t.ch[0].samples.iter_mut().for_each(|v| *v = 0.0);
                }
                tail = Some(t);
                if let Flow::Crash = p.emit(fe.as_mut(), s, true) {
                    return Outcome::Exit(exit::SOFTWARE);
                }
            } else if let Flow::Crash = p.emit(fe.as_mut(), s, false) {
                return Outcome::Exit(exit::SOFTWARE);
            }
        }
    }
    p.report_late(true);
    let (tl, tr) = tail
        .as_ref()
        .map(|s| (s.ch[0].samples.as_slice(), s.ch[1].samples.as_slice()))
        .unwrap_or((&[], &[]));
    let seconds = match p.opus.finish(tl, tr) {
        Ok(s) => s,
        Err(e) => {
            p.say.line(&protocol::warn(
                "io",
                &format!("finishing the audio file: {e}"),
            ));
            p.aligner.file_seconds()
        }
    };
    let dropped = p.out.dropped.load(Ordering::Relaxed);
    p.out.finish();
    if dropped > 0 {
        p.say.line(&protocol::warn(
            "stdout-backpressure",
            &format!("{dropped} packet batches were dropped because the app did not read them"),
        ));
    }
    p.say.line(&protocol::stopped(seconds, reason));
    drop(events);
    teardown(fe, &say);
    Outcome::Exit(if reason == "io" { exit::IO } else { exit::OK })
}

/// Tears the front end down on its own thread; gives up after the budget.
fn teardown(fe: Box<dyn Frontend>, say: &Say) {
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::spawn(move || {
        fe.close();
        let _ = done_tx.send(());
    });
    if done_rx.recv_timeout(TEARDOWN_BUDGET).is_err() {
        say.line(&protocol::warn(
            "teardown-timeout",
            "the audio devices did not close within 2 s; exiting anyway",
        ));
    }
}
