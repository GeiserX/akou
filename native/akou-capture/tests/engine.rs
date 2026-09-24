//! The whole helper in process: the file source through the engine, with stdin, stdout and stderr
//! as pipes, checked the way the app reads them.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use akou_capture::clock::Now;
use akou_capture::engine::{self, Outcome, RunConfig};
use akou_capture::file_source::FileSource;
use akou_capture::opus_writer;
use akou_capture::protocol::{self, Ch, Packet};
use akou_capture::protocol::{CallInfo, MicInfo};
use akou_capture::simulate::Faults;
use akou_capture::source::{
    CallMode, Chunk, ClockKind, Event, Frontend, OpenError, Opened, Status,
};
use akou_capture::wav::{self, Wav};

#[derive(Clone, Default)]
struct Shared(Arc<Mutex<Vec<u8>>>);

impl Write for Shared {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// stdin fed line by line; dropping the sender closes it.
struct Stdin {
    rx: Receiver<Vec<u8>>,
    buf: Vec<u8>,
}

impl Read for Stdin {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.buf.is_empty() {
            match self.rx.recv() {
                Ok(b) => self.buf = b,
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len());
        out[..n].copy_from_slice(&self.buf[..n]);
        self.buf.drain(..n);
        Ok(n)
    }
}

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("akou-capture-engine-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

fn tone(freq: f64, rate: u32, secs: f64, amp: f32) -> Vec<f32> {
    (0..(rate as f64 * secs) as usize)
        .map(|i| amp * (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin() as f32)
        .collect()
}

fn stereo(rate: u32, secs: f64) -> Wav {
    let bytes = wav::encode_i16(
        rate,
        &[tone(440.0, rate, secs, 0.3), tone(1_000.0, rate, secs, 0.3)],
    );
    wav::parse(&bytes).unwrap()
}

struct Run {
    handle: std::thread::JoinHandle<Outcome>,
    stdin: Option<Sender<Vec<u8>>>,
    out: Shared,
    err: Shared,
    path: PathBuf,
}

impl Run {
    fn start(name: &str, w: Wav, speed: f64, looped: bool, call: CallMode, faults: Faults) -> Run {
        let call_on = call != CallMode::None;
        let fe = FileSource::new(w, "test.wav", speed, looped, true, call_on, faults.clone());
        Run::with(name, Box::new(fe), call, faults, &[])
    }

    /// The file source at `--speed 0` behind the gates at `gates` seconds of file (see `Gated`).
    /// Returns the run and what opens the gates, one `send(())` each.
    fn gated(name: &str, w: Wav, looped: bool, gates: &[f64]) -> (Run, Sender<()>) {
        let fe = FileSource::new(w, "test.wav", 0.0, looped, true, true, Faults::none());
        let (open, opened) = mpsc::channel();
        let fe = Gated::new(Box::new(fe), gates, opened);
        (
            Run::with(name, Box::new(fe), CallMode::System, Faults::none(), &[]),
            open,
        )
    }

    /// Any front end; the `early` lines are on stdin before the helper starts.
    fn with(
        name: &str,
        fe: Box<dyn Frontend>,
        call: CallMode,
        faults: Faults,
        early: &[&str],
    ) -> Run {
        let path = tmp(name);
        let (tx, rx) = mpsc::channel();
        for l in early {
            tx.send(format!("{l}\n").into_bytes()).unwrap();
        }
        let out = Shared::default();
        let err = Shared::default();
        let cfg = RunConfig {
            out: path.clone(),
            mic_default: false,
            call,
            faults,
        };
        let (o, e) = (out.clone(), err.clone());
        let handle = std::thread::spawn(move || {
            engine::run(
                cfg,
                fe,
                Box::new(Stdin { rx, buf: vec![] }),
                Box::new(o),
                Box::new(e),
            )
        });
        Run {
            handle,
            stdin: Some(tx),
            out,
            err,
            path,
        }
    }

    fn send(&self, cmd: &str) {
        if let Some(s) = &self.stdin {
            let _ = s.send(format!("{cmd}\n").into_bytes());
        }
    }

    fn lines(&self) -> Vec<String> {
        String::from_utf8(self.err.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(String::from)
            .collect()
    }

    fn packets(&self) -> Vec<Packet> {
        let bytes = self.out.0.lock().unwrap().clone();
        let (p, used) = protocol::decode_packets(&bytes).unwrap();
        assert_eq!(used, bytes.len(), "a torn packet on stdout");
        p
    }

    /// Waits for a stderr line containing `what`. The deadline only turns a hang into a failure;
    /// nothing here measures time.
    fn wait_for(&self, what: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !self.lines().iter().any(|l| l.contains(what)) {
            assert!(
                std::time::Instant::now() < deadline,
                "no line with {what}: {:#?}",
                self.lines()
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Waits for the gate at `t` s (see `Gated`): the engine has taken the file up to `t`.
    fn at_gate(&self, t: f64) {
        self.wait_for(&format!(r#""code":"gate","msg":"{t:.2}""#));
    }

    /// Sends `cmds` and waits until the engine has applied them: the helper reports an unknown
    /// line in the order it reads its input, so its report means every line before it was taken.
    fn apply(&self, cmds: &[&str], tag: &str) {
        for c in cmds {
            self.send(c);
        }
        self.send(tag);
        self.wait_for(&format!(r#""code":"unknown-command","msg":"{tag}""#));
    }

    /// Closes stdin (which means stop) and waits for the end.
    fn finish(mut self) -> (Outcome, Self) {
        drop(self.stdin.take());
        self.join()
    }

    /// Waits for the run to end on its own, stdin still open.
    fn join(mut self) -> (Outcome, Self) {
        let h = std::mem::replace(&mut self.handle, std::thread::spawn(|| Outcome::Exit(-1)));
        (h.join().unwrap(), self)
    }
}

/// A driven front end held at gates the test opens, so a test acts at an exact point of the
/// source's own clock rather than after a sleep on the wall clock. Events pass through until a
/// tick reaches the next gate; then it says `warn {code: gate, msg: "<t>"}` through the engine,
/// which prints it once it has taken everything up to that tick, and waits for the test to open
/// the gate. A gate at 0 holds the source before its first buffer.
struct Gated {
    inner: Box<dyn Frontend>,
    gates: Vec<f64>,
    open: Option<Receiver<()>>,
    rx: Option<Receiver<Event>>,
    tx: Option<std::sync::mpsc::SyncSender<Event>>,
}

impl Gated {
    fn new(inner: Box<dyn Frontend>, gates: &[f64], open: Receiver<()>) -> Gated {
        Gated {
            inner,
            gates: gates.to_vec(),
            open: Some(open),
            rx: None,
            tx: None,
        }
    }
}

impl Frontend for Gated {
    fn caps(&self) -> Vec<&'static str> {
        self.inner.caps()
    }
    fn clock(&self) -> ClockKind {
        self.inner.clock()
    }
    fn open(&mut self, tx: std::sync::mpsc::SyncSender<Event>) -> Result<Opened, OpenError> {
        let (itx, irx) = mpsc::sync_channel(engine::EVENT_QUEUE);
        self.tx = Some(tx);
        self.rx = Some(irx);
        self.inner.open(itx)
    }
    fn start(&mut self, anchor: Now) {
        let (Some(tx), Some(rx), Some(open)) = (self.tx.take(), self.rx.take(), self.open.take())
        else {
            return;
        };
        let mut gates = self.gates.clone().into_iter().peekable();
        std::thread::spawn(move || {
            let hold = |t: f64| {
                let gate = Event::Warn {
                    code: "gate",
                    msg: format!("{t:.2}"),
                };
                tx.send(gate).is_ok() && open.recv().is_ok()
            };
            if gates.next_if(|g| *g <= 0.0).is_some() && !hold(0.0) {
                return;
            }
            for ev in rx {
                let t = match &ev {
                    Event::Tick(n) => Some(n.awake_ns.saturating_sub(anchor.awake_ns) as f64 / 1e9),
                    _ => None,
                };
                if tx.send(ev).is_err() {
                    return;
                }
                if let Some(t) = t
                    && let Some(g) = gates.next_if(|g| t >= *g - 1e-9)
                    && !hold(g)
                {
                    return;
                }
            }
        });
        self.inner.start(anchor);
    }
    fn rebuild(&mut self, ch: Ch) -> Result<Vec<String>, String> {
        self.inner.rebuild(ch)
    }
    fn probe_call(&mut self) {
        self.inner.probe_call();
    }
    fn probe_answered(&mut self) -> Option<bool> {
        self.inner.probe_answered()
    }
    fn status(&mut self) -> Status {
        self.inner.status()
    }
    fn close(self: Box<Self>) {
        self.inner.close();
    }
}

/// A driven front end whose sources the test scripts: `delivers(ch, t)` says whether a source
/// sends its 10 ms buffer at `t` seconds, and mic buffers are stamped `mic_lag_ns` before the
/// host clock that carries them (a high-latency input). Output is running, the mic is running.
struct Scripted {
    secs: f64,
    delivers: fn(Ch, f64) -> bool,
    mic_lag_ns: u64,
    tx: Option<std::sync::mpsc::SyncSender<Event>>,
}

impl Frontend for Scripted {
    fn caps(&self) -> Vec<&'static str> {
        vec!["file"]
    }
    fn clock(&self) -> ClockKind {
        ClockKind::Driven
    }
    fn open(&mut self, tx: std::sync::mpsc::SyncSender<Event>) -> Result<Opened, OpenError> {
        self.tx = Some(tx);
        Ok(Opened {
            mic: Some(MicInfo {
                id: "scripted".into(),
                name: "scripted".into(),
                rate: 16_000,
            }),
            call: Some(CallInfo {
                mode: "system".into(),
                rate: 16_000,
            }),
            exclude: vec![],
            ..Default::default()
        })
    }
    fn start(&mut self, anchor: Now) {
        let Some(tx) = self.tx.clone() else { return };
        let (secs, delivers, lag) = (self.secs, self.delivers, self.mic_lag_ns);
        std::thread::spawn(move || {
            let steps = (secs * 100.0) as u64;
            for i in 0..steps {
                let t = i as f64 / 100.0;
                let at = anchor.awake_ns + i * 10_000_000;
                for ch in Ch::BOTH {
                    if !delivers(ch, t) {
                        continue;
                    }
                    let stamp = if ch == Ch::Mic {
                        at.saturating_sub(lag)
                    } else {
                        at
                    };
                    let samples = tone(440.0, 16_000, 0.01, 0.3);
                    let c = Chunk {
                        ch,
                        awake_ns: stamp,
                        rate: 16_000,
                        samples,
                        heard: true,
                    };
                    if tx.send(Event::Chunk(c)).is_err() {
                        return;
                    }
                }
                let end = at + 10_000_000;
                let tick = Now {
                    awake_ns: end,
                    cont_ns: anchor.cont_ns + (end - anchor.awake_ns),
                };
                if tx.send(Event::Tick(tick)).is_err() {
                    return;
                }
            }
            let _ = tx.send(Event::Eof);
        });
    }
    fn rebuild(&mut self, _ch: Ch) -> Result<Vec<String>, String> {
        Ok(vec![])
    }
    fn probe_call(&mut self) {
        if let Some(tx) = &self.tx {
            let _ = tx.try_send(Event::Probe { heard: true });
        }
    }
    fn status(&mut self) -> Status {
        Status {
            output_running: Some(true),
            mic_running: true,
            default_input: None,
            default_output: None,
        }
    }
    fn close(self: Box<Self>) {}
}

/// Runs a scripted front end to its end; returns stderr lines and packets.
fn run_scripted(name: &str, fe: Scripted) -> (Vec<String>, Vec<Packet>) {
    run_frontend(name, Box::new(fe))
}

/// Runs any driven front end to its end; returns stderr lines and packets.
fn run_frontend(name: &str, fe: Box<dyn Frontend>) -> (Vec<String>, Vec<Packet>) {
    run_frontend_as(name, fe, CallMode::System)
}

/// `run_frontend` with the call side captured as `call` says.
fn run_frontend_as(
    name: &str,
    fe: Box<dyn Frontend>,
    call: CallMode,
) -> (Vec<String>, Vec<Packet>) {
    let path = tmp(name);
    let (_tx, rx) = mpsc::channel::<Vec<u8>>();
    let out = Shared::default();
    let err = Shared::default();
    let cfg = RunConfig {
        out: path,
        mic_default: false,
        call,
        faults: Faults::none(),
    };
    let outcome = engine::run(
        cfg,
        fe,
        Box::new(Stdin { rx, buf: vec![] }),
        Box::new(out.clone()),
        Box::new(err.clone()),
    );
    assert_eq!(outcome, Outcome::Exit(0));
    let lines: Vec<String> = String::from_utf8(err.0.lock().unwrap().clone())
        .unwrap()
        .lines()
        .map(String::from)
        .collect();
    let bytes = out.0.lock().unwrap().clone();
    let (packets, _) = protocol::decode_packets(&bytes).unwrap();
    (lines, packets)
}

/// The split of the two rules, from the mic's side: the stall rule still owns a source that
/// clocks on its own. A mic that stops delivering while its device runs is `stalled` and
/// rebuilt every 3 s (positive control for the dead-call tests, where the call side never is).
#[test]
fn a_stalled_mic_is_rebuilt_every_3_s_by_the_stall_rule() {
    let (lines, _) = run_scripted(
        "mic-stall.opus",
        Scripted {
            secs: 12.0,
            delivers: |ch, t| ch == Ch::Call || t < 1.0,
            mic_lag_ns: 0,
            tx: None,
        },
    );
    assert!(
        lines
            .iter()
            .any(|l| l.contains(r#""type":"health","ch":"mic","state":"stalled""#)),
        "{lines:#?}"
    );
    let mic_rebuilds = lines
        .iter()
        .filter(|l| l.contains(r#""type":"device","ch":"mic","event":"rebuilt""#))
        .count();
    // Last audio at 0.99 s: rebuilt at 4, 7 and 10 s.
    assert_eq!(mic_rebuilds, 3, "{lines:#?}");
}

fn late_warns(lines: &[String]) -> Vec<&String> {
    typed(lines, "warn")
        .into_iter()
        .filter(|l| l.contains(r#""code":"late-audio""#))
        .collect()
}

/// A high-latency input (a Bluetooth headset, a virtual device): mic buffers arrive 150 ms after
/// their timestamps, beyond the fixed emit latency. The emit latency grows to fit the source, so
/// the mic is delivered rather than zero-filled as if the device were silent.
#[test]
fn a_mic_that_arrives_late_is_delivered_because_the_latency_grows_to_fit_it() {
    let (lines, packets) = run_scripted(
        "late-mic.opus",
        Scripted {
            secs: 3.0,
            delivers: |_, _| true,
            mic_lag_ns: 150_000_000,
            tx: None,
        },
    );
    let mic: Vec<&Packet> = packets.iter().filter(|p| p.ch == Ch::Mic).collect();
    // The last 150 ms of the timeline has no mic audio: it was still in flight at the end.
    let after: Vec<&&Packet> = mic
        .iter()
        .filter(|p| (0.2..2.8).contains(&p.file_seconds))
        .collect();
    assert!(after.len() > 100);
    assert!(
        after.iter().all(|p| !p.zero_filled),
        "{} of {} mic packets from 0.2 to 2.8 s were zero-filled",
        after.iter().filter(|p| p.zero_filled).count(),
        after.len()
    );
    assert!(late_warns(&lines).is_empty(), "{lines:#?}");
}

/// A source later than the latency may grow to (400 ms) loses audio; that loss is reported as
/// `warn {code: late-audio}` instead of passing for a silent device.
#[test]
fn a_mic_later_than_the_latency_bound_is_reported_as_late_audio() {
    let (lines, _) = run_scripted(
        "later-mic.opus",
        Scripted {
            secs: 3.0,
            delivers: |_, _| true,
            mic_lag_ns: 600_000_000,
            tx: None,
        },
    );
    let late = late_warns(&lines);
    assert!(!late.is_empty(), "{lines:#?}");
    assert!(late[0].contains(r#""msg":"mic: "#), "{}", late[0]);
    assert!(late.iter().all(|l| !l.contains("call: ")));
}

/// Positive control: the same source on time never reports late audio.
#[test]
fn a_mic_on_time_never_reports_late_audio() {
    let (lines, _) = run_scripted(
        "ontime-mic.opus",
        Scripted {
            secs: 3.0,
            delivers: |_, _| true,
            mic_lag_ns: 0,
            tx: None,
        },
    );
    assert!(late_warns(&lines).is_empty(), "{lines:#?}");
}

/// A host-clock front end whose mic runs during `open`, as on macOS where the mic opens first
/// and the call side's open can take seconds: a second of mic buffers is queued before the
/// anchor. Then both sources deliver 10 ms buffers in real time.
struct Live {
    tx: Option<std::sync::mpsc::SyncSender<Event>>,
}

impl Frontend for Live {
    fn caps(&self) -> Vec<&'static str> {
        vec!["file"]
    }
    fn clock(&self) -> ClockKind {
        ClockKind::Host
    }
    fn open(&mut self, tx: std::sync::mpsc::SyncSender<Event>) -> Result<Opened, OpenError> {
        let before = akou_capture::clock::now().awake_ns - 1_000_000_000;
        for i in 0..100 {
            let c = Chunk {
                ch: Ch::Mic,
                awake_ns: before + i * 10_000_000,
                rate: 16_000,
                samples: tone(440.0, 16_000, 0.01, 0.3),
                heard: true,
            };
            tx.send(Event::Chunk(c)).unwrap();
        }
        self.tx = Some(tx);
        Ok(Opened {
            mic: Some(MicInfo {
                id: "live".into(),
                name: "live".into(),
                rate: 16_000,
            }),
            call: Some(CallInfo {
                mode: "system".into(),
                rate: 16_000,
            }),
            exclude: vec![],
            ..Default::default()
        })
    }
    fn start(&mut self, anchor: Now) {
        let Some(tx) = self.tx.clone() else { return };
        std::thread::spawn(move || {
            for i in 0..300u64 {
                let at = anchor.awake_ns + i * 10_000_000;
                let due = at + 10_000_000;
                let now = akou_capture::clock::now().awake_ns;
                if due > now {
                    std::thread::sleep(Duration::from_nanos(due - now));
                }
                for ch in Ch::BOTH {
                    let c = Chunk {
                        ch,
                        awake_ns: at,
                        rate: 16_000,
                        samples: tone(440.0, 16_000, 0.01, 0.3),
                        heard: true,
                    };
                    if tx.send(Event::Chunk(c)).is_err() {
                        return;
                    }
                }
            }
            let _ = tx.send(Event::Eof);
        });
    }
    fn rebuild(&mut self, _ch: Ch) -> Result<Vec<String>, String> {
        Ok(vec![])
    }
    fn probe_call(&mut self) {}
    fn status(&mut self) -> Status {
        Status {
            output_running: Some(true),
            mic_running: true,
            default_input: None,
            default_output: None,
        }
    }
    fn close(self: Box<Self>) {}
}

/// Mic buffers queued before the anchor are dropped by the timeline, so they say nothing about
/// how late a source is: they must not grow the emit latency. The part keeps the 100 ms device
/// latency, not the 400 ms bound.
#[test]
fn mic_buffers_from_before_capturing_do_not_grow_the_emit_latency() {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let out = Shared::default();
    let err = Shared::default();
    let cfg = RunConfig {
        out: tmp("pre-anchor.opus"),
        mic_default: false,
        call: CallMode::System,
        faults: Faults::none(),
    };
    let (o, e) = (out.clone(), err.clone());
    let handle = std::thread::spawn(move || {
        engine::run(
            cfg,
            Box::new(Live { tx: None }),
            Box::new(Stdin { rx, buf: vec![] }),
            Box::new(o),
            Box::new(e),
        )
    });
    // How far the newest mic packet on stdout trails the clock; the least of many looks, so a
    // slow runner that delays one look cannot make the part look slower than it is.
    std::thread::sleep(Duration::from_millis(700));
    let mut least = u64::MAX;
    for _ in 0..40 {
        std::thread::sleep(Duration::from_millis(25));
        let bytes = out.0.lock().unwrap().clone();
        let now = akou_capture::clock::now().cont_ns;
        let (p, _) = protocol::decode_packets(&bytes).unwrap();
        if let Some(last) = p.iter().rev().find(|x| x.ch == Ch::Mic) {
            least = least.min(now.saturating_sub(last.capture_ns));
        }
    }
    drop(tx);
    assert_eq!(handle.join().unwrap(), Outcome::Exit(0));
    assert!(
        least < 250_000_000,
        "mic packets trail the clock by {least} ns"
    );
}

/// A front end whose default output changes 400 ms in, well before the engine's once-a-second
/// status poll. With `notify` it says so with `Event::Devices`, as the Windows device
/// notifications do; without it the change waits for the poll.
struct Notifying {
    notify: bool,
    /// The output the call side reports it opened.
    opened_on: Option<&'static str>,
    changed: Arc<std::sync::atomic::AtomicBool>,
    polls: Arc<Mutex<Vec<std::time::Instant>>>,
    sent: Arc<Mutex<Option<std::time::Instant>>>,
    tx: Option<std::sync::mpsc::SyncSender<Event>>,
}

impl Frontend for Notifying {
    fn caps(&self) -> Vec<&'static str> {
        vec!["file"]
    }
    fn clock(&self) -> ClockKind {
        ClockKind::Host
    }
    fn open(&mut self, tx: std::sync::mpsc::SyncSender<Event>) -> Result<Opened, OpenError> {
        self.tx = Some(tx);
        Ok(Opened {
            mic: None,
            call: Some(CallInfo {
                mode: "system".into(),
                rate: 16_000,
            }),
            exclude: vec![],
            devices: [
                None,
                self.opened_on
                    .map(|id| akou_capture::health::device_watch::DeviceId {
                        id: id.into(),
                        name: id.into(),
                    }),
            ],
        })
    }
    fn start(&mut self, _anchor: Now) {
        let Some(tx) = self.tx.clone() else { return };
        let (notify, changed, sent) = (self.notify, self.changed.clone(), self.sent.clone());
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            changed.store(true, std::sync::atomic::Ordering::SeqCst);
            *sent.lock().unwrap() = Some(std::time::Instant::now());
            if notify {
                let _ = tx.send(Event::Devices);
            }
            std::thread::sleep(Duration::from_millis(300));
            let _ = tx.send(Event::Eof);
        });
    }
    fn rebuild(&mut self, _ch: Ch) -> Result<Vec<String>, String> {
        Ok(vec![])
    }
    fn probe_call(&mut self) {}
    fn status(&mut self) -> Status {
        self.polls.lock().unwrap().push(std::time::Instant::now());
        let id = if self.changed.load(std::sync::atomic::Ordering::SeqCst) {
            "headset"
        } else {
            "speakers"
        };
        Status {
            output_running: Some(false),
            mic_running: false,
            default_input: None,
            default_output: Some(akou_capture::health::device_watch::DeviceId {
                id: id.into(),
                name: id.into(),
            }),
        }
    }
    fn close(self: Box<Self>) {}
}

fn run_notifying(name: &str, notify: bool) -> (Vec<String>, Duration) {
    run_notifying_from(name, notify, None, false)
}

fn run_notifying_from(
    name: &str,
    notify: bool,
    opened_on: Option<&'static str>,
    changed_already: bool,
) -> (Vec<String>, Duration) {
    let (_tx, rx) = mpsc::channel::<Vec<u8>>();
    let err = Shared::default();
    let polls = Arc::new(Mutex::new(vec![]));
    let sent = Arc::new(Mutex::new(None));
    let fe = Notifying {
        notify,
        opened_on,
        changed: Arc::new(std::sync::atomic::AtomicBool::new(changed_already)),
        polls: polls.clone(),
        sent: sent.clone(),
        tx: None,
    };
    let cfg = RunConfig {
        out: tmp(name),
        mic_default: false,
        call: CallMode::System,
        faults: Faults::none(),
    };
    let outcome = engine::run(
        cfg,
        Box::new(fe),
        Box::new(Stdin { rx, buf: vec![] }),
        Box::new(Shared::default()),
        Box::new(err.clone()),
    );
    assert_eq!(outcome, Outcome::Exit(0));
    let lines: Vec<String> = String::from_utf8(err.0.lock().unwrap().clone())
        .unwrap()
        .lines()
        .map(String::from)
        .collect();
    let sent = sent.lock().unwrap().expect("the change happened");
    // How soon after the change the engine asked for the status again.
    let after = polls
        .lock()
        .unwrap()
        .iter()
        .filter(|t| **t >= sent)
        .map(|t| t.duration_since(sent))
        .min()
        .unwrap_or(Duration::MAX);
    (lines, after)
}

/// DESIGN 2.2: a default-device change the OS announces is followed at once, not at the next
/// once-a-second poll, so a changed output is rebuilt with well under a second lost (ROADMAP M3).
#[test]
fn a_device_notification_rebuilds_the_changed_default_at_once() {
    let (lines, after) = run_notifying("notify.opus", true);
    assert!(
        after < Duration::from_millis(200),
        "polled {after:?} after the change"
    );
    assert!(
        lines.iter().any(
            |l| l.contains(r#""type":"device","ch":"call","event":"changed","name":"headset""#)
        ),
        "{lines:#?}"
    );
    assert!(
        lines
            .iter()
            .any(|l| l.contains(r#""type":"device","ch":"call","event":"rebuilt""#)),
        "{lines:#?}"
    );
    // Positive control: without the notification nothing looks before the poll, and the part
    // (which ends 700 ms in, before the first poll at 1 s) never sees the change.
    let (lines, after) = run_notifying("no-notify.opus", false);
    assert!(
        after >= Duration::from_millis(300),
        "polled {after:?} after the change"
    );
    assert!(
        !lines.iter().any(|l| l.contains(r#""event":"rebuilt""#)),
        "{lines:#?}"
    );
}

/// The default output changed while the call side was opening: the source opened on the old
/// one, the first status already names the new one. The part follows it at the first poll.
#[test]
fn a_default_that_changed_during_the_open_is_followed_at_once() {
    let (lines, _) = run_notifying_from("changed-in-open.opus", false, Some("speakers"), true);
    assert!(
        lines.iter().any(
            |l| l.contains(r#""type":"device","ch":"call","event":"changed","name":"headset""#)
        ),
        "{lines:#?}"
    );
    assert!(
        lines.iter().any(|l| l.contains(r#""event":"rebuilt""#)),
        "{lines:#?}"
    );
    // Positive control: a front end that does not say what it opened takes the new default as
    // its starting point, and the stream stays on the old device.
    let (lines, _) = run_notifying_from("changed-in-open-unknown.opus", false, None, true);
    assert!(
        !lines.iter().any(|l| l.contains(r#""event":"rebuilt""#)),
        "{lines:#?}"
    );
}

/// A pinned mic whose stream is lost, and whose rebuild fails `fails` times (the sound server
/// restarting, the device not back yet). Nothing else would ever look at it again: no default
/// to watch, and the stall rule waits for a running device.
struct Flaky {
    fails: u32,
    attempts: Arc<Mutex<Vec<std::time::Instant>>>,
    tx: Option<std::sync::mpsc::SyncSender<Event>>,
}

impl Frontend for Flaky {
    fn caps(&self) -> Vec<&'static str> {
        vec!["file"]
    }
    fn clock(&self) -> ClockKind {
        ClockKind::Host
    }
    fn open(&mut self, tx: std::sync::mpsc::SyncSender<Event>) -> Result<Opened, OpenError> {
        self.tx = Some(tx);
        Ok(Opened {
            mic: Some(MicInfo {
                id: "usb-headset".into(),
                name: "usb-headset".into(),
                rate: 16_000,
            }),
            ..Default::default()
        })
    }
    fn start(&mut self, _anchor: Now) {
        let Some(tx) = self.tx.clone() else { return };
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let _ = tx.send(Event::Lost {
                ch: Ch::Mic,
                detail: "the sound server connection closed".into(),
            });
            std::thread::sleep(Duration::from_millis(2_500));
            let _ = tx.send(Event::Eof);
        });
    }
    fn rebuild(&mut self, _ch: Ch) -> Result<Vec<String>, String> {
        let mut a = self.attempts.lock().unwrap();
        a.push(std::time::Instant::now());
        if a.len() as u32 <= self.fails {
            return Err("no sound server answered".into());
        }
        Ok(vec![])
    }
    fn probe_call(&mut self) {}
    fn status(&mut self) -> Status {
        Status::default()
    }
    fn close(self: Box<Self>) {}
}

fn run_flaky(name: &str, fails: u32) -> (Vec<String>, usize) {
    let (_tx, rx) = mpsc::channel::<Vec<u8>>();
    let err = Shared::default();
    let attempts = Arc::new(Mutex::new(vec![]));
    let fe = Flaky {
        fails,
        attempts: attempts.clone(),
        tx: None,
    };
    let cfg = RunConfig {
        out: tmp(name),
        mic_default: false,
        call: CallMode::None,
        faults: Faults::none(),
    };
    let outcome = engine::run(
        cfg,
        Box::new(fe),
        Box::new(Stdin { rx, buf: vec![] }),
        Box::new(Shared::default()),
        Box::new(err.clone()),
    );
    assert_eq!(outcome, Outcome::Exit(0));
    let lines = String::from_utf8(err.0.lock().unwrap().clone())
        .unwrap()
        .lines()
        .map(String::from)
        .collect();
    let n = attempts.lock().unwrap().len();
    (lines, n)
}

/// A pinned mic lost while its rebuild could not succeed is tried again on a timer, so it comes
/// back once the device or the sound server does, instead of staying silent for the rest of the
/// part.
#[test]
fn a_mic_whose_rebuild_failed_is_tried_again_until_it_comes_back() {
    let (lines, attempts) = run_flaky("flaky-mic.opus", 1);
    assert!(
        lines
            .iter()
            .any(|l| l.contains(r#""type":"warn","code":"rebuild-failed""#)),
        "{lines:#?}"
    );
    assert!(
        lines
            .iter()
            .any(|l| l.contains(r#""type":"device","ch":"mic","event":"rebuilt""#)),
        "{lines:#?}"
    );
    assert_eq!(attempts, 2);
    // Positive control: a mic that never comes back is never reported rebuilt, and the retries
    // back off (1 s, then 2 s) rather than running at every status poll.
    let (lines, attempts) = run_flaky("dead-mic.opus", u32::MAX);
    assert!(
        !lines.iter().any(|l| l.contains(r#""event":"rebuilt""#)),
        "{lines:#?}"
    );
    assert!((2..=3).contains(&attempts), "{attempts} attempts in 2.6 s");
}

fn typed<'a>(lines: &'a [String], t: &str) -> Vec<&'a String> {
    let tag = format!("\"type\":\"{t}\"");
    lines.iter().filter(|l| l.contains(&tag)).collect()
}

fn num_field(line: &str, key: &str) -> f64 {
    let k = format!("\"{key}\":");
    let at = line.find(&k).unwrap() + k.len();
    let rest = &line[at..];
    let end = rest.find([',', '}']).unwrap();
    rest[..end].trim_matches('"').parse().unwrap()
}

#[test]
fn a_wav_runs_end_to_end_into_packets_and_a_stereo_opus_file() {
    // 44.1 kHz in: the resampler runs on both sides.
    let r = Run::start(
        "e2e.opus",
        stereo(44_100, 3.0),
        0.0,
        false,
        CallMode::System,
        Faults::none(),
    );
    let (outcome, r) = r.join();
    assert_eq!(outcome, Outcome::Exit(0));
    let lines = r.lines();
    assert!(lines[0].starts_with(r#"{"type":"hello","protocol":"akou-capture/1""#));
    assert!(
        lines[1].starts_with(r#"{"type":"capturing","mic":{"id":"file","#),
        "{}",
        lines[1]
    );
    assert_eq!(typed(&lines, "first_audio").len(), 2);
    assert!(typed(&lines, "level").len() >= 10);
    let stopped = typed(&lines, "stopped");
    assert_eq!(stopped.len(), 1);
    assert!(stopped[0].contains(r#""reason":"eof""#));
    let secs = num_field(stopped[0], "file_seconds");
    assert!((secs - 3.0).abs() < 0.03, "{secs}");

    // Packets: both channels, 20 ms each, contiguous on the file timeline, host clock stepping.
    let p = r.packets();
    let mic: Vec<&Packet> = p.iter().filter(|x| x.ch == Ch::Mic).collect();
    let call: Vec<&Packet> = p.iter().filter(|x| x.ch == Ch::Call).collect();
    assert_eq!(mic.len(), call.len());
    let mut at = 0.0;
    for (i, m) in mic.iter().enumerate() {
        assert!(
            (m.file_seconds - at).abs() < 1e-9,
            "packet {i} at {}",
            m.file_seconds
        );
        at += m.samples.len() as f64 / 16_000.0;
        assert_eq!(m.capture_ns, call[i].capture_ns);
        if i > 0 && m.samples.len() == 320 {
            assert_eq!(m.capture_ns - mic[i - 1].capture_ns, 20_000_000);
        }
    }
    assert!((at - secs).abs() < 1e-6);
    // Past the first packet everything was delivered on both sides.
    assert!(mic[1..].iter().all(|m| !m.zero_filled));
    assert!(call[1..].iter().all(|m| !m.zero_filled));

    // The file: stereo, the same length, mic left and call right.
    let rec = opus_writer::recover(&r.path).unwrap();
    assert!(rec.ended);
    assert_eq!(rec.channels, 2);
    assert!(
        (rec.seconds() - secs).abs() < 1e-6,
        "{} vs {secs}",
        rec.seconds()
    );
}

#[test]
fn stop_on_stdin_finishes_the_file_and_says_stopped() {
    let (r, _open) = Run::gated("stop.opus", stereo(48_000, 1.0), true, &[0.7]);
    r.at_gate(0.7);
    r.send("stop");
    let (outcome, r) = r.finish();
    assert_eq!(outcome, Outcome::Exit(0));
    let lines = r.lines();
    let stopped = typed(&lines, "stopped");
    assert!(stopped[0].contains(r#""reason":"stop""#));
    // Stopped 0.7 s into the file: everything up to there is in it, nothing after.
    let secs = num_field(stopped[0], "file_seconds");
    assert!((secs - 0.7).abs() < 1e-6, "{secs}");
    assert!((opus_writer::recover(&r.path).unwrap().seconds() - secs).abs() < 1e-6);
}

#[test]
fn pause_drops_audio_and_the_file_continues_where_it_paused() {
    // Paused from 0.4 s to 1.0 s of a 1.4 s source.
    let (r, open) = Run::gated("pause.opus", stereo(48_000, 1.4), false, &[0.4, 1.0]);
    r.at_gate(0.4);
    r.apply(&["pause"], "sync-pause");
    open.send(()).unwrap();
    r.at_gate(1.0);
    r.apply(&["resume"], "sync-resume");
    open.send(()).unwrap();
    let (_, r) = r.join();
    let secs = num_field(typed(&r.lines(), "stopped")[0], "file_seconds");
    // 0.8 s written, not 1.4 s.
    assert!((secs - 0.8).abs() < 1e-6, "{secs}");
    let mic: Vec<Packet> = r
        .packets()
        .into_iter()
        .filter(|p| p.ch == Ch::Mic)
        .collect();
    let mut jump = 0u64;
    for w in mic.windows(2) {
        assert!(
            (w[1].file_seconds - w[0].file_seconds - 0.02).abs() < 1e-9 || w[1].samples.len() < 320
        );
        jump = jump.max(w[1].capture_ns - w[0].capture_ns);
    }
    // The host clock shows the pause; the file position does not.
    assert_eq!(jump, 620_000_000);
}

#[test]
fn mute_zeroes_the_mic_in_packets_and_file_and_unmute_brings_it_back() {
    // Muted from 0.3 s to 0.7 s of a 1 s source.
    let (r, open) = Run::gated("mute.opus", stereo(48_000, 1.0), false, &[0.3, 0.7]);
    r.at_gate(0.3);
    r.apply(&["mute"], "sync-mute");
    open.send(()).unwrap();
    r.at_gate(0.7);
    r.apply(&["unmute"], "sync-unmute");
    open.send(()).unwrap();
    let (_, r) = r.join();
    let p = r.packets();
    let mic: Vec<&Packet> = p.iter().filter(|x| x.ch == Ch::Mic).collect();
    let silent = mic
        .iter()
        .filter(|m| m.samples.iter().all(|v| *v == 0.0))
        .count();
    let loud = mic
        .iter()
        .filter(|m| m.samples.iter().any(|v| v.abs() > 0.05))
        .count();
    // Muted from the first slot not yet out at 0.3 s (0.28 s, with the 20 ms emit latency) to the
    // last one out at 0.7 s: 20 slots. The first of them carries the decimator's tail of the audio
    // before it, so 19 are all zeros.
    assert_eq!((silent, loud), (19, 31));
    // The call side kept going throughout.
    assert!(
        p.iter()
            .filter(|x| x.ch == Ch::Call)
            .all(|c| !c.zero_filled || c.file_seconds == 0.0)
    );
}

/// A part that ends muted on a short last slot: that tail goes to the file through
/// `finish`, and it is muted there too.
#[test]
fn a_part_that_ends_muted_writes_no_mic_in_the_last_short_slot() {
    // 1.01 s at 48 kHz: 50 full 20 ms slots and a 480-sample tail. Muted before any audio.
    let (r, open) = Run::gated("muted-tail.opus", stereo(48_000, 1.01), false, &[0.0]);
    r.at_gate(0.0);
    r.apply(&["mute"], "sync-mute");
    open.send(()).unwrap();
    let (outcome, r) = r.join();
    assert_eq!(outcome, Outcome::Exit(0));
    let mut dec = opus::Decoder::new(48_000, opus::Channels::Stereo).unwrap();
    let mut reader = ogg::reading::PacketReader::new(std::io::BufReader::new(
        std::fs::File::open(&r.path).unwrap(),
    ));
    let mut pcm = vec![0.0f32; 5760 * 2];
    let (mut left, mut right) = (Vec::new(), Vec::new());
    let mut i = 0;
    while let Some(p) = reader.read_packet().unwrap() {
        i += 1;
        if i <= 2 {
            continue;
        }
        let n = dec.decode_float(&p.data, &mut pcm, false).unwrap();
        for f in 0..n {
            left.push(pcm[2 * f]);
            right.push(pcm[2 * f + 1]);
        }
    }
    let peak = |s: &[f32]| s.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    // The call side is audible to the end, so the tail is really in the file.
    assert!(peak(&right[right.len() - 1_000..]) > 0.1);
    assert!(
        peak(&left) < 0.05,
        "mic peak {} in a muted file",
        peak(&left)
    );
}

#[test]
fn call_none_sends_mic_packets_only_and_leaves_the_right_channel_silent() {
    let r = Run::start(
        "mic-only.opus",
        stereo(48_000, 1.0),
        0.0,
        false,
        CallMode::None,
        Faults::none(),
    );
    let (_, r) = r.join();
    let lines = r.lines();
    assert!(lines[1].contains(r#""call":null"#), "{}", lines[1]);
    let p = r.packets();
    assert!(!p.is_empty());
    assert!(p.iter().all(|x| x.ch == Ch::Mic));
}

#[test]
fn an_unknown_command_is_reported_and_ignored() {
    let r = Run::start(
        "unknown.opus",
        stereo(48_000, 1.0),
        1.0,
        true,
        CallMode::System,
        Faults::none(),
    );
    r.send("dance");
    std::thread::sleep(Duration::from_millis(100));
    r.send("stop");
    let (outcome, r) = r.finish();
    assert_eq!(outcome, Outcome::Exit(0));
    assert!(
        r.lines()
            .iter()
            .any(|l| l.contains(r#""code":"unknown-command""#))
    );
}

/// A byte on the command pipe that is not UTF-8 is an unknown command, not the end of input: the
/// part keeps recording until a real `stop`.
#[test]
fn a_command_line_that_is_not_utf8_is_reported_and_does_not_stop_the_part() {
    let r = Run::start(
        "not-utf8.opus",
        stereo(48_000, 1.0),
        1.0,
        true,
        CallMode::System,
        Faults::none(),
    );
    if let Some(s) = &r.stdin {
        s.send(b"\xff\n".to_vec()).unwrap();
    }
    // Wait on what the helper says, never on the wall clock: a slow runner starts the sources late,
    // so a fixed sleep says nothing about how much audio came after the bad line.
    let newest = |r: &Run| {
        r.packets()
            .iter()
            .map(|p| p.file_seconds)
            .fold(0.0, f64::max)
    };
    let until = |r: &Run, what: &str, done: &dyn Fn(&Run) -> bool| {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !done(r) {
            assert!(
                typed(&r.lines(), "stopped").is_empty(),
                "stopped before {what}: {:#?}",
                r.lines()
            );
            assert!(
                std::time::Instant::now() < deadline,
                "no {what}: {:#?}",
                r.lines()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    until(&r, "unknown-command", &|r| {
        r.lines()
            .iter()
            .any(|l| l.contains(r#""code":"unknown-command""#))
    });
    let at_report = newest(&r);
    until(&r, "audio after the report", &|r| {
        newest(r) > at_report + 0.1
    });
    assert!(typed(&r.lines(), "stopped").is_empty(), "{:#?}", r.lines());
    r.send("stop");
    let (outcome, r) = r.finish();
    assert_eq!(outcome, Outcome::Exit(0));
    let secs = num_field(typed(&r.lines(), "stopped")[0], "file_seconds");
    assert!(
        secs > at_report + 0.1,
        "{secs} after the report at {at_report}"
    );
}

/// A call side scripted the way the G4 quiet-tap run saw a process tap (docs/gates/M0-results.md):
/// driven, 16 kHz, 10 ms buffers. The mic always delivers. `call(t)` says what the call side
/// sends at `t` seconds: nothing, or a 1 kHz tone of some amplitude (0: a buffer of zeros)
/// stamped `offset_ns` from `t` on the stream's own clock. The OS reports output running from
/// `running_from`, and says so at once (`Event::Devices`). At `lost_at` the call stream fails
/// (`Event::Lost`), and the engine rebuilds it. A probe hears audio while output runs, and
/// answers at once from its own thread.
///
/// With `probe_at` the probe answers the way the macOS probe does instead: it listens, and
/// returns the moment it hears the app play, which here is `probe_at` s. The script waits there
/// until the engine has asked, then sends that step's call buffer and the verdict right after it,
/// ahead of the tick that makes the buffer's slot due: the order a real probe's verdict and the
/// stream's own audio reach the engine in. `matches` is `probe_matches_call`.
struct Tap {
    secs: f64,
    running_from: f64,
    call: fn(f64) -> Option<(i64, f32)>,
    lost_at: Option<f64>,
    probe_at: Option<f64>,
    matches: bool,
    probe_wanted: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    tx: Option<std::sync::mpsc::SyncSender<Event>>,
}

impl Tap {
    fn new(secs: f64, running_from: f64, call: fn(f64) -> Option<(i64, f32)>) -> Tap {
        Tap {
            secs,
            running_from,
            call,
            lost_at: None,
            probe_at: None,
            matches: false,
            probe_wanted: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
            tx: None,
        }
    }
}

impl Frontend for Tap {
    fn caps(&self) -> Vec<&'static str> {
        vec!["file"]
    }
    fn clock(&self) -> ClockKind {
        ClockKind::Driven
    }
    fn open(&mut self, tx: std::sync::mpsc::SyncSender<Event>) -> Result<Opened, OpenError> {
        self.tx = Some(tx);
        Ok(Opened {
            mic: Some(MicInfo {
                id: "tap-test".into(),
                name: "tap-test".into(),
                rate: 16_000,
            }),
            call: Some(CallInfo {
                mode: "system".into(),
                rate: 16_000,
            }),
            exclude: vec![],
            ..Default::default()
        })
    }
    fn start(&mut self, anchor: Now) {
        let Some(tx) = self.tx.clone() else { return };
        let (secs, from, call, lost_at) = (self.secs, self.running_from, self.call, self.lost_at);
        let (probe_at, wanted) = (self.probe_at, self.probe_wanted.clone());
        let running = self.running.clone();
        std::thread::spawn(move || {
            let steps = (secs * 100.0).round() as u64;
            let mut lost = false;
            let mut answered = false;
            for i in 0..steps {
                let t = i as f64 / 100.0;
                let answer_now = !answered && probe_at.is_some_and(|p| t >= p - 1e-9);
                if answer_now {
                    // The engine asks for the probe as it emits a slot; wait for it.
                    let waited = std::time::Instant::now();
                    while !wanted.load(Ordering::SeqCst) {
                        assert!(
                            waited.elapsed() < Duration::from_secs(10),
                            "no probe was asked by {t} s"
                        );
                        std::thread::sleep(Duration::from_millis(1));
                    }
                }
                let at = anchor.awake_ns + i * 10_000_000;
                let run = t >= from - 1e-9;
                if run != running.swap(run, Ordering::Relaxed) && tx.send(Event::Devices).is_err() {
                    return;
                }
                if !lost && lost_at.is_some_and(|l| t >= l - 1e-9) {
                    lost = true;
                    let _ = tx.send(Event::Lost {
                        ch: Ch::Call,
                        detail: "scripted".into(),
                    });
                }
                let mic = Chunk {
                    ch: Ch::Mic,
                    awake_ns: at,
                    rate: 16_000,
                    samples: vec![0.01; 160],
                    heard: true,
                };
                if tx.send(Event::Chunk(mic)).is_err() {
                    return;
                }
                if let Some((off, amp)) = call(t) {
                    let samples: Vec<f32> = (0..160u64)
                        .map(|k| {
                            let n = (i * 160 + k) as f64;
                            amp * (2.0 * std::f64::consts::PI * 1_000.0 * n / 16_000.0).sin() as f32
                        })
                        .collect();
                    let c = Chunk {
                        ch: Ch::Call,
                        awake_ns: (at as i64 + off) as u64,
                        rate: 16_000,
                        heard: amp != 0.0,
                        samples,
                    };
                    if tx.send(Event::Chunk(c)).is_err() {
                        return;
                    }
                }
                if answer_now {
                    answered = true;
                    wanted.store(false, Ordering::SeqCst);
                    if tx.send(Event::Probe { heard: true }).is_err() {
                        return;
                    }
                }
                let end = at + 10_000_000;
                let tick = Now {
                    awake_ns: end,
                    cont_ns: anchor.cont_ns + (end - anchor.awake_ns),
                };
                if tx.send(Event::Tick(tick)).is_err() {
                    return;
                }
            }
            let _ = tx.send(Event::Eof);
        });
    }
    fn rebuild(&mut self, _ch: Ch) -> Result<Vec<String>, String> {
        Ok(vec![])
    }
    fn probe_call(&mut self) {
        if self.probe_at.is_some() {
            // The script answers when the probe hears the app (see `Tap`).
            self.probe_wanted.store(true, Ordering::SeqCst);
            return;
        }
        // The verdict comes from the probe's own thread, as on macOS, and always arrives.
        let heard = self.running.load(Ordering::Relaxed);
        if let Some(tx) = self.tx.clone() {
            std::thread::spawn(move || tx.send(Event::Probe { heard }));
        }
    }
    fn status(&mut self) -> Status {
        Status {
            output_running: Some(self.running.load(Ordering::Relaxed)),
            mic_running: true,
            default_input: None,
            default_output: None,
        }
    }
    fn probe_matches_call(&self) -> bool {
        self.matches
    }
    fn close(self: Box<Self>) {}
}

/// Seconds on the file timeline of the first call sample at or above `level`, from `from` s.
fn call_onset(packets: &[Packet], from: f64, level: f32) -> f64 {
    for p in packets
        .iter()
        .filter(|p| p.ch == Ch::Call && p.file_seconds >= from)
    {
        if let Some(i) = p.samples.iter().position(|v| v.abs() >= level) {
            return p.file_seconds + i as f64 / 16_000.0;
        }
    }
    panic!("no call audio after {from} s");
}

/// The call samples of the timeline from `from` for `secs` seconds.
fn call_span(packets: &[Packet], from: f64, secs: f64) -> Vec<f32> {
    let mut out = vec![];
    for p in packets.iter().filter(|p| p.ch == Ch::Call) {
        for (i, v) in p.samples.iter().enumerate() {
            let t = p.file_seconds + i as f64 / 16_000.0;
            if t >= from - 1e-9 && t < from + secs - 1e-9 {
                out.push(*v);
            }
        }
    }
    out
}

/// [G4 quiet-tap run] The call side is silent with nothing playing (no buffers at all) for 12 s,
/// then the call starts. The OS reports output running 300 ms before the tap's first buffer,
/// as the status poll can. That is not 12 s of silence while output ran: no probe, no rebuild,
/// no `dead`. The first word is whole and sits where its timestamps say from its first sample.
#[test]
fn the_first_start_after_a_silent_tap_keeps_the_first_word_whole_and_aligned() {
    let (lines, packets) = run_frontend(
        "quiet-tap.opus",
        Box::new(Tap::new(16.0, 11.7, |t| (t >= 12.0).then_some((0, 0.3)))),
    );
    let call_lines: Vec<&String> = lines
        .iter()
        .filter(|l| l.contains(r#""ch":"call""#))
        .filter(|l| l.contains(r#""type":"health""#) || l.contains(r#""type":"device""#))
        .collect();
    assert!(call_lines.is_empty(), "{call_lines:#?}");
    // Within 2 ms: the resampler and decimator add a fixed 1.4 ms to every channel alike.
    let onset = call_onset(&packets, 11.0, 0.05);
    assert!(
        (onset - 12.0).abs() <= 0.002,
        "the word starts at {onset} s, not 12 s"
    );
    // The first 20 ms of the word are there: a 0.3 sine has an RMS of 0.21.
    let first = call_span(&packets, 12.0, 0.02);
    let rms = (first.iter().map(|v| v * v).sum::<f32>() / first.len() as f32).sqrt();
    assert!(rms > 0.18, "first 20 ms RMS {rms}");
    assert!(
        packets
            .iter()
            .filter(|p| p.ch == Ch::Call && p.file_seconds >= 12.0 && p.file_seconds < 15.5)
            .all(|p| !p.zero_filled)
    );
}

/// A call stream that fails and is rebuilt comes back as a new stream on its own clock (here it
/// reads 33 ms earlier, 50 ms after the old one stopped). The engine restarts it on the
/// timeline, so what it carries lands where its timestamps say at once, instead of 17 ms off and
/// slewed back at 1 ms a second.
#[test]
fn a_rebuilt_call_stream_is_aligned_from_its_first_audio() {
    let mut tap = Tap::new(9.0, 0.0, |t| {
        if t < 5.0 {
            Some((0, 0.3))
        } else if t < 5.05 {
            None
        } else {
            Some((-33_000_000, if t >= 6.0 { 0.3 } else { 0.0 }))
        }
    });
    tap.lost_at = Some(5.0);
    let (lines, packets) = run_frontend("rebuilt.opus", Box::new(tap));
    assert!(
        lines
            .iter()
            .any(|l| l.contains(r#""type":"device","ch":"call","event":"rebuilt""#)),
        "{lines:#?}"
    );
    // Within 2 ms, as above; kept on the old clock it would be about 15 ms early.
    let onset = call_onset(&packets, 5.5, 0.05);
    assert!(
        (onset - 5.967).abs() <= 0.002,
        "the audio after the rebuild starts at {onset} s, not 5.967 s"
    );
}

/// The call side's `health` and `device` lines.
fn call_side_lines(lines: &[String]) -> Vec<&String> {
    lines
        .iter()
        .filter(|l| l.contains(r#""ch":"call""#))
        .filter(|l| l.contains(r#""type":"health""#) || l.contains(r#""type":"device""#))
        .collect()
}

/// The `silent_for` of the first `dead` line on the call side.
fn first_dead(lines: &[String]) -> Option<f64> {
    lines
        .iter()
        .find(|l| l.contains(r#""type":"health","ch":"call","state":"dead""#))
        .map(|l| num_field(l, "silent_for"))
}

/// [T0.2] A stream that stops for 1.5 s and comes back. The probe is asked after 1 s and hears
/// the app the moment it plays again, which is the moment the stream's own buffers come back:
/// the verdict reaches the engine before the slot carrying those buffers is due. The stream
/// shows it is alive before the verdict, so the verdict is dropped: no `dead`, no rebuild, no
/// lost first word.
#[test]
fn t0_2_a_probe_that_hears_the_stream_come_back_does_not_rebuild_it() {
    let mut tap = Tap::new(6.0, 0.0, |t| (!(2.0..3.5).contains(&t)).then_some((0, 0.3)));
    tap.probe_at = Some(3.5);
    let (lines, _) = run_frontend("probe-race-stopped.opus", Box::new(tap));
    assert!(call_side_lines(&lines).is_empty(), "{lines:#?}");
}

/// [T0.2] The same for a stream of zeros: 11 s of zeros while output runs, then speech. The probe
/// hears the speech as the stream delivers it, and the verdict is dropped.
#[test]
fn t0_2_a_probe_that_hears_zeros_turn_into_speech_does_not_rebuild_the_stream() {
    let mut tap = Tap::new(14.0, 0.0, |t| {
        Some((0, if (1.0..12.0).contains(&t) { 0.0 } else { 0.3 }))
    });
    tap.probe_at = Some(12.0);
    let (lines, _) = run_frontend("probe-race-zeros.opus", Box::new(tap));
    assert!(call_side_lines(&lines).is_empty(), "{lines:#?}");
}

/// [T0.2] Positive control for the two above: the same probe, the app playing again at 3.5 s,
/// but the stream stays dead. The verdict stands and the call side is rebuilt.
#[test]
fn t0_2_a_probe_that_hears_the_app_while_the_stream_stays_dead_rebuilds_it() {
    let mut tap = Tap::new(6.0, 0.0, |t| (t < 2.0).then_some((0, 0.3)));
    tap.probe_at = Some(3.5);
    let (lines, _) = run_frontend("probe-race-dead.opus", Box::new(tap));
    assert!(
        lines
            .iter()
            .any(|l| l.contains(r#""type":"device","ch":"call","event":"rebuilt""#)),
        "{lines:#?}"
    );
    let silent_for = first_dead(&lines).expect("a dead line");
    assert!((1.0..2.0).contains(&silent_for), "{silent_for}");
}

/// [T0.2] With per-app capture and a probe that reads the whole output (Windows and Linux), a
/// stream that stops delivering waits the full 10 s like zeros: the probe would hear the other
/// apps. Where the probe listens to the same processes (macOS), the same stream is probed after
/// 1 s (positive control).
#[test]
fn t0_2_per_app_capture_probes_no_buffers_after_1_s_only_when_the_probe_matches_the_call() {
    for matches in [false, true] {
        let mut tap = Tap::new(14.0, 0.0, |t| (t < 2.0).then_some((0, 0.3)));
        tap.matches = matches;
        // The app plays on: the probe answers just after the slot that should ask for it.
        tap.probe_at = Some(if matches { 3.1 } else { 12.1 });
        let (lines, _) = run_frontend_as(
            &format!("apps-stopped-{matches}.opus"),
            Box::new(tap),
            CallMode::Apps(vec!["Meeting".into()]),
        );
        let silent_for = first_dead(&lines).expect("a dead line");
        if matches {
            assert!((1.0..2.0).contains(&silent_for), "{silent_for}");
        } else {
            assert!((10.0..11.0).contains(&silent_for), "{silent_for}");
        }
    }
}

#[cfg(feature = "simulate")]
mod faults {
    use super::*;

    fn with(specs: &[&str]) -> Faults {
        let mut f = Faults::none();
        for s in specs {
            f.apply(s).unwrap();
        }
        f
    }

    /// The call side's health lines, as `(state, rebuilds)`.
    fn call_health(lines: &[String]) -> Vec<(String, u32)> {
        typed(lines, "health")
            .iter()
            .filter(|l| l.contains(r#""ch":"call""#))
            .map(|l| {
                let at = l.find(r#""state":""#).unwrap() + 9;
                let state = l[at..at + l[at..].find('"').unwrap()].to_string();
                (state, num_field(l, "rebuilds") as u32)
            })
            .collect()
    }

    fn call_rebuilds(lines: &[String]) -> usize {
        lines
            .iter()
            .filter(|l| l.contains(r#""type":"device","ch":"call","event":"rebuilt""#))
            .count()
    }

    /// A command sent during a slow open is kept for the part, not dropped while the helper
    /// checks for a stop: a `mute` before `capturing` mutes the first packet, and a line it
    /// cannot read is still reported.
    #[test]
    fn commands_before_capturing_are_kept_for_the_part() {
        // The lines are on stdin before the helper starts, so it reads them while it opens; the
        // source is held until the part has taken them.
        let faults = with(&["capturing-delay=300"]);
        let fe = FileSource::new(
            stereo(48_000, 1.0),
            "test.wav",
            0.0,
            false,
            true,
            true,
            faults.clone(),
        );
        let (open, opened) = mpsc::channel();
        let fe = Gated::new(Box::new(fe), &[0.0], opened);
        let r = Run::with(
            "early.opus",
            Box::new(fe),
            CallMode::System,
            faults,
            &["mute", "dance"],
        );
        r.at_gate(0.0);
        r.apply(&[], "sync");
        open.send(()).unwrap();
        let (outcome, r) = r.join();
        assert_eq!(outcome, Outcome::Exit(0));
        let lines = r.lines();
        assert!(
            lines
                .iter()
                .any(|l| l.contains(r#""code":"unknown-command""#)),
            "{lines:#?}"
        );
        let p = r.packets();
        let mic: Vec<&Packet> = p.iter().filter(|x| x.ch == Ch::Mic).collect();
        assert_eq!(mic.len(), 50);
        assert!(
            mic.iter().all(|m| m.samples.iter().all(|v| *v == 0.0)),
            "a mic packet went out unmuted"
        );
    }

    /// The `silent_for` of each `dead` line on the call side.
    fn dead_silent_for(lines: &[String]) -> Vec<f64> {
        typed(lines, "health")
            .into_iter()
            .filter(|l| l.contains(r#""ch":"call""#) && l.contains(r#""state":"dead""#))
            .map(|l| num_field(l, "silent_for"))
            .collect()
    }

    /// [T0.2] The call side stops delivering while output keeps running (a tap-only aggregate
    /// delivers nothing when its IO callback stops: the M0 hour run's 10.5 s gap). No buffers at
    /// all is not a quiet call: after 1 s the probe hears audio, the call side is rebuilt and
    /// `health {state: dead}` goes out, and the next rebuild waits for the backoff. The stall rule
    /// never rebuilds the call side on its own, so there is no rebuild every 3 s and no
    /// `stalled` line.
    #[test]
    fn t0_2_a_call_side_that_stops_delivering_is_rebuilt_within_a_second() {
        let r = Run::start(
            "dead.opus",
            stereo(16_000, 30.0),
            20.0,
            false,
            CallMode::System,
            with(&["call-dead-at=1"]),
        );
        let (_, r) = r.join();
        let lines = r.lines();
        let health = call_health(&lines);
        assert!(health.iter().all(|(s, _)| s != "stalled"), "{health:?}");
        // Dead at 2 s (1 s after the last buffer), again at 12 s (10 s backoff); the 30 s
        // backoff puts the third past the end of the file.
        assert_eq!(
            health,
            vec![("dead".to_string(), 1), ("dead".to_string(), 2)],
            "{health:?}"
        );
        assert_eq!(call_rebuilds(&lines), 2, "{lines:#?}");
        let first = dead_silent_for(&lines)[0];
        assert!((1.0..1.5).contains(&first), "{first}");
        let dead = typed(&lines, "health")
            .into_iter()
            .find(|l| l.contains(r#""state":"dead""#))
            .unwrap();
        assert!(dead.contains("stopped delivering"), "{dead}");
    }

    /// [T0.2] Positive control for the fast path: a call side that keeps delivering buffers, all
    /// zeros, while output runs is a stream carrying silence. It keeps the probe-first 10 s rule,
    /// so real silences are never "repaired" early.
    #[test]
    fn t0_2_a_call_side_of_zeros_waits_the_full_10_s_before_the_probe() {
        let r = Run::start(
            "zeros.opus",
            stereo(16_000, 30.0),
            20.0,
            false,
            CallMode::System,
            with(&["call-zeros-at=1"]),
        );
        let (_, r) = r.join();
        let lines = r.lines();
        // Dead at 11 s and 21 s; the call packets kept coming, flagged delivered, all zeros.
        assert_eq!(
            call_health(&lines),
            vec![("dead".to_string(), 1), ("dead".to_string(), 2)],
            "{lines:#?}"
        );
        let first = dead_silent_for(&lines)[0];
        assert!((10.0..10.5).contains(&first), "{first}");
        let p = r.packets();
        let late: Vec<&Packet> = p
            .iter()
            .filter(|x| x.ch == Ch::Call && x.file_seconds > 1.1)
            .collect();
        assert!(!late.is_empty());
        assert!(
            late.iter()
                .all(|c| !c.zero_filled && c.samples.iter().all(|v| *v == 0.0))
        );
    }

    /// A dead call side that a rebuild brings back: the dead-call rule's rebuild heals it, and
    /// audio returning reports `ok`.
    #[test]
    fn a_call_side_that_a_rebuild_heals_reports_dead_then_ok() {
        let r = Run::start(
            "heal.opus",
            stereo(16_000, 20.0),
            20.0,
            false,
            CallMode::System,
            with(&["call-dead-at=1", "rebuild-heals"]),
        );
        let (_, r) = r.join();
        let lines = r.lines();
        let states: Vec<String> = call_health(&lines).into_iter().map(|h| h.0).collect();
        assert_eq!(states, vec!["dead", "ok"], "{lines:#?}");
        assert_eq!(call_rebuilds(&lines), 1);
    }

    /// The same healing for a stream of zeros: `rebuild-heals` brings its audio back.
    #[test]
    fn a_call_side_of_zeros_that_a_rebuild_heals_reports_dead_then_ok() {
        let r = Run::start(
            "heal-zeros.opus",
            stereo(16_000, 20.0),
            20.0,
            false,
            CallMode::System,
            with(&["call-zeros-at=1", "rebuild-heals"]),
        );
        let (_, r) = r.join();
        let lines = r.lines();
        let states: Vec<String> = call_health(&lines).into_iter().map(|h| h.0).collect();
        assert_eq!(states, vec!["dead", "ok"], "{lines:#?}");
        assert_eq!(call_rebuilds(&lines), 1);
    }

    #[test]
    fn t0_16_call_silent_from_the_start_never_blocks_the_mic() {
        let r = Run::start(
            "silent.opus",
            stereo(48_000, 1.0),
            0.0,
            false,
            CallMode::System,
            with(&["call-silent"]),
        );
        let (_, r) = r.join();
        let p = r.packets();
        let mic: Vec<&Packet> = p.iter().filter(|x| x.ch == Ch::Mic).collect();
        let call: Vec<&Packet> = p.iter().filter(|x| x.ch == Ch::Call).collect();
        assert_eq!(mic[0].file_seconds, 0.0);
        assert_eq!(mic.len(), call.len());
        assert!(
            call.iter()
                .all(|c| c.zero_filled && c.samples.iter().all(|v| *v == 0.0))
        );
        assert!(mic[1..].iter().all(|m| !m.zero_filled));
        let lines = r.lines();
        assert_eq!(typed(&lines, "first_audio").len(), 1);
        assert!(
            typed(&lines, "health")
                .iter()
                .all(|l| !l.contains("no-buffers"))
        );
    }

    #[test]
    fn a_crash_exits_70_without_stopped_and_leaves_a_readable_file() {
        let r = Run::start(
            "crash.opus",
            stereo(48_000, 3.0),
            0.0,
            false,
            CallMode::System,
            with(&["crash-at=2.5"]),
        );
        let (outcome, r) = r.join();
        assert_eq!(outcome, Outcome::Exit(70));
        assert!(typed(&r.lines(), "stopped").is_empty());
        let rec = opus_writer::recover(&r.path).unwrap();
        assert!(!rec.ended);
        // Two seconds of packets, less the encoder's lookahead that only `finish` flushes.
        assert_eq!(rec.last_granule, 2 * 48_000);
        assert_eq!(rec.seconds(), 2.0 - rec.pre_skip as f64 / 48_000.0);
    }

    #[test]
    fn sleep_shows_as_a_host_clock_jump_the_file_does_not_have() {
        let r = Run::start(
            "sleep.opus",
            stereo(48_000, 1.0),
            0.0,
            false,
            CallMode::System,
            with(&["sleep-at=0.5", "sleep-for=3600"]),
        );
        let (_, r) = r.join();
        let mic: Vec<Packet> = r
            .packets()
            .into_iter()
            .filter(|p| p.ch == Ch::Mic)
            .collect();
        let jumps: Vec<(f64, u64)> = mic
            .windows(2)
            .map(|w| (w[1].file_seconds, w[1].capture_ns - w[0].capture_ns))
            .filter(|(_, d)| *d > 1_000_000_000)
            .collect();
        assert_eq!(jumps.len(), 1);
        assert!((jumps[0].0 - 0.5).abs() < 0.03, "{:?}", jumps);
        assert!((jumps[0].1 as f64 / 1e9 - 3600.0).abs() < 0.05);
    }

    #[test]
    fn hang_on_stop_ignores_stop() {
        let r = Run::start(
            "hang.opus",
            stereo(48_000, 1.0),
            1.0,
            true,
            CallMode::System,
            with(&["hang-on-stop"]),
        );
        std::thread::sleep(Duration::from_millis(200));
        r.send("stop");
        let (outcome, r) = r.finish();
        assert_eq!(outcome, Outcome::Hang);
        assert!(typed(&r.lines(), "stopped").is_empty());
    }
}
