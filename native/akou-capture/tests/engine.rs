//! The whole helper in process: the file source through the engine, with stdin, stdout and stderr
//! as pipes, checked the way the app reads them.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use akou_capture::engine::{self, Outcome, RunConfig};
use akou_capture::file_source::FileSource;
use akou_capture::opus_writer;
use akou_capture::protocol::{self, Ch, Packet};
use akou_capture::simulate::Faults;
use akou_capture::source::CallMode;
use akou_capture::wav::{self, Wav};

#[derive(Clone, Default)]
struct Shared(Arc<Mutex<Vec<u8>>>);

impl Write for Shared {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// stdin fed line by line; dropping the sender closes it.
struct Stdin {
    rx: Receiver<Vec<u8>>,
    buf: Vec<u8>,
}

impl Read for Stdin {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.buf.is_empty() {
            match self.rx.recv() {
                Ok(b) => self.buf = b,
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len());
        out[..n].copy_from_slice(&self.buf[..n]);
        self.buf.drain(..n);
        Ok(n)
    }
}

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("akou-capture-engine-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

fn tone(freq: f64, rate: u32, secs: f64, amp: f32) -> Vec<f32> {
    (0..(rate as f64 * secs) as usize)
        .map(|i| amp * (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin() as f32)
        .collect()
}

fn stereo(rate: u32, secs: f64) -> Wav {
    let bytes = wav::encode_i16(
        rate,
        &[tone(440.0, rate, secs, 0.3), tone(1_000.0, rate, secs, 0.3)],
    );
    wav::parse(&bytes).unwrap()
}

struct Run {
    handle: std::thread::JoinHandle<Outcome>,
    stdin: Option<Sender<Vec<u8>>>,
    out: Shared,
    err: Shared,
    path: PathBuf,
}

impl Run {
    fn start(name: &str, w: Wav, speed: f64, looped: bool, call: CallMode, faults: Faults) -> Run {
        let path = tmp(name);
        let (tx, rx) = mpsc::channel();
        let out = Shared::default();
        let err = Shared::default();
        let call_on = call != CallMode::None;
        let fe = FileSource::new(w, "test.wav", speed, looped, true, call_on, faults.clone());
        let cfg = RunConfig {
            out: path.clone(),
            mic_default: false,
            call,
            faults,
        };
        let (o, e) = (out.clone(), err.clone());
        let handle = std::thread::spawn(move || {
            engine::run(
                cfg,
                Box::new(fe),
                Box::new(Stdin { rx, buf: vec![] }),
                Box::new(o),
                Box::new(e),
            )
        });
        Run {
            handle,
            stdin: Some(tx),
            out,
            err,
            path,
        }
    }

    fn send(&self, cmd: &str) {
        if let Some(s) = &self.stdin {
            let _ = s.send(format!("{cmd}\n").into_bytes());
        }
    }

    fn lines(&self) -> Vec<String> {
        String::from_utf8(self.err.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(String::from)
            .collect()
    }

    fn packets(&self) -> Vec<Packet> {
        let bytes = self.out.0.lock().unwrap().clone();
        let (p, used) = protocol::decode_packets(&bytes).unwrap();
        assert_eq!(used, bytes.len(), "a torn packet on stdout");
        p
    }

    /// Closes stdin (which means stop) and waits for the end.
    fn finish(mut self) -> (Outcome, Self) {
        drop(self.stdin.take());
        self.join()
    }

    /// Waits for the run to end on its own, stdin still open.
    fn join(mut self) -> (Outcome, Self) {
        let h = std::mem::replace(&mut self.handle, std::thread::spawn(|| Outcome::Exit(-1)));
        (h.join().unwrap(), self)
    }
}

fn typed<'a>(lines: &'a [String], t: &str) -> Vec<&'a String> {
    let tag = format!("\"type\":\"{t}\"");
    lines.iter().filter(|l| l.contains(&tag)).collect()
}

fn num_field(line: &str, key: &str) -> f64 {
    let k = format!("\"{key}\":");
    let at = line.find(&k).unwrap() + k.len();
    let rest = &line[at..];
    let end = rest.find([',', '}']).unwrap();
    rest[..end].trim_matches('"').parse().unwrap()
}

#[test]
fn a_wav_runs_end_to_end_into_packets_and_a_stereo_opus_file() {
    // 44.1 kHz in: the resampler runs on both sides.
    let r = Run::start(
        "e2e.opus",
        stereo(44_100, 3.0),
        0.0,
        false,
        CallMode::System,
        Faults::none(),
    );
    let (outcome, r) = r.join();
    assert_eq!(outcome, Outcome::Exit(0));
    let lines = r.lines();
    assert!(lines[0].starts_with(r#"{"type":"hello","protocol":"akou-capture/1""#));
    assert!(
        lines[1].starts_with(r#"{"type":"capturing","mic":{"id":"file","#),
        "{}",
        lines[1]
    );
    assert_eq!(typed(&lines, "first_audio").len(), 2);
    assert!(typed(&lines, "level").len() >= 10);
    let stopped = typed(&lines, "stopped");
    assert_eq!(stopped.len(), 1);
    assert!(stopped[0].contains(r#""reason":"eof""#));
    let secs = num_field(stopped[0], "file_seconds");
    assert!((secs - 3.0).abs() < 0.03, "{secs}");

    // Packets: both channels, 20 ms each, contiguous on the file timeline, host clock stepping.
    let p = r.packets();
    let mic: Vec<&Packet> = p.iter().filter(|x| x.ch == Ch::Mic).collect();
    let call: Vec<&Packet> = p.iter().filter(|x| x.ch == Ch::Call).collect();
    assert_eq!(mic.len(), call.len());
    let mut at = 0.0;
    for (i, m) in mic.iter().enumerate() {
        assert!(
            (m.file_seconds - at).abs() < 1e-9,
            "packet {i} at {}",
            m.file_seconds
        );
        at += m.samples.len() as f64 / 16_000.0;
        assert_eq!(m.capture_ns, call[i].capture_ns);
        if i > 0 && m.samples.len() == 320 {
            assert_eq!(m.capture_ns - mic[i - 1].capture_ns, 20_000_000);
        }
    }
    assert!((at - secs).abs() < 1e-6);
    // Past the first packet everything was delivered on both sides.
    assert!(mic[1..].iter().all(|m| !m.zero_filled));
    assert!(call[1..].iter().all(|m| !m.zero_filled));

    // The file: stereo, the same length, mic left and call right.
    let rec = opus_writer::recover(&r.path).unwrap();
    assert!(rec.ended);
    assert_eq!(rec.channels, 2);
    assert!(
        (rec.seconds() - secs).abs() < 1e-6,
        "{} vs {secs}",
        rec.seconds()
    );
}

#[test]
fn stop_on_stdin_finishes_the_file_and_says_stopped() {
    let r = Run::start(
        "stop.opus",
        stereo(48_000, 1.0),
        1.0,
        true,
        CallMode::System,
        Faults::none(),
    );
    std::thread::sleep(Duration::from_millis(700));
    r.send("stop");
    let (outcome, r) = r.finish();
    assert_eq!(outcome, Outcome::Exit(0));
    let lines = r.lines();
    let stopped = typed(&lines, "stopped");
    assert!(stopped[0].contains(r#""reason":"stop""#));
    let secs = num_field(stopped[0], "file_seconds");
    assert!(secs > 0.5 && secs < 1.2, "{secs}");
    assert!((opus_writer::recover(&r.path).unwrap().seconds() - secs).abs() < 1e-6);
}

#[test]
fn pause_drops_audio_and_the_file_continues_where_it_paused() {
    let r = Run::start(
        "pause.opus",
        stereo(48_000, 1.0),
        1.0,
        true,
        CallMode::System,
        Faults::none(),
    );
    std::thread::sleep(Duration::from_millis(400));
    r.send("pause");
    std::thread::sleep(Duration::from_millis(600));
    r.send("resume");
    std::thread::sleep(Duration::from_millis(400));
    r.send("stop");
    let (_, r) = r.finish();
    let secs = num_field(typed(&r.lines(), "stopped")[0], "file_seconds");
    // About 0.8 s written, not 1.4 s.
    assert!(secs > 0.6 && secs < 1.0, "{secs}");
    let mic: Vec<Packet> = r
        .packets()
        .into_iter()
        .filter(|p| p.ch == Ch::Mic)
        .collect();
    let mut jump = 0u64;
    for w in mic.windows(2) {
        assert!(
            (w[1].file_seconds - w[0].file_seconds - 0.02).abs() < 1e-9 || w[1].samples.len() < 320
        );
        jump = jump.max(w[1].capture_ns - w[0].capture_ns);
    }
    // The host clock shows the pause; the file position does not.
    assert!(jump >= 500_000_000, "{jump}");
}

#[test]
fn mute_zeroes_the_mic_in_packets_and_file_and_unmute_brings_it_back() {
    let r = Run::start(
        "mute.opus",
        stereo(48_000, 1.0),
        1.0,
        true,
        CallMode::System,
        Faults::none(),
    );
    std::thread::sleep(Duration::from_millis(300));
    r.send("mute");
    std::thread::sleep(Duration::from_millis(400));
    r.send("unmute");
    std::thread::sleep(Duration::from_millis(300));
    r.send("stop");
    let (_, r) = r.finish();
    let p = r.packets();
    let mic: Vec<&Packet> = p.iter().filter(|x| x.ch == Ch::Mic).collect();
    let silent = mic
        .iter()
        .filter(|m| m.samples.iter().all(|v| *v == 0.0))
        .count();
    let loud = mic
        .iter()
        .filter(|m| m.samples.iter().any(|v| v.abs() > 0.05))
        .count();
    assert!(silent >= 10, "{silent}");
    assert!(loud >= 20, "{loud}");
    // The call side kept going throughout.
    assert!(
        p.iter()
            .filter(|x| x.ch == Ch::Call)
            .all(|c| !c.zero_filled || c.file_seconds == 0.0)
    );
}

#[test]
fn call_none_sends_mic_packets_only_and_leaves_the_right_channel_silent() {
    let r = Run::start(
        "mic-only.opus",
        stereo(48_000, 1.0),
        0.0,
        false,
        CallMode::None,
        Faults::none(),
    );
    let (_, r) = r.join();
    let lines = r.lines();
    assert!(lines[1].contains(r#""call":null"#), "{}", lines[1]);
    let p = r.packets();
    assert!(!p.is_empty());
    assert!(p.iter().all(|x| x.ch == Ch::Mic));
}

#[test]
fn an_unknown_command_is_reported_and_ignored() {
    let r = Run::start(
        "unknown.opus",
        stereo(48_000, 1.0),
        1.0,
        true,
        CallMode::System,
        Faults::none(),
    );
    r.send("dance");
    std::thread::sleep(Duration::from_millis(100));
    r.send("stop");
    let (outcome, r) = r.finish();
    assert_eq!(outcome, Outcome::Exit(0));
    assert!(
        r.lines()
            .iter()
            .any(|l| l.contains(r#""code":"unknown-command""#))
    );
}

#[cfg(feature = "simulate")]
mod faults {
    use super::*;

    fn with(specs: &[&str]) -> Faults {
        let mut f = Faults::none();
        for s in specs {
            f.apply(s).unwrap();
        }
        f
    }

    /// [T0.2] The call side dies while output keeps running: the stall rule rebuilds it after
    /// 3 s, and after 10 s of nothing the probe hears audio, the call side is rebuilt again and
    /// `health {state: dead}` goes out.
    #[test]
    fn t0_2_a_dead_call_side_is_probed_rebuilt_and_reported() {
        let f = with(&["call-dead-at=1"]);
        let r = Run::start(
            "dead.opus",
            stereo(48_000, 2.0),
            20.0,
            true,
            CallMode::System,
            f,
        );
        std::thread::sleep(Duration::from_millis(1500));
        r.send("stop");
        let (_, r) = r.finish();
        let lines = r.lines();
        let health = typed(&lines, "health");
        let stalled = health
            .iter()
            .position(|l| l.contains(r#""state":"stalled""#))
            .expect("stalled");
        let dead = health
            .iter()
            .position(|l| l.contains(r#""state":"dead""#))
            .expect("dead");
        assert!(stalled < dead);
        assert!(
            health[dead].contains(r#""ch":"call""#) && health[dead].contains(r#""rebuilds":1"#)
        );
        assert!(num_field(health[dead], "silent_for") >= 10.0);
        assert!(
            lines
                .iter()
                .any(|l| l.contains(r#""type":"device","ch":"call","event":"rebuilt""#))
        );
    }

    /// A dead call side that a rebuild brings back is fixed by the stall rule within seconds and
    /// never reaches the dead-call verdict.
    #[test]
    fn a_call_side_that_a_rebuild_heals_recovers_without_a_dead_verdict() {
        let f = with(&["call-dead-at=1", "rebuild-heals"]);
        let r = Run::start(
            "heal.opus",
            stereo(48_000, 2.0),
            20.0,
            true,
            CallMode::System,
            f,
        );
        std::thread::sleep(Duration::from_millis(1000));
        r.send("stop");
        let (_, r) = r.finish();
        let lines = r.lines();
        let health: Vec<&String> = typed(&lines, "health");
        let states: Vec<&str> = health
            .iter()
            .map(|l| {
                if l.contains(r#""state":"stalled""#) {
                    "stalled"
                } else if l.contains(r#""state":"ok""#) {
                    "ok"
                } else {
                    "other"
                }
            })
            .collect();
        assert_eq!(states, vec!["stalled", "ok"], "{health:?}");
    }

    #[test]
    fn t0_16_call_silent_from_the_start_never_blocks_the_mic() {
        let r = Run::start(
            "silent.opus",
            stereo(48_000, 1.0),
            0.0,
            false,
            CallMode::System,
            with(&["call-silent"]),
        );
        let (_, r) = r.join();
        let p = r.packets();
        let mic: Vec<&Packet> = p.iter().filter(|x| x.ch == Ch::Mic).collect();
        let call: Vec<&Packet> = p.iter().filter(|x| x.ch == Ch::Call).collect();
        assert_eq!(mic[0].file_seconds, 0.0);
        assert_eq!(mic.len(), call.len());
        assert!(
            call.iter()
                .all(|c| c.zero_filled && c.samples.iter().all(|v| *v == 0.0))
        );
        assert!(mic[1..].iter().all(|m| !m.zero_filled));
        let lines = r.lines();
        assert_eq!(typed(&lines, "first_audio").len(), 1);
        assert!(
            typed(&lines, "health")
                .iter()
                .all(|l| !l.contains("no-buffers"))
        );
    }

    #[test]
    fn a_crash_exits_70_without_stopped_and_leaves_a_readable_file() {
        let r = Run::start(
            "crash.opus",
            stereo(48_000, 3.0),
            0.0,
            false,
            CallMode::System,
            with(&["crash-at=2.5"]),
        );
        let (outcome, r) = r.join();
        assert_eq!(outcome, Outcome::Exit(70));
        assert!(typed(&r.lines(), "stopped").is_empty());
        let rec = opus_writer::recover(&r.path).unwrap();
        assert!(!rec.ended);
        assert_eq!(rec.seconds(), 2.0);
    }

    #[test]
    fn sleep_shows_as_a_host_clock_jump_the_file_does_not_have() {
        let r = Run::start(
            "sleep.opus",
            stereo(48_000, 1.0),
            0.0,
            false,
            CallMode::System,
            with(&["sleep-at=0.5", "sleep-for=3600"]),
        );
        let (_, r) = r.join();
        let mic: Vec<Packet> = r
            .packets()
            .into_iter()
            .filter(|p| p.ch == Ch::Mic)
            .collect();
        let jumps: Vec<(f64, u64)> = mic
            .windows(2)
            .map(|w| (w[1].file_seconds, w[1].capture_ns - w[0].capture_ns))
            .filter(|(_, d)| *d > 1_000_000_000)
            .collect();
        assert_eq!(jumps.len(), 1);
        assert!((jumps[0].0 - 0.5).abs() < 0.03, "{:?}", jumps);
        assert!((jumps[0].1 as f64 / 1e9 - 3600.0).abs() < 0.05);
    }

    #[test]
    fn hang_on_stop_ignores_stop() {
        let r = Run::start(
            "hang.opus",
            stereo(48_000, 1.0),
            1.0,
            true,
            CallMode::System,
            with(&["hang-on-stop"]),
        );
        std::thread::sleep(Duration::from_millis(200));
        r.send("stop");
        let (outcome, r) = r.finish();
        assert_eq!(outcome, Outcome::Hang);
        assert!(typed(&r.lines(), "stopped").is_empty());
    }
}
