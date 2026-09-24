//! The Windows front end (DESIGN 2.2 and 2.3), through WASAPI with the `wasapi` crate.
//!
//! - The call side is process loopback in exclude mode on the process tree the app names with
//!   `--exclude-responsible <pid>` (the app, its WebView2 processes and this helper), from build
//!   20348 on; loopback of the default render device before that, with a warning that akou's own
//!   sounds are not left out. `--call app:<id>` is process loopback in include mode on that app's
//!   tree. `wasapi_rules` makes these choices.
//! - The mic is the default communications capture device, the one call apps use, or the device
//!   `--mic <id>` names, falling back to the default when it is gone.
//! - Streams open in shared mode at the device's own mix rate and channel count (TRAPS T4.21),
//!   as 32-bit float; process loopback has no device and runs at 48 kHz stereo. Buffers flagged
//!   silent are zeros. Timestamps are the buffers' own performance-counter times, moved onto the
//!   awake clock.
//! - Each stream is read on its own thread at `Pro Audio` priority (MMCSS).
//! - Device notifications (`IMMNotificationClient`) make the engine poll the defaults at once, so
//!   a changed default is rebuilt without waiting for the next second.
//! - `SetThreadExecutionState` keeps the machine from idle sleep while recording.
//! - The output-running signal and the probe are the default render device's peak meter.
//!
//! Every WASAPI object lives on the thread that made it, and the engine reaches the threads
//! through messages with deadlines, so a call that hangs never stalls capture and a stop always
//! finishes. Nothing here runs on the development machine: CI builds it on Windows, and a real
//! call is on the release checklist.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender, SyncSender, TryRecvError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use wasapi::{
    AudioCaptureClient, AudioClient, Device, DeviceEnumerator, DeviceEventCallbacks, Direction,
    Handle, Role, SampleType, StreamMode, WasapiError, WaveFormat,
};
use windows::Win32::Foundation::{CloseHandle, E_ACCESSDENIED, HANDLE, STILL_ACTIVE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Power::{ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState};
use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows::Win32::System::Threading::{
    AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, GetExitCodeProcess,
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::core::w;

use crate::clock;
use crate::convert::{Format, SampleKind, to_mono};
use crate::health::dead_call::PROBE_S;
use crate::health::device_watch::{DeviceId, MicTarget, mic_target};
use crate::protocol::{CallInfo, Ch, MicInfo};
use crate::source::{
    CallMode, Chunk, ClockKind, DeviceConfig, Endpoint, Endpoints, Event, Frontend, OpenError,
    Opened, Status,
};
use crate::wasapi_rules::{CallSource, Proc, endpoint_plan, plan};

const OPEN_BUDGET: Duration = Duration::from_secs(10);
const REBUILD_BUDGET: Duration = Duration::from_secs(3);
const STATUS_BUDGET: Duration = Duration::from_millis(500);
const CLOSE_BUDGET: Duration = Duration::from_millis(600);
/// The shared-mode buffer WASAPI keeps for each stream: 200 ms, in units of 100 ns.
const BUFFER_HNS: i64 = 2_000_000;
/// How long a reader waits for the next buffer before it looks at its messages again.
const WAIT_MS: u32 = 20;
/// Process loopback has no device format: it is asked for this one.
const LOOPBACK_RATE: u32 = 48_000;
const LOOPBACK_CHANNELS: usize = 2;

fn err(what: &str, e: WasapiError) -> OpenError {
    let denied = matches!(&e, WasapiError::Windows(w) if w.code() == E_ACCESSDENIED);
    if denied {
        return OpenError::permission(format!(
            "{what}: access denied; turn on Settings > Privacy & security > Microphone > Let desktop apps access your microphone"
        ));
    }
    OpenError::unavailable(format!("{what}: {e}"))
}

/// COM for this thread, released when the thread is done with it.
struct Com(bool);

impl Com {
    fn init() -> Com {
        Com(wasapi::initialize_mta().is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            wasapi::deinitialize();
        }
    }
}

/// The MMCSS `Pro Audio` class for this thread, reverted when dropped.
struct ProAudio(Option<HANDLE>);

impl ProAudio {
    fn enter() -> ProAudio {
        let mut index = 0u32;
        // SAFETY: a constant task name and an out-parameter; the handle is reverted on drop.
        ProAudio(unsafe { AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut index) }.ok())
    }
}

impl Drop for ProAudio {
    fn drop(&mut self) {
        if let Some(h) = self.0.take() {
            // SAFETY: the handle this thread got from AvSetMmThreadCharacteristicsW.
            let _ = unsafe { AvRevertMmThreadCharacteristics(h) };
        }
    }
}

/// The Windows build number (`RtlGetVersion`, which, unlike `GetVersionEx`, does not lie to an
/// executable without a compatibility manifest). 0 when unknown.
pub fn build() -> u32 {
    // SAFETY: a plain C struct, zero is a valid value for every field.
    let mut v: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    v.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    // SAFETY: the size field is set; the call fills the struct.
    let status = unsafe { windows::Wdk::System::SystemServices::RtlGetVersion(&mut v) };
    if status.is_ok() { v.dwBuildNumber } else { 0 }
}

/// Every running process with its parent and executable name.
fn processes() -> Vec<Proc> {
    // SAFETY: a snapshot handle, closed below.
    let Ok(snap) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return vec![];
    };
    let mut e = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut out = vec![];
    // SAFETY: `e` has its size set; the snapshot is valid.
    let mut ok = unsafe { Process32FirstW(snap, &mut e) }.is_ok();
    while ok {
        let len = e
            .szExeFile
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(e.szExeFile.len());
        out.push(Proc {
            pid: e.th32ProcessID,
            parent: e.th32ParentProcessID,
            exe: String::from_utf16_lossy(&e.szExeFile[..len]),
        });
        // SAFETY: as above.
        ok = unsafe { Process32NextW(snap, &mut e) }.is_ok();
    }
    // SAFETY: the snapshot handle from above.
    let _ = unsafe { CloseHandle(snap) };
    out
}

fn alive(pid: u32) -> bool {
    // SAFETY: a query-only handle, closed below.
    let Ok(h) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return false;
    };
    let mut code = 0u32;
    // SAFETY: a valid process handle and an out-parameter.
    let ok = unsafe { GetExitCodeProcess(h, &mut code) }.is_ok();
    // SAFETY: the handle from OpenProcess.
    let _ = unsafe { CloseHandle(h) };
    ok && code == STILL_ACTIVE.0 as u32
}

fn device_id(d: &Device) -> Option<DeviceId> {
    Some(DeviceId {
        id: d.get_id().ok()?,
        name: d.get_friendlyname().unwrap_or_default(),
    })
}

/// The active devices of one direction. `DeviceCollection`'s own iterator panics on an error,
/// and a panic here aborts the helper, so this walks it by index.
fn active(en: &DeviceEnumerator, dir: Direction) -> Vec<Device> {
    let Ok(c) = en.get_device_collection(&dir) else {
        return vec![];
    };
    let n = c.get_nbr_devices().unwrap_or(0);
    (0..n)
        .filter_map(|i| c.get_device_at_index(i).ok())
        .collect()
}

/// One running capture stream.
struct Stream {
    client: AudioClient,
    capture: AudioCaptureClient,
    event: Handle,
    format: Format,
    frame: usize,
    rate: u32,
    buf: Vec<u8>,
}

impl Stream {
    /// Starts `client` capturing 32-bit float at `rate` and `channels`, event-driven, with WASAPI
    /// converting from the device's own format when it differs (it never changes the device).
    fn start(mut client: AudioClient, rate: u32, channels: usize) -> Result<Stream, WasapiError> {
        let fmt = WaveFormat::new(32, 32, &SampleType::Float, rate as usize, channels, None);
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: BUFFER_HNS,
        };
        client.initialize_client(&fmt, &Direction::Capture, &mode)?;
        let event = client.set_get_eventhandle()?;
        let capture = client.get_audiocaptureclient()?;
        client.start_stream()?;
        Ok(Stream {
            client,
            capture,
            event,
            format: Format {
                kind: SampleKind::F32,
                channels,
                interleaved: true,
            },
            frame: channels * 4,
            rate,
            buf: Vec::new(),
        })
    }

    /// Waits up to `WAIT_MS` for the next buffer and hands every buffer queued to the engine.
    fn pump(
        &mut self,
        ch: Ch,
        tx: &SyncSender<Event>,
        running: &AtomicBool,
        dropped: &AtomicU64,
    ) -> Result<(), String> {
        // A timeout is normal: loopback sends nothing at all while nothing plays.
        let _ = self.event.wait_for_event(WAIT_MS);
        loop {
            let n = self
                .capture
                .get_next_packet_size()
                .map_err(|e| e.to_string())?
                .unwrap_or(0) as usize;
            if n == 0 {
                return Ok(());
            }
            let need = n * self.frame;
            if self.buf.len() < need {
                self.buf.resize(need, 0);
            }
            let (frames, info) = self
                .capture
                .read_from_device(&mut self.buf[..need])
                .map_err(|e| e.to_string())?;
            let frames = frames as usize;
            if frames == 0 {
                return Ok(());
            }
            let mut samples = Vec::with_capacity(frames);
            let heard = if info.flags.silent {
                // AUDCLNT_BUFFERFLAGS_SILENT: the contents are undefined; the audio is silence.
                samples.resize(frames, 0.0);
                false
            } else {
                to_mono(
                    self.format,
                    &[&self.buf[..frames * self.frame]],
                    &mut samples,
                )
            };
            let now = clock::now().awake_ns;
            let device = (!info.flags.timestamp_error && info.timestamp > 0)
                .then(|| info.timestamp.saturating_mul(100));
            let chunk = Chunk {
                ch,
                awake_ns: clock::stamp(now, clock::qpc_ns(), device, frames, self.rate),
                rate: self.rate,
                samples,
                heard,
            };
            running.store(true, Ordering::Relaxed);
            if tx.try_send(Event::Chunk(chunk)).is_err() {
                dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        let _ = self.client.stop_stream();
    }
}

enum Msg<T> {
    Open(Sender<Result<T, OpenError>>),
    Close(Sender<()>),
}

/// One source on its own thread: the thread owns COM, the MMCSS class and the stream, and reads
/// the stream between messages.
struct Worker<T> {
    tx: Sender<Msg<T>>,
    running: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

type Opener<T> = Box<dyn FnMut(&SyncSender<Event>) -> Result<(Stream, T), OpenError> + Send>;

impl<T: Send + 'static> Worker<T> {
    fn spawn(
        ch: Ch,
        events: SyncSender<Event>,
        dropped: Arc<AtomicU64>,
        mut opener: Opener<T>,
    ) -> Self {
        let (tx, rx) = mpsc::channel::<Msg<T>>();
        let running = Arc::new(AtomicBool::new(false));
        let run = running.clone();
        let handle = std::thread::spawn(move || {
            let _com = Com::init();
            let _pro = ProAudio::enter();
            let mut live: Option<Stream> = None;
            loop {
                let msg = if live.is_some() {
                    match rx.try_recv() {
                        Ok(m) => Some(m),
                        Err(TryRecvError::Empty) => None,
                        Err(TryRecvError::Disconnected) => return,
                    }
                } else {
                    match rx.recv() {
                        Ok(m) => Some(m),
                        Err(_) => return,
                    }
                };
                match msg {
                    Some(Msg::Open(reply)) => {
                        live = None;
                        run.store(false, Ordering::Relaxed);
                        let r = opener(&events).map(|(s, info)| {
                            live = Some(s);
                            info
                        });
                        let _ = reply.send(r);
                    }
                    Some(Msg::Close(reply)) => {
                        drop(live.take());
                        let _ = reply.send(());
                        return;
                    }
                    None => {}
                }
                let pumped = match live.as_mut() {
                    Some(s) => s.pump(ch, &events, &run, &dropped),
                    None => Ok(()),
                };
                if let Err(detail) = pumped {
                    live = None;
                    run.store(false, Ordering::Relaxed);
                    let _ = events.try_send(Event::Lost { ch, detail });
                }
            }
        });
        Worker {
            tx,
            running,
            handle: Some(handle),
        }
    }

    fn open(&self, budget: Duration, what: &str) -> Result<T, OpenError> {
        let (reply, rx) = mpsc::channel();
        self.tx
            .send(Msg::Open(reply))
            .map_err(|_| OpenError::unavailable(format!("the {what} worker is gone")))?;
        rx.recv_timeout(budget)
            .map_err(|_| OpenError::unavailable(format!("the {what} did not open in time")))?
    }

    /// Stops the stream within `budget`; a stuck worker is left behind.
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

fn open_mic(
    requested: &str,
    events: &SyncSender<Event>,
) -> Result<(Stream, (MicInfo, Option<DeviceId>)), OpenError> {
    let en = DeviceEnumerator::new().map_err(|e| err("the device list", e))?;
    let ids: Vec<String> = active(&en, Direction::Capture)
        .iter()
        .filter_map(|d| d.get_id().ok())
        .collect();
    let default = || en.get_default_device_for_role(&Direction::Capture, &Role::Communications);
    let device = match mic_target(requested, &ids) {
        MicTarget::Pinned(id) => en.get_device(&id),
        MicTarget::Default => default(),
        MicTarget::FallbackFromPinned(id) => {
            let _ = events.try_send(Event::Health {
                ch: Ch::Mic,
                state: "fallback",
                detail: format!("microphone {id} is not connected; using the default input"),
            });
            default()
        }
    }
    .map_err(|e| OpenError::no_device(format!("no input device: {e}")))?;
    let client = device
        .get_iaudioclient()
        .map_err(|e| err("the microphone", e))?;
    let mix = client
        .get_mixformat()
        .map_err(|e| err("the microphone's format", e))?;
    let rate = mix.get_samplespersec();
    let channels = mix.get_nchannels().max(1) as usize;
    let stream = Stream::start(client, rate, channels).map_err(|e| err("the microphone", e))?;
    let id = device_id(&device);
    let info = MicInfo {
        id: if requested == "default" {
            "default".into()
        } else {
            id.as_ref().map(|d| d.id.clone()).unwrap_or_default()
        },
        name: id
            .as_ref()
            .map(|d| d.name.clone())
            .unwrap_or_else(|| "microphone".into()),
        rate,
    };
    Ok((stream, (info, id)))
}

/// What the call side opened.
struct CallOpen {
    info: CallInfo,
    exclude: Vec<String>,
    tapped: Vec<u32>,
    device: Option<DeviceId>,
}

fn default_render() -> Result<Device, WasapiError> {
    DeviceEnumerator::new()?.get_default_device_for_role(&Direction::Render, &Role::Console)
}

fn open_endpoint() -> Result<(Stream, u32), OpenError> {
    let device =
        default_render().map_err(|e| OpenError::no_device(format!("no output device: {e}")))?;
    let client = device
        .get_iaudioclient()
        .map_err(|e| err("the default output", e))?;
    let mix = client
        .get_mixformat()
        .map_err(|e| err("the default output's format", e))?;
    let rate = mix.get_samplespersec();
    let stream = Stream::start(client, rate, mix.get_nchannels().max(1) as usize)
        .map_err(|e| err("loopback of the default output", e))?;
    Ok((stream, rate))
}

fn open_call(
    cfg: &DeviceConfig,
    build: u32,
    events: &SyncSender<Event>,
    warned: &mut bool,
) -> Result<(Stream, CallOpen), OpenError> {
    let mut p = plan(
        build,
        &cfg.call,
        cfg.exclude_responsible.as_deref(),
        std::process::id(),
        &processes(),
    )?;
    let loopback = match p.source {
        CallSource::ExcludeTree(pid) => Some((pid, false)),
        CallSource::IncludeTree(pid) => Some((pid, true)),
        CallSource::Endpoint => None,
    };
    let (stream, rate) = match loopback {
        Some((pid, include)) => {
            let started = AudioClient::new_application_loopback_client(pid, include)
                .and_then(|c| Stream::start(c, LOOPBACK_RATE, LOOPBACK_CHANNELS));
            match started {
                Ok(s) => (s, LOOPBACK_RATE),
                Err(e) if !include => {
                    // A build that should have process loopback refused it: record the whole
                    // output rather than nothing, and say what that costs.
                    p = endpoint_plan(&format!("process loopback failed ({e})"));
                    open_endpoint()?
                }
                Err(e) => return Err(err("process loopback of the app", e)),
            }
        }
        None => open_endpoint()?,
    };
    if let Some(w) = p.warn.as_ref().filter(|_| !*warned) {
        *warned = true;
        let _ = events.try_send(Event::Warn {
            code: "exclude-unavailable",
            msg: w.clone(),
        });
    }
    let device = default_render().ok().and_then(|d| device_id(&d));
    Ok((
        stream,
        CallOpen {
            info: CallInfo {
                mode: cfg.call.wire(),
                rate,
            },
            exclude: p.exclude,
            tapped: p.tapped,
            device,
        },
    ))
}

/// The peak meter of the default render device, sampled for up to `for_s`: did anything play?
fn meter_heard(for_s: f64) -> Option<bool> {
    let meter = default_render().ok()?.get_audiometerinformation().ok()?;
    let end = Instant::now() + Duration::from_secs_f64(for_s);
    loop {
        if meter.get_peak_value().ok()? > 0.0 {
            return Some(true);
        }
        if Instant::now() >= end {
            return Some(false);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

enum CtlMsg {
    Status(Sender<Status>),
    Close(Sender<()>),
}

/// The thread that watches devices: notifications, the defaults, the output meter and the
/// keep-awake request, which Windows keeps per thread, so it lives here for the whole part.
struct Control {
    tx: Sender<CtlMsg>,
    handle: Option<JoinHandle<()>>,
    last: Status,
}

impl Control {
    fn spawn(events: SyncSender<Event>) -> Control {
        let (tx, rx) = mpsc::channel::<CtlMsg>();
        let handle = std::thread::spawn(move || {
            let _com = Com::init();
            // SAFETY: a flag change for this thread; cleared below and when the thread ends.
            let awake = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            if awake.0 == 0 {
                let _ = events.try_send(Event::Warn {
                    code: "keep-awake",
                    msg: "the machine may sleep while recording: SetThreadExecutionState failed"
                        .into(),
                });
            }
            let en = DeviceEnumerator::new().ok();
            let _registration = en.as_ref().and_then(|en| {
                let mut cb = DeviceEventCallbacks::new();
                let t = events.clone();
                cb.set_default_device_callback(move |_, _, _| {
                    let _ = t.try_send(Event::Devices);
                });
                let t = events.clone();
                cb.set_device_state_callback(move |_, _| {
                    let _ = t.try_send(Event::Devices);
                });
                let t = events.clone();
                cb.set_device_removed_callback(move |_| {
                    let _ = t.try_send(Event::Devices);
                });
                en.register_notification_callback(cb).ok()
            });
            for msg in rx {
                match msg {
                    CtlMsg::Status(reply) => {
                        let mut st = Status::default();
                        if let Some(en) = en.as_ref() {
                            if let Ok(out) =
                                en.get_default_device_for_role(&Direction::Render, &Role::Console)
                            {
                                st.output_running = out
                                    .get_audiometerinformation()
                                    .and_then(|m| m.get_peak_value())
                                    .ok()
                                    .map(|p| p > 0.0);
                                st.default_output = device_id(&out);
                            }
                            st.default_input = en
                                .get_default_device_for_role(
                                    &Direction::Capture,
                                    &Role::Communications,
                                )
                                .ok()
                                .and_then(|d| device_id(&d));
                        }
                        let _ = reply.send(st);
                    }
                    CtlMsg::Close(reply) => {
                        // SAFETY: as above.
                        unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
                        let _ = reply.send(());
                        return;
                    }
                }
            }
        });
        Control {
            tx,
            handle: Some(handle),
            last: Status::default(),
        }
    }

    fn status(&mut self) -> Status {
        let (reply, rx) = mpsc::channel();
        if self.tx.send(CtlMsg::Status(reply)).is_ok()
            && let Ok(s) = rx.recv_timeout(STATUS_BUDGET)
        {
            self.last = s;
        }
        self.last.clone()
    }

    fn close(mut self, budget: Duration) {
        let (reply, rx) = mpsc::channel();
        if self.tx.send(CtlMsg::Close(reply)).is_ok()
            && rx.recv_timeout(budget).is_ok()
            && let Some(h) = self.handle.take()
        {
            let _ = h.join();
        }
    }
}

pub struct WindowsFrontend {
    cfg: DeviceConfig,
    build: u32,
    events: Option<SyncSender<Event>>,
    mic: Option<Worker<(MicInfo, Option<DeviceId>)>>,
    call: Option<Worker<CallOpen>>,
    control: Option<Control>,
    tapped: Vec<u32>,
    apps_exited: bool,
    probing: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
}

pub fn frontend(cfg: &DeviceConfig) -> Result<Box<dyn Frontend>, OpenError> {
    Ok(Box::new(WindowsFrontend {
        cfg: cfg.clone(),
        build: build(),
        events: None,
        mic: None,
        call: None,
        control: None,
        tapped: vec![],
        apps_exited: false,
        probing: Arc::new(AtomicBool::new(false)),
        dropped: Arc::new(AtomicU64::new(0)),
    }))
}

impl Frontend for WindowsFrontend {
    fn caps(&self) -> Vec<&'static str> {
        vec!["loopback", "mic", "probe", "exclude-responsible", "app"]
    }

    fn clock(&self) -> ClockKind {
        ClockKind::Host
    }

    fn open(&mut self, tx: SyncSender<Event>) -> Result<Opened, OpenError> {
        self.events = Some(tx.clone());
        self.control = Some(Control::spawn(tx.clone()));
        let mut opened = Opened::default();
        // The mic first: it never depends on the call side (TRAPS T0.16).
        if self.cfg.mic != "none" {
            let requested = self.cfg.mic.clone();
            let m = Worker::spawn(
                Ch::Mic,
                tx.clone(),
                self.dropped.clone(),
                Box::new(move |events| open_mic(&requested, events)),
            );
            let r = m.open(OPEN_BUDGET, "microphone");
            self.mic = Some(m);
            let (info, device) = r?;
            opened.mic = Some(info);
            opened.devices[0] = device;
        }
        if self.cfg.call != CallMode::None {
            let (cfg, build) = (self.cfg.clone(), self.build);
            let mut warned = false;
            let c = Worker::spawn(
                Ch::Call,
                tx,
                self.dropped.clone(),
                Box::new(move |events| open_call(&cfg, build, events, &mut warned)),
            );
            let r = c.open(OPEN_BUDGET, "call side");
            self.call = Some(c);
            let o = r?;
            opened.call = Some(o.info);
            opened.exclude = o.exclude;
            opened.devices[1] = o.device;
            self.tapped = o.tapped;
        }
        Ok(opened)
    }

    fn start(&mut self, _anchor: clock::Now) {}

    fn rebuild(&mut self, ch: Ch) -> Result<Vec<String>, String> {
        match ch {
            Ch::Mic => {
                let m = self.mic.as_ref().ok_or("no microphone")?;
                m.open(REBUILD_BUDGET, "microphone")
                    .map(|_| vec![])
                    .map_err(|e| e.msg)
            }
            Ch::Call => {
                let c = self.call.as_ref().ok_or("no call side")?;
                let o = c.open(REBUILD_BUDGET, "call side").map_err(|e| e.msg)?;
                self.tapped = o.tapped;
                Ok(o.exclude)
            }
        }
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
            let heard = {
                let _com = Com::init();
                meter_heard(PROBE_S).unwrap_or(false)
            };
            flag.store(false, Ordering::Release);
            let _ = tx.try_send(Event::Probe { heard });
        });
    }

    fn status(&mut self) -> Status {
        if matches!(self.cfg.call, CallMode::Apps(_))
            && !self.apps_exited
            && !self.tapped.is_empty()
            && !self.tapped.iter().any(|p| alive(*p))
        {
            self.apps_exited = true;
            if let Some(tx) = &self.events {
                let _ = tx.try_send(Event::Health {
                    ch: Ch::Call,
                    state: "tapped-apps-exited",
                    detail: "every tapped app has exited".into(),
                });
            }
        }
        let mut st = self
            .control
            .as_mut()
            .map(Control::status)
            .unwrap_or_default();
        st.mic_running = self
            .mic
            .as_ref()
            .is_some_and(|m| m.running.load(Ordering::Relaxed));
        st
    }

    fn close(mut self: Box<Self>) {
        if let Some(m) = self.mic.take() {
            m.close(CLOSE_BUDGET);
        }
        if let Some(c) = self.call.take() {
            c.close(CLOSE_BUDGET);
        }
        if let Some(c) = self.control.take() {
            c.close(CLOSE_BUDGET);
        }
    }
}

/// Every active capture and render endpoint, with the defaults the helper uses (communications
/// for the mic, console for the output). Reads properties only.
pub fn list_devices() -> Result<Endpoints, OpenError> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _com = Com::init();
        let r = (|| {
            let en = DeviceEnumerator::new().map_err(|e| err("the device list", e))?;
            let side = |dir: Direction, role: Role| {
                let default = en
                    .get_default_device_for_role(&dir, &role)
                    .ok()
                    .and_then(|d| d.get_id().ok());
                active(&en, dir)
                    .iter()
                    .filter_map(device_id)
                    .map(|d| Endpoint {
                        default: default.as_deref() == Some(d.id.as_str()),
                        id: d.id,
                        name: d.name,
                    })
                    .collect::<Vec<_>>()
            };
            Ok(Endpoints {
                backend: "wasapi",
                inputs: side(Direction::Capture, Role::Communications),
                outputs: side(Direction::Render, Role::Console),
            })
        })();
        let _ = tx.send(r);
    });
    rx.recv_timeout(OPEN_BUDGET)
        .map_err(|_| OpenError::unavailable("the Windows audio service did not answer in time"))?
}
