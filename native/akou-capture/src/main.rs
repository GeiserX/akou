//! `akou-capture`: the capture helper binary (docs/DESIGN.md sections 1.3 and 2.4).
//!
//! ```text
//! akou-capture run --out <part.opus> --mic default|<device-id>|none \
//!   --call system|none|app:<id>[,<id>] [--exclude-responsible <bundle-id|pid>]
//! akou-capture run --out <part.opus> --mic default --call system \
//!   --from-wav <stereo.wav> [--speed X | --realtime] [--loop]
//! akou-capture --version
//! ```
//!
//! With `--from-wav` no device is opened on any OS: the WAV's left channel is the mic and its right
//! channel the call. Setting `AKOU_CAPTURE_FILE_ONLY=1` refuses device capture altogether, which
//! test environments use so nothing can ever open a device or ask for a permission.

use std::path::PathBuf;

use akou_capture::engine::{self, Outcome, RunConfig};
use akou_capture::file_source::FileSource;
use akou_capture::protocol::{self, exit};
use akou_capture::simulate::Faults;
use akou_capture::source::{CallMode, DeviceConfig, Frontend};

const USAGE: &str = "usage: akou-capture run --out FILE --mic default|<id>|none --call system|none|app:<id>[,<id>] \
[--exclude-responsible <bundle-id|pid>] [--from-wav FILE [--speed X | --realtime] [--loop]]";

#[derive(Debug)]
struct Args {
    out: PathBuf,
    mic: String,
    call: CallMode,
    exclude_responsible: Option<String>,
    from_wav: Option<PathBuf>,
    speed: f64,
    looped: bool,
    faults: Faults,
}

fn parse(argv: &[String]) -> Result<Args, String> {
    let mut it = argv.iter();
    match it.next().map(String::as_str) {
        Some("run") => {}
        Some(other) => return Err(format!("unknown command {other}")),
        None => return Err("missing command".into()),
    }
    let mut out = None;
    let mut mic = None;
    let mut call = None;
    let mut exclude_responsible = None;
    let mut from_wav = None;
    let mut speed = 0.0;
    let mut looped = false;
    let mut faults = Faults::none();
    while let Some(a) = it.next() {
        let mut val = || {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{a} needs a value"))
        };
        match a.as_str() {
            "--out" => out = Some(PathBuf::from(val()?)),
            "--mic" => mic = Some(val()?),
            "--call" => call = Some(CallMode::parse(&val()?)?),
            "--exclude-responsible" => exclude_responsible = Some(val()?),
            "--from-wav" => from_wav = Some(PathBuf::from(val()?)),
            "--speed" => {
                let v = val()?;
                speed = v
                    .parse::<f64>()
                    .ok()
                    .filter(|s| s.is_finite() && *s >= 0.0)
                    .ok_or_else(|| format!("--speed needs a number >= 0, not {v}"))?;
            }
            "--realtime" => speed = 1.0,
            "--loop" => looped = true,
            "--simulate" => faults.apply(&val()?)?,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let mic = mic.ok_or("--mic is required")?;
    if mic.is_empty() {
        return Err("--mic needs a value".into());
    }
    Ok(Args {
        out: out.ok_or("--out is required")?,
        mic,
        call: call.ok_or("--call is required")?,
        exclude_responsible,
        from_wav,
        speed,
        looped,
        faults,
    })
}

fn fail(code: &str, msg: &str, status: i32) -> ! {
    eprintln!("{}", protocol::warn(code, msg));
    std::process::exit(status)
}

#[cfg(unix)]
fn install_signals() {
    extern "C" fn on_signal(_: libc::c_int) {
        engine::SIGNALLED.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    let handler = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
    // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
    unsafe {
        libc::signal(libc::SIGINT, handler);
        libc::signal(libc::SIGTERM, handler);
    }
}

#[cfg(not(unix))]
fn install_signals() {}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if matches!(
        argv.first().map(String::as_str),
        Some("--version" | "version")
    ) {
        println!(
            "akou-capture {} ({})",
            protocol::VERSION,
            protocol::PROTOCOL
        );
        return;
    }
    if matches!(
        argv.first().map(String::as_str),
        Some("--help" | "help" | "-h")
    ) {
        println!("{USAGE}");
        return;
    }
    let args = match parse(&argv) {
        Ok(a) => a,
        Err(e) => fail("usage", &format!("{e}\n{USAGE}"), exit::USAGE),
    };
    install_signals();

    let mic_on = args.mic != "none";
    let call_on = args.call != CallMode::None;
    if !mic_on && !call_on {
        fail(
            "usage",
            "--mic none with --call none captures nothing",
            exit::USAGE,
        );
    }
    let fe: Box<dyn Frontend> = match &args.from_wav {
        Some(path) => {
            let bytes = std::fs::read(path).unwrap_or_else(|e| {
                fail(
                    "io",
                    &format!("cannot read {}: {e}", path.display()),
                    exit::NO_DEVICE,
                )
            });
            let wav = akou_capture::wav::parse(&bytes).unwrap_or_else(|e| {
                fail("io", &format!("{}: {e}", path.display()), exit::NO_DEVICE)
            });
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".into());
            Box::new(FileSource::new(
                wav,
                &name,
                args.speed,
                args.looped,
                mic_on,
                call_on,
                args.faults.clone(),
            ))
        }
        None => {
            if std::env::var_os("AKOU_CAPTURE_FILE_ONLY").is_some_and(|v| v == "1") {
                fail(
                    "file-only",
                    "AKOU_CAPTURE_FILE_ONLY=1 refuses device capture; pass --from-wav",
                    exit::UNAVAILABLE,
                );
            }
            if args.faults.any() {
                fail("usage", "fault switches need --from-wav", exit::USAGE);
            }
            let cfg = DeviceConfig {
                mic: args.mic.clone(),
                call: args.call.clone(),
                exclude_responsible: args.exclude_responsible.clone(),
            };
            match akou_capture::device_frontend(&cfg) {
                Ok(fe) => fe,
                Err(e) => fail(e.code, &e.msg, e.exit),
            }
        }
    };
    let cfg = RunConfig {
        out: args.out,
        mic_default: args.mic == "default",
        call: args.call,
        faults: args.faults,
    };
    let outcome = engine::run(
        cfg,
        fe,
        Box::new(std::io::stdin()),
        Box::new(std::io::stdout()),
        Box::new(std::io::stderr()),
    );
    match outcome {
        Outcome::Exit(code) => std::process::exit(code),
        Outcome::Hang => loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn parses_the_launch_arguments_the_app_sends() {
        let a = parse(&argv(
            "run --out /x/part-001.opus --mic default --call system --exclude-responsible io.github.geiserx.akou",
        ))
        .unwrap();
        assert_eq!(a.mic, "default");
        assert_eq!(a.call, CallMode::System);
        assert_eq!(
            a.exclude_responsible.as_deref(),
            Some("io.github.geiserx.akou")
        );
        assert_eq!(a.from_wav, None);
        let b = parse(&argv(
            "run --out o.opus --mic none --call app:us.zoom.xos --from-wav a.wav --realtime --loop",
        ))
        .unwrap();
        assert_eq!(b.speed, 1.0);
        assert!(b.looped);
        assert!(parse(&argv("run --out o --mic default")).is_err());
        assert!(parse(&argv("run --out o --mic default --call speakers")).is_err());
        assert!(parse(&argv("record")).is_err());
        assert!(parse(&argv("run --out o --mic default --call system --speed -1")).is_err());
    }

    /// DESIGN 2.5: fault switches are absent from a shipping build.
    #[cfg(not(feature = "simulate"))]
    #[test]
    fn a_shipping_build_rejects_simulate_as_a_usage_error() {
        let e = parse(&argv(
            "run --out o --mic default --call system --from-wav a.wav --simulate crash-at=1",
        ))
        .unwrap_err();
        assert!(e.contains("no fault switches"), "{e}");
    }

    #[cfg(feature = "simulate")]
    #[test]
    fn a_test_build_accepts_simulate() {
        let a = parse(&argv(
            "run --out o --mic default --call system --from-wav a.wav --simulate crash-at=1",
        ))
        .unwrap();
        assert_eq!(a.faults.crash_at(), Some(1.0));
    }
}
