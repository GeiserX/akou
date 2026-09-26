//! `akou-capture dictate --from-wav FILE` (DC-N10): the whole dictate process with no device, no
//! key tap, no clipboard and no accessibility call. Only in builds with the `simulate` feature.
//!
//! - `--from-wav FILE`: the WAV's first channel is the mic. It is the only clock: every 10 ms of
//!   file is one step, keys and commands land on the step they fall in, and after the file ends
//!   the mic is silence until one second past the last scripted key.
//! - `--keys FILE`: the key tap, `<ms> down|up <Key>` per line (`keys::parse_script`).
//! - `--inserter fake[:FILE]`: the inserter, which appends what it was asked to insert or focus
//!   to FILE as JSON lines and answers `inserted` at once.
//! - `--clipboard fake`: the clipboard, in memory; `method: clipboard` writes it and the log says so.
//! - `--ax fake FILE`: what has the keyboard, `<ms> {"app","pid","window","field"}` per line; the
//!   last line at or before a key-down is the session's target.
//! - `--speed X`: 0 (the default) runs as fast as it goes, 1 in real time.
//! - `--mic-open-delay MS`: the stream delivers its first sample MS after it opens (a slow device).
//! - `--mic-bluetooth`: the mic reports a Bluetooth transport, so it is never kept warm.
//!
//! At `--speed 0` stdin is read once the timeline is over; paced, each command lands on the step
//! it arrives in. After the timeline the process waits for commands until `stop` or the end of
//! stdin.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use super::keys::{Scripted, parse_script};
use super::protocol::{self as p, Command, Target, Value};
use super::session::{Config, Dictate, Inserter, Out, Targets};
use crate::json::Json;
use crate::protocol::exit;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Switches {
    pub from_wav: Option<PathBuf>,
    pub keys: Option<PathBuf>,
    /// `Some(None)`: the fake inserter with no log.
    pub inserter: Option<Option<PathBuf>>,
    pub clipboard_fake: bool,
    pub ax: Option<PathBuf>,
    pub speed: f64,
    pub mic_open_delay_ms: u64,
    pub mic_bluetooth: bool,
}

impl Switches {
    /// Takes one simulate switch and its value; `Ok(false)` when `a` is not one.
    pub fn take(
        &mut self,
        a: &str,
        val: &mut dyn FnMut() -> Result<String, String>,
    ) -> Result<bool, String> {
        match a {
            "--from-wav" => self.from_wav = Some(PathBuf::from(val()?)),
            "--keys" => self.keys = Some(PathBuf::from(val()?)),
            "--inserter" => {
                let v = val()?;
                self.inserter = Some(match v.split_once(':') {
                    Some(("fake", path)) if !path.is_empty() => Some(PathBuf::from(path)),
                    None if v == "fake" => None,
                    _ => return Err(format!("--inserter takes fake or fake:FILE, not {v}")),
                });
            }
            "--clipboard" => {
                let v = val()?;
                if v != "fake" {
                    return Err(format!("--clipboard takes fake, not {v}"));
                }
                self.clipboard_fake = true;
            }
            "--ax" => {
                let v = val()?;
                if v != "fake" {
                    return Err(format!("--ax takes fake FILE, not {v}"));
                }
                self.ax = Some(PathBuf::from(val()?));
            }
            "--speed" => {
                let v = val()?;
                self.speed = v
                    .parse::<f64>()
                    .ok()
                    .filter(|s| s.is_finite() && (*s == 0.0 || *s >= 0.01))
                    .ok_or_else(|| format!("--speed needs 0 or a number >= 0.01, not {v}"))?;
            }
            "--mic-open-delay" => {
                let v = val()?;
                self.mic_open_delay_ms = v
                    .parse()
                    .map_err(|_| format!("--mic-open-delay needs milliseconds, not {v}"))?;
            }
            "--mic-bluetooth" => self.mic_bluetooth = true,
            _ => return Ok(false),
        }
        Ok(true)
    }
}

struct FakeTargets(Vec<(u64, Target)>);

impl Targets for FakeTargets {
    fn target(&mut self, t_ns: u64) -> Target {
        self.0
            .iter()
            .rev()
            .find(|(ms, _)| ms * 1_000_000 <= t_ns)
            .map_or_else(Target::unknown, |(_, t)| t.clone())
    }
}

fn parse_ax(text: &str) -> Result<Vec<(u64, Target)>, String> {
    let mut out = Vec::new();
    for (n, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (ms, json) = line
            .split_once(char::is_whitespace)
            .ok_or_else(|| format!("ax line {}: expected `<ms> {{...}}`", n + 1))?;
        let ms: u64 = ms
            .parse()
            .map_err(|_| format!("ax line {}: {ms} is not milliseconds", n + 1))?;
        let t = Target::from_value(&Value::parse(json)?)
            .map_err(|e| format!("ax line {}: {e}", n + 1))?;
        out.push((ms, t));
    }
    Ok(out)
}

struct FakeInserter {
    log: Option<PathBuf>,
    clipboard: Option<String>,
    clipboard_fake: bool,
}

impl FakeInserter {
    fn write(&self, j: Json) {
        if let Some(path) = &self.log {
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .expect("the fake inserter's log opens");
            writeln!(f, "{}", j.to_line()).expect("the fake inserter's log is written");
        }
    }
}

impl Inserter for FakeInserter {
    fn insert(
        &mut self,
        id: &str,
        text: &str,
        method: &str,
        send_key: &str,
        target: &Target,
    ) -> Result<(String, u64), String> {
        if method == "clipboard" {
            if !self.clipboard_fake {
                return Err("no-clipboard".into());
            }
            self.clipboard = Some(text.to_string());
        }
        self.write(Json::obj(vec![
            ("type", Json::str("insert")),
            ("id", Json::str(id)),
            ("text", Json::str(text)),
            ("method", Json::str(method)),
            ("send_key", Json::str(send_key)),
            ("app", Json::str(&target.app)),
            (
                "clipboard",
                self.clipboard.as_deref().map_or(Json::Null, Json::str),
            ),
        ]));
        Ok((method.to_string(), 0))
    }

    fn focus(&mut self, target: &Target) {
        self.write(Json::obj(vec![
            ("type", Json::str("focus")),
            ("app", Json::str(&target.app)),
            ("pid", Json::Int(target.pid)),
        ]));
    }
}

/// With no inserter switch a simulate build has no inserter at all: it never falls back to a
/// real one.
struct NoInserter;

impl Inserter for NoInserter {
    fn insert(
        &mut self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
        _: &Target,
    ) -> Result<(String, u64), String> {
        Err("no-inserter".into())
    }
    fn focus(&mut self, _: &Target) {}
}

struct Stdio<'a> {
    stdout: &'a mut dyn Write,
    stderr: &'a mut dyn Write,
}

impl Out for Stdio<'_> {
    fn line(&mut self, line: String) {
        let _ = writeln!(self.stderr, "{line}");
        let _ = self.stderr.flush();
    }
    fn packet(&mut self, bytes: Vec<u8>) {
        let _ = self.stdout.write_all(&bytes);
        let _ = self.stdout.flush();
    }
}

fn read(path: &PathBuf) -> Result<Vec<u8>, (i32, String)> {
    std::fs::read(path).map_err(|e| (exit::IO, format!("cannot read {}: {e}", path.display())))
}

/// The mic: the WAV's first channel at 16 kHz.
fn mic_samples(path: &PathBuf) -> Result<Vec<f32>, (i32, String)> {
    let wav = crate::wav::parse(&read(path)?)
        .map_err(|e| (exit::IO, format!("{}: {e}", path.display())))?;
    let first = wav.data.into_iter().next().unwrap_or_default();
    if wav.rate == 16_000 {
        return Ok(first);
    }
    let mut rs =
        crate::resample::StreamResampler::new(wav.rate, 16_000).map_err(|e| (exit::IO, e))?;
    let mut out = Vec::new();
    rs.push(&first, &mut out);
    rs.push(&vec![0.0; rs.buffered() + 1024], &mut out);
    let skip = rs.delay().min(out.len());
    let want = first.len() * 16_000 / wav.rate as usize;
    Ok(out.into_iter().skip(skip).take(want).collect())
}

pub fn run(
    sw: Switches,
    cfg: Config,
    stdin: Box<dyn BufRead + Send>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let mut out = Stdio { stdout, stderr };
    let loaded = (|| {
        let wav = mic_samples(sw.from_wav.as_ref().expect("run needs --from-wav"))?;
        let keys = match &sw.keys {
            Some(k) => {
                parse_script(&String::from_utf8_lossy(&read(k)?)).map_err(|e| (exit::USAGE, e))?
            }
            None => Vec::new(),
        };
        let ax = match &sw.ax {
            Some(a) => {
                parse_ax(&String::from_utf8_lossy(&read(a)?)).map_err(|e| (exit::USAGE, e))?
            }
            None => Vec::new(),
        };
        Ok::<_, (i32, String)>((wav, keys, ax))
    })();
    let (wav, keys, ax) = match loaded {
        Ok(v) => v,
        Err((code, msg)) => {
            out.line(p::warn(if code == exit::IO { "io" } else { "usage" }, &msg));
            return code;
        }
    };
    let inserter: Box<dyn Inserter> = match &sw.inserter {
        Some(log) => Box::new(FakeInserter {
            log: log.clone(),
            clipboard: None,
            clipboard_fake: sw.clipboard_fake,
        }),
        None => Box::new(NoInserter),
    };
    let mut cfg = cfg;
    cfg.bluetooth = sw.mic_bluetooth;
    let mut d = Dictate::new(cfg, Box::new(FakeTargets(ax)), inserter);

    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        for line in stdin.lines() {
            match line {
                Ok(l) if l.trim().is_empty() => {}
                Ok(l) => {
                    if tx.send(Some(l)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(None);
    });
    // Returns false once the app said stop or closed stdin.
    let handle = |d: &mut Dictate, msg: Option<String>, t_ns: u64, out: &mut Stdio| match msg {
        None => {
            d.command(Command::Stop, t_ns, out);
            false
        }
        Some(l) => match Command::parse(&l) {
            Ok(c) => d.command(c, t_ns, out),
            Err(e) => {
                out.line(p::warn("bad-command", &format!("{e}: {l}")));
                true
            }
        },
    };

    d.begin("simulate", true, ("granted", "granted"), &mut out);
    let last_key = keys.last().map_or(0, |k: &Scripted| k.ms);
    let end_ms = (wav.len() as u64 / 16).max(last_key + 1000).div_ceil(10) * 10;
    let start = Instant::now();
    let mut next_key = 0;
    let mut opened_at: Option<u64> = None;
    let mut running = true;
    'timeline: for ms in (0..end_ms).step_by(10) {
        if sw.speed > 0.0 {
            let due = start + Duration::from_secs_f64(ms as f64 / 1000.0 / sw.speed);
            if let Some(wait) = due.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
        }
        let t = ms * 1_000_000;
        // At speed 0 the timeline takes no time, so a command has no moment within it: commands
        // are read once it is over. Paced, they land on the step they arrive in.
        while sw.speed > 0.0
            && let Ok(msg) = rx.try_recv()
        {
            if !handle(&mut d, msg, t, &mut out) {
                running = false;
                break 'timeline;
            }
        }
        while next_key < keys.len() && keys[next_key].ms <= ms {
            let k = &keys[next_key];
            d.key(k.down, &k.key, k.ms * 1_000_000, &mut out);
            next_key += 1;
        }
        if d.mic_open() {
            let at = *opened_at.get_or_insert(ms);
            if ms >= at + sw.mic_open_delay_ms {
                let from = (ms * 16) as usize;
                let chunk: Vec<f32> = (from..from + 160)
                    .map(|i| wav.get(i).copied().unwrap_or(0.0))
                    .collect();
                d.audio(t, &chunk, &mut out);
            }
        } else {
            opened_at = None;
        }
        d.tick(t, &mut out);
    }
    let t_end = end_ms * 1_000_000;
    while running {
        running = handle(&mut d, rx.recv().unwrap_or(None), t_end, &mut out);
    }
    out.line(p::stopped("stop"));
    exit::OK
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictate::activation::Mode;
    use crate::dictate::keys::Hotkey;
    use crate::dictate::mic::Warm;
    use crate::protocol::decode_packets;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("akou-dictate-sim-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A mono 16 kHz WAV: silence with a constant "word" between two times.
    fn wav(name: &str, secs: f64, word: (f64, f64)) -> PathBuf {
        let n = (16_000.0 * secs) as usize;
        let s: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f64 / 16_000.0;
                if t >= word.0 && t < word.1 { 0.5 } else { 0.0 }
            })
            .collect();
        let path = dir().join(name);
        std::fs::write(&path, crate::wav::encode_i16(16_000, &[s])).unwrap();
        path
    }

    fn file(name: &str, text: &str) -> PathBuf {
        let path = dir().join(name);
        std::fs::write(&path, text).unwrap();
        path
    }

    fn cfg(warm: Warm) -> Config {
        Config {
            hotkey: Hotkey::parse("RightCommand").unwrap(),
            mode: Mode::HoldOrToggle,
            warm,
            bluetooth: false,
            ring_ms: super::super::mic::RING_MS,
        }
    }

    fn sim(sw: Switches, warm: Warm, stdin: &str) -> (i32, Vec<String>, Vec<u8>) {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = run(
            sw,
            cfg(warm),
            Box::new(std::io::Cursor::new(stdin.as_bytes().to_vec())),
            &mut stdout,
            &mut stderr,
        );
        let lines = String::from_utf8(stderr)
            .unwrap()
            .lines()
            .map(String::from)
            .collect();
        (code, lines, stdout)
    }

    /// DC-N10 end to end with every fake: a WAV mic, a scripted hold, a scripted target, and the
    /// app's insert recorded by the fake inserter. The word at 0 ms is in the session's audio
    /// because the key went down at 400 ms with a warm mic (DC-N4).
    #[test]
    fn dc_n10_a_scripted_dictation_runs_with_no_device_key_or_clipboard() {
        let log = dir().join("inserts.jsonl");
        let _ = std::fs::remove_file(&log);
        let sw = Switches {
            from_wav: Some(wav("word-at-0.wav", 2.0, (0.0, 0.3))),
            keys: Some(file(
                "hold.keys",
                "400 down RightCommand\n1400 up RightCommand\n",
            )),
            inserter: Some(Some(log.clone())),
            clipboard_fake: true,
            ax: Some(file(
                "ax.txt",
                "0 {\"app\":\"Notes\",\"pid\":5,\"window\":\"n\",\"field\":\"editable\"}\n",
            )),
            ..Switches::default()
        };
        let stdin =
            "{\"type\":\"insert\",\"id\":\"1\",\"text\":\"hello\",\"method\":\"clipboard\"}\n";
        let (code, lines, stdout) = sim(sw, Warm::Always, stdin);
        assert_eq!(code, 0, "{lines:?}");
        assert!(lines[0].starts_with(r#"{"type":"ready","protocol":"akou-dictate/1""#));
        assert!(lines[0].contains(r#""backend":"simulate","swallow_keys":true"#));
        let started = lines
            .iter()
            .find(|l| l.contains("session.started"))
            .unwrap();
        assert!(started.contains(r#""app":"Notes""#), "{started}");
        assert!(started.contains(r#""capture_ns":"0""#), "{started}");
        assert!(
            lines
                .iter()
                .any(|l| l.contains(r#""type":"session.ended","id":"1","reason":"release""#))
        );
        assert!(
            lines
                .iter()
                .any(|l| l.contains(r#""type":"inserted","id":"1","method":"clipboard""#))
        );
        assert_eq!(
            lines.last().unwrap(),
            r#"{"type":"stopped","reason":"stop"}"#
        );
        let (packets, _) = decode_packets(&stdout).unwrap();
        let word: usize = packets
            .iter()
            .flat_map(|p| p.samples.iter())
            .filter(|x| (**x - 0.5).abs() < 1e-3)
            .count();
        assert_eq!(word, 300 * 16, "the whole word is in the session");
        let logged = std::fs::read_to_string(&log).unwrap();
        assert!(
            logged.contains(r#""text":"hello","method":"clipboard""#),
            "{logged}"
        );
        assert!(logged.contains(r#""app":"Notes""#), "{logged}");
        assert!(logged.contains(r#""clipboard":"hello""#), "{logged}");
    }

    /// DC-N4 through the switches: `off` with a device that takes 300 ms reports the session only
    /// at its first sample.
    #[test]
    fn dc_n10_the_slow_mic_switch_drives_the_readiness_gate() {
        let sw = Switches {
            from_wav: Some(wav("silence.wav", 1.0, (0.0, 0.0))),
            keys: Some(file(
                "tap.keys",
                "400 down RightCommand\n500 up RightCommand\n",
            )),
            mic_open_delay_ms: 300,
            ..Switches::default()
        };
        let (code, lines, _) = sim(sw, Warm::Off, "");
        assert_eq!(code, 0);
        let started = lines
            .iter()
            .find(|l| l.contains("session.started"))
            .unwrap();
        assert!(started.contains(r#""capture_ns":"700000000""#), "{started}");
        assert!(
            started.contains(r#""field":"unknown""#),
            "no --ax: the target is unknown"
        );
    }

    #[test]
    fn dc_n10_no_inserter_switch_means_no_insert_and_bad_input_is_refused() {
        let sw = Switches {
            from_wav: Some(wav("short.wav", 0.2, (0.0, 0.0))),
            ..Switches::default()
        };
        let stdin =
            "{\"type\":\"insert\",\"id\":\"9\",\"text\":\"x\"}\nnot json\n{\"type\":\"stop\"}\n";
        let (code, lines, _) = sim(sw, Warm::Auto, stdin);
        assert_eq!(code, 0);
        assert!(
            lines
                .iter()
                .any(|l| l.contains(r#""type":"insert.failed","id":"9","reason":"no-inserter""#)),
            "{lines:?}"
        );
        assert!(lines.iter().any(|l| l.contains(r#""code":"bad-command""#)));

        let missing = Switches {
            from_wav: Some(dir().join("nope.wav")),
            ..Switches::default()
        };
        assert_eq!(sim(missing, Warm::Auto, "").0, exit::IO);
        let bad_keys = Switches {
            from_wav: Some(wav("short2.wav", 0.2, (0.0, 0.0))),
            keys: Some(file("bad.keys", "500 down A\n400 up A\n")),
            ..Switches::default()
        };
        assert_eq!(sim(bad_keys, Warm::Auto, "").0, exit::USAGE);
    }
}
