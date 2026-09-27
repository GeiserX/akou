//! The macOS backend of `akou-capture dictate` (docs/ux/DICTATION.md DC-N1, DC-N4, DC-N8, DC-N9,
//! DC-L2): the key tap, what has the keyboard, the grants and the microphone.
//!
//! - **Grant.** The Accessibility grant belongs to the app bundle macOS holds responsible for this
//!   process, which is the akou app that spawned it; a grant on the helper's own path does nothing
//!   (docs/gates/dc-k1-accessibility-grant.md). The helper asks the non-prompting
//!   `AXIsProcessTrusted` only; nothing here can show a permission dialog except opening the
//!   microphone, which is the app's own first-use prompt.
//! - **The tap** is an active `CGEventTap` at the head of the session, on its own thread with its
//!   own run loop. Its callback names the key (`mac_keys`), asks `tap::Gate` whether to swallow,
//!   and returns: nothing else runs there. When macOS disables it (`TapDisabledByTimeout`,
//!   `TapDisabledByUserInput`) the callback enables it again at once, never a timer that polls it
//!   (the voucher leak of Handy #1827), and tells the gate which keys are still down. The setup
//!   follows handy-keys' macOS listener (MIT, Copyright (c) 2026 handy-computer); akou needs its own
//!   callback because DC-A4 decides per event whether Escape or Enter is swallowed, which a
//!   registered set of blocked hotkeys cannot say. Events the helper posts itself carry
//!   `AKOU_EVENT` in their user-data field and pass untouched.
//! - **What has the keyboard** (`Screen`): the focused application from the system-wide
//!   accessibility element, its frontmost on-screen window (`kCGWindowNumber`, a stable id, never a
//!   title), and the focused element's kind: a secure text field is `secure`, a text role or a
//!   settable value is `editable`, anything else `not-editable`, and a read that fails
//!   (a dormant tree, no grant) `unknown`. Every accessibility read times out at 200 ms
//!   (`AXUIElementSetMessagingTimeout` on the system-wide element). Nothing here writes to another
//!   process's accessibility tree.
//! - **The insert** is `mac_insert`: the general pasteboard's promise and key events from a
//!   private source. The worker loop stays on the main thread, because AppKit serves the promise
//!   only on the main run loop, which `mac_insert::wait` turns between messages. After `focus`
//!   the worker waits (turning the run loop) until the target is frontmost, at most `FOCUS_MS`,
//!   so the insert that follows compares against the window that now has the keyboard.
//! - **The microphone** is `macos::mic::MicWorker`, the same cpal stream `run` records with, opened
//!   and closed as `live` asks; a Bluetooth device (`kAudioDeviceTransportTypeBluetooth`) is never
//!   kept warm.
//!
//! Nothing in this module runs in `cargo test`: a tap would take the developer's own keys. The CI
//! macOS runner drives it with posted events (`.github/workflows/ci.yml`, the helper job).

use std::cell::Cell;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::mpsc::{self, SyncSender};
use std::time::Duration;

use objc2::msg_send;
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::{AnyClass, AnyObject};
use objc2_application_services::{AXError, AXIsProcessTrusted, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{
    CFDictionary, CFMachPort, CFNumber, CFRange, CFRetained, CFRunLoop, CFString, CFType,
    kCFRunLoopCommonModes, kCFRunLoopDefaultMode,
};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventMask, CGEventSource, CGEventSourceStateID, CGEventTapLocation,
    CGEventTapOptions, CGEventTapPlacement, CGEventTapProxy, CGEventType,
    CGWindowListCopyWindowInfo, CGWindowListOption, kCGNullWindowID, kCGWindowLayer,
    kCGWindowNumber, kCGWindowOwnerPID,
};
use objc2_foundation::NSString;

use super::insert::{Inserter, Os, Targets};
use super::live::{self, Device, Stdio};
use super::mac_insert::{self, Events, Pasteboard};
use super::mac_keys;
use super::protocol::{self as p, Target};
use super::readback::Field;
use super::session::{Config, Dictate, Out};
use super::tap::{Gate, TapEvent};
use crate::clock;
use crate::macos::mic::MicWorker;
use crate::macos::props;
use crate::source::Event;

pub const BACKEND: &str = "cgeventtap";
/// The user-data mark on every event the helper posts, so its own tap lets them pass.
pub const AKOU_EVENT: i64 = 0x616B_6F75;
/// The longest any accessibility read may take (DC-L2).
const AX_TIMEOUT_S: f32 = 0.2;
const MIC_OPEN: Duration = Duration::from_secs(3);
const MIC_CLOSE: Duration = Duration::from_millis(1500);
/// The longest `focus` waits for the target to come to the front.
const FOCUS_MS: u64 = 500;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn IsSecureEventInputEnabled() -> u8;
}

// `NSRunningApplication` and `AVCaptureDevice` are looked up by name at run time.
#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {}
#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {}

/// The non-prompting trust check (never `AXIsProcessTrustedWithOptions` with the prompt).
pub fn trusted() -> bool {
    // SAFETY: a query with no arguments.
    unsafe { AXIsProcessTrusted() }
}

/// The microphone grant without asking: `AVAuthorizationStatusAuthorized` is 3. Not asked yet
/// reads `denied` until the protocol has a word for it; opening the device asks.
fn mic_grant() -> &'static str {
    autoreleasepool(|_| {
        let Some(cls) = AnyClass::get(c"AVCaptureDevice") else {
            return "denied";
        };
        let media = NSString::from_str("soun");
        // SAFETY: a class method taking an NSString and returning an NSInteger.
        let status: isize = unsafe { msg_send![cls, authorizationStatusForMediaType: &*media] };
        if status == 3 { "granted" } else { "denied" }
    })
}

/// `(mic, accessibility)` as `ready` names them.
pub fn grants() -> (&'static str, &'static str) {
    (mic_grant(), if trusted() { "granted" } else { "denied" })
}

// ---------------------------------------------------------------------------
// What has the keyboard

fn attr(el: &AXUIElement, name: &str) -> Option<CFRetained<CFType>> {
    let key = CFString::from_str(name);
    let mut v: *const CFType = std::ptr::null();
    // SAFETY: `v` is a valid out-pointer; a non-null result is a +1 reference.
    let err = unsafe { el.copy_attribute_value(&key, NonNull::from(&mut v)) };
    if err != AXError::Success {
        return None;
    }
    NonNull::new(v as *mut CFType).map(|p| unsafe { CFRetained::from_raw(p) })
}

fn attr_string(el: &AXUIElement, name: &str) -> Option<String> {
    attr(el, name).and_then(|v| v.downcast_ref::<CFString>().map(|s| s.to_string()))
}

fn attr_element(el: &AXUIElement, name: &str) -> Option<CFRetained<AXUIElement>> {
    attr(el, name).and_then(|v| v.downcast::<AXUIElement>().ok())
}

fn settable(el: &AXUIElement, name: &str) -> bool {
    let key = CFString::from_str(name);
    let mut s: u8 = 0;
    // SAFETY: `s` is a valid out-pointer.
    let err = unsafe { el.is_attribute_settable(&key, NonNull::from(&mut s)) };
    err == AXError::Success && s != 0
}

/// DC-N8, DC-N9: what kind of field has the keyboard.
pub fn field_kind(role: Option<&str>, subrole: Option<&str>, value_settable: bool) -> &'static str {
    match (role, subrole) {
        (_, Some("AXSecureTextField")) => "secure",
        (None, _) => "unknown",
        (Some("AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField"), _) => "editable",
        _ if value_settable => "editable",
        _ => "not-editable",
    }
}

fn system_wide() -> CFRetained<AXUIElement> {
    // SAFETY: no arguments; returns a +1 reference.
    unsafe { AXUIElement::new_system_wide() }
}

/// The pid of the application with the keyboard: the accessibility answer when trusted, else the
/// owner of the frontmost normal window.
fn front_pid(sys: &AXUIElement) -> Option<i32> {
    if let Some(app) = attr_element(sys, "AXFocusedApplication") {
        let mut pid: libc::pid_t = 0;
        // SAFETY: `pid` is a valid out-pointer.
        if unsafe { app.pid(NonNull::from(&mut pid)) } == AXError::Success && pid > 0 {
            return Some(pid);
        }
    }
    windows().into_iter().next().map(|(pid, _)| pid)
}

/// On-screen normal windows, front to back, as `(owner pid, window number)`. Neither needs the
/// screen-recording grant (only window names do).
fn windows() -> Vec<(i32, i64)> {
    let opts = CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements;
    let Some(list) = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) else {
        return Vec::new();
    };
    let num = |d: &CFDictionary, k: &CFString| -> Option<i64> {
        // SAFETY: the key is a CFString and the dictionary's values are CF objects.
        let v = unsafe { d.value((k as *const CFString).cast()) };
        let v = NonNull::new(v as *mut CFType)?;
        // SAFETY: a borrowed CF object from a live dictionary.
        let v: &CFType = unsafe { v.as_ref() };
        v.downcast_ref::<CFNumber>()?.as_i64()
    };
    let mut out = Vec::new();
    for i in 0..list.count() {
        // SAFETY: `i` is in bounds; every element of this array is a CFDictionary.
        let d = unsafe { list.value_at_index(i) } as *const CFDictionary;
        let Some(d) = (unsafe { d.as_ref() }) else {
            continue;
        };
        // SAFETY: the window-list keys are CFString constants.
        let (owner, layer, number) = unsafe {
            (
                num(d, kCGWindowOwnerPID),
                num(d, kCGWindowLayer),
                num(d, kCGWindowNumber),
            )
        };
        if let (Some(pid), Some(0), Some(n)) = (owner, layer, number) {
            out.push((pid as i32, n));
        }
    }
    out
}

fn running_app(pid: i32) -> Option<Retained<AnyObject>> {
    let cls = AnyClass::get(c"NSRunningApplication")?;
    // SAFETY: a class method taking a pid_t and returning an autoreleased object or nil.
    unsafe { msg_send![cls, runningApplicationWithProcessIdentifier: pid] }
}

fn bundle_id(pid: i32) -> String {
    autoreleasepool(|_| {
        let Some(app) = running_app(pid) else {
            return String::new();
        };
        // SAFETY: `bundleIdentifier` returns an NSString or nil.
        let id: Option<Retained<NSString>> = unsafe { msg_send![&app, bundleIdentifier] };
        id.map(|s| s.to_string()).unwrap_or_default()
    })
}

/// The focused element of the application `pid`.
fn focused(pid: i32) -> Option<CFRetained<AXUIElement>> {
    // SAFETY: any pid; returns a +1 reference.
    let app = unsafe { AXUIElement::new_application(pid) };
    attr_element(&app, "AXFocusedUIElement")
}

/// A UTF-16 offset (what `AXSelectedTextRange` counts) as a character index.
pub fn char_index(value: &str, utf16: usize) -> usize {
    let mut units = 0;
    for (i, c) in value.chars().enumerate() {
        if units >= utf16 {
            return i;
        }
        units += c.len_utf16();
    }
    value.chars().count()
}

pub struct Screen;

impl Targets for Screen {
    fn target(&mut self, _t_ns: u64) -> Target {
        let sys = system_wide();
        let Some(pid) = front_pid(&sys) else {
            return Target::unknown();
        };
        let window = windows()
            .into_iter()
            .find(|(owner, _)| *owner == pid)
            .map(|(_, n)| n.to_string())
            .unwrap_or_default();
        let field = match focused(pid) {
            Some(el) => field_kind(
                attr_string(&el, "AXRole").as_deref(),
                attr_string(&el, "AXSubrole").as_deref(),
                settable(&el, "AXValue"),
            ),
            None => "unknown",
        };
        Target {
            app: bundle_id(pid),
            pid: i64::from(pid),
            window,
            field: field.into(),
        }
    }

    fn secure_input(&mut self) -> bool {
        // SAFETY: a query with no arguments.
        unsafe { IsSecureEventInputEnabled() != 0 }
    }

    fn elevated(&mut self, _: &Target) -> bool {
        false
    }

    fn focus(&mut self, t: &Target) {
        let Ok(pid) = i32::try_from(t.pid) else {
            return;
        };
        autoreleasepool(|_| {
            if let Some(app) = running_app(pid) {
                // NSApplicationActivateAllWindows.
                // SAFETY: `activateWithOptions:` takes an NSUInteger and returns a BOOL.
                let _: bool = unsafe { msg_send![&app, activateWithOptions: 1usize] };
            }
        });
        // Activation lands on a later turn of the window server: wait for it (turning the run
        // loop, so a pending promise is still served), or the insert right after would compare
        // against the window that had the keyboard before.
        let sys = system_wide();
        for _ in 0..FOCUS_MS / 20 {
            if front_pid(&sys) == Some(pid) {
                break;
            }
            // SAFETY: a CF constant.
            CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, 0.02, false);
        }
    }

    fn read_field(&mut self, t: &Target) -> Field {
        let Ok(pid) = i32::try_from(t.pid) else {
            return Field::Unreadable;
        };
        let Some(el) = focused(pid) else {
            return Field::Unreadable;
        };
        if attr_string(&el, "AXSubrole").as_deref() == Some("AXSecureTextField") {
            return Field::Unreadable;
        }
        let Some(value) = attr_string(&el, "AXValue") else {
            return Field::Unreadable;
        };
        let caret = attr(&el, "AXSelectedTextRange")
            .and_then(|v| v.downcast::<AXValue>().ok())
            .and_then(|v| {
                let mut r = CFRange {
                    location: 0,
                    length: 0,
                };
                // SAFETY: `r` is a CFRange, the type asked for.
                let ok = unsafe {
                    v.value(AXValueType::CFRange, NonNull::from(&mut r).cast::<c_void>())
                };
                ok.then_some(r.location.max(0) as usize)
            })
            .unwrap_or(value.encode_utf16().count());
        let caret = char_index(&value, caret);
        Field::Text { value, caret }
    }

    fn trusted(&mut self) -> bool {
        trusted()
    }
}

// ---------------------------------------------------------------------------
// The tap

struct Ctx {
    gate: Gate,
    tap: Cell<Option<NonNull<CFMachPort>>>,
}

fn keys_down(gate: &Gate) -> Vec<String> {
    let flags = CGEventSource::flags_state(CGEventSourceStateID::CombinedSessionState);
    let mut held = mac_keys::held_modifiers(flags.0);
    let thought: Vec<String> = gate.lock().act.held().to_vec();
    for k in thought {
        if let Some(code) = mac_keys::key_code(&k)
            && CGEventSource::key_state(CGEventSourceStateID::CombinedSessionState, code)
        {
            held.push(k);
        }
    }
    held
}

unsafe extern "C-unwind" fn callback(
    _proxy: CGEventTapProxy,
    ty: CGEventType,
    event: NonNull<CGEvent>,
    user: *mut c_void,
) -> *mut CGEvent {
    // SAFETY: `user` is the `Ctx` the tap was created with; it lives as long as the tap.
    let ctx = unsafe { &*(user as *const Ctx) };
    let t_ns = clock::now().awake_ns;
    if ty == CGEventType::TapDisabledByTimeout || ty == CGEventType::TapDisabledByUserInput {
        if let Some(tap) = ctx.tap.get() {
            // SAFETY: the port outlives every callback of its own tap.
            CGEvent::tap_enable(unsafe { tap.as_ref() }, true);
        }
        let held = keys_down(&ctx.gate);
        ctx.gate.event(TapEvent::Disabled { t_ns, held: &held });
        return event.as_ptr();
    }
    // SAFETY: a live event for the duration of the callback.
    let ev = unsafe { event.as_ref() };
    if CGEvent::integer_value_field(Some(ev), CGEventField::EventSourceUserData) == AKOU_EVENT {
        return event.as_ptr();
    }
    let code = CGEvent::integer_value_field(Some(ev), CGEventField::KeyboardEventKeycode) as u16;
    let button = || CGEvent::integer_value_field(Some(ev), CGEventField::MouseEventButtonNumber);
    let key = if ty == CGEventType::KeyDown {
        mac_keys::key_name(code).map(|n| (n, true))
    } else if ty == CGEventType::KeyUp {
        mac_keys::key_name(code).map(|n| (n, false))
    } else if ty == CGEventType::FlagsChanged {
        mac_keys::modifier_change(code, CGEvent::flags(Some(ev)).0)
    } else if ty == CGEventType::OtherMouseDown {
        mac_keys::mouse_name(button()).map(|n| (n, true))
    } else if ty == CGEventType::OtherMouseUp {
        mac_keys::mouse_name(button()).map(|n| (n, false))
    } else {
        None
    };
    let Some((name, down)) = key else {
        return event.as_ptr();
    };
    if ctx.gate.event(TapEvent::Key { down, name, t_ns }).swallow {
        std::ptr::null_mut()
    } else {
        event.as_ptr()
    }
}

/// Starts the tap on its own thread; `Err` when macOS refuses it (no Accessibility grant).
fn start_tap(gate: Gate) -> Result<(), String> {
    let (init_tx, init_rx) = mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("akou-dictate-tap".into())
        .spawn(move || {
            let mask: CGEventMask = (1 << CGEventType::KeyDown.0)
                | (1 << CGEventType::KeyUp.0)
                | (1 << CGEventType::FlagsChanged.0)
                | (1 << CGEventType::OtherMouseDown.0)
                | (1 << CGEventType::OtherMouseUp.0);
            // Lives as long as the process: the tap never stops before the helper exits.
            let ctx: &'static Ctx = Box::leak(Box::new(Ctx {
                gate,
                tap: Cell::new(None),
            }));
            // SAFETY: the callback matches `CGEventTapCallBack`; `ctx` outlives the tap.
            let tap = unsafe {
                CGEvent::tap_create(
                    CGEventTapLocation::SessionEventTap,
                    CGEventTapPlacement::HeadInsertEventTap,
                    CGEventTapOptions::Default,
                    mask,
                    Some(callback),
                    ctx as *const Ctx as *mut c_void,
                )
            };
            let Some(tap) = tap else {
                let _ = init_tx.send(Err("macOS refused the key tap (Accessibility)".into()));
                return;
            };
            ctx.tap.set(Some(NonNull::from(&*tap)));
            let (Some(source), Some(rl)) = (
                CFMachPort::new_run_loop_source(None, Some(&tap), 0),
                CFRunLoop::current(),
            ) else {
                let _ = init_tx.send(Err("the key tap has no run loop".into()));
                return;
            };
            // SAFETY: a CF constant.
            rl.add_source(Some(&source), unsafe { kCFRunLoopCommonModes });
            CGEvent::tap_enable(&tap, true);
            let _ = init_tx.send(Ok(()));
            // Parked in the run loop: no timer, no polling; recovery is in the callback.
            while CFMachPort::is_valid(&tap) {
                CFRunLoop::run();
            }
            // The port died (the grant was revoked): the worker re-checks the grant.
            ctx.gate.event(TapEvent::Disabled {
                t_ns: clock::now().awake_ns,
                held: &[],
            });
        })
        .map_err(|e| format!("the key tap thread: {e}"))?;
    init_rx
        .recv()
        .unwrap_or_else(|_| Err("the key tap thread ended".into()))
}

// ---------------------------------------------------------------------------
// The microphone

/// `kAudioHardwarePropertyDevices`, `kAudioDevicePropertyTransportType` and the Bluetooth
/// transports (`'dev#'`, `'tran'`, `'blue'`, `'blea'`).
const DEVICES: u32 = 0x6465_7623;
const TRANSPORT: u32 = 0x7472_616E;
const BLUETOOTH: [u32; 2] = [0x626C_7565, 0x626C_6561];

fn is_bluetooth(uid: &str) -> bool {
    use objc2_core_audio::{
        kAudioDevicePropertyDeviceUID, kAudioHardwarePropertyDefaultInputDevice,
        kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    };
    let sys = kAudioObjectSystemObject as u32;
    let global = kAudioObjectPropertyScopeGlobal;
    let id = if uid == "default" {
        props::get::<u32>(sys, kAudioHardwarePropertyDefaultInputDevice, global).ok()
    } else {
        props::get_ids(sys, DEVICES, global)
            .unwrap_or_default()
            .into_iter()
            .find(|d| {
                props::get_string(*d, kAudioDevicePropertyDeviceUID, global).as_deref() == Ok(uid)
            })
    };
    id.and_then(|d| props::get::<u32>(d, TRANSPORT, global).ok())
        .is_some_and(|t| BLUETOOTH.contains(&t))
}

#[derive(Default)]
pub struct MacMic {
    worker: Option<MicWorker>,
}

impl Device for MacMic {
    fn open(&mut self, device: &str, events: SyncSender<Event>) -> Result<bool, String> {
        self.close();
        let w = MicWorker::spawn(device.to_string(), events);
        match w.open(MIC_OPEN) {
            Ok(info) => {
                self.worker = Some(w);
                Ok(is_bluetooth(if device == "default" {
                    "default"
                } else {
                    &info.id
                }))
            }
            Err(e) => {
                w.close(MIC_CLOSE);
                Err(format!("{}: {}", e.code, e.msg))
            }
        }
    }

    fn close(&mut self) {
        if let Some(w) = self.worker.take() {
            w.close(MIC_CLOSE);
        }
    }
}

// ---------------------------------------------------------------------------

/// `dictate --probe`: what this build would report at `ready`, without a tap or a device.
pub fn probe() -> String {
    let (mic, ax) = grants();
    p::ready(BACKEND, true, mic, ax)
}

/// Runs the dictate process on this Mac until `stop` or the end of stdin.
pub fn run(cfg: Config) -> i32 {
    let mut out = Stdio {
        stdout: std::io::stdout(),
        stderr: std::io::stderr(),
    };
    // Every accessibility read of this process gives up after 200 ms.
    // SAFETY: the system-wide element sets the default for every element.
    let _ = unsafe { system_wide().set_messaging_timeout(AX_TIMEOUT_S) };
    let (tx, rx) = mpsc::channel();
    let inserter = match (Pasteboard::general(), Events::new()) {
        (Some(clip), Some(sink)) => Some(Inserter::new(Os::Mac, Box::new(clip), Box::new(sink))),
        _ => None,
    };
    let no_inserter = inserter.is_none();
    let mut d = Dictate::new(cfg, Box::new(Screen), inserter);
    let (mic, ax) = grants();
    let mut gate = d.gate();
    gate.set_wake(live::forward_wakes(tx.clone()));
    let tapped = if ax == "granted" {
        start_tap(gate)
    } else {
        Err("Accessibility is not granted, so no key reaches dictation".into())
    };
    // With no tap nothing is swallowed, so the app shows no Enter hint (DC-A4).
    d.begin(BACKEND, tapped.is_ok(), (mic, ax), &mut out);
    if let Err(e) = tapped {
        out.line(p::warn("no-tap", &e));
    }
    if no_inserter {
        // Every insert answers `insert.failed no-inserter` and the app opens the draft box.
        out.line(p::warn("no-inserter", "no pasteboard or event source"));
    }
    live::read_lines(
        Box::new(std::io::BufReader::new(std::io::stdin())),
        tx.clone(),
    );
    let mut dev = MacMic::default();
    // The worker stays on this, the main thread: see `mac_insert::wait`.
    live::serve_with(
        &mut d,
        &mut dev,
        tx,
        rx,
        &mut clock::now,
        &mut mac_insert::wait,
        &mut out,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DC-N8 and DC-N9 read the field's kind from these three answers.
    #[test]
    fn the_field_kind_follows_role_subrole_and_settable_value() {
        assert_eq!(
            field_kind(Some("AXTextField"), Some("AXSecureTextField"), true),
            "secure"
        );
        assert_eq!(field_kind(None, Some("AXSecureTextField"), false), "secure");
        assert_eq!(field_kind(Some("AXTextArea"), None, false), "editable");
        assert_eq!(field_kind(Some("AXWebArea"), None, true), "editable");
        assert_eq!(field_kind(Some("AXButton"), None, false), "not-editable");
        assert_eq!(field_kind(None, None, false), "unknown");
    }

    #[test]
    fn a_utf16_caret_is_a_character_index() {
        assert_eq!(char_index("hello", 5), 5);
        assert_eq!(char_index("a😀b", 3), 2, "the emoji is two UTF-16 units");
        assert_eq!(char_index("a😀b", 4), 3);
        assert_eq!(char_index("ab", 9), 2);
    }
}
