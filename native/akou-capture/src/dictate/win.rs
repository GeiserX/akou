//! The Windows backend of `akou-capture dictate` (docs/ux/DICTATION.md DC-N1, DC-N4, DC-N6 to
//! DC-N9, DC-A6, DC-L2): the key hook, what has the keyboard, the microphone and the insert.
//!
//! - **No grant.** Windows asks nothing of a process that hooks the keyboard or posts keys; the
//!   microphone grant is the privacy switch for desktop apps, read from the registry where
//!   Settings writes it, never asked.
//! - **The hook** is a `WH_KEYBOARD_LL` hook on its own thread with its own message loop. Its
//!   procedure names the key (`win_keys`), asks `tap::Gate` whether to swallow, and returns:
//!   nothing else runs there, because Windows drops a low-level hook that is slow to answer
//!   without telling it. The same thread owns a hidden window that hears a session unlock
//!   (`WM_WTSSESSION_CHANGE`) and a resume (`WM_POWERBROADCAST`), where the hook is installed again
//!   and every key the gate thinks is down and Windows says is not goes up (`TapEvent::Disabled`).
//! - **The mask key.** When the gate asks for it, a Win or Alt release is held back and posted
//!   again after the unassigned key 0xE8, in one `SendInput`, so Windows sees a chord and opens
//!   neither the Start menu nor the menu bar (AutoHotkey's `#MenuMaskKey`).
//! - **Mouse buttons** (DC-A6) come through a `WH_MOUSE_LL` hook, installed only while a mouse
//!   button is the binding or the recorder is open: a mouse hook sees every move on the machine.
//!   The worker tells the hook thread when that changes.
//! - Events the helper posts carry `AKOU_EVENT` in `dwExtraInfo` and pass untouched.
//! - **What has the keyboard** (`Screen`): the foreground window (its handle is the window id),
//!   its process's executable name as the app, and the focused element through UI Automation: a
//!   password field is `secure`, an edit control or a writable value `editable`, a document with
//!   a text pattern `editable` unless its value says read-only (a web page's body), anything else
//!   `not-editable`, and no answer `unknown`. Every UI Automation call gives up after 200 ms
//!   (`IUIAutomation2` connection and transaction timeouts).
//! - **Elevated.** A window running at a higher integrity level than the helper drops its posted
//!   keys (UIPI), so the insert goes clipboard-only (`reason: elevated`). A process whose token
//!   the helper may not read is taken as higher, unless the helper runs elevated itself.
//! - **Focus** after the draft box: `SetForegroundWindow`, and when Windows refuses a background
//!   process, the same through the input of the thread that has the foreground; then the worker
//!   waits, pumping its messages, until the target is in front, at most `FOCUS_MS`.
//! - **The field read-back** (DC-L2) is the focused element's value (`ValuePattern`, else the text
//!   pattern's document), and the caret from the text pattern's selection, counted in UTF-16 units
//!   like macOS. A UI Automation client writes nothing into the app it reads.
//! - **The insert** is `win_insert`, whose clipboard owner window lives on the worker's thread, so
//!   the worker stays on the main thread and pumps its messages in `win_insert::wait`.
//! - **The microphone** is `crate::windows::DictateMic`, the stream `run` records with. The inputs
//!   are WASAPI's capture endpoints; their transport is not read yet, so a Bluetooth headset is
//!   not told apart (DC-N5 on Windows is open), and a lid is never reported closed.
//! - **Other audio** (DC-U8): while the app asks for it, a session pauses the media sessions that
//!   are playing and plays them again at its end (`win_media`, on its own thread; the media
//!   service is reached only at the first pause).
//!
//! Nothing in this module runs in `cargo test`: a hook would take the developer's own keys. The
//! CI Windows runner drives it with posted events (`.github/workflows/ci.yml`, the helper job).

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::OnceLock;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TOKEN_MANDATORY_LABEL,
    TOKEN_QUERY, TokenIntegrityLevel,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW,
};
use windows::Win32::System::RemoteDesktop::WTSRegisterSessionNotification;
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationElement, IUIAutomationTextPattern,
    IUIAutomationValuePattern, TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start,
    UIA_ComboBoxControlTypeId, UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_TextPatternId,
    UIA_ValuePatternId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DispatchMessageW, GetForegroundWindow,
    GetMessageW, GetWindowThreadProcessId, HC_ACTION, HHOOK, IsIconic, KBDLLHOOKSTRUCT,
    LLKHF_EXTENDED, MSG, MSLLHOOKSTRUCT, PostMessageW, RegisterClassW, SW_RESTORE,
    SetForegroundWindow, SetWindowsHookExW, ShowWindow, TranslateMessage, UnhookWindowsHookEx,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WINDOW_EX_STYLE, WINDOW_STYLE, WM_KEYDOWN, WM_SYSKEYDOWN,
    WNDCLASSW,
};
use windows::core::{Interface, PCWSTR, PWSTR, w};

use super::inputs::{Input, Transport};
use super::insert::{Inserter, Os, Targets};
use super::live::{self, Device, Msg, Stdio};
use super::media::{Players, Worker};
use super::protocol::{self as p, Target};
use super::readback::{Field, char_index};
use super::session::{Config, Dictate, Out};
use super::tap::{Gate, TapEvent};
use super::win_insert::{self, Clip, Keys};
use super::win_keys;
use super::win_media::Smtc;
use crate::clock;
use crate::windows::DictateMic;

pub const BACKEND: &str = "llhook";
/// The `dwExtraInfo` of every event the helper posts, so its own hook lets them pass.
pub const AKOU_EVENT: usize = 0x616B_6F75;
/// The longest any UI Automation call may take (DC-L2).
const UIA_TIMEOUT_MS: u32 = 200;
/// The longest `focus` waits for the target to come to the front.
const FOCUS_MS: u64 = 500;
/// `SECURITY_MANDATORY_HIGH_RID`: an elevated process.
const HIGH_INTEGRITY: u32 = 0x3000;

const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
const WTS_SESSION_UNLOCK: usize = 0x8;
const WM_POWERBROADCAST: u32 = 0x0218;
const PBT_APMRESUMESUSPEND: usize = 0x7;
const PBT_APMRESUMEAUTOMATIC: usize = 0x12;
/// The worker's word to the hook thread: install (1) or remove (0) the mouse hook.
const WM_MOUSE_HOOK: u32 = 0x8000 + 1;

// ---------------------------------------------------------------------------
// Grants

fn reg_string(root: HKEY, path: PCWSTR, value: PCWSTR) -> Option<String> {
    let mut buf = [0u16; 64];
    let mut len = std::mem::size_of_val(&buf) as u32;
    // SAFETY: `buf` holds `len` bytes; the value is read as a string, zero-terminated.
    let r = unsafe {
        RegGetValueW(
            root,
            path,
            value,
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if r.is_err() {
        return None;
    }
    let n = (len as usize / 2).min(buf.len());
    Some(
        String::from_utf16_lossy(&buf[..n])
            .trim_end_matches('\0')
            .to_string(),
    )
}

/// The microphone privacy switch, as Settings writes it: `Deny` for desktop apps, for all apps,
/// or by policy for the machine.
fn mic_grant() -> &'static str {
    let store = w!(
        "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone"
    );
    let desktop = w!(
        "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged"
    );
    let denied = [
        (HKEY_CURRENT_USER, desktop),
        (HKEY_CURRENT_USER, store),
        (HKEY_LOCAL_MACHINE, store),
    ]
    .into_iter()
    .any(|(root, path)| reg_string(root, path, w!("Value")).as_deref() == Some("Deny"));
    if denied { "denied" } else { "granted" }
}

/// `dictate --probe`: what this build would report at `ready`, without a hook or a device.
pub fn probe() -> String {
    p::ready(BACKEND, true, mic_grant(), "not-needed")
}

// ---------------------------------------------------------------------------
// The hook

static GATE: OnceLock<Gate> = OnceLock::new();

#[derive(Default)]
struct Hooks {
    keyboard: Option<HHOOK>,
    mouse: Option<HHOOK>,
}

thread_local! {
    static HOOKS: RefCell<Hooks> = RefCell::new(Hooks::default());
}

fn hinstance() -> Option<HINSTANCE> {
    // SAFETY: the module of this executable.
    unsafe { GetModuleHandleW(None) }.ok().map(Into::into)
}

impl Hooks {
    fn set_keyboard(&mut self) -> Result<(), String> {
        if let Some(h) = self.keyboard.take() {
            // SAFETY: a hook this thread installed.
            let _ = unsafe { UnhookWindowsHookEx(h) };
        }
        // SAFETY: the procedure matches `HOOKPROC` and lives as long as the process.
        let h = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), hinstance(), 0) }
            .map_err(|e| format!("Windows refused the keyboard hook: {e}"))?;
        self.keyboard = Some(h);
        Ok(())
    }

    /// Installs, removes or (with `again`) installs anew the mouse hook.
    fn set_mouse(&mut self, on: bool, again: bool) {
        if on && self.mouse.is_some() && !again {
            return;
        }
        if let Some(h) = self.mouse.take() {
            // SAFETY: a hook this thread installed.
            let _ = unsafe { UnhookWindowsHookEx(h) };
        }
        if on {
            // SAFETY: as for the keyboard hook.
            self.mouse =
                unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), hinstance(), 0) }.ok();
        }
    }
}

fn now_ns() -> u64 {
    clock::now().awake_ns
}

fn down_now(vk: u16) -> bool {
    // SAFETY: a query; the high bit says the key is down now.
    unsafe { GetAsyncKeyState(i32::from(vk)) < 0 }
}

/// Every key the gate thinks is down that Windows still reports down.
fn keys_down(gate: &Gate) -> Vec<String> {
    let thought: Vec<String> = gate.lock().act.held().to_vec();
    thought
        .into_iter()
        .filter(|k| {
            let vk = win_keys::vk_of(k).map(|(v, _)| v).or_else(|| {
                // Mouse3 to Mouse5: VK_MBUTTON, VK_XBUTTON1, VK_XBUTTON2.
                match k.to_ascii_lowercase().as_str() {
                    "mouse3" => Some(0x04),
                    "mouse4" => Some(0x05),
                    "mouse5" => Some(0x06),
                    _ => None,
                }
            });
            vk.is_some_and(down_now)
        })
        .collect()
}

/// The hook was installed again (unlock, resume): Windows may have dropped it meanwhile, and
/// releases in the gap were never seen.
fn reinstall() {
    HOOKS.with(|h| {
        let mut h = h.borrow_mut();
        let _ = h.set_keyboard();
        let mouse = h.mouse.is_some();
        h.set_mouse(mouse, true);
    });
    if let Some(gate) = GATE.get() {
        let held = keys_down(gate);
        gate.event(TapEvent::Disabled {
            t_ns: now_ns(),
            held: &held,
        });
    }
}

unsafe extern "system" fn keyboard(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32
        && let Some(gate) = GATE.get()
    {
        // SAFETY: for HC_ACTION, `lp` points at this event's KBDLLHOOKSTRUCT.
        let k = unsafe { &*(lp.0 as *const KBDLLHOOKSTRUCT) };
        let extended = k.flags.0 & LLKHF_EXTENDED.0 != 0;
        if k.dwExtraInfo != AKOU_EVENT
            && let Some(name) = win_keys::key_name(k.vkCode, k.scanCode, extended)
        {
            let down = matches!(wp.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            let v = gate.event(TapEvent::Key {
                down,
                name,
                t_ns: now_ns(),
            });
            if v.mask {
                // The release goes out again after the mask key, in one batch, so nothing lands
                // between; if Windows refuses the batch the release passes unmasked.
                let vk = k.vkCode as u16;
                let mask = win_keys::MASK_KEY;
                if win_insert::post(&[
                    (mask, false, true),
                    (mask, false, false),
                    (vk, extended, false),
                ])
                .is_ok()
                {
                    return LRESULT(1);
                }
            }
            if v.swallow {
                return LRESULT(1);
            }
        }
    }
    // SAFETY: the arguments are the ones this hook procedure received.
    unsafe { CallNextHookEx(None, code, wp, lp) }
}

unsafe extern "system" fn mouse(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32
        && let Some(gate) = GATE.get()
    {
        // SAFETY: for HC_ACTION, `lp` points at this event's MSLLHOOKSTRUCT.
        let m = unsafe { &*(lp.0 as *const MSLLHOOKSTRUCT) };
        if m.dwExtraInfo != AKOU_EVENT
            && let Some((name, down)) = win_keys::mouse_name(wp.0 as u32, m.mouseData)
            && gate
                .event(TapEvent::Key {
                    down,
                    name,
                    t_ns: now_ns(),
                })
                .swallow
        {
            return LRESULT(1);
        }
    }
    // SAFETY: the arguments are the ones this hook procedure received.
    unsafe { CallNextHookEx(None, code, wp, lp) }
}

unsafe extern "system" fn hook_window(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match (msg, wp.0) {
        (WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK) => {
            reinstall();
            LRESULT(0)
        }
        (WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND) => {
            reinstall();
            LRESULT(1)
        }
        (WM_MOUSE_HOOK, on) => {
            HOOKS.with(|h| h.borrow_mut().set_mouse(on != 0, false));
            LRESULT(0)
        }
        // SAFETY: the arguments are the ones this window procedure received.
        _ => unsafe { DefWindowProcW(hwnd, msg, wp, lp) },
    }
}

/// The hidden window that hears unlock and resume. Never shown; a message-only window would not
/// receive the power broadcast.
fn notify_window() -> Result<HWND, String> {
    let hinstance = hinstance().ok_or("no module handle")?;
    let class = w!("akou-dictate-hook");
    // SAFETY: registering a class and creating a window of it on this thread.
    unsafe {
        let wc = WNDCLASSW {
            lpfnWndProc: Some(hook_window),
            hInstance: hinstance,
            lpszClassName: class,
            ..Default::default()
        };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            None,
            None,
            Some(hinstance),
            None,
        )
        .map_err(|e| format!("the hook's window: {e}"))?;
        // NOTIFY_FOR_THIS_SESSION. Without it the hook is still installed again on resume.
        let _ = WTSRegisterSessionNotification(hwnd, 0);
        Ok(hwnd)
    }
}

/// Starts the hooks on their own thread; returns the hook window's handle, for `WM_MOUSE_HOOK`.
fn start_hook(gate: Gate, mouse: bool) -> Result<isize, String> {
    if GATE.set(gate).is_err() {
        return Err("the hook is already running".into());
    }
    let (init_tx, init_rx) = mpsc::channel::<Result<isize, String>>();
    std::thread::Builder::new()
        .name("akou-dictate-hook".into())
        .spawn(move || {
            let hwnd = match notify_window() {
                Ok(h) => h,
                Err(e) => {
                    let _ = init_tx.send(Err(e));
                    return;
                }
            };
            let installed = HOOKS.with(|h| {
                let mut h = h.borrow_mut();
                h.set_keyboard()?;
                h.set_mouse(mouse, false);
                Ok::<(), String>(())
            });
            if let Err(e) = installed {
                let _ = init_tx.send(Err(e));
                return;
            }
            let _ = init_tx.send(Ok(hwnd.0 as isize));
            // The hooks are called from inside this loop; nothing else runs on this thread.
            let mut msg = MSG::default();
            // SAFETY: `msg` is a valid out-pointer; the messages are this thread's own.
            unsafe {
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        })
        .map_err(|e| format!("the hook thread: {e}"))?;
    init_rx
        .recv()
        .unwrap_or_else(|_| Err("the hook thread ended".into()))
}

// ---------------------------------------------------------------------------
// What has the keyboard

/// DC-N8, DC-N9: what kind of field has the keyboard, from UI Automation's answers: the control
/// type (`None` when nothing answered), whether it is a password field, what its value pattern
/// says about writing (`None` without one) and whether it has a text pattern.
pub fn field_kind(
    control: Option<i32>,
    password: bool,
    read_only: Option<bool>,
    text: bool,
) -> &'static str {
    const EDIT: i32 = UIA_EditControlTypeId.0;
    const COMBO: i32 = UIA_ComboBoxControlTypeId.0;
    const DOCUMENT: i32 = UIA_DocumentControlTypeId.0;
    if password {
        return "secure";
    }
    match (control, read_only) {
        (None, _) => "unknown",
        (Some(_), Some(true)) => "not-editable",
        (Some(EDIT | COMBO), _) => "editable",
        (Some(_), Some(false)) => "editable",
        (Some(DOCUMENT), None) if text => "editable",
        _ => "not-editable",
    }
}

fn foreground() -> Option<(HWND, u32)> {
    // SAFETY: queries.
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        (pid != 0).then_some((hwnd, pid))
    }
}

struct Process(HANDLE);

impl Process {
    fn open(pid: u32) -> Option<Process> {
        // SAFETY: limited query rights, which Windows grants for most processes.
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
            .ok()
            .map(Process)
    }

    /// The executable's file name: `notepad.exe`.
    fn exe(&self) -> Option<String> {
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        // SAFETY: `buf` holds `len` UTF-16 units.
        unsafe {
            QueryFullProcessImageNameW(
                self.0,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
        }
        .ok()?;
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit(['\\', '/']).next().map(str::to_string)
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        // SAFETY: a handle this struct opened.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// The integrity level of a process's token (`SECURITY_MANDATORY_*_RID`).
fn integrity(process: HANDLE) -> Option<u32> {
    // SAFETY: the token is opened for query and closed below; the buffer is u64-aligned and as
    // large as Windows asked for, and holds a TOKEN_MANDATORY_LABEL whose SID points into it.
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut len);
        let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
        let ok = GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(buf.as_mut_ptr().cast::<c_void>()),
            len,
            &mut len,
        );
        let _ = CloseHandle(token);
        ok.ok()?;
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = label.Label.Sid;
        let n = *GetSidSubAuthorityCount(sid);
        if n == 0 {
            return None;
        }
        Some(*GetSidSubAuthority(sid, u32::from(n) - 1))
    }
}

/// DC-N6: the target runs above the helper, so its posted keys would be dropped (UIPI). A token
/// the helper may not read is a higher one, unless the helper itself is elevated.
pub fn is_elevated(own: Option<u32>, target: Option<u32>) -> bool {
    match (own, target) {
        (Some(o), Some(t)) => t > o,
        (Some(o), None) => o < HIGH_INTEGRITY,
        (None, _) => false,
    }
}

fn hwnd_of(t: &Target) -> Option<HWND> {
    t.window
        .parse::<usize>()
        .ok()
        .filter(|h| *h != 0)
        .map(|h| HWND(h as *mut c_void))
}

pub struct Screen {
    uia: Option<IUIAutomation>,
}

impl Screen {
    /// UI Automation on this thread (COM must be initialised on it); `None` leaves every field
    /// `unknown`, so every insert goes to the draft box.
    fn new() -> Screen {
        // SAFETY: COM is initialised on this thread by `run`.
        let uia: Option<IUIAutomation> =
            unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }.ok();
        if let Some(a2) = uia.as_ref().and_then(|a| a.cast::<IUIAutomation2>().ok()) {
            // SAFETY: plain setters.
            unsafe {
                let _ = a2.SetConnectionTimeout(UIA_TIMEOUT_MS);
                let _ = a2.SetTransactionTimeout(UIA_TIMEOUT_MS);
            }
        }
        Screen { uia }
    }

    /// The focused element, asked twice: the first call into a process UI Automation has not
    /// reached yet can outlast the connection timeout, and the next call finds the connection made.
    /// Without the second ask the first insert into a newly opened window fails `field-unknown`.
    fn focused(&self) -> Option<IUIAutomationElement> {
        let uia = self.uia.as_ref()?;
        // SAFETY: COM calls on this thread's object.
        (0..2).find_map(|_| unsafe { uia.GetFocusedElement() }.ok())
    }
}

fn kind_of(el: &IUIAutomationElement) -> &'static str {
    // SAFETY: COM calls on a live element; each gives up after the UI Automation timeout.
    unsafe {
        let password = el.CurrentIsPassword().is_ok_and(|b| b.as_bool());
        let control = el.CurrentControlType().ok().map(|c| c.0);
        let read_only = el
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .ok()
            .and_then(|v| v.CurrentIsReadOnly().ok())
            .map(|b| b.as_bool());
        let text = el
            .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            .is_ok();
        field_kind(control, password, read_only, text)
    }
}

/// The element's text and the caret as a UTF-16 offset, when the text pattern has one.
fn read(el: &IUIAutomationElement) -> Option<(String, Option<usize>)> {
    // SAFETY: COM calls on a live element; each gives up after the UI Automation timeout.
    unsafe {
        let text = el
            .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            .ok();
        let value = el
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .ok()
            .and_then(|v| v.CurrentValue().ok())
            .map(|b| b.to_string());
        let doc = text.as_ref().and_then(|t| t.DocumentRange().ok());
        let value = match (value, &doc) {
            (Some(v), _) if !v.is_empty() || doc.is_none() => v,
            (_, Some(d)) => d.GetText(-1).ok()?.to_string(),
            (None, None) => return None,
            (Some(v), None) => v,
        };
        let caret = (|| {
            let (t, d) = (text.as_ref()?, doc.as_ref()?);
            let sel = t.GetSelection().ok()?;
            if sel.Length().ok()? < 1 {
                return None;
            }
            let first = sel.GetElement(0).ok()?;
            let before = d.Clone().ok()?;
            before
                .MoveEndpointByRange(
                    TextPatternRangeEndpoint_End,
                    &first,
                    TextPatternRangeEndpoint_Start,
                )
                .ok()?;
            Some(before.GetText(-1).ok()?.len())
        })();
        Some((value, caret))
    }
}

impl Targets for Screen {
    fn target(&mut self, _t_ns: u64) -> Target {
        let Some((hwnd, pid)) = foreground() else {
            return Target::unknown();
        };
        let field = self.focused().map_or("unknown", |el| kind_of(&el));
        Target {
            app: Process::open(pid).and_then(|p| p.exe()).unwrap_or_default(),
            pid: i64::from(pid),
            window: (hwnd.0 as usize).to_string(),
            field: field.into(),
        }
    }

    fn secure_input(&mut self) -> bool {
        false
    }

    fn elevated(&mut self, t: &Target) -> bool {
        // SAFETY: the pseudo-handle of this process needs no closing.
        let own = integrity(unsafe { GetCurrentProcess() });
        let target = u32::try_from(t.pid)
            .ok()
            .and_then(Process::open)
            .and_then(|p| integrity(p.0));
        is_elevated(own, target)
    }

    fn focus(&mut self, t: &Target) {
        let Some(hwnd) = hwnd_of(t) else {
            return;
        };
        // SAFETY: window calls on a handle that may be stale, which Windows refuses harmlessly.
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            if !SetForegroundWindow(hwnd).as_bool() {
                // A background process may not take the foreground; the thread that has it may
                // hand it over while the two share their input.
                let (me, front) = (
                    GetCurrentThreadId(),
                    GetWindowThreadProcessId(GetForegroundWindow(), None),
                );
                if front != 0 && front != me && AttachThreadInput(me, front, true).as_bool() {
                    let _ = SetForegroundWindow(hwnd);
                    let _ = AttachThreadInput(me, front, false);
                }
            }
        }
        for _ in 0..FOCUS_MS / 20 {
            if foreground().is_some_and(|(h, _)| h == hwnd) {
                break;
            }
            win_insert::pump();
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn read_field(&mut self, _t: &Target) -> Field {
        let Some(el) = self.focused() else {
            return Field::Unreadable;
        };
        // SAFETY: a COM call on a live element.
        if unsafe { el.CurrentIsPassword() }.is_ok_and(|b| b.as_bool()) {
            return Field::Unreadable;
        }
        let Some((value, caret)) = read(&el) else {
            return Field::Unreadable;
        };
        let caret = char_index(&value, caret.unwrap_or(value.encode_utf16().count()));
        Field::Text { value, caret }
    }

    fn trusted(&mut self) -> bool {
        true
    }
}

// ---------------------------------------------------------------------------
// The microphone

#[derive(Default)]
pub struct WinMic {
    mic: Option<DictateMic>,
}

impl Device for WinMic {
    fn inputs(&mut self) -> Vec<Input> {
        crate::windows::list_devices()
            .map(|l| {
                l.inputs
                    .into_iter()
                    .map(|e| Input {
                        id: e.id,
                        transport: Transport::Other,
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
    // UI Automation from a multithreaded apartment, as Microsoft advises for a client; the
    // clipboard calls need no apartment.
    // SAFETY: once, on this thread, before any COM call.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let (tx, rx) = mpsc::channel();
    let inserter = Clip::new().map(|c| Inserter::new(Os::Windows, Box::new(c), Box::new(Keys)));
    let no_inserter = inserter.is_none();
    let mut d = Dictate::new(cfg, Box::new(Screen::new()), inserter);
    d.set_media(Box::new(Worker::spawn(|| {
        Smtc::new().map(|m| Box::new(m) as Box<dyn Players>)
    })));
    let mut gate = d.gate();
    gate.set_wake(live::forward_wakes(tx.clone()));
    let mut mouse_on = gate.lock().act.wants_mouse();
    let hooked = start_hook(gate.clone(), mouse_on);
    d.begin(
        BACKEND,
        hooked.is_ok(),
        (mic_grant(), "not-needed"),
        &mut out,
    );
    let hook_window = match hooked {
        Ok(h) => Some(h),
        Err(e) => {
            out.line(p::warn("no-tap", &e));
            None
        }
    };
    if no_inserter {
        // Every insert answers `insert.failed no-inserter` and the app opens the draft box.
        out.line(p::warn(
            "no-inserter",
            "Windows refused the clipboard window",
        ));
    }
    live::read_lines(
        Box::new(std::io::BufReader::new(std::io::stdin())),
        tx.clone(),
    );
    let mut dev = WinMic::default();
    // The worker stays on this, the main thread, which owns the clipboard window.
    let mut wait = |rx: &Receiver<Msg>, step: Duration| {
        let want = gate.lock().act.wants_mouse();
        if want != mouse_on
            && let Some(h) = hook_window
        {
            mouse_on = want;
            // SAFETY: a message to the hook thread's own window.
            let _ = unsafe {
                PostMessageW(
                    Some(HWND(h as *mut c_void)),
                    WM_MOUSE_HOOK,
                    WPARAM(usize::from(want)),
                    LPARAM(0),
                )
            };
        }
        win_insert::wait(rx, step)
    };
    live::serve_with(
        &mut d,
        &mut dev,
        tx,
        rx,
        &mut clock::now,
        &mut wait,
        &mut out,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DC-N8 and DC-N9 read the field's kind from UI Automation's four answers.
    #[test]
    fn the_field_kind_follows_control_type_password_and_value() {
        let (edit, doc, combo, button) = (
            Some(UIA_EditControlTypeId.0),
            Some(UIA_DocumentControlTypeId.0),
            Some(UIA_ComboBoxControlTypeId.0),
            Some(50000),
        );
        assert_eq!(field_kind(edit, true, Some(false), true), "secure");
        assert_eq!(field_kind(None, true, None, false), "secure");
        assert_eq!(field_kind(edit, false, None, false), "editable");
        assert_eq!(field_kind(edit, false, Some(true), false), "not-editable");
        assert_eq!(field_kind(combo, false, None, false), "editable");
        assert_eq!(
            field_kind(doc, false, None, true),
            "editable",
            "Word, a rich edit"
        );
        assert_eq!(
            field_kind(doc, false, Some(true), true),
            "not-editable",
            "a web page's body"
        );
        assert_eq!(field_kind(doc, false, None, false), "not-editable");
        assert_eq!(field_kind(button, false, Some(false), false), "editable");
        assert_eq!(field_kind(button, false, None, false), "not-editable");
        assert_eq!(field_kind(None, false, None, false), "unknown");
    }

    /// DC-N6: only a target above the helper is elevated; an unreadable token counts as above
    /// unless the helper is elevated itself.
    #[test]
    fn elevated_means_a_higher_integrity_level() {
        const MEDIUM: u32 = 0x2000;
        assert!(is_elevated(Some(MEDIUM), Some(HIGH_INTEGRITY)));
        assert!(!is_elevated(Some(MEDIUM), Some(MEDIUM)));
        assert!(!is_elevated(Some(HIGH_INTEGRITY), Some(MEDIUM)));
        assert!(is_elevated(Some(MEDIUM), None));
        assert!(!is_elevated(Some(HIGH_INTEGRITY), None));
        assert!(!is_elevated(None, Some(HIGH_INTEGRITY)));
    }
}
