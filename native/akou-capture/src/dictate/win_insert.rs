//! The Windows inserter of `akou-capture dictate` (docs/ux/DICTATION.md DC-N6, DC-N7, DC-N8): the
//! clipboard behind `insert::Clipboard` and `SendInput` behind `insert::Sink`. The receipt rules
//! themselves are in `insert`, the same on every OS.
//!
//! - **The promise** is delayed rendering: a paste puts `CF_UNICODETEXT` on the clipboard with no
//!   data (`SetClipboardData(CF_UNICODETEXT, NULL)`), and the first app that asks for the text
//!   makes Windows send `WM_RENDERFORMAT` to the owner window. That message is the read receipt.
//!   Windows keeps the rendered text, so a second read in the same paste sends nothing; the
//!   restore waits `QUIET_MS` after the first. A `CF_TEXT` read renders the Unicode text too,
//!   since Windows converts from it.
//! - **Markers.** Every promise, and every clipboard-only copy made for a password field or an
//!   elevated window, carries `ExcludeClipboardContentFromMonitorProcessing`, so clipboard
//!   managers that follow the convention neither read nor keep it, and
//!   `CanIncludeInClipboardHistory` and `CanUploadToCloudClipboard` set to 0, so Windows'
//!   own clipboard history (Win+V) and its cloud sync skip it.
//! - **The owner** is a message-only window on the worker's thread. `wait` pumps that thread's
//!   messages between the worker's steps, so a read is answered within one step. Rendering sets
//!   the text again without changing ownership, which moves Windows' sequence number, so the
//!   change count this clipboard reports while it still owns its promise is the one publishing
//!   left: only another writer (`WM_DESTROYCLIPBOARD`) makes it differ.
//! - **The snapshot** is every format whose data is global memory, by format number: text in
//!   every encoding, HTML, RTF, a DIB image, a file list, an app's private formats. Formats that
//!   hold a GDI handle (`CF_BITMAP`, a metafile, a palette) or that the owner draws itself are
//!   left out: they cannot be copied as bytes, and the DIB beside a bitmap carries the image.
//! - **The events** come from `SendInput`, each carrying `win::AKOU_EVENT` in `dwExtraInfo` so the
//!   helper's own hook lets it pass. The V of the paste chord is the virtual key the layout of the
//!   window under the cursor types V with (`VkKeyScanExW`), which is also what every Windows app
//!   matches Ctrl+V on; a layout with no V at all (Russian, Greek) still pastes with `VK_V`.
//! - **The typed path** is one `KEYEVENTF_UNICODE` down and up per UTF-16 unit, a surrogate pair
//!   as its two units, which is how Windows delivers them to an app.
//!
//! Nothing here runs in `cargo test`: it would take the developer's clipboard and keyboard. The CI
//! Windows runner drives it (`.github/workflows/ci.yml`, the helper job).

use std::cell::RefCell;
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::time::Duration;

use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
    GetClipboardFormatNameW, GetClipboardOwner, GetClipboardSequenceNumber, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{
    GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyboardLayout, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS,
    KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, SendInput, VIRTUAL_KEY,
    VkKeyScanExW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetForegroundWindow,
    GetWindowThreadProcessId, HWND_MESSAGE, MSG, MsgWaitForMultipleObjects, PM_REMOVE,
    PeekMessageW, QS_ALLINPUT, RegisterClassW, TranslateMessage, WINDOW_EX_STYLE, WINDOW_STYLE,
    WNDCLASSW,
};
use windows::core::w;

use super::insert::{Clipboard, Key, Sink, Snapshot};
use super::live::Msg;
use super::win::AKOU_EVENT;
use super::win_keys;
use crate::clock;

const CF_UNICODETEXT: u32 = 13;
const WM_RENDERFORMAT: u32 = 0x0305;
const WM_RENDERALLFORMATS: u32 = 0x0306;
const WM_DESTROYCLIPBOARD: u32 = 0x0307;
/// Another program may hold the clipboard open for a moment: tries, 5 ms apart.
const OPEN_TRIES: u32 = 10;

/// The worker's wait on Windows (`live::serve_with`): this thread's window messages (the
/// clipboard owner's `WM_RENDERFORMAT`), then the next message on the queue.
pub fn wait(rx: &Receiver<Msg>, step: Duration) -> Result<Msg, RecvTimeoutError> {
    pump();
    if let Ok(m) = rx.try_recv() {
        return Ok(m);
    }
    let ms = u32::try_from(step.as_millis()).unwrap_or(u32::MAX);
    // SAFETY: no handles; returns when a message arrives for this thread or the time passes.
    unsafe { MsgWaitForMultipleObjects(None, false, ms, QS_ALLINPUT) };
    pump();
    rx.try_recv().map_err(|e| match e {
        TryRecvError::Empty => RecvTimeoutError::Timeout,
        TryRecvError::Disconnected => RecvTimeoutError::Disconnected,
    })
}

/// Dispatches every message waiting for this thread's windows.
pub fn pump() {
    let mut msg = MSG::default();
    // SAFETY: `msg` is a valid out-pointer; the messages are this thread's own.
    unsafe {
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

// ---------------------------------------------------------------------------
// The clipboard

#[derive(Default)]
struct Promise {
    /// The text as UTF-16 with its terminating zero, while a promise is out.
    text: Option<Vec<u16>>,
    /// When the text was read, on the awake clock the worker uses.
    reads: Vec<u64>,
    /// The promise still owns the clipboard.
    owned: bool,
}

thread_local! {
    static PROMISE: RefCell<Promise> = RefCell::new(Promise::default());
}

/// Global memory holding `bytes`, for `SetClipboardData` (which takes it over on success).
fn global(bytes: &[u8]) -> Option<HGLOBAL> {
    // SAFETY: a fresh allocation of at least `bytes.len()` bytes, locked only to copy into it.
    unsafe {
        let g = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).ok()?;
        let p = GlobalLock(g);
        if p.is_null() {
            let _ = GlobalFree(Some(g));
            return None;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p.cast::<u8>(), bytes.len());
        let _ = GlobalUnlock(g);
        Some(g)
    }
}

fn utf16_bytes(units: &[u16]) -> Vec<u8> {
    units.iter().flat_map(|u| u.to_le_bytes()).collect()
}

/// Puts `bytes` on the open clipboard as `format`.
fn set(format: u32, bytes: &[u8]) -> bool {
    let Some(g) = global(bytes) else {
        return false;
    };
    // SAFETY: the clipboard is open (or this is a `WM_RENDERFORMAT`); on success Windows owns `g`.
    unsafe {
        if SetClipboardData(format, Some(HANDLE(g.0))).is_ok() {
            true
        } else {
            let _ = GlobalFree(Some(g));
            false
        }
    }
}

/// Renders the promised text, in answer to `WM_RENDERFORMAT`.
fn render() {
    let text = PROMISE.with(|p| {
        let mut p = p.borrow_mut();
        let t = p.text.clone();
        if t.is_some() {
            p.reads.push(clock::now().awake_ns);
        }
        t
    });
    if let Some(t) = text {
        set(CF_UNICODETEXT, &utf16_bytes(&t));
    }
}

unsafe extern "system" fn clip_window(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_RENDERFORMAT => {
            if wp.0 as u32 == CF_UNICODETEXT {
                render();
            }
            LRESULT(0)
        }
        // The helper is exiting with a promise out: leave the text behind for the paste.
        WM_RENDERALLFORMATS => {
            // SAFETY: this window may open the clipboard it owns.
            unsafe {
                if OpenClipboard(Some(hwnd)).is_ok() {
                    if GetClipboardOwner().is_ok_and(|o| o == hwnd) {
                        render();
                    }
                    let _ = CloseClipboard();
                }
            }
            LRESULT(0)
        }
        WM_DESTROYCLIPBOARD => {
            PROMISE.with(|p| {
                let mut p = p.borrow_mut();
                p.owned = false;
                p.text = None;
            });
            LRESULT(0)
        }
        // SAFETY: the arguments are the ones this window procedure received.
        _ => unsafe { DefWindowProcW(hwnd, msg, wp, lp) },
    }
}

/// Global-memory formats a snapshot can copy as bytes (see the module doc). `name` is a
/// registered format's name: OLE's own two point into the process that copied, so written back
/// by another owner they would name an object that is gone.
pub fn copyable(format: u32, name: &str) -> bool {
    // CF_BITMAP, CF_METAFILEPICT, CF_PALETTE, CF_ENHMETAFILE, CF_OWNERDISPLAY and the display
    // variants, then CF_GDIOBJFIRST to CF_GDIOBJLAST.
    !matches!(format, 2 | 3 | 9 | 14 | 0x80 | 0x82 | 0x83 | 0x8E)
        && !(0x300..=0x3FF).contains(&format)
        && !matches!(name, "DataObject" | "Ole Private Data")
}

/// A registered format's name; empty for the standard ones.
fn format_name(format: u32) -> String {
    let mut buf = [0u16; 128];
    // SAFETY: `buf` is writable for its whole length.
    let n = unsafe { GetClipboardFormatNameW(format, &mut buf) };
    String::from_utf16_lossy(&buf[..usize::try_from(n).unwrap_or(0).min(buf.len())])
}

pub struct Clip {
    hwnd: HWND,
    /// The sequence number publishing left, reported while the promise owns the clipboard.
    published: u64,
    /// `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory`,
    /// `CanUploadToCloudClipboard`.
    markers: [u32; 3],
}

impl Clip {
    /// The owner window on this thread; `None` when Windows refuses it.
    pub fn new() -> Option<Clip> {
        // SAFETY: registering a class and creating a message-only window of it on this thread.
        unsafe {
            let hinstance = GetModuleHandleW(None).ok()?;
            let class = w!("akou-dictate-clipboard");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(clip_window),
                hInstance: hinstance.into(),
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
                Some(HWND_MESSAGE),
                None,
                Some(hinstance.into()),
                None,
            )
            .ok()?;
            let markers = [
                RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing")),
                RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory")),
                RegisterClipboardFormatW(w!("CanUploadToCloudClipboard")),
            ];
            Some(Clip {
                hwnd,
                published: 0,
                markers,
            })
        }
    }

    fn open(&self) -> bool {
        for i in 0..OPEN_TRIES {
            // SAFETY: this thread's own window.
            if unsafe { OpenClipboard(Some(self.hwnd)) }.is_ok() {
                return true;
            }
            if i + 1 < OPEN_TRIES {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        false
    }

    /// Marks what is on the open clipboard for clipboard managers and Windows' history to skip.
    fn mark(&self) {
        for m in self.markers.into_iter().filter(|m| *m != 0) {
            set(m, &0u32.to_le_bytes());
        }
    }
}

fn close() {
    // SAFETY: closes the clipboard this thread opened.
    let _ = unsafe { CloseClipboard() };
}

impl Clipboard for Clip {
    fn snapshot(&mut self) -> Snapshot {
        if !self.open() {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut f = 0;
        loop {
            // SAFETY: the clipboard is open.
            f = unsafe { EnumClipboardFormats(f) };
            if f == 0 {
                break;
            }
            if !copyable(f, &format_name(f)) {
                continue;
            }
            // SAFETY: the clipboard is open; a global-memory format's handle is an HGLOBAL that
            // stays valid until the clipboard closes, locked only to copy it.
            unsafe {
                let Ok(h) = GetClipboardData(f) else {
                    continue;
                };
                let g = HGLOBAL(h.0);
                let size = GlobalSize(g);
                let p = GlobalLock(g);
                if p.is_null() {
                    continue;
                }
                let bytes = std::slice::from_raw_parts(p.cast::<u8>(), size).to_vec();
                let _ = GlobalUnlock(g);
                out.push((f.to_string(), bytes));
            }
        }
        close();
        out
    }

    fn publish(&mut self, text: &str) -> Result<u64, String> {
        if !self.open() {
            return Err("the clipboard is held by another program".into());
        }
        // SAFETY: the clipboard is open; emptying it makes this window the owner (and sends this
        // window its own `WM_DESTROYCLIPBOARD` for an older promise first).
        unsafe {
            let _ = EmptyClipboard();
        }
        PROMISE.with(|p| {
            let mut p = p.borrow_mut();
            p.text = Some(text.encode_utf16().chain([0]).collect());
            p.reads.clear();
            p.owned = true;
        });
        // A null handle is the promise; Windows reports it as a null result, not an error.
        // SAFETY: the clipboard is open and owned by this window.
        let _ = unsafe { SetClipboardData(CF_UNICODETEXT, None) };
        self.mark();
        close();
        // SAFETY: a query with no arguments.
        self.published = u64::from(unsafe { GetClipboardSequenceNumber() });
        Ok(self.published)
    }

    fn write(&mut self, text: &str, concealed: bool) -> Result<(), String> {
        if !self.open() {
            return Err("the clipboard is held by another program".into());
        }
        // SAFETY: the clipboard is open.
        unsafe {
            let _ = EmptyClipboard();
        }
        let units: Vec<u16> = text.encode_utf16().chain([0]).collect();
        let ok = set(CF_UNICODETEXT, &utf16_bytes(&units));
        if ok && concealed {
            self.mark();
        }
        close();
        if ok {
            Ok(())
        } else {
            Err("Windows refused the text on the clipboard".into())
        }
    }

    fn change_count(&mut self) -> u64 {
        let owned = PROMISE.with(|p| p.borrow().owned);
        // SAFETY: queries with no arguments.
        unsafe {
            if owned && GetClipboardOwner().is_ok_and(|o| o == self.hwnd) {
                self.published
            } else {
                u64::from(GetClipboardSequenceNumber())
            }
        }
    }

    fn restore(&mut self, snapshot: &Snapshot) {
        if !self.open() {
            return;
        }
        // SAFETY: the clipboard is open.
        unsafe {
            let _ = EmptyClipboard();
        }
        for (format, bytes) in snapshot {
            if let Ok(f) = format.parse::<u32>() {
                set(f, bytes);
            }
        }
        close();
        PROMISE.with(|p| *p.borrow_mut() = Promise::default());
    }

    fn reads(&mut self) -> Vec<u64> {
        PROMISE.with(|p| std::mem::take(&mut p.borrow_mut().reads))
    }
}

// ---------------------------------------------------------------------------
// The events

fn key(vk: u16, extended: bool, down: bool) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: AKOU_EVENT,
            },
        },
    }
}

fn unicode(unit: u16, down: bool) -> INPUT {
    let mut flags = KEYEVENTF_UNICODE;
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: unit,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: AKOU_EVENT,
            },
        },
    }
}

/// `(vk, extended, down)` in order, as one `SendInput`, so nothing the user types lands between.
pub fn post(keys: &[(u16, bool, bool)]) -> Result<(), String> {
    let inputs: Vec<INPUT> = keys.iter().map(|&(v, e, d)| key(v, e, d)).collect();
    send(&inputs)
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    // SAFETY: a slice of initialised INPUTs and their size.
    let n = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if n as usize == inputs.len() {
        Ok(())
    } else {
        Err(format!(
            "Windows took {n} of {} key events (another program blocks input)",
            inputs.len()
        ))
    }
}

fn resolve(name: &str) -> Result<(u16, bool), String> {
    win_keys::vk_of(name).ok_or_else(|| format!("no key named {name}"))
}

pub struct Keys;

impl Sink for Keys {
    fn held_modifiers(&mut self) -> Vec<String> {
        win_keys::modifier_vks()
            // SAFETY: a query; the high bit says the key is down now.
            .filter(|(vk, _)| unsafe { GetAsyncKeyState(i32::from(*vk)) } < 0)
            .map(|(_, n)| n.to_string())
            .collect()
    }

    fn modifier(&mut self, name: &str, down: bool) -> Result<(), String> {
        let (vk, ext) = resolve(name)?;
        post(&[(vk, ext, down)])
    }

    fn press(&mut self, mods: &[&str], k: Key) -> Result<(), String> {
        let mods: Vec<(u16, bool)> = mods.iter().map(|m| resolve(m)).collect::<Result<_, _>>()?;
        let (vk, ext) = match k {
            Key::Code(c) => (c, false),
            Key::Named(n) => resolve(n)?,
        };
        let mut seq: Vec<(u16, bool, bool)> = mods.iter().map(|&(v, e)| (v, e, true)).collect();
        seq.push((vk, ext, true));
        seq.push((vk, ext, false));
        seq.extend(mods.iter().rev().map(|&(v, e)| (v, e, false)));
        post(&seq)
    }

    fn keycode(&mut self, ch: char) -> Option<u16> {
        let mut buf = [0u16; 2];
        let unit = *ch.encode_utf16(&mut buf).first()?;
        // SAFETY: queries; a thread id of 0 (no foreground window) is this thread's layout.
        let r = unsafe {
            let tid = GetWindowThreadProcessId(GetForegroundWindow(), None);
            VkKeyScanExW(unit, GetKeyboardLayout(tid))
        };
        if r == -1 {
            // No key types it on this layout: shortcuts still match the Latin virtual key.
            return win_keys::vk_of(&ch.to_ascii_uppercase().to_string()).map(|(v, _)| v);
        }
        Some((r & 0xFF) as u16)
    }

    fn type_text(&mut self, text: &str) -> Result<(), String> {
        let inputs: Vec<INPUT> = text
            .encode_utf16()
            .flat_map(|u| [unicode(u, true), unicode(u, false)])
            .collect();
        send(&inputs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_snapshot_copies_memory_formats_and_skips_gdi_handles() {
        for f in [1, 7, 8, 13, 15, 16, 17, 0xC000, 0xC123] {
            assert!(copyable(f, ""), "{f:#x}");
        }
        assert!(copyable(0xC0A0, "HTML Format"));
        for f in [2, 3, 9, 14, 0x80, 0x82, 0x83, 0x8E, 0x300, 0x3FF] {
            assert!(!copyable(f, ""), "{f:#x}");
        }
        assert!(!copyable(0xC004, "DataObject"));
        assert!(!copyable(0xC00B, "Ole Private Data"));
    }

    /// Events are built, never sent: every one carries the helper's mark, so its own hook lets
    /// them pass, and a key-up carries `KEYEVENTF_KEYUP`.
    #[test]
    fn every_event_carries_the_helpers_mark() {
        let down = key(0x56, false, true);
        let up = key(0xA3, true, false);
        let ch = unicode(0xD83D, true);
        // SAFETY: each INPUT was built as a keyboard input.
        unsafe {
            assert_eq!(down.Anonymous.ki.dwExtraInfo, AKOU_EVENT);
            assert_eq!(down.Anonymous.ki.dwFlags, KEYBD_EVENT_FLAGS(0));
            assert_eq!(
                up.Anonymous.ki.dwFlags,
                KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP
            );
            assert_eq!(ch.Anonymous.ki.dwExtraInfo, AKOU_EVENT);
            assert_eq!(ch.Anonymous.ki.wScan, 0xD83D);
            assert_eq!(ch.Anonymous.ki.dwFlags, KEYEVENTF_UNICODE);
        }
    }
}
