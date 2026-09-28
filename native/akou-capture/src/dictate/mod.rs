//! `akou-capture dictate`: the long-lived dictation process (docs/ux/DICTATION.md section 9).
//!
//! ```text
//! akou-capture dictate [--hotkey KEY] [--activation hold-or-toggle|hold|toggle]
//!   [--warm off|auto|always] [--probe]
//! akou-capture dictate ... --from-wav FILE [--keys FILE] [--inserter fake[:FILE]]
//!   [--clipboard fake] [--ax fake FILE] [--speed X] [--mic-open-delay MS] [--mic-bluetooth]
//!   [--ring-ms MS]
//! ```
//!
//! It owns everything with a timing or a permission constraint: the hotkey, the warm mic and its
//! ring, the insert and the field read-back, so there is no process hop between the key-up and the
//! audio cut. It is separate from the per-call `run`, so a dictation crash never touches a call
//! recording. It never talks to the network. The protocol is `akou-dictate/1` (`protocol`).
//!
//! The switches of the second form are the fakes of DC-N10 and exist only with the `simulate`
//! feature, which never ships: a shipping build refuses each of them as a usage error, and CI
//! checks that on the release binary. The insert and its guards (`insert`) run against those fakes.
//!
//! On macOS the real process runs the key tap, the accessibility reads and the microphone (`mac`,
//! through the worker loop in `live`) and inserts through the general pasteboard and posted key
//! events (`mac_insert`). On Windows it runs a low-level keyboard hook, UI Automation and the
//! WASAPI microphone (`win`) and inserts through the clipboard and `SendInput` (`win_insert`). On
//! Linux it reads the keys from evdev and records through the sound server (`linux`), with no
//! inserter yet. `--probe` prints the `ready` line the process would send (backend,
//! `swallow_keys`, grants read without asking) and exits, on every OS.

pub mod activation;
pub mod evdev_keys;
#[cfg(any(test, feature = "simulate"))]
pub mod fake;
pub mod globe;
pub mod inputs;
pub mod insert;
pub mod keys;
#[cfg(target_os = "linux")]
pub mod linux;
pub mod live;
#[cfg(target_os = "macos")]
pub mod mac;
#[cfg(target_os = "macos")]
pub mod mac_insert;
pub mod mac_keys;
pub mod mic;
pub mod protocol;
pub mod readback;
pub mod selection;
pub mod session;
#[cfg(feature = "simulate")]
pub mod sim;
pub mod tap;
#[cfg(target_os = "windows")]
pub mod win;
#[cfg(target_os = "windows")]
pub mod win_insert;
pub mod win_keys;

use crate::protocol::exit;
use activation::Mode;
use keys::Hotkey;
use mic::Warm;

pub const USAGE: &str = "usage: akou-capture dictate [--hotkey KEY] [--activation hold-or-toggle|hold|toggle] [--warm off|auto|always] [--probe]";

/// The switches only a `simulate` build has. A shipping build names them in its refusal.
const SIMULATE_ONLY: [&str; 9] = [
    "--from-wav",
    "--keys",
    "--inserter",
    "--clipboard",
    "--ax",
    "--speed",
    "--mic-open-delay",
    "--mic-bluetooth",
    "--ring-ms",
];

#[derive(Debug)]
pub struct Args {
    pub hotkey: Hotkey,
    pub mode: Mode,
    pub warm: Warm,
    /// Print `ready` and exit, with no tap and no device (DC-N1's backend listing).
    pub probe: bool,
    #[cfg(feature = "simulate")]
    pub sim: sim::Switches,
}

/// The default key per OS (DC-A2).
fn default_hotkey() -> &'static str {
    if cfg!(target_os = "macos") {
        "RightCommand"
    } else if cfg!(target_os = "windows") {
        "RightControl"
    } else {
        "Control+Shift+Space"
    }
}

pub fn parse(argv: &[String]) -> Result<Args, String> {
    let mut hotkey = Hotkey::parse(default_hotkey()).expect("the default binds");
    let mut mode = Mode::HoldOrToggle;
    let mut warm = Warm::Auto;
    let mut probe = false;
    #[cfg(feature = "simulate")]
    let mut sim = sim::Switches::default();
    let mut it = argv.iter();
    while let Some(a) = it.next() {
        let mut val = || {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{a} needs a value"))
        };
        match a.as_str() {
            "--hotkey" => hotkey = Hotkey::parse(&val()?)?,
            "--activation" => mode = Mode::parse(&val()?)?,
            "--warm" => warm = Warm::parse(&val()?)?,
            "--probe" => probe = true,
            other => {
                #[cfg(feature = "simulate")]
                if sim.take(other, &mut val)? {
                    continue;
                }
                if SIMULATE_ONLY.contains(&other) {
                    return Err(format!(
                        "this build has no simulate switches ({other} needs the `simulate` feature)"
                    ));
                }
                return Err(format!("unknown argument {other}"));
            }
        }
    }
    Ok(Args {
        hotkey,
        mode,
        warm,
        probe,
        #[cfg(feature = "simulate")]
        sim,
    })
}

/// Runs `akou-capture dictate` with the arguments after `dictate`; returns the exit code.
pub fn main(argv: &[String]) -> i32 {
    let fail = |code: &str, msg: &str, status: i32| {
        eprintln!("{}", protocol::warn(code, msg));
        status
    };
    let args = match parse(argv) {
        Ok(a) => a,
        Err(e) => return fail("usage", &format!("{e}\n{USAGE}"), exit::USAGE),
    };
    if args.probe {
        eprintln!("{}", probe());
        return exit::OK;
    }
    let cfg = session::Config {
        hotkey: args.hotkey,
        mode: args.mode,
        warm: args.warm,
        bluetooth: false,
        ring_ms: mic::RING_MS,
        os: insert::Os::current(),
    };
    #[cfg(feature = "simulate")]
    if args.sim.from_wav.is_some() {
        return sim::run(
            args.sim,
            cfg,
            Box::new(std::io::BufReader::new(std::io::stdin())),
            &mut std::io::stdout(),
            &mut std::io::stderr(),
        );
    }
    #[cfg(feature = "simulate")]
    if args.sim != sim::Switches::default() {
        return fail(
            "usage",
            "the fake key, inserter and accessibility switches need --from-wav",
            exit::USAGE,
        );
    }
    if std::env::var_os("AKOU_CAPTURE_FILE_ONLY").is_some_and(|v| v == "1") {
        return fail(
            "file-only",
            "AKOU_CAPTURE_FILE_ONLY=1 refuses device capture",
            exit::UNAVAILABLE,
        );
    }
    #[cfg(target_os = "macos")]
    return mac::run(cfg);
    #[cfg(target_os = "windows")]
    return win::run(cfg);
    #[cfg(target_os = "linux")]
    return linux::run(cfg);
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = cfg;
        fail(
            "no-backend",
            "dictate has no key and insert backend on this OS yet",
            exit::UNAVAILABLE,
        )
    }
}

/// The `ready` line this build would send, without a tap or a device: the backend and the
/// grants, each read without asking (DC-N1's listing, which CI runs on every OS).
pub fn probe() -> String {
    #[cfg(target_os = "macos")]
    return mac::probe();
    #[cfg(target_os = "windows")]
    return win::probe();
    #[cfg(target_os = "linux")]
    return linux::probe();
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    protocol::ready("none", false, "not-needed", "not-needed")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn the_real_switches_parse_and_default_per_os() {
        let a = parse(&argv(
            "--hotkey RightShift --activation toggle --warm always",
        ))
        .unwrap();
        assert_eq!(a.hotkey, Hotkey::Modifier("RightShift".into()));
        assert_eq!(a.mode, Mode::Toggle);
        assert_eq!(a.warm, Warm::Always);
        let d = parse(&[]).unwrap();
        assert_eq!(
            d.hotkey.trigger(),
            Hotkey::parse(default_hotkey()).unwrap().trigger()
        );
        assert_eq!(d.warm, Warm::Auto, "auto is the default");
        assert!(parse(&argv("--hotkey")).is_err());
        assert!(parse(&argv("--warm lukewarm")).is_err());
        assert!(parse(&argv("--dance")).is_err());
    }

    /// DC-N10: a shipping build refuses every fake as a usage error, so no build that reaches a
    /// user can be told to fake a key, an insert or an accessibility read.
    #[cfg(not(feature = "simulate"))]
    #[test]
    fn dc_n10_a_shipping_build_refuses_every_simulate_switch() {
        for s in SIMULATE_ONLY {
            let e = parse(&[s.to_string(), "fake".into(), "x".into()]).unwrap_err();
            assert!(e.contains("no simulate switches"), "{s}: {e}");
        }
        assert_eq!(main(&argv("--inserter fake")), exit::USAGE);
    }

    #[cfg(feature = "simulate")]
    #[test]
    fn dc_n10_a_test_build_takes_every_simulate_switch() {
        let a = parse(&argv(
            "--from-wav a.wav --keys k --inserter fake:log --clipboard fake --ax fake ax --speed 1 --mic-open-delay 300 --mic-bluetooth --ring-ms 0",
        ))
        .unwrap();
        assert_eq!(a.sim.ring_ms, Some(0));
        assert_eq!(a.sim.inserter, Some(Some("log".into())));
        assert!(a.sim.clipboard_fake && a.sim.mic_bluetooth);
        assert_eq!(a.sim.mic_open_delay_ms, 300);
        assert!(parse(&argv("--inserter real")).is_err());
        assert!(parse(&argv("--clipboard system")).is_err());
        assert!(parse(&argv("--ax real x")).is_err());
        assert_eq!(
            main(&argv("--inserter fake")),
            exit::USAGE,
            "a fake with no --from-wav never reaches a device"
        );
    }
}
