//! The Linux front end (DESIGN 2.2): the default source for the mic and the default sink's
//! monitor for the call side.
//!
//! Both go through the PulseAudio native protocol, which PipeWire (`pipewire-pulse`) and
//! PulseAudio both serve, with the pure-Rust `pulseaudio` crate. So one client covers both
//! servers, and the helper links no C audio library: it starts on any Linux, and `--from-wav`
//! works on a machine with no sound server at all.
//!
//! - Streams open at the source's own rate and channel count as 32-bit float (TRAPS T4.21); the
//!   aligner resamples.
//! - The server gives record data no capture time, so buffers are stamped from their arrivals on
//!   `CLOCK_MONOTONIC` by `clock::ArrivalClock`, which removes the delivery jitter.
//! - Device watch is the engine's once-a-second poll of the defaults; a stream whose source
//!   disappears, or a server that goes away, is reported as lost and rebuilt.
//! - The output-running signal is the default sink's state (`running`).
//! - While recording, a logind inhibitor (`systemd-inhibit`, held through a pipe so it ends with
//!   the helper however the helper ends) keeps the machine from sleeping.
//!
//! Every call to the server runs on one worker thread and the engine waits on it with deadlines,
//! so a server that hangs never stalls capture, and a stop always finishes.

use std::ffi::CStr;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender, SyncSender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use futures::executor::block_on;
use pulseaudio::protocol::stream::{BufferAttr, StreamFlags};
use pulseaudio::protocol::{
    DEFAULT_SINK, Prop, Props, PulseError, RecordStreamParams, SampleFormat, SampleSpec, SinkState,
    SourceInfo,
};
use pulseaudio::{Client, ClientError, RecordStream};

use crate::clock;
use crate::convert::{Format, SampleKind, to_mono};
use crate::health::dead_call::PROBE_S;
use crate::health::device_watch::DeviceId;
use crate::protocol::{CallInfo, Ch, MicInfo};
use crate::pulse_rules::{Framer, SETTLE_S, Settle, SourceView, fragment_bytes, pick_mic};
use crate::source::{
    CallMode, Chunk, ClockKind, DeviceConfig, Endpoint, Endpoints, Event, Frontend, OpenError,
    Opened, Status,
};

const CLIENT_NAME: &CStr = c"akou-capture";
const OPEN_BUDGET: Duration = Duration::from_secs(10);
const REBUILD_BUDGET: Duration = Duration::from_secs(3);
const STATUS_BUDGET: Duration = Duration::from_millis(500);
const CLOSE_BUDGET: Duration = Duration::from_millis(600);
/// The longest `open` waits for that: a stream may deliver nothing (a suspended source).
const SETTLE_BUDGET: Duration = Duration::from_secs(1);

fn no_server() -> OpenError {
    OpenError::unavailable(
        "no sound server answered: neither PipeWire (pipewire-pulse) nor PulseAudio is running for this user",
    )
}

/// Connects to the user's sound server: `PULSE_SERVER`, `$XDG_RUNTIME_DIR/pulse/native`, then
/// `/run/user/<uid>/pulse/native` for a helper started without a session environment.
fn connect() -> Result<Client, OpenError> {
    match Client::from_env(CLIENT_NAME) {
        Ok(c) => return Ok(c),
        Err(ClientError::ServerUnavailable) => {}
        Err(e) => return Err(OpenError::unavailable(format!("the sound server: {e}"))),
    }
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    let path = format!("/run/user/{uid}/pulse/native");
    let socket = std::os::unix::net::UnixStream::connect(&path).map_err(|_| no_server())?;
    let cookie = pulseaudio::cookie_path_from_env().and_then(|p| std::fs::read(p).ok());
    Client::new_unix(CLIENT_NAME, socket, cookie)
        .map_err(|e| OpenError::unavailable(format!("the sound server: {e}")))
}

fn gone(e: &ClientError) -> bool {
    matches!(e, ClientError::Disconnected | ClientError::Io(_))
}

fn cstr(b: &CStr) -> String {
    b.to_string_lossy().into_owned()
}

fn view(s: &SourceInfo) -> SourceView {
    SourceView {
        name: cstr(&s.name),
        description: s.description.as_deref().map(cstr).unwrap_or_default(),
        monitor_of: s.monitor_of_sink_name.as_deref().map(cstr),
    }
}

/// One record stream and what it records.
struct Live {
    /// Dropping it deletes the stream on the server.
    _stream: RecordStream,
    source: u32,
    /// Set once the stream has been reported lost, so it is reported once.
    reported: bool,
}

/// Opens a record stream on `src` that sends `ch` chunks to `events`. `settle` is the flag
/// `open` sets when it stops waiting, at a channel's first open; a rebuild has none.
fn record(
    client: &Client,
    src: &SourceInfo,
    ch: Ch,
    events: &SyncSender<Event>,
    received: &Arc<AtomicU64>,
    dropped: &Arc<AtomicU64>,
    settle: Option<&Arc<AtomicBool>>,
) -> Result<(Live, u32), ClientError> {
    let rate = src.sample_spec.sample_rate;
    let channels = src.sample_spec.channels.max(1);
    let spec = SampleSpec {
        format: SampleFormat::Float32Le,
        channels,
        sample_rate: rate,
    };
    let mut props = Props::new();
    let what = if ch == Ch::Mic {
        c"akou microphone"
    } else {
        c"akou call audio"
    };
    props.set(Prop::MediaName, what);
    let params = RecordStreamParams {
        sample_spec: spec,
        channel_map: src.channel_map,
        source_index: Some(src.index),
        buffer_attr: BufferAttr {
            fragment_size: fragment_bytes(rate, channels),
            ..Default::default()
        },
        flags: StreamFlags {
            adjust_latency: true,
            ..Default::default()
        },
        props,
        ..Default::default()
    };
    let format = Format {
        kind: SampleKind::F32,
        channels: channels as usize,
        interleaved: true,
    };
    let mut framer = Framer::new(channels as usize * 4);
    let mut arrivals = clock::ArrivalClock::new(rate);
    let mut hold = Settle::new(settle.is_some());
    let mut whole = Vec::new();
    let (tx, frames, drop_count, released) = (
        events.clone(),
        received.clone(),
        dropped.clone(),
        settle.cloned(),
    );
    // Runs on the client's reader thread: convert, stamp, hand over, never block.
    let sink = move |data: &[u8]| {
        whole.clear();
        framer.push(data, &mut whole);
        if whole.is_empty() {
            return;
        }
        let mut samples = Vec::with_capacity(whole.len() / format.channels / 4);
        let heard = to_mono(format, &[&whole], &mut samples);
        let now = clock::now().awake_ns;
        let awake_ns = arrivals.stamp(now, samples.len());
        frames.fetch_add(samples.len() as u64, Ordering::Relaxed);
        // The first-open hold-back (`pulse_rules::Settle`): it ends with the settle wait in
        // `open`, so nothing after `capturing` is held back.
        if !hold.forward(
            arrivals.seen_s(),
            arrivals.restarts(),
            released.as_ref().is_some_and(|r| r.load(Ordering::Acquire)),
        ) {
            return;
        }
        let chunk = Chunk {
            ch,
            awake_ns,
            rate,
            samples,
            heard,
        };
        if tx.try_send(Event::Chunk(chunk)).is_err() {
            drop_count.fetch_add(1, Ordering::Relaxed);
        }
    };
    let stream = block_on(client.create_record_stream(params, sink))?;
    let got = stream.sample_spec();
    // The closure above converts and stamps with the requested format: the server must use it.
    if got.format != SampleFormat::Float32Le || got.channels != channels || got.sample_rate != rate
    {
        return Err(ClientError::ServerError(PulseError::NotSupported));
    }
    Ok((
        Live {
            _stream: stream,
            source: src.index,
            reported: false,
        },
        rate,
    ))
}

enum Msg {
    Open(Ch, Sender<Result<Info, OpenError>>),
    Status(Sender<Status>),
    Close(Sender<()>),
}

/// What a stream opened, and on which device (the watch's starting point).
enum Info {
    Mic(MicInfo, DeviceId),
    Call(CallInfo, DeviceId),
}

/// The worker's side: the connection and the two streams.
struct Worker {
    cfg: DeviceConfig,
    events: SyncSender<Event>,
    client: Option<Client>,
    live: [Option<Live>; 2],
    /// Frames each stream has delivered since it opened.
    received: [Arc<AtomicU64>; 2],
    /// A stream has been opened on this channel before: a rebuild forwards at once.
    opened: [bool; 2],
    dropped: Arc<AtomicU64>,
    /// Set when `open` stops waiting for the first streams to settle.
    released: Arc<AtomicBool>,
}

impl Worker {
    fn client(&mut self) -> Result<Client, OpenError> {
        if let Some(c) = &self.client {
            return Ok(c.clone());
        }
        let c = connect()?;
        self.client = Some(c.clone());
        Ok(c)
    }

    /// A failed call: forget a connection that has closed, so the next call reconnects.
    fn failed(&mut self, what: &str, e: ClientError) -> OpenError {
        if gone(&e) {
            self.client = None;
            return OpenError::unavailable(format!("{what}: the sound server connection closed"));
        }
        match e {
            ClientError::ServerError(PulseError::NoEntity) => {
                OpenError::no_device(format!("{what}: no such device"))
            }
            ClientError::ServerError(PulseError::AccessDenied) => {
                OpenError::permission(format!("{what}: the sound server refused access"))
            }
            e => OpenError::unavailable(format!("{what}: {e}")),
        }
    }

    fn open(&mut self, ch: Ch) -> Result<Info, OpenError> {
        self.live[ch.index()] = None;
        self.received[ch.index()].store(0, Ordering::Relaxed);
        let client = self.client()?;
        let (src, device) = match ch {
            Ch::Mic => {
                let server =
                    block_on(client.server_info()).map_err(|e| self.failed("the microphone", e))?;
                let sources = block_on(client.list_sources())
                    .map_err(|e| self.failed("the microphone", e))?;
                let views: Vec<SourceView> = sources.iter().map(view).collect();
                let default = server.default_source_name.as_deref().map(cstr);
                let pick = pick_mic(&self.cfg.mic, &views, default.as_deref())?;
                if let Some(pinned) = &pick.fallback_from {
                    let _ = self.events.try_send(Event::Health {
                        ch: Ch::Mic,
                        state: "fallback",
                        detail: format!(
                            "microphone {pinned} is not connected; using the default input"
                        ),
                    });
                }
                let src = sources
                    .into_iter()
                    .find(|s| cstr(&s.name) == pick.source)
                    .ok_or_else(|| {
                        OpenError::no_device(format!("no input named {}", pick.source))
                    })?;
                let device = DeviceId {
                    id: cstr(&src.name),
                    name: view(&src).description,
                };
                (src, device)
            }
            Ch::Call => {
                if matches!(self.cfg.call, CallMode::Apps(_)) {
                    return Err(OpenError::unavailable(
                        "capturing one app is not available on Linux; use --call system",
                    ));
                }
                let sink = block_on(client.sink_info_by_name(DEFAULT_SINK.to_owned()))
                    .map_err(|e| self.failed("the default output", e))?;
                let monitor = sink.monitor_source_index.ok_or_else(|| {
                    OpenError::no_device("the default output has no monitor to record")
                })?;
                let src = block_on(client.source_info(monitor))
                    .map_err(|e| self.failed("the default output's monitor", e))?;
                let device = DeviceId {
                    id: cstr(&sink.name),
                    name: sink.description.as_deref().map(cstr).unwrap_or_default(),
                };
                (src, device)
            }
        };
        let (live, rate) = record(
            &client,
            &src,
            ch,
            &self.events,
            &self.received[ch.index()],
            &self.dropped,
            (!self.opened[ch.index()]).then_some(&self.released),
        )
        .map_err(|e| self.failed("opening the stream", e))?;
        self.live[ch.index()] = Some(live);
        self.opened[ch.index()] = true;
        Ok(match ch {
            Ch::Mic => Info::Mic(
                MicInfo {
                    id: if self.cfg.mic == "default" {
                        "default".into()
                    } else {
                        cstr(&src.name)
                    },
                    name: device.name.clone(),
                    rate,
                },
                device,
            ),
            Ch::Call => Info::Call(
                CallInfo {
                    mode: self.cfg.call.wire(),
                    rate,
                },
                device,
            ),
        })
    }

    /// Reports a live stream as lost, once, so the engine rebuilds it.
    fn lose(&mut self, ch: Ch, detail: &str) {
        if let Some(l) = self.live[ch.index()].as_mut()
            && !l.reported
        {
            l.reported = true;
            let _ = self.events.try_send(Event::Lost {
                ch,
                detail: detail.into(),
            });
        }
    }

    fn status(&mut self) -> Status {
        let mut st = Status::default();
        // After the server went away, keep trying: once it is back, its defaults read as a
        // change and the engine rebuilds both sources onto it.
        let Ok(client) = self.client() else {
            return st;
        };
        let server = match block_on(client.server_info()) {
            Ok(s) => s,
            Err(e) => {
                if gone(&e) {
                    self.client = None;
                    for ch in Ch::BOTH {
                        self.lose(ch, "the sound server connection closed");
                    }
                }
                return st;
            }
        };
        if let Some(name) = server.default_sink_name.as_deref()
            && let Ok(sink) = block_on(client.sink_info_by_name(name.to_owned()))
        {
            st.output_running = Some(sink.state == SinkState::Running);
            st.default_output = Some(DeviceId {
                id: cstr(&sink.name),
                name: sink.description.as_deref().map(cstr).unwrap_or_default(),
            });
        }
        if let Some(name) = server.default_source_name.as_deref()
            && let Ok(src) = block_on(client.source_info_by_name(name.to_owned()))
        {
            st.default_input = Some(DeviceId {
                id: cstr(&src.name),
                name: view(&src).description,
            });
        }
        // A stream whose source went away delivers nothing and says nothing: find it here.
        for ch in Ch::BOTH {
            let Some(index) = self.live[ch.index()].as_ref().map(|l| l.source) else {
                continue;
            };
            match block_on(client.source_info(index)) {
                Ok(_) => {
                    if ch == Ch::Mic {
                        st.mic_running = true;
                    }
                }
                Err(_) => self.lose(ch, "its source went away"),
            }
        }
        st
    }
}

/// The engine's handle on the worker.
struct Handle {
    tx: Sender<Msg>,
    handle: Option<JoinHandle<()>>,
    last: Status,
}

impl Handle {
    fn spawn(
        cfg: DeviceConfig,
        events: SyncSender<Event>,
        received: [Arc<AtomicU64>; 2],
        dropped: Arc<AtomicU64>,
        released: Arc<AtomicBool>,
    ) -> Handle {
        let (tx, rx) = mpsc::channel::<Msg>();
        let handle = std::thread::spawn(move || {
            let mut w = Worker {
                cfg,
                events,
                client: None,
                live: [None, None],
                received,
                opened: [false; 2],
                dropped,
                released,
            };
            for msg in rx {
                match msg {
                    Msg::Open(ch, reply) => {
                        let _ = reply.send(w.open(ch));
                    }
                    Msg::Status(reply) => {
                        let _ = reply.send(w.status());
                    }
                    Msg::Close(reply) => {
                        w.live = [None, None];
                        drop(w.client.take());
                        let _ = reply.send(());
                        return;
                    }
                }
            }
        });
        Handle {
            tx,
            handle: Some(handle),
            last: Status::default(),
        }
    }

    fn open(&self, ch: Ch, budget: Duration) -> Result<Info, OpenError> {
        let (reply, rx) = mpsc::channel();
        self.tx
            .send(Msg::Open(ch, reply))
            .map_err(|_| OpenError::unavailable("the sound server worker is gone"))?;
        rx.recv_timeout(budget).map_err(|_| {
            OpenError::unavailable(format!("the {} did not open in time", ch_label(ch)))
        })?
    }

    /// The server's view now, or the last one when the server does not answer in time.
    fn status(&mut self) -> Status {
        let (reply, rx) = mpsc::channel();
        if self.tx.send(Msg::Status(reply)).is_ok()
            && let Ok(s) = rx.recv_timeout(STATUS_BUDGET)
        {
            self.last = s;
        }
        self.last.clone()
    }

    fn close(mut self, budget: Duration) {
        let (reply, rx) = mpsc::channel();
        if self.tx.send(Msg::Close(reply)).is_ok()
            && rx.recv_timeout(budget).is_ok()
            && let Some(h) = self.handle.take()
        {
            let _ = h.join();
        }
    }
}

fn ch_label(ch: Ch) -> &'static str {
    match ch {
        Ch::Mic => "microphone",
        Ch::Call => "default output's monitor",
    }
}

/// A throwaway second stream on the default output's monitor, listened to for up to 3 s: did
/// anything audible play (DESIGN 2.5)? Its own connection, so a slow probe never holds up the
/// worker.
fn probe() -> bool {
    let Ok(client) = connect() else {
        return false;
    };
    let Ok(sink) = block_on(client.sink_info_by_name(DEFAULT_SINK.to_owned())) else {
        return false;
    };
    let Some(monitor) = sink.monitor_source_index else {
        return false;
    };
    let Ok(src) = block_on(client.source_info(monitor)) else {
        return false;
    };
    let heard = Arc::new(AtomicBool::new(false));
    let flag = heard.clone();
    let rate = src.sample_spec.sample_rate;
    let spec = SampleSpec {
        format: SampleFormat::Float32Le,
        channels: src.sample_spec.channels.max(1),
        sample_rate: rate,
    };
    let params = RecordStreamParams {
        sample_spec: spec,
        channel_map: src.channel_map,
        source_index: Some(src.index),
        buffer_attr: BufferAttr {
            fragment_size: fragment_bytes(rate, spec.channels),
            ..Default::default()
        },
        ..Default::default()
    };
    let stream = block_on(client.create_record_stream(params, move |data: &[u8]| {
        if data
            .chunks_exact(4)
            .any(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]) != 0.0)
        {
            flag.store(true, Ordering::Relaxed);
        }
    }));
    let Ok(stream) = stream else {
        return false;
    };
    let end = Instant::now() + Duration::from_secs_f64(PROBE_S);
    while Instant::now() < end && !heard.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(stream);
    heard.load(Ordering::Relaxed)
}

/// The logind sleep inhibitor, held by a `systemd-inhibit` child that waits on a pipe from this
/// process: closing the pipe (a stop, a crash, a kill) ends it and releases the lock.
struct Inhibitor {
    child: Child,
    checked: bool,
}

impl Inhibitor {
    fn hold() -> Result<Inhibitor, String> {
        Command::new("systemd-inhibit")
            .args([
                "--what=idle:sleep",
                "--who=akou",
                "--why=Recording a call",
                "--mode=block",
                "cat",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map(|child| Inhibitor {
                child,
                checked: false,
            })
            .map_err(|e| format!("systemd-inhibit: {e}"))
    }

    /// Why the inhibitor has ended (no logind, or polkit refused it), said once. Asked at every
    /// status poll: a refusal takes a moment to arrive.
    fn refused(&mut self) -> Option<String> {
        if self.checked {
            return None;
        }
        match self.child.try_wait() {
            Ok(Some(status)) => {
                self.checked = true;
                let mut msg = String::new();
                if let Some(mut e) = self.child.stderr.take() {
                    let _ = e.read_to_string(&mut msg);
                }
                Some(format!("systemd-inhibit exited ({status}): {}", msg.trim()))
            }
            Ok(None) => None,
            Err(e) => {
                self.checked = true;
                Some(e.to_string())
            }
        }
    }

    fn release(mut self, budget: Duration) {
        drop(self.child.stdin.take());
        let end = Instant::now() + budget;
        while Instant::now() < end {
            if !matches!(self.child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct LinuxFrontend {
    cfg: DeviceConfig,
    events: Option<SyncSender<Event>>,
    worker: Option<Handle>,
    probing: Arc<AtomicBool>,
    received: [Arc<AtomicU64>; 2],
    dropped: Arc<AtomicU64>,
    /// The first-open hold-back is over (see `pulse_rules::Settle`).
    released: Arc<AtomicBool>,
    awake: Option<Inhibitor>,
}

pub fn frontend(cfg: &DeviceConfig) -> Result<Box<dyn Frontend>, OpenError> {
    Ok(Box::new(LinuxFrontend {
        cfg: cfg.clone(),
        events: None,
        worker: None,
        probing: Arc::new(AtomicBool::new(false)),
        received: [Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0))],
        dropped: Arc::new(AtomicU64::new(0)),
        released: Arc::new(AtomicBool::new(false)),
        awake: None,
    }))
}

impl Frontend for LinuxFrontend {
    fn caps(&self) -> Vec<&'static str> {
        vec!["monitor", "mic", "probe"]
    }

    fn clock(&self) -> ClockKind {
        ClockKind::Host
    }

    fn open(&mut self, tx: SyncSender<Event>) -> Result<Opened, OpenError> {
        self.events = Some(tx.clone());
        let w = Handle::spawn(
            self.cfg.clone(),
            tx.clone(),
            self.received.clone(),
            self.dropped.clone(),
            self.released.clone(),
        );
        let mut opened = Opened::default();
        // The mic first: it never depends on the call side (TRAPS T0.16).
        let mic = (self.cfg.mic != "none").then(|| w.open(Ch::Mic, OPEN_BUDGET));
        let call = (self.cfg.call != CallMode::None).then(|| w.open(Ch::Call, OPEN_BUDGET));
        self.worker = Some(w);
        for r in [mic, call].into_iter().flatten() {
            match r? {
                Info::Mic(m, d) => {
                    opened.mic = Some(m);
                    opened.devices[0] = Some(d);
                }
                Info::Call(c, d) => {
                    opened.call = Some(c);
                    opened.devices[1] = Some(d);
                }
            }
        }
        // Say `capturing` once both streams have settled (see SETTLE_S), so the part's first
        // second has both sources. A server that sends nothing while nothing plays (PulseAudio's
        // null sink) never settles: the budget bounds the wait.
        let want = |rate: u32| (f64::from(rate) * SETTLE_S) as u64;
        let end = Instant::now() + SETTLE_BUDGET;
        let rates = [
            opened.mic.as_ref().map(|m| m.rate),
            opened.call.as_ref().map(|c| c.rate),
        ];
        while Instant::now() < end
            && Ch::BOTH.iter().any(|ch| {
                rates[ch.index()]
                    .is_some_and(|r| self.received[ch.index()].load(Ordering::Relaxed) < want(r))
            })
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        // Settled or not, `capturing` comes next: a stream that has not delivered its first
        // 0.4 s yet forwards from its next buffer, or the part would lose its start.
        self.released.store(true, Ordering::Release);
        match Inhibitor::hold() {
            Ok(i) => self.awake = Some(i),
            Err(e) => {
                let _ = tx.try_send(Event::Warn {
                    code: "keep-awake",
                    msg: format!("the machine may sleep while recording: {e}"),
                });
            }
        }
        Ok(opened)
    }

    fn start(&mut self, _anchor: clock::Now) {}

    fn rebuild(&mut self, ch: Ch) -> Result<Vec<String>, String> {
        let w = self
            .worker
            .as_ref()
            .ok_or("the sound server worker is gone")?;
        w.open(ch, REBUILD_BUDGET)
            .map(|_| vec![])
            .map_err(|e| e.msg)
    }

    fn probe_call(&mut self) {
        let Some(tx) = self.events.clone() else {
            return;
        };
        if self.probing.swap(true, Ordering::AcqRel) {
            return;
        }
        let flag = self.probing.clone();
        std::thread::spawn(move || {
            let heard = probe();
            flag.store(false, Ordering::Release);
            let _ = tx.try_send(Event::Probe { heard });
        });
    }

    fn status(&mut self) -> Status {
        if let (Some(i), Some(tx)) = (self.awake.as_mut(), self.events.as_ref())
            && let Some(why) = i.refused()
        {
            let _ = tx.try_send(Event::Warn {
                code: "keep-awake",
                msg: format!("the machine may sleep while recording: {why}"),
            });
        }
        self.worker.as_mut().map(Handle::status).unwrap_or_default()
    }

    fn close(mut self: Box<Self>) {
        if let Some(w) = self.worker.take() {
            w.close(CLOSE_BUDGET);
        }
        if let Some(i) = self.awake.take() {
            i.release(CLOSE_BUDGET);
        }
    }
}

/// Every source and sink the server lists. Monitors are left out of the inputs.
pub fn list_devices() -> Result<Endpoints, OpenError> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let r = (|| {
            let client = connect()?;
            let err = |e: ClientError| OpenError::unavailable(format!("the sound server: {e}"));
            let server = block_on(client.server_info()).map_err(err)?;
            let dsrc = server.default_source_name.as_deref().map(cstr);
            let dsink = server.default_sink_name.as_deref().map(cstr);
            let inputs = block_on(client.list_sources())
                .map_err(err)?
                .iter()
                .map(view)
                .filter(|v| v.monitor_of.is_none())
                .map(|v| Endpoint {
                    default: dsrc.as_deref() == Some(v.name.as_str()),
                    id: v.name,
                    name: v.description,
                })
                .collect();
            let outputs = block_on(client.list_sinks())
                .map_err(err)?
                .iter()
                .map(|s| Endpoint {
                    id: cstr(&s.name),
                    name: s.description.as_deref().map(cstr).unwrap_or_default(),
                    default: dsink.as_deref() == Some(cstr(&s.name).as_str()),
                })
                .collect();
            Ok(Endpoints {
                backend: "pulse",
                inputs,
                outputs,
            })
        })();
        let _ = tx.send(r);
    });
    rx.recv_timeout(OPEN_BUDGET)
        .map_err(|_| OpenError::unavailable("the sound server did not answer in time"))?
}
