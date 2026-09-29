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
//!   and closed as `live` asks, on the device `inputs::choose` picks from Core Audio's inputs and
//!   their transport (`kAudioDeviceTransportTypeBuiltIn`, `...Bluetooth`, `...BluetoothLE`,
//!   DC-N5). A Bluetooth device is never kept warm. A closed lid is IOKit's `AppleClamshellState`
//!   on `IOPMrootDomain`, which a desktop Mac does not have (read as open).
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
    CFBoolean, CFDictionary, CFMachPort, CFNumber, CFPreferencesAppSynchronize,
    CFPreferencesCopyAppValue, CFPreferencesSetAppValue, CFRange, CFRetained, CFRunLoop, CFString,
    CFType, CGPoint, CGSize, ConcreteType, kCFRunLoopCommonModes, kCFRunLoopDefaultMode,
};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventMask, CGEventSource, CGEventSourceStateID, CGEventTapLocation,
    CGEventTapOptions, CGEventTapPlacement, CGEventTapProxy, CGEventType,
    CGWindowListCopyWindowInfo, CGWindowListOption, kCGNullWindowID, kCGWindowBounds,
    kCGWindowLayer, kCGWindowNumber, kCGWindowOwnerPID,
};
use objc2_foundation::NSString;

use super::globe::{Globe, Prefs};
use super::inputs::{Input, Transport};
use super::insert::{Inserter, Os, Targets};
use super::live::{self, Device, Stdio};
use super::mac_insert::{self, Events, Pasteboard};
use super::mac_keys;
use super::protocol::{self as p, Target};
use super::readback::{Field, char_index};
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

/// The microphone grant without asking (DC-N3).
fn mic_grant() -> &'static str {
    autoreleasepool(|_| {
        let Some(cls) = AnyClass::get(c"AVCaptureDevice") else {
            return "denied";
        };
        let media = NSString::from_str("soun");
        // SAFETY: a class method taking an NSString and returning an NSInteger.
        let status: isize = unsafe { msg_send![cls, authorizationStatusForMediaType: &*media] };
        mic_word(status)
    })
}

/// An `AVAuthorizationStatus` as `ready` names it: 3 (authorized) is `granted`, 0 (not
/// determined) is `not-asked`, since macOS asks when the device first opens and lists akou in the
/// Microphone pane only after that; 1 (restricted) and 2 (denied) are `denied`.
fn mic_word(status: isize) -> &'static str {
    match status {
        3 => "granted",
        0 => "not-asked",
        _ => "denied",
    }
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
    windows().into_iter().next().map(|w| w.pid)
}

/// An on-screen normal window: its owner, its number and its bounds.
struct Window {
    pid: i32,
    number: i64,
    frame: Option<p::Frame>,
}

/// On-screen normal windows, front to back, with their bounds (`kCGWindowBounds`, points from the
/// top left of the primary display). None of it needs the screen-recording grant (only window
/// names do).
fn windows() -> Vec<Window> {
    let opts = CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements;
    let Some(list) = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) else {
        return Vec::new();
    };
    /// The value of `k` in `d` as `T`, borrowed from the dictionary.
    fn get<'a, T: ConcreteType>(d: &'a CFDictionary, k: &CFString) -> Option<&'a T> {
        // SAFETY: the key is a CFString and the dictionary's values are CF objects.
        let v = unsafe { d.value((k as *const CFString).cast()) };
        let v = NonNull::new(v as *mut CFType)?;
        // SAFETY: a borrowed CF object from a live dictionary.
        let v: &'a CFType = unsafe { v.as_ref() };
        v.downcast_ref::<T>()
    }
    let num = |d: &CFDictionary, k: &CFString| get::<CFNumber>(d, k)?.as_i64();
    let bounds = |d: &CFDictionary| -> Option<p::Frame> {
        // SAFETY: the window-list key is a CFString constant.
        let b = get::<CFDictionary>(d, unsafe { kCGWindowBounds })?;
        let n = |k: &str| {
            let v = get::<CFNumber>(b, &CFString::from_str(k))?.as_f64()?;
            v.is_finite().then(|| v.round() as i64)
        };
        Some(p::Frame {
            x: n("X")?,
            y: n("Y")?,
            width: n("Width")?,
            height: n("Height")?,
        })
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
            out.push(Window {
                pid: pid as i32,
                number: n,
                frame: bounds(d),
            });
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

/// An accessibility value of `el` of type `ty` (a point, a size, a range), read into `T`.
fn ax_value<T: Copy>(el: &AXUIElement, name: &str, ty: AXValueType, empty: T) -> Option<T> {
    let v = attr(el, name)?.downcast::<AXValue>().ok()?;
    let mut out = empty;
    // SAFETY: `out` is a `T`, the Core Foundation type `ty` names.
    let ok = unsafe { v.value(ty, NonNull::from(&mut out).cast::<c_void>()) };
    ok.then_some(out)
}

/// The frame of the window with the keyboard in application `pid`: its `AXFocusedWindow`'s
/// position and size, in the same top-left points as `kCGWindowBounds`.
fn focused_window_frame(pid: i32) -> Option<p::Frame> {
    // SAFETY: any pid; returns a +1 reference.
    let app = unsafe { AXUIElement::new_application(pid) };
    let win = attr_element(&app, "AXFocusedWindow")?;
    let at = ax_value(
        &win,
        "AXPosition",
        AXValueType::CGPoint,
        CGPoint::new(0.0, 0.0),
    )?;
    let size = ax_value(&win, "AXSize", AXValueType::CGSize, CGSize::new(0.0, 0.0))?;
    let n = |v: f64| v.is_finite().then(|| v.round() as i64);
    Some(p::Frame {
        x: n(at.x)?,
        y: n(at.y)?,
        width: n(size.width)?,
        height: n(size.height)?,
    })
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
            .find(|w| w.pid == pid)
            .map(|w| w.number.to_string())
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

    /// The window with the keyboard, where the pill shows: the focused application's
    /// `AXFocusedWindow`, else (no grant, a dormant tree) its frontmost normal window.
    fn frame(&mut self) -> Option<p::Frame> {
        let pid = front_pid(&system_wide())?;
        focused_window_frame(pid)
            .filter(|f| f.width > 0 && f.height > 0)
            .or_else(|| windows().into_iter().find(|w| w.pid == pid)?.frame)
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

/// `kAudioHardwarePropertyDevices`, `kAudioDevicePropertyTransportType` and its values
/// (`'dev#'`, `'tran'`; built-in `'bltn'`, Bluetooth `'blue'` and `'blea'`).
const DEVICES: u32 = 0x6465_7623;
const TRANSPORT: u32 = 0x7472_616E;
const BUILT_IN: u32 = 0x626C_746E;
const BLUETOOTH: [u32; 2] = [0x626C_7565, 0x626C_6561];

pub fn transport_of(code: u32) -> Transport {
    if code == BUILT_IN {
        Transport::BuiltIn
    } else if BLUETOOTH.contains(&code) {
        Transport::Bluetooth
    } else {
        Transport::Other
    }
}

/// Each Core Audio device's UID (what cpal calls its id) with its transport.
fn transports() -> Vec<(String, Transport)> {
    use objc2_core_audio::{
        kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    };
    let global = kAudioObjectPropertyScopeGlobal;
    props::get_ids(kAudioObjectSystemObject as u32, DEVICES, global)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|d| {
            let uid = props::get_string(d, kAudioDevicePropertyDeviceUID, global).ok()?;
            let code = props::get::<u32>(d, TRANSPORT, global).unwrap_or(0);
            Some((uid, transport_of(code)))
        })
        .collect()
}

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOServiceMatching(name: *const std::ffi::c_char) -> *mut c_void;
    fn IOServiceGetMatchingService(main_port: u32, matching: *mut c_void) -> u32;
    fn IORegistryEntryCreateCFProperty(
        entry: u32,
        key: &CFString,
        allocator: *const c_void,
        options: u32,
    ) -> *mut CFType;
    fn IOObjectRelease(object: u32) -> i32;
}

/// A MacBook's lid is closed (`AppleClamshellState`); a Mac with no lid reads open.
fn lid_closed() -> bool {
    // SAFETY: `IOServiceMatching` returns a dictionary that `IOServiceGetMatchingService`
    // consumes; the service is released below; the property is a +1 CF object or null.
    unsafe {
        let service = IOServiceGetMatchingService(0, IOServiceMatching(c"IOPMrootDomain".as_ptr()));
        if service == 0 {
            return false;
        }
        let key = CFString::from_str("AppleClamshellState");
        let v = IORegistryEntryCreateCFProperty(service, &key, std::ptr::null(), 0);
        IOObjectRelease(service);
        let Some(v) = NonNull::new(v) else {
            return false;
        };
        let v: CFRetained<CFType> = CFRetained::from_raw(v);
        v.downcast_ref::<CFBoolean>().is_some_and(CFBoolean::value)
    }
}

// ---------------------------------------------------------------------------
// Preferences

/// `CFPreferences` for the current user on any host, the domain `defaults` reads and writes: the
/// Globe key's action and akou's copy of it (DC-N2).
pub struct CfPrefs;

impl Prefs for CfPrefs {
    fn get(&mut self, domain: &str, key: &str) -> Option<i64> {
        let v = CFPreferencesCopyAppValue(&CFString::from_str(key), &CFString::from_str(domain))?;
        v.downcast_ref::<CFNumber>()?.as_i64()
    }

    fn set(&mut self, domain: &str, key: &str, value: Option<i64>) {
        let (key, domain) = (CFString::from_str(key), CFString::from_str(domain));
        let n = value.map(CFNumber::new_i64);
        // SAFETY: a CFString key and domain and a CFNumber (or none, which removes the key).
        unsafe { CFPreferencesSetAppValue(&key, n.as_deref().map(|n| n.as_ref()), &domain) };
        CFPreferencesAppSynchronize(&domain);
    }
}

#[derive(Default)]
pub struct MacMic {
    worker: Option<MicWorker>,
}

impl Device for MacMic {
    fn inputs(&mut self) -> Vec<Input> {
        let Ok(list) = crate::macos::list_devices() else {
            return Vec::new();
        };
        let kinds = transports();
        list.inputs
            .into_iter()
            .map(|e| Input {
                transport: kinds
                    .iter()
                    .find(|(uid, _)| *uid == e.id)
                    .map_or(Transport::Other, |(_, t)| *t),
                id: e.id,
                default: e.default,
            })
            .collect()
    }

    fn lid_closed(&mut self) -> bool {
        lid_closed()
    }

    fn open(&mut self, device: &str, events: SyncSender<Event>) -> Result<(), String> {
        self.close();
        let w = MicWorker::spawn(device.to_string(), events);
        match w.open(MIC_OPEN) {
            Ok(_) => {
                self.worker = Some(w);
                Ok(())
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
    d.set_globe(Globe::new(Box::new(CfPrefs)));
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

    /// DC-N3: a microphone never asked for is not a refusal, so the switch can start the helper
    /// and opening the device asks.
    #[test]
    fn the_mic_grant_tells_never_asked_from_refused() {
        assert_eq!(mic_word(3), "granted");
        assert_eq!(mic_word(0), "not-asked");
        assert_eq!(mic_word(1), "denied");
        assert_eq!(mic_word(2), "denied");
    }
}
