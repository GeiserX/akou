//! The macOS front end (DESIGN 2.2): the call side through a Core Audio process tap read by a
//! private aggregate device, the mic as a separate cpal stream.
//!
//! Bindings: `objc2-core-audio` (with `objc2`, `objc2-foundation`, `objc2-core-foundation`).
//! DESIGN 2.2 names cidre; we use the objc2 crates instead because cpal 0.18, which the mic needs
//! anyway, is built on exactly these crates, so the helper carries one binding stack instead of
//! two. They are generated from Apple's headers (including `CATapDescription` and the process-tap
//! and aggregate-device keys), versioned on crates.io and pinned by `Cargo.lock`.
//!
//! Each source lives on its own worker thread and the engine reaches it through messages with
//! deadlines, so a Core Audio call that hangs (a stale grant once blocked teardown forever)
//! never stalls capture, and a stop always finishes.
//!
//! Nothing here runs in the tests on this machine: opening a tap or a microphone asks for a
//! permission. The pure parts (exclusion, format mapping) are tested; the rest runs on hardware
//! in the release checklist.

pub mod aggregate;
pub mod exclude;
pub mod mic;
pub mod tap;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender, SyncSender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use objc2_core_audio::{
    AudioObjectID, kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioDevicePropertyDeviceUID,
    kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDefaultOutputDevice,
    kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyName,
    kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, kAudioProcessPropertyBundleID,
    kAudioProcessPropertyPID,
};

use self::aggregate::{Aggregate, Sink};
use self::exclude::{AudioProc, Target, parse_target, select_apps, select_excluded};
use self::mic::MicWorker;
use self::tap::{ProcessTap, Scope};
use crate::clock::Now;
use crate::health::dead_call::PROBE_S;
use crate::health::device_watch::DeviceId;
use crate::protocol::{CallInfo, Ch};
use crate::source::{
    CallMode, ClockKind, DeviceConfig, Event, Frontend, OpenError, Opened, Status,
};

const OPEN_BUDGET: Duration = Duration::from_secs(15);
const REBUILD_BUDGET: Duration = Duration::from_secs(3);
const CLOSE_BUDGET: Duration = Duration::from_millis(1500);

/// Core Audio property reads. None of them prompts for a permission.
pub mod props {
    use std::ffi::c_void;
    use std::ptr::NonNull;

    use objc2_core_audio::{
        AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID,
        AudioObjectPropertyAddress, AudioObjectPropertyScope, AudioObjectPropertySelector,
        kAudioObjectPropertyElementMain,
    };
    use objc2_core_foundation::{CFRetained, CFString};

    fn address(
        sel: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: sel,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain,
        }
    }

    /// A fixed-size property (numbers, ids, stream formats).
    pub fn get<T: Copy>(
        obj: AudioObjectID,
        sel: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
    ) -> Result<T, i32> {
        let addr = address(sel, scope);
        let mut value = std::mem::MaybeUninit::<T>::zeroed();
        let mut size = std::mem::size_of::<T>() as u32;
        // SAFETY: the out-buffer is `size` bytes; T is a plain C value type.
        let status = unsafe {
            AudioObjectGetPropertyData(
                obj,
                NonNull::from(&addr),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::new_unchecked(value.as_mut_ptr() as *mut c_void),
            )
        };
        if status != 0 || size as usize != std::mem::size_of::<T>() {
            return Err(status);
        }
        // SAFETY: Core Audio filled all of it.
        Ok(unsafe { value.assume_init() })
    }

    /// An array of object ids.
    pub fn get_ids(
        obj: AudioObjectID,
        sel: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
    ) -> Result<Vec<AudioObjectID>, i32> {
        let addr = address(sel, scope);
        let mut size = 0u32;
        // SAFETY: size query.
        let status = unsafe {
            AudioObjectGetPropertyDataSize(
                obj,
                NonNull::from(&addr),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
            )
        };
        if status != 0 {
            return Err(status);
        }
        let n = size as usize / std::mem::size_of::<AudioObjectID>();
        let mut ids = vec![0 as AudioObjectID; n];
        if n == 0 {
            return Ok(ids);
        }
        // SAFETY: the buffer holds `size` bytes.
        let status = unsafe {
            AudioObjectGetPropertyData(
                obj,
                NonNull::from(&addr),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::new_unchecked(ids.as_mut_ptr() as *mut c_void),
            )
        };
        if status != 0 {
            return Err(status);
        }
        ids.truncate(size as usize / std::mem::size_of::<AudioObjectID>());
        Ok(ids)
    }

    /// A CFString property, returned retained by Core Audio.
    pub fn get_string(
        obj: AudioObjectID,
        sel: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
    ) -> Result<String, i32> {
        let ptr: *const CFString = get(obj, sel, scope)?;
        let Some(nn) = NonNull::new(ptr as *mut CFString) else {
            return Ok(String::new());
        };
        // SAFETY: Core Audio hands out a +1 reference for CFString properties.
        let s: CFRetained<CFString> = unsafe { CFRetained::from_raw(nn) };
        Ok(s.to_string())
    }
}

/// The process macOS holds responsible for `pid` (`responsibility_get_pid_responsible_for_pid`,
/// looked up at run time because it is not in the public SDK). The pid itself when unknown.
pub fn responsible_pid(pid: i32) -> i32 {
    type F = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
    static FUNC: std::sync::OnceLock<Option<F>> = std::sync::OnceLock::new();
    let f = FUNC.get_or_init(|| {
        // SAFETY: dlsym with a NUL-terminated name; the symbol has the declared C signature.
        let sym = unsafe {
            libc::dlsym(
                libc::RTLD_DEFAULT,
                c"responsibility_get_pid_responsible_for_pid".as_ptr(),
            )
        };
        (!sym.is_null()).then(|| unsafe { std::mem::transmute::<*mut libc::c_void, F>(sym) })
    });
    match f {
        // SAFETY: a plain query about another process.
        Some(f) => {
            let r = unsafe { f(pid) };
            if r > 0 { r } else { pid }
        }
        None => pid,
    }
}

/// Every Core Audio process object with its pid, bundle id and responsible process.
pub fn audio_processes() -> Vec<AudioProc> {
    let ids = props::get_ids(
        kAudioObjectSystemObject as AudioObjectID,
        kAudioHardwarePropertyProcessObjectList,
        kAudioObjectPropertyScopeGlobal,
    )
    .unwrap_or_default();
    ids.into_iter()
        .filter_map(|object| {
            let pid: i32 = props::get(
                object,
                kAudioProcessPropertyPID,
                kAudioObjectPropertyScopeGlobal,
            )
            .ok()?;
            let bundle = props::get_string(
                object,
                kAudioProcessPropertyBundleID,
                kAudioObjectPropertyScopeGlobal,
            )
            .unwrap_or_default();
            Some(AudioProc {
                object,
                pid,
                bundle,
                responsible: responsible_pid(pid),
            })
        })
        .collect()
}

fn default_device(sel: u32) -> Option<(AudioObjectID, DeviceId)> {
    let id: AudioObjectID = props::get(
        kAudioObjectSystemObject as AudioObjectID,
        sel,
        kAudioObjectPropertyScopeGlobal,
    )
    .ok()
    .filter(|id: &AudioObjectID| *id != 0)?;
    let uid = props::get_string(
        id,
        kAudioDevicePropertyDeviceUID,
        kAudioObjectPropertyScopeGlobal,
    )
    .unwrap_or_else(|_| id.to_string());
    let name = props::get_string(
        id,
        kAudioObjectPropertyName,
        kAudioObjectPropertyScopeGlobal,
    )
    .unwrap_or_default();
    Some((id, DeviceId { id: uid, name }))
}

/// Keeps the machine from idle-sleeping while recording (DESIGN 2.2).
mod keep_awake {
    use objc2_core_foundation::CFString;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(
            kind: *const CFString,
            level: u32,
            name: *const CFString,
            id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }

    const LEVEL_ON: u32 = 255;

    pub fn hold() -> Option<u32> {
        let kind = CFString::from_str("PreventUserIdleSystemSleep");
        let name = CFString::from_str("akou is recording a call");
        let mut id = 0u32;
        // SAFETY: valid CFStrings and out-pointer.
        let r = unsafe { IOPMAssertionCreateWithName(&*kind, LEVEL_ON, &*name, &mut id) };
        (r == 0).then_some(id)
    }

    pub fn release(id: u32) {
        // SAFETY: an assertion this process created.
        unsafe { IOPMAssertionRelease(id) };
    }
}

static TAP_SERIAL: AtomicU32 = AtomicU32::new(0);

fn unique(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        std::process::id(),
        TAP_SERIAL.fetch_add(1, Ordering::Relaxed)
    )
}

/// Resolves what the tap should capture for this configuration, right now.
fn resolve_scope(cfg: &DeviceConfig) -> Result<(Scope, Vec<String>, Vec<i32>), OpenError> {
    let procs = audio_processes();
    match &cfg.call {
        CallMode::Apps(ids) => {
            let chosen = select_apps(&procs, ids);
            if chosen.is_empty() {
                return Err(OpenError::no_device(format!(
                    "no running app matches {}",
                    ids.join(", ")
                )));
            }
            Ok((
                Scope::Processes(chosen.iter().map(|p| p.object).collect()),
                vec![],
                chosen.iter().map(|p| p.pid).collect(),
            ))
        }
        _ => {
            let target: Option<Target> = cfg.exclude_responsible.as_deref().map(parse_target);
            let own = std::process::id() as i32;
            let ex = select_excluded(&procs, target.as_ref(), own, responsible_pid(own));
            Ok((
                Scope::GlobalExcluding(ex.iter().map(|p| p.object).collect()),
                ex.iter().map(|p| p.label()).collect(),
                vec![],
            ))
        }
    }
}

/// The live call side: a tap and its aggregate, owned by one worker thread.
enum CallMsg {
    Open(Sender<Result<(CallInfo, Vec<String>), OpenError>>),
    Close(Sender<()>),
}

struct CallWorker {
    tx: Sender<CallMsg>,
    tapped: Arc<std::sync::Mutex<Vec<i32>>>,
    handle: Option<JoinHandle<()>>,
}

impl CallWorker {
    fn spawn(cfg: DeviceConfig, events: SyncSender<Event>, dropped: Arc<AtomicU64>) -> CallWorker {
        let (tx, rx) = mpsc::channel::<CallMsg>();
        let tapped = Arc::new(std::sync::Mutex::new(Vec::new()));
        let t = tapped.clone();
        let handle = std::thread::spawn(move || {
            let mut live: Option<(ProcessTap, Aggregate)> = None;
            for msg in rx {
                match msg {
                    CallMsg::Open(reply) => {
                        // Rebuild: the old tap and aggregate go first (the new ones resolve
                        // the exclusion again, DESIGN 2.3).
                        if let Some((mut tap, mut agg)) = live.take() {
                            agg.close();
                            tap.destroy();
                        }
                        let r = (|| {
                            let (scope, names, pids) = resolve_scope(&cfg)?;
                            let tap = ProcessTap::create(&scope, &unique("akou-capture-tap"))
                                .map_err(OpenError::unavailable)?;
                            let agg = Aggregate::open(
                                &tap,
                                "akou-capture",
                                &unique("akou-capture"),
                                Sink::Stream {
                                    tx: events.clone(),
                                    dropped: dropped.clone(),
                                },
                            )
                            .map_err(OpenError::unavailable)?;
                            let info = CallInfo {
                                mode: cfg.call.wire(),
                                rate: agg.rate,
                            };
                            if let Ok(mut g) = t.lock() {
                                *g = pids;
                            }
                            live = Some((tap, agg));
                            Ok((info, names))
                        })();
                        let _ = reply.send(r);
                    }
                    CallMsg::Close(reply) => {
                        if let Some((mut tap, mut agg)) = live.take() {
                            agg.close();
                            tap.destroy();
                        }
                        let _ = reply.send(());
                        return;
                    }
                }
            }
        });
        CallWorker {
            tx,
            tapped,
            handle: Some(handle),
        }
    }

    fn open(&self, budget: Duration) -> Result<(CallInfo, Vec<String>), OpenError> {
        let (reply, rx) = mpsc::channel();
        self.tx
            .send(CallMsg::Open(reply))
            .map_err(|_| OpenError::unavailable("the call worker is gone"))?;
        rx.recv_timeout(budget)
            .map_err(|_| OpenError::unavailable("the process tap did not open in time"))?
    }

    fn close(mut self, budget: Duration) {
        let (reply, rx) = mpsc::channel();
        if self.tx.send(CallMsg::Close(reply)).is_ok()
            && rx.recv_timeout(budget).is_ok()
            && let Some(h) = self.handle.take()
        {
            let _ = h.join();
        }
    }
}

/// A throwaway second tap on the same scope, listened to for up to 3 s (DESIGN 2.5).
fn probe(cfg: &DeviceConfig) -> bool {
    let Ok((scope, _, _)) = resolve_scope(cfg) else {
        return false;
    };
    let Ok(tap) = ProcessTap::create(&scope, &unique("akou-probe-tap")) else {
        return false;
    };
    let heard = Arc::new(AtomicBool::new(false));
    let Ok(mut agg) = Aggregate::open(
        &tap,
        "akou-probe",
        &unique("akou-probe"),
        Sink::Probe(heard.clone()),
    ) else {
        return false;
    };
    let end = Instant::now() + Duration::from_secs_f64(PROBE_S);
    while Instant::now() < end && !heard.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(20));
    }
    agg.close();
    heard.load(Ordering::Relaxed)
}

pub struct MacFrontend {
    cfg: DeviceConfig,
    events: Option<SyncSender<Event>>,
    call: Option<CallWorker>,
    mic: Option<MicWorker>,
    probing: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    awake: Option<u32>,
    apps_exited: bool,
}

impl MacFrontend {
    pub fn new(cfg: DeviceConfig) -> Self {
        MacFrontend {
            cfg,
            events: None,
            call: None,
            mic: None,
            probing: Arc::new(AtomicBool::new(false)),
            dropped: Arc::new(AtomicU64::new(0)),
            awake: None,
            apps_exited: false,
        }
    }
}

impl Frontend for MacFrontend {
    fn caps(&self) -> Vec<&'static str> {
        vec!["tap", "mic", "probe", "exclude-responsible", "app"]
    }

    fn clock(&self) -> ClockKind {
        ClockKind::Host
    }

    fn open(&mut self, tx: SyncSender<Event>) -> Result<Opened, OpenError> {
        self.events = Some(tx.clone());
        let mut opened = Opened::default();
        // The mic first: it never depends on the call side (TRAPS T0.16).
        if self.cfg.mic != "none" {
            let m = MicWorker::spawn(self.cfg.mic.clone(), tx.clone());
            let info = m.open(OPEN_BUDGET);
            self.mic = Some(m);
            opened.mic = Some(info?);
        }
        if self.cfg.call != CallMode::None {
            let c = CallWorker::spawn(self.cfg.clone(), tx, self.dropped.clone());
            let r = c.open(OPEN_BUDGET);
            self.call = Some(c);
            let (info, names) = r?;
            opened.call = Some(info);
            opened.exclude = names;
        }
        self.awake = keep_awake::hold();
        Ok(opened)
    }

    fn start(&mut self, _anchor: Now) {}

    fn rebuild(&mut self, ch: Ch) -> Result<Vec<String>, String> {
        match ch {
            Ch::Mic => {
                let m = self.mic.as_ref().ok_or("no microphone")?;
                m.open(REBUILD_BUDGET).map(|_| vec![]).map_err(|e| e.msg)
            }
            Ch::Call => {
                let c = self.call.as_ref().ok_or("no call side")?;
                c.open(REBUILD_BUDGET)
                    .map(|(_, names)| names)
                    .map_err(|e| e.msg)
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
        let cfg = self.cfg.clone();
        let flag = self.probing.clone();
        std::thread::spawn(move || {
            let heard = probe(&cfg);
            flag.store(false, Ordering::Release);
            let _ = tx.try_send(Event::Probe { heard });
        });
    }

    fn status(&mut self) -> Status {
        let out = default_device(kAudioHardwarePropertyDefaultOutputDevice);
        let running = out.as_ref().map(|(id, _)| {
            props::get::<u32>(
                *id,
                kAudioDevicePropertyDeviceIsRunningSomewhere,
                kAudioObjectPropertyScopeGlobal,
            )
            .map(|v| v != 0)
            .unwrap_or(false)
        });
        if let (CallMode::Apps(_), Some(c)) = (&self.cfg.call, &self.call)
            && !self.apps_exited
        {
            let pids = c.tapped.lock().map(|g| g.clone()).unwrap_or_default();
            // SAFETY: signal 0 only checks that the process exists.
            let alive = pids.iter().any(|p| unsafe { libc::kill(*p, 0) } == 0);
            if !pids.is_empty() && !alive {
                self.apps_exited = true;
                if let Some(tx) = &self.events {
                    let _ = tx.try_send(Event::Health {
                        ch: Ch::Call,
                        state: "tapped-apps-exited",
                        detail: "every tapped app has exited".into(),
                    });
                }
            }
        }
        Status {
            output_running: Some(running.unwrap_or(false)),
            mic_running: self
                .mic
                .as_ref()
                .is_some_and(|m| m.running.load(Ordering::Relaxed)),
            default_input: default_device(kAudioHardwarePropertyDefaultInputDevice).map(|d| d.1),
            default_output: out.map(|d| d.1),
        }
    }

    fn permission_suspect(&self) -> bool {
        true
    }

    fn close(mut self: Box<Self>) {
        if let Some(m) = self.mic.take() {
            m.close(CLOSE_BUDGET);
        }
        if let Some(c) = self.call.take() {
            c.close(CLOSE_BUDGET);
        }
        if let Some(id) = self.awake.take() {
            keep_awake::release(id);
        }
    }
}
