//! The Linux backend of `akou-capture dictate` (docs/ux/DICTATION.md DC-N1, DC-N4, DC-A6): the
//! key reader and the microphone. There is no inserter and no field read on Linux yet, so every
//! insert answers `insert.failed no-inserter` and the app opens the draft box.
//!
//! - **evdev.** The keys come from the kernel's input devices, `/dev/input/event*`, read on their
//!   own thread, which names each key (`evdev_keys`), hands it to `tap::Gate` and goes back to
//!   `poll`. Reading a device takes nothing from the apps: evdev cannot swallow a key without
//!   grabbing the whole keyboard, so `ready.swallow_keys` is false (DC-A4) and a chord's last key
//!   also reaches the app.
//! - **Which devices.** A device is classified from its sysfs capability bits, without opening it:
//!   a keyboard is read always; a mouse (middle or side buttons, no keys) only while a mouse
//!   button is bound or the recorder is open (DC-A6), since it also reports every move; anything
//!   else never. The list is read again every 2 s, so a keyboard plugged in later, or a device
//!   made readable later, is picked up.
//! - **The grant.** The nodes belong to root and the `input` group. The packaged udev rule tags
//!   them `uaccess`, which gives the user of the active seat read access. `grants.accessibility`
//!   is `granted` when a keyboard node is readable (`access(2)`, nothing opened) and `denied`
//!   otherwise; the app then shows the rule. A later `grant.lost` means no keyboard is readable
//!   any more.
//! - **Time.** Each device is switched to `CLOCK_MONOTONIC` stamps (`EVIOCSCLOCKID`), the awake
//!   clock, so a key is stamped when the kernel saw it, not when the thread woke.
//! - **Lost events.** A device whose buffer overflowed (`SYN_DROPPED`) is resynced from the keys
//!   the kernel says are down now (`EVIOCGKEY`); a device that went away (unplugged) is closed and
//!   the gate resynced the same way, so a hotkey held on a keyboard that was pulled does not stick.
//! - **The microphone** is `crate::linux::DictateMic`, the PulseAudio-protocol stream `run`
//!   records with (PipeWire or PulseAudio). A Bluetooth source is told by its name and never kept
//!   warm; a built-in mic is not told apart, so DC-N5's preference does not apply here yet.
//!
//! The GlobalShortcuts portal, AT-SPI and the X11 and Wayland inserts are still to come. Nothing
//! in this module runs in `cargo test`: it would read the developer's own keyboard. The CI Linux
//! runner drives it with a virtual keyboard and mouse (`.github/workflows/ci.yml`).

use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender};
use std::time::{Duration, Instant};

use super::evdev_keys::{self, KEY_MAX, Kind};
use super::inputs::{self, Input};
use super::insert::Targets;
use super::live::{self, Device, Stdio};
use super::protocol::{self as p, Target};
use super::readback::Field;
use super::session::{Config, Dictate, Out};
use super::tap::{Gate, TapEvent};
use crate::clock;
use crate::linux::DictateMic;

pub const BACKEND: &str = "evdev";
const INPUT_DIR: &str = "/dev/input";
const SYS_INPUT: &str = "/sys/class/input";
/// The device list is read again this often.
const RESCAN: Duration = Duration::from_secs(2);
const POLL_MS: i32 = 250;

const KEY_BYTES: usize = KEY_MAX as usize / 8 + 1;

/// `_IOC` for the input ioctls (`'E'`), in the layout x86-64 and arm64 share.
const fn ioc(dir: u64, nr: u64, size: u64) -> u64 {
    (dir << 30) | (size << 16) | ((b'E' as u64) << 8) | nr
}
const EVIOCSCLOCKID: u64 = ioc(1, 0xa0, std::mem::size_of::<libc::c_int>() as u64);
const EVIOCGKEY: u64 = ioc(2, 0x18, KEY_BYTES as u64);

// ---------------------------------------------------------------------------
// Devices

/// Every event node and its kind, from sysfs, without opening any.
fn nodes() -> Vec<(PathBuf, Kind)> {
    let Ok(dir) = std::fs::read_dir(INPUT_DIR) else {
        return Vec::new();
    };
    let mut out: Vec<(PathBuf, Kind)> = dir
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            if !name.starts_with("event") {
                return None;
            }
            let caps = std::fs::read_to_string(
                Path::new(SYS_INPUT)
                    .join(&name)
                    .join("device/capabilities/key"),
            )
            .ok()?;
            Some((e.path(), evdev_keys::kind(&caps, usize::BITS)))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn readable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: a zero-terminated path; `access` only asks.
    unsafe { libc::access(c.as_ptr(), libc::R_OK) == 0 }
}

/// `granted` when some keyboard node can be read, asked without opening one.
pub fn access() -> &'static str {
    let any = nodes()
        .iter()
        .any(|(path, kind)| *kind == Kind::Keyboard && readable(path));
    if any { "granted" } else { "denied" }
}

/// `dictate --probe`: what this build would report at `ready`, without reading a device.
pub fn probe() -> String {
    p::ready(BACKEND, false, "not-needed", access())
}

struct Node {
    path: PathBuf,
    kind: Kind,
    file: File,
    /// The kernel stamps this device's events on the monotonic clock.
    monotonic: bool,
    state: evdev_keys::Device,
}

fn open_node(path: &Path, kind: Kind) -> std::io::Result<Node> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    let id: libc::c_int = libc::CLOCK_MONOTONIC;
    // SAFETY: an input device's fd and a pointer to one int, as EVIOCSCLOCKID takes.
    let monotonic = unsafe { libc::ioctl(file.as_raw_fd(), EVIOCSCLOCKID as _, &id) } == 0;
    Ok(Node {
        path: path.to_path_buf(),
        kind,
        file,
        monotonic,
        state: evdev_keys::Device::default(),
    })
}

/// Every key the kernel says is down now on these devices.
fn keys_down(fds: &[RawFd]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for fd in fds {
        let mut bits = [0u8; KEY_BYTES];
        // SAFETY: EVIOCGKEY writes at most KEY_BYTES bytes, the size encoded in the request.
        if unsafe { libc::ioctl(*fd, EVIOCGKEY as _, bits.as_mut_ptr()) } < 0 {
            continue;
        }
        for n in evdev_keys::held_names(&bits) {
            if !out.contains(&n) {
                out.push(n);
            }
        }
    }
    out
}

fn now_ns() -> u64 {
    clock::now().awake_ns
}

/// Reads what one device has; false once it is gone.
fn drain(gate: &Gate, node: &mut Node, fds: &[RawFd]) -> bool {
    const SIZE: usize = std::mem::size_of::<libc::input_event>();
    let mut buf = [0u8; SIZE * 64];
    loop {
        // SAFETY: reads at most `buf.len()` bytes into `buf`.
        let n = unsafe {
            libc::read(
                node.file.as_raw_fd(),
                buf.as_mut_ptr().cast::<libc::c_void>(),
                buf.len(),
            )
        };
        if n < 0 {
            return std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock;
        }
        if n == 0 {
            return false;
        }
        for chunk in buf[..n as usize].chunks_exact(SIZE) {
            // SAFETY: the kernel writes whole `input_event`s; the copy needs no alignment.
            let ev: libc::input_event =
                unsafe { std::ptr::read_unaligned(chunk.as_ptr().cast::<libc::input_event>()) };
            let t_ns = if node.monotonic {
                (ev.time.tv_sec as u64)
                    .saturating_mul(1_000_000_000)
                    .saturating_add(ev.time.tv_usec as u64 * 1_000)
            } else {
                now_ns()
            };
            node.state
                .event(gate, (ev.type_, ev.code, ev.value), t_ns, &mut || {
                    keys_down(fds)
                });
        }
    }
}

/// Every key the gate thinks is down that no open device reports down goes up.
fn resync(gate: &Gate, open: &[Node]) {
    let fds: Vec<RawFd> = open.iter().map(|n| n.file.as_raw_fd()).collect();
    let held = keys_down(&fds);
    gate.event(TapEvent::Disabled {
        t_ns: now_ns(),
        held: &held,
    });
}

/// The reader thread: rescans the devices, polls the open ones and hands their keys to the gate.
fn start_reader(gate: Gate) -> Result<(), String> {
    std::thread::Builder::new()
        .name("akou-dictate-evdev".into())
        .spawn(move || {
            let mut open: Vec<Node> = Vec::new();
            let mut scanned: Option<Instant> = None;
            let mut mouse = false;
            loop {
                let want_mouse = gate.lock().act.wants_mouse();
                if scanned.is_none_or(|t| t.elapsed() >= RESCAN) || want_mouse != mouse {
                    mouse = want_mouse;
                    scanned = Some(Instant::now());
                    let found = nodes();
                    let before = open.len();
                    open.retain(|n| {
                        found.iter().any(|(p, _)| *p == n.path)
                            && (n.kind == Kind::Keyboard || mouse)
                    });
                    let closed = open.len() < before;
                    for (path, kind) in found {
                        let wanted = match kind {
                            Kind::Keyboard => true,
                            Kind::Mouse => mouse,
                            Kind::Other => false,
                        };
                        if wanted
                            && !open.iter().any(|n| n.path == path)
                            && let Ok(n) = open_node(&path, kind)
                        {
                            open.push(n);
                        }
                    }
                    if closed {
                        resync(&gate, &open);
                    }
                }
                if open.is_empty() {
                    std::thread::sleep(Duration::from_millis(POLL_MS as u64));
                    continue;
                }
                let mut fds: Vec<libc::pollfd> = open
                    .iter()
                    .map(|n| libc::pollfd {
                        fd: n.file.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    })
                    .collect();
                // SAFETY: `fds` holds `fds.len()` pollfds for open descriptors.
                let ready =
                    unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, POLL_MS) };
                if ready <= 0 {
                    continue;
                }
                let raw: Vec<RawFd> = fds.iter().map(|f| f.fd).collect();
                let mut gone: Vec<usize> = Vec::new();
                for (i, f) in fds.iter().enumerate() {
                    if f.revents != 0 && !drain(&gate, &mut open[i], &raw) {
                        gone.push(i);
                    }
                }
                if !gone.is_empty() {
                    for i in gone.into_iter().rev() {
                        open.remove(i);
                    }
                    resync(&gate, &open);
                }
            }
        })
        .map(|_| ())
        .map_err(|e| format!("the key reader thread: {e}"))
}

// ---------------------------------------------------------------------------
// What has the keyboard

/// No window or field is read on Linux yet: every target is `unknown`, so nothing is inserted
/// blind (DC-N9).
pub struct Screen;

impl Targets for Screen {
    fn target(&mut self, _t_ns: u64) -> Target {
        Target::unknown()
    }

    fn secure_input(&mut self) -> bool {
        false
    }

    fn elevated(&mut self, _t: &Target) -> bool {
        false
    }

    fn focus(&mut self, _t: &Target) {}

    fn read_field(&mut self, _t: &Target) -> Field {
        Field::Unreadable
    }

    fn trusted(&mut self) -> bool {
        access() == "granted"
    }
}

// ---------------------------------------------------------------------------
// The microphone

#[derive(Default)]
pub struct LinuxMic {
    mic: Option<DictateMic>,
}

impl Device for LinuxMic {
    fn inputs(&mut self) -> Vec<Input> {
        crate::linux::list_devices()
            .map(|l| {
                l.inputs
                    .into_iter()
                    .map(|e| Input {
                        transport: inputs::pulse_transport(&e.id),
                        id: e.id,
                        default: e.default,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn lid_closed(&mut self) -> bool {
        false
    }

    fn open(
        &mut self,
        device: &str,
        events: SyncSender<crate::source::Event>,
    ) -> Result<(), String> {
        self.close();
        let m = DictateMic::open(device, events).map_err(|e| format!("{}: {}", e.code, e.msg))?;
        self.mic = Some(m);
        Ok(())
    }

    fn close(&mut self) {
        if let Some(m) = self.mic.take() {
            m.close();
        }
    }
}

// ---------------------------------------------------------------------------

/// Runs the dictate process on this machine until `stop` or the end of stdin.
pub fn run(cfg: Config) -> i32 {
    let mut out = Stdio {
        stdout: std::io::stdout(),
        stderr: std::io::stderr(),
    };
    let (tx, rx) = mpsc::channel();
    let mut d = Dictate::new(cfg, Box::new(Screen), None);
    let mut gate = d.gate();
    gate.set_wake(live::forward_wakes(tx.clone()));
    // Before the reader's first key, not only at `begin`: evdev swallows nothing (DC-A4).
    gate.lock().act.set_swallows(false);
    let grant = access();
    // The reader starts even with nothing readable: it looks again every 2 s, so a udev rule
    // applied after the start lets the key work without a restart. `ready` has already said
    // `denied` by then, and the protocol has no line to take that back yet.
    let reader = start_reader(gate);
    d.begin(BACKEND, false, ("not-needed", grant), &mut out);
    match reader {
        Err(e) => out.line(p::warn("no-tap", &e)),
        Ok(()) if grant != "granted" => out.line(p::warn(
            "no-tap",
            "no keyboard under /dev/input can be read by this user: a udev rule tagging them uaccess, or the input group, gives access",
        )),
        Ok(()) => {}
    }
    // Every insert answers `insert.failed no-inserter` and the app opens the draft box.
    out.line(p::warn(
        "no-inserter",
        "dictation cannot insert on Linux yet",
    ));
    live::read_lines(
        Box::new(std::io::BufReader::new(std::io::stdin())),
        tx.clone(),
    );
    let mut dev = LinuxMic::default();
    live::serve(&mut d, &mut dev, tx, rx, &mut clock::now, &mut out)
}
