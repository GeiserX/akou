//! The M0 drift test's signal source (ROADMAP G4, TRAPS "Drift between two clocks"): one process
//! that plays a marker train into two output devices at once, scheduled on the host clock, so the
//! two trains share one clock whatever each device's own clock does.
//!
//! - The **mic** device (a virtual loopback such as BlackHole, whose input akou records as the mic)
//!   gets a continuous 500 Hz pilot at -40 dBFS and a 3.0 to 4.5 kHz chirp every period.
//! - The **call** device (the speakers the process tap hears) gets a 900 Hz pilot and a 1.5 to
//!   2.5 kHz chirp every period, half a period after the mic chirp so the two never overlap in a
//!   channel that hears both. It stays silent (no stream running) until `--call-start`, pauses for
//!   `--mute-for` seconds at `--mute-at`, and each time it starts it plays the `--clip` (48 kHz mono
//!   f32, the "first words after silence") from its very first sample.
//!
//! `--mic-device none` plays nothing on the mic side. Then nothing at all plays while the call side
//! is silent, so the process tap, which hears every output device, is really quiet: the case the
//! "first words after silence" and "memory with the call source muted" checks need.
//!
//! Every chirp and clip start is written to `--events` as JSON lines with its host time in
//! nanoseconds (the awake host clock, which cpal reports), so the analysis
//! (`scripts/drift-test.ts`) can check the recording against the schedule.
//!
//! ```text
//! cargo run --release --example drift-signal -- --mic-device "BlackHole 2ch" \
//!   --call-device "Mac mini Speakers" --seconds 3720 --call-start 35 --mute-at 2100 \
//!   --mute-for 600 --clip first-words.f32 --events signal.jsonl
//! ```
//!
//! macOS only; it opens real output devices and is never run by the tests.

#[cfg(target_os = "macos")]
mod imp {
    use std::io::Write;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{SyncSender, sync_channel};
    use std::time::Duration;

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    const PERIOD_S: f64 = 10.0;
    const CHIRP_S: f64 = 0.05;
    const CHIRP_AMP: f32 = 0.3;
    const PILOT_AMP: f32 = 0.01;

    #[derive(Debug)]
    enum Ev {
        Chirp {
            ch: &'static str,
            k: i64,
            host_ns: u64,
        },
        Clip {
            ch: &'static str,
            host_ns: u64,
        },
        FirstCallback {
            ch: &'static str,
            host_ns: u64,
        },
    }

    /// The awake host clock in nanoseconds: the clock cpal's timestamps are on.
    fn now_ns() -> u64 {
        akou_capture::clock::now().awake_ns
    }

    /// A Hann-windowed linear chirp.
    fn chirp(rate: f64, f0: f64, f1: f64) -> Vec<f32> {
        let n = (CHIRP_S * rate).round() as usize;
        (0..n)
            .map(|i| {
                let t = i as f64 / rate;
                let phase =
                    2.0 * std::f64::consts::PI * (f0 * t + (f1 - f0) * t * t / (2.0 * CHIRP_S));
                let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (n - 1) as f64).cos();
                (phase.sin() * w) as f32 * CHIRP_AMP
            })
            .collect()
    }

    struct Gen {
        name: &'static str,
        rate: f64,
        channels: usize,
        pilot_hz: f64,
        pilot_phase: f64,
        chirp: Vec<f32>,
        chirp_pos: Option<usize>,
        last_k: i64,
        t0_ns: u64,
        offset_ns: u64,
        clip: Arc<Vec<f32>>,
        clip_pos: Option<usize>,
        start_clip: Arc<AtomicBool>,
        first: bool,
        tx: SyncSender<Ev>,
    }

    impl Gen {
        fn fill(&mut self, out: &mut [f32], playback_ns: u64) {
            let frames = out.len() / self.channels;
            let ns_per_frame = 1e9 / self.rate;
            if self.first {
                self.first = false;
                let _ = self.tx.try_send(Ev::FirstCallback {
                    ch: self.name,
                    host_ns: playback_ns,
                });
            }
            if self.start_clip.swap(false, Ordering::Relaxed) && !self.clip.is_empty() {
                self.clip_pos = Some(0);
                let _ = self.tx.try_send(Ev::Clip {
                    ch: self.name,
                    host_ns: playback_ns,
                });
            }
            // The marker, if one is due in this buffer, and the frame it starts on.
            let end_ns = playback_ns + (frames as f64 * ns_per_frame) as u64;
            let base = self.t0_ns + self.offset_ns;
            let mut start_frame = usize::MAX;
            if end_ns > base {
                let period = (PERIOD_S * 1e9) as u64;
                let k = (playback_ns.saturating_sub(base)).div_ceil(period) as i64;
                let at = base + k as u64 * period;
                if k > self.last_k && at < end_ns {
                    self.last_k = k;
                    // Floor, not round: rounding a marker in the last half frame gives `frames`,
                    // which never plays while the event still says it did.
                    start_frame = (((at - playback_ns) as f64 / ns_per_frame).floor() as usize)
                        .min(frames.saturating_sub(1));
                    let _ = self.tx.try_send(Ev::Chirp {
                        ch: self.name,
                        k,
                        host_ns: playback_ns + (start_frame as f64 * ns_per_frame) as u64,
                    });
                }
            }
            let dphi = 2.0 * std::f64::consts::PI * self.pilot_hz / self.rate;
            for f in 0..frames {
                if f == start_frame {
                    self.chirp_pos = Some(0);
                }
                let mut v = (self.pilot_phase.sin() as f32) * PILOT_AMP;
                self.pilot_phase = (self.pilot_phase + dphi) % (2.0 * std::f64::consts::PI);
                if let Some(p) = self.chirp_pos {
                    v += self.chirp[p];
                    self.chirp_pos = (p + 1 < self.chirp.len()).then_some(p + 1);
                }
                if let Some(p) = self.clip_pos {
                    v += self.clip[p];
                    self.clip_pos = (p + 1 < self.clip.len()).then_some(p + 1);
                }
                for c in 0..self.channels {
                    out[f * self.channels + c] = v;
                }
            }
        }
    }

    fn arg(args: &[String], name: &str) -> Option<String> {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1).cloned())
    }

    fn num(args: &[String], name: &str, default: f64) -> f64 {
        arg(args, name)
            .map(|v| {
                v.parse()
                    .unwrap_or_else(|_| panic!("{name} needs a number"))
            })
            .unwrap_or(default)
    }

    fn open(
        host: &cpal::Host,
        device_name: &str,
        mut g: Gen,
    ) -> Result<(cpal::Stream, f64), String> {
        let device = host
            .output_devices()
            .map_err(|e| e.to_string())?
            .find(|d| {
                d.description()
                    .map(|x| x.name() == device_name)
                    .unwrap_or(false)
            })
            .ok_or_else(|| format!("no output device named {device_name}"))?;
        let cfg = device.default_output_config().map_err(|e| e.to_string())?;
        if cfg.sample_format() != cpal::SampleFormat::F32 {
            return Err(format!(
                "{device_name}: {:?} output, need f32",
                cfg.sample_format()
            ));
        }
        let rate = cfg.sample_rate() as f64;
        if (rate - 48_000.0).abs() > 0.5 {
            return Err(format!(
                "{device_name}: runs at {rate} Hz, the clip needs 48 kHz"
            ));
        }
        g.rate = rate;
        g.channels = cfg.channels() as usize;
        let stream = device
            .build_output_stream::<f32, _, _>(
                cfg.config(),
                move |out: &mut [f32], info: &cpal::OutputCallbackInfo| {
                    let ns = info.timestamp().playback.as_nanos() as u64;
                    g.fill(out, ns);
                },
                |e| eprintln!("stream error: {e}"),
                None,
            )
            .map_err(|e| format!("{device_name}: {e}"))?;
        Ok((stream, rate))
    }

    pub fn main() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let mic_name = arg(&args, "--mic-device").expect("--mic-device NAME");
        let call_name = arg(&args, "--call-device").expect("--call-device NAME");
        let seconds = num(&args, "--seconds", 3720.0);
        let call_start = num(&args, "--call-start", 35.0);
        let mute_at = num(&args, "--mute-at", f64::INFINITY);
        let mute_for = num(&args, "--mute-for", 0.0);
        let events_path = arg(&args, "--events").expect("--events FILE");
        let clip: Vec<f32> = arg(&args, "--clip")
            .map(|p| {
                std::fs::read(&p)
                    .unwrap_or_else(|e| panic!("{p}: {e}"))
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|b| f32::from_le_bytes(*b))
                    .collect()
            })
            .unwrap_or_default();
        let clip = Arc::new(clip);

        let t0_ns = now_ns() + 2_000_000_000;
        let (tx, rx) = sync_channel::<Ev>(1024);
        let mut events = std::fs::File::create(&events_path).expect("events file");
        let host = cpal::default_host();
        let gen_for = |name: &'static str, pilot_hz, f0, f1, offset_s: f64, start_clip| Gen {
            name,
            rate: 48_000.0,
            channels: 1,
            pilot_hz,
            pilot_phase: 0.0,
            chirp: chirp(48_000.0, f0, f1),
            chirp_pos: None,
            last_k: -1,
            t0_ns,
            offset_ns: (offset_s * 1e9) as u64,
            clip: clip.clone(),
            clip_pos: None,
            start_clip,
            first: true,
            tx: tx.clone(),
        };
        let mic_clip = Arc::new(AtomicBool::new(false));
        let call_clip = Arc::new(AtomicBool::new(false));
        let mic = (mic_name != "none").then(|| {
            open(
                &host,
                &mic_name,
                gen_for("mic", 500.0, 3000.0, 4500.0, 0.0, mic_clip),
            )
            .unwrap_or_else(|e| panic!("{e}"))
            .0
        });
        let (call, _) = open(
            &host,
            &call_name,
            gen_for(
                "call",
                900.0,
                1500.0,
                2500.0,
                PERIOD_S / 2.0,
                call_clip.clone(),
            ),
        )
        .unwrap_or_else(|e| panic!("{e}"));
        drop(tx);

        let write = |f: &mut std::fs::File, line: String| {
            let _ = writeln!(f, "{line}");
            let _ = f.flush();
        };
        write(
            &mut events,
            format!(
                "{{\"ev\":\"start\",\"t0_ns\":{t0_ns},\"period_s\":{PERIOD_S},\"call_offset_s\":{},\"chirp_s\":{CHIRP_S},\"call_start_s\":{call_start},\"mute_at_s\":{},\"mute_for_s\":{mute_for},\"seconds\":{seconds},\"clip_samples\":{},\"mic\":{}}}",
                PERIOD_S / 2.0,
                if mute_at.is_finite() { mute_at } else { -1.0 },
                clip.len(),
                mic.is_some()
            ),
        );
        if let Some(m) = &mic {
            m.play().expect("mic stream");
        }

        // The call side's schedule, in seconds from t0.
        let mut plan: Vec<(f64, &str)> = vec![(call_start, "play")];
        if mute_at.is_finite() && mute_for > 0.0 {
            plan.push((mute_at, "pause"));
            plan.push((mute_at + mute_for, "play"));
        }
        plan.push((seconds, "end"));
        let at = |s: f64| t0_ns as f64 + s * 1e9;
        for (s, what) in plan {
            loop {
                for ev in rx.try_iter() {
                    write(&mut events, render(&ev));
                }
                let now = now_ns() as f64;
                if now >= at(s) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(
                    ((at(s) - now) / 1e6).clamp(1.0, 200.0) as u64,
                ));
            }
            let host_ns = now_ns();
            match what {
                "play" => {
                    call_clip.store(true, Ordering::Relaxed);
                    call.play().expect("call stream");
                }
                "pause" => call.pause().expect("call pause"),
                _ => {}
            }
            write(
                &mut events,
                format!("{{\"ev\":\"call.{what}\",\"host_ns\":{host_ns}}}"),
            );
            if what == "end" {
                break;
            }
        }
        drop(call);
        drop(mic);
        for ev in rx.try_iter() {
            write(&mut events, render(&ev));
        }
    }

    fn render(ev: &Ev) -> String {
        match ev {
            Ev::Chirp { ch, k, host_ns } => {
                format!("{{\"ev\":\"chirp\",\"ch\":\"{ch}\",\"k\":{k},\"host_ns\":{host_ns}}}")
            }
            Ev::Clip { ch, host_ns } => {
                format!("{{\"ev\":\"clip\",\"ch\":\"{ch}\",\"host_ns\":{host_ns}}}")
            }
            Ev::FirstCallback { ch, host_ns } => {
                format!("{{\"ev\":\"first_callback\",\"ch\":\"{ch}\",\"host_ns\":{host_ns}}}")
            }
        }
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    imp::main();
    #[cfg(not(target_os = "macos"))]
    eprintln!("drift-signal plays into macOS output devices; it does nothing on this OS");
}
