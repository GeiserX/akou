//! The binary's own argument and input handling: what the app sees as exit codes and `warn` lines
//! when the launch itself is wrong. Every run is in file mode with `AKOU_CAPTURE_FILE_ONLY=1`, so
//! nothing here can open a device.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use akou_capture::protocol::exit;
use akou_capture::wav;

fn dir() -> PathBuf {
    let d = std::env::temp_dir().join(format!("akou-capture-cli-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn stereo_wav(name: &str, secs: f64) -> PathBuf {
    let rate = 16_000;
    let n = (rate as f64 * secs) as usize;
    let ch: Vec<f32> = (0..n).map(|i| ((i % 40) as f32 / 40.0) - 0.5).collect();
    let path = dir().join(name);
    std::fs::write(&path, wav::encode_i16(rate, &[ch.clone(), ch])).unwrap();
    path
}

/// Runs the helper with stdin held open; returns the exit code (None if killed by a signal) and
/// stderr. Stops it after 10 s.
fn run(args: &[&str]) -> (Option<i32>, String) {
    let out = dir().join("cli.opus");
    let mut child = Command::new(env!("CARGO_BIN_EXE_akou-capture"))
        .args([
            "run",
            "--out",
            out.to_str().unwrap(),
            "--mic",
            "default",
            "--call",
            "system",
        ])
        .args(args)
        .env("AKOU_CAPTURE_FILE_ONLY", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take();
    let end = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() > end {
            if let Some(mut s) = stdin.take() {
                let _ = s.write_all(b"stop\n");
            }
            std::thread::sleep(Duration::from_secs(3));
            let _ = child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).into(),
    )
}

/// A WAV that cannot be read or parsed is an I/O failure: `warn {code: io}` and exit 74, the
/// two channels agreeing, so the app's `EXIT.io` mapping matches it.
#[test]
fn an_unreadable_or_malformed_wav_is_warn_io_and_exit_74() {
    let d = dir();
    let empty = d.join("empty.wav");
    std::fs::write(&empty, b"").unwrap();
    let garbage = d.join("garbage.wav");
    std::fs::write(&garbage, b"this is not a wav file at all, not even close").unwrap();
    let good = std::fs::read(stereo_wav("good.wav", 0.5)).unwrap();
    let truncated = d.join("truncated.wav");
    std::fs::write(&truncated, &good[..20]).unwrap();
    let missing = d.join("does-not-exist.wav");
    for path in [&empty, &garbage, &truncated, &missing] {
        let (code, err) = run(&["--from-wav", path.to_str().unwrap()]);
        assert_eq!(code, Some(exit::IO), "{}: {err}", path.display());
        assert!(err.contains(r#""code":"io""#), "{}: {err}", path.display());
    }
    // Positive control: a good WAV records and stops cleanly.
    let (code, err) = run(&["--from-wav", stereo_wav("ok.wav", 0.5).to_str().unwrap()]);
    assert_eq!(code, Some(exit::OK), "{err}");
}

/// A speed so small that the pacing wait overflows is a usage error, not an abort.
#[test]
fn a_vanishingly_small_speed_is_a_usage_error() {
    let w = stereo_wav("speed.wav", 0.5);
    for speed in ["1e-300", "5e-324", "0.001"] {
        let (code, err) = run(&["--from-wav", w.to_str().unwrap(), "--speed", speed]);
        assert_eq!(code, Some(exit::USAGE), "--speed {speed}: {err}");
        assert!(err.contains("--speed"), "{err}");
    }
    // Positive control: 0 (as fast as possible) and a slow but sane speed are accepted.
    for speed in ["0", "0.5"] {
        let (code, err) = run(&["--from-wav", w.to_str().unwrap(), "--speed", speed]);
        assert_ne!(code, Some(exit::USAGE), "--speed {speed}: {err}");
        assert!(
            err.contains(r#""type":"stopped""#),
            "--speed {speed}: {err}"
        );
    }
}

/// `devices` lists devices without opening one, so it too is refused in file-only mode, and it
/// takes no arguments.
#[test]
fn devices_is_refused_in_file_only_mode_and_takes_no_arguments() {
    let bin = env!("CARGO_BIN_EXE_akou-capture");
    let out = Command::new(bin)
        .arg("devices")
        .env("AKOU_CAPTURE_FILE_ONLY", "1")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(exit::UNAVAILABLE));
    assert!(String::from_utf8_lossy(&out.stderr).contains(r#""code":"file-only""#));
    assert!(out.stdout.is_empty());
    let out = Command::new(bin)
        .args(["devices", "--all"])
        .env("AKOU_CAPTURE_FILE_ONLY", "1")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(exit::USAGE));
    // Positive control: the usage text names the command.
    let out = Command::new(bin).arg("--help").output().unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).contains("akou-capture devices"));
}
