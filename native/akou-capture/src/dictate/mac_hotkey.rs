//! The dictation chord as a macOS registered hotkey (`RegisterEventHotKey`), beside the tap.
//!
//! Under Secure Input (a password field, a terminal's secure entry, or a login window that never
//! let go of it) macOS gives every event tap the modifiers and nothing else, so a chord such as
//! `Option+Space` never reaches the tap (DC-A2). A registered hotkey is matched by macOS itself and
//! still arrives. Its press and release go to the gate as `TapEvent::Hotkey`, where the tap's own
//! report of the same press, when it has one, counts once (`Activation::bound`).
//!
//! Carbon delivers the hotkey through the main thread's event queue, which nothing here reads
//! unless asked: `pump` dispatches whatever is queued, and the worker's wait calls it every turn
//! (`mac_insert::wait`). A key alone, a side-specific modifier and `Fn` cannot be registered
//! (`mac_keys::carbon_chord`) and stay with the tap, which hears a key alone under Secure Input.

use std::ffi::c_void;
use std::ptr;

use super::keys::Hotkey;
use super::mac_keys;
use super::session::Binder;
use super::tap::{Gate, TapEvent};
use crate::clock;

type OsStatus = i32;
type EventRef = *mut c_void;
type EventTargetRef = *mut c_void;
type EventHotKeyRef = *mut c_void;
type EventHandlerRef = *mut c_void;
type EventHandlerCallRef = *mut c_void;
type Handler = unsafe extern "C" fn(EventHandlerCallRef, EventRef, *mut c_void) -> OsStatus;

#[repr(C)]
struct EventTypeSpec {
    class: u32,
    kind: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct EventHotKeyId {
    signature: u32,
    id: u32,
}

/// `kEventClassKeyboard` (`'keyb'`), `kEventHotKeyPressed` and `kEventHotKeyReleased`.
const KEYBOARD: u32 = 0x6B65_7962;
const PRESSED: u32 = 5;
const RELEASED: u32 = 6;
/// `'akou'`, the signature of the one hotkey this process registers.
const SIGNATURE: u32 = 0x616B_6F75;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn GetApplicationEventTarget() -> EventTargetRef;
    fn GetEventDispatcherTarget() -> EventTargetRef;
    fn InstallEventHandler(
        target: EventTargetRef,
        handler: Handler,
        count: usize,
        list: *const EventTypeSpec,
        user: *mut c_void,
        out: *mut EventHandlerRef,
    ) -> OsStatus;
    fn RegisterEventHotKey(
        code: u32,
        modifiers: u32,
        id: EventHotKeyId,
        target: EventTargetRef,
        options: u32,
        out: *mut EventHotKeyRef,
    ) -> OsStatus;
    fn UnregisterEventHotKey(hotkey: EventHotKeyRef) -> OsStatus;
    fn GetEventKind(event: EventRef) -> u32;
    fn ReceiveNextEvent(
        count: usize,
        list: *const EventTypeSpec,
        timeout: f64,
        pull: u8,
        out: *mut EventRef,
    ) -> OsStatus;
    fn SendEventToEventTarget(event: EventRef, target: EventTargetRef) -> OsStatus;
    fn ReleaseEvent(event: EventRef);
}

unsafe extern "C" fn on_hotkey(
    _: EventHandlerCallRef,
    event: EventRef,
    user: *mut c_void,
) -> OsStatus {
    // SAFETY: `user` is the gate `OsHotkey::install` leaked; it lives as long as the process.
    let gate = unsafe { &*(user as *const Gate) };
    // SAFETY: a live event for the duration of the handler.
    let down = match unsafe { GetEventKind(event) } {
        PRESSED => true,
        RELEASED => false,
        _ => return 0,
    };
    gate.event(TapEvent::Hotkey {
        down,
        t_ns: clock::now().awake_ns,
    });
    0
}

/// Dispatches every event queued for this process, without waiting. Main thread only.
pub fn pump() {
    let mut event: EventRef = ptr::null_mut();
    // SAFETY: Carbon's own pump: each event pulled is sent to the dispatcher, then released.
    unsafe {
        while ReceiveNextEvent(0, ptr::null(), 0.0, 1, &mut event) == 0 {
            SendEventToEventTarget(event, GetEventDispatcherTarget());
            ReleaseEvent(event);
        }
    }
}

/// The registered dictation chord, a `Binder` so every rebind moves it. Main thread only.
pub struct OsHotkey {
    current: EventHotKeyRef,
}

impl OsHotkey {
    /// Installs the handler that hands each press to `gate`; `None` when Carbon refuses it.
    pub fn install(gate: Gate) -> Option<OsHotkey> {
        let user = Box::into_raw(Box::new(gate)) as *mut c_void;
        let kinds = [
            EventTypeSpec {
                class: KEYBOARD,
                kind: PRESSED,
            },
            EventTypeSpec {
                class: KEYBOARD,
                kind: RELEASED,
            },
        ];
        let mut handler: EventHandlerRef = ptr::null_mut();
        // SAFETY: the handler matches `EventHandlerProcPtr`; `user` is never freed.
        let status = unsafe {
            InstallEventHandler(
                GetApplicationEventTarget(),
                on_hotkey,
                kinds.len(),
                kinds.as_ptr(),
                user,
                &mut handler,
            )
        };
        (status == 0).then_some(OsHotkey {
            current: ptr::null_mut(),
        })
    }

    fn release(&mut self) {
        if !self.current.is_null() {
            // SAFETY: a hotkey this process registered and has not unregistered.
            unsafe { UnregisterEventHotKey(self.current) };
            self.current = ptr::null_mut();
        }
    }
}

impl Binder for OsHotkey {
    /// Never refuses: a chord macOS will not hold (another app has it, or Carbon cannot express
    /// it) still works through the tap whenever Secure Input is off.
    fn bind(&mut self, hotkey: &Hotkey) -> Result<(), String> {
        self.release();
        if let Some((code, modifiers)) = mac_keys::carbon_chord(hotkey) {
            let id = EventHotKeyId {
                signature: SIGNATURE,
                id: 1,
            };
            let mut out: EventHotKeyRef = ptr::null_mut();
            // SAFETY: plain values and an out pointer to a local.
            let status = unsafe {
                RegisterEventHotKey(
                    code,
                    modifiers,
                    id,
                    GetApplicationEventTarget(),
                    0,
                    &mut out,
                )
            };
            if status == 0 {
                self.current = out;
            }
        }
        Ok(())
    }

    fn holds_under_secure_input(&self) -> bool {
        !self.current.is_null()
    }
}
