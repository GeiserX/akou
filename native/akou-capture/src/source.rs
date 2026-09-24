//! What a front end is: the OS-specific part that opens the two sources and hands their buffers
//! to the engine. Everything after this point is the same on every OS (DESIGN 2.1).

use std::sync::mpsc::SyncSender;

use crate::clock::Now;
use crate::health::device_watch::DeviceId;
use crate::protocol::{CallInfo, Ch, MicInfo, exit};

/// One buffer from one source, already mono float at the source's own rate.
#[derive(Clone, Debug)]
pub struct Chunk {
    pub ch: Ch,
    /// Awake-clock time of the first sample.
    pub awake_ns: u64,
    pub rate: u32,
    pub samples: Vec<f32>,
    /// Some sample on some device channel was non-zero (taken before the channels were
    /// averaged, TRAPS T0.28).
    pub heard: bool,
}

#[derive(Clone, Debug)]
pub enum Event {
    Chunk(Chunk),
    /// A driven clock (the file source): every source has delivered up to this time.
    Tick(Now),
    /// A probe's verdict on whether the output is audible right now.
    Probe {
        heard: bool,
    },
    /// A source failed (device gone, stream error); the engine rebuilds it.
    Lost {
        ch: Ch,
        detail: String,
    },
    /// A health verdict only the front end can make (a pinned mic fell back to the default,
    /// every tapped app exited).
    Health {
        ch: Ch,
        state: &'static str,
        detail: String,
    },
    Warn {
        code: &'static str,
        msg: String,
    },
    /// The file source reached its end.
    Eof,
}

/// `--call system | none | app:<id>[,<id>]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallMode {
    System,
    None,
    Apps(Vec<String>),
}

impl CallMode {
    pub fn parse(s: &str) -> Result<CallMode, String> {
        match s {
            "system" => Ok(CallMode::System),
            "none" => Ok(CallMode::None),
            _ => {
                let Some(ids) = s.strip_prefix("app:") else {
                    return Err(format!(
                        "--call must be system, none or app:<id>[,<id>], not {s}"
                    ));
                };
                let ids: Vec<String> = ids
                    .split(',')
                    .map(str::trim)
                    .filter(|x| !x.is_empty())
                    .map(String::from)
                    .collect();
                if ids.is_empty() {
                    return Err("--call app: needs at least one id".into());
                }
                Ok(CallMode::Apps(ids))
            }
        }
    }

    pub fn wire(&self) -> String {
        match self {
            CallMode::System => "system".into(),
            CallMode::None => "none".into(),
            CallMode::Apps(ids) => format!("app:{}", ids.join(",")),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceConfig {
    /// `default`, `none`, or a device id.
    pub mic: String,
    pub call: CallMode,
    /// The app's bundle id or pid, whose audio processes the call side excludes (DESIGN 2.3).
    pub exclude_responsible: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Opened {
    pub mic: Option<MicInfo>,
    pub call: Option<CallInfo>,
    /// Names of the processes the call side excludes.
    pub exclude: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OpenError {
    /// The sysexits code to exit with.
    pub exit: i32,
    /// The `warn` code.
    pub code: &'static str,
    pub msg: String,
}

impl OpenError {
    pub fn unsupported(what: &str) -> Self {
        OpenError {
            exit: exit::UNAVAILABLE,
            code: "unsupported",
            msg: format!("device capture is unsupported on {what} yet; use --from-wav"),
        }
    }

    pub fn no_device(msg: impl Into<String>) -> Self {
        OpenError {
            exit: exit::NO_DEVICE,
            code: "no-device",
            msg: msg.into(),
        }
    }

    pub fn permission(msg: impl Into<String>) -> Self {
        OpenError {
            exit: exit::PERMISSION,
            code: "permission",
            msg: msg.into(),
        }
    }

    pub fn unavailable(msg: impl Into<String>) -> Self {
        OpenError {
            exit: exit::UNAVAILABLE,
            code: "open",
            msg: msg.into(),
        }
    }

    pub fn io(msg: impl Into<String>) -> Self {
        OpenError {
            exit: exit::IO,
            code: "io",
            msg: msg.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClockKind {
    /// Real devices: the engine reads the host clock.
    Host,
    /// The file source sends `Event::Tick`.
    Driven,
}

/// What the engine polls about once a second.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Status {
    /// The OS says the default output is running (`None`: this front end cannot tell, and the
    /// dead-call rule never fires).
    pub output_running: Option<bool>,
    /// The microphone is present and its stream has not failed.
    pub mic_running: bool,
    pub default_input: Option<DeviceId>,
    pub default_output: Option<DeviceId>,
}

pub trait Frontend: Send {
    /// Advertised in `hello`.
    fn caps(&self) -> Vec<&'static str>;
    fn clock(&self) -> ClockKind;
    /// Opens the sources. Device audio may start flowing into `tx` at once; audio before the
    /// anchor is dropped by the aligner.
    fn open(&mut self, tx: SyncSender<Event>) -> Result<Opened, OpenError>;
    /// The timeline starts at `anchor`. The file source starts producing here.
    fn start(&mut self, anchor: Now);
    /// Rebuilds one source (tap and aggregate, or mic stream). Returns the call side's
    /// re-resolved exclusion names.
    fn rebuild(&mut self, ch: Ch) -> Result<Vec<String>, String>;
    /// Starts a probe of the call side; the verdict arrives as `Event::Probe` within 3 s.
    fn probe_call(&mut self);
    fn status(&mut self) -> Status;
    /// The permission-suspect rule applies (macOS: a missing grant gives silent zeros).
    fn permission_suspect(&self) -> bool {
        false
    }
    /// Stops and releases everything. May block on a hung OS call; the engine runs it on its
    /// own thread under a deadline.
    fn close(self: Box<Self>);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_modes() {
        assert_eq!(CallMode::parse("system"), Ok(CallMode::System));
        assert_eq!(CallMode::parse("none"), Ok(CallMode::None));
        assert_eq!(
            CallMode::parse("app:us.zoom.xos, com.microsoft.teams2"),
            Ok(CallMode::Apps(vec![
                "us.zoom.xos".into(),
                "com.microsoft.teams2".into()
            ]))
        );
        assert!(CallMode::parse("app:").is_err());
        assert!(CallMode::parse("speakers").is_err());
        assert_eq!(CallMode::parse("app:a,b").unwrap().wire(), "app:a,b");
    }
}
