//! The file front end: `akou-capture run --from-wav <stereo.wav>` feeds a WAV's left channel as the
//! mic and its right channel as the call through the same aligner, Opus writer and protocol as the
//! devices, so the whole helper runs end to end on any OS without touching a device.
//!
//! It drives its own clock: every 10 ms of file it sends both chunks and then a `Tick`, and the
//! engine emits up to that tick. `--speed 1` paces it in real time, `--speed 20` twenty times
//! faster, `--speed 0` (the default) as fast as the engine takes it. `--loop` repeats the file.
//!
//! The fault switches that concern sources (`call-silent`, `call-dead-at`, `call-zeros-at`,
//! `rebuild-heals`, `sleep-at`) act here.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::clock::Now;
use crate::protocol::{CallInfo, Ch, MicInfo};
use crate::simulate::Faults;
use crate::source::{ClockKind, Event, Frontend, OpenError, Opened, Status};
use crate::wav::Wav;

pub struct FileSource {
    wav: Option<Wav>,
    name: String,
    speed: f64,
    looped: bool,
    mic_on: bool,
    call_on: bool,
    faults: Faults,
    tx: Option<SyncSender<Event>>,
    stop: Arc<AtomicBool>,
    healed: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    /// The verdict of the probe just asked, until the engine takes it.
    answer: Option<bool>,
}

impl FileSource {
    pub fn new(
        wav: Wav,
        name: &str,
        speed: f64,
        looped: bool,
        mic_on: bool,
        call_on: bool,
        faults: Faults,
    ) -> Self {
        FileSource {
            wav: Some(wav),
            name: name.to_string(),
            speed,
            looped,
            mic_on,
            call_on,
            faults,
            tx: None,
            stop: Arc::new(AtomicBool::new(false)),
            healed: Arc::new(AtomicBool::new(false)),
            worker: None,
            answer: None,
        }
    }

    /// With fault switches set, the file stands for a machine whose output is playing (unless
    /// the call side is silent from the start), as in the fake helper. Without them this front
    /// end cannot tell, and the dead-call rule stays off.
    fn output_running(&self) -> Option<bool> {
        if self.faults.any() {
            Some(!self.faults.call_silent())
        } else {
            None
        }
    }
}

impl Frontend for FileSource {
    fn caps(&self) -> Vec<&'static str> {
        vec!["file"]
    }

    fn clock(&self) -> ClockKind {
        ClockKind::Driven
    }

    fn open(&mut self, tx: SyncSender<Event>) -> Result<Opened, OpenError> {
        let wav = self
            .wav
            .as_ref()
            .ok_or_else(|| OpenError::io("file source opened twice"))?;
        if wav.channels != 2 {
            return Err(OpenError::no_device(format!(
                "{} has {} channels; the file source needs stereo (left mic, right call)",
                self.name, wav.channels
            )));
        }
        if wav.frames() == 0 {
            return Err(OpenError::no_device(format!("{} has no audio", self.name)));
        }
        self.tx = Some(tx);
        Ok(Opened {
            mic: self.mic_on.then(|| MicInfo {
                id: "file".into(),
                name: format!("{} (left)", self.name),
                rate: wav.rate,
            }),
            call: self.call_on.then(|| CallInfo {
                mode: "file".into(),
                rate: wav.rate,
            }),
            exclude: vec![],
            devices: [None, None],
        })
    }

    fn start(&mut self, anchor: Now) {
        let (Some(tx), Some(wav)) = (self.tx.clone(), self.wav.take()) else {
            return;
        };
        let stop = self.stop.clone();
        let healed = self.healed.clone();
        let speed = self.speed;
        let looped = self.looped;
        let (mic_on, call_on) = (self.mic_on, self.call_on);
        let call_silent = self.faults.call_silent();
        let dead_at = self.faults.call_dead_at();
        let zeros_at = self.faults.call_zeros_at();
        let sleep = self.faults.sleep();
        self.worker = Some(std::thread::spawn(move || {
            let step = (wav.rate as usize / 100).max(1);
            let frames = wav.frames();
            let t0 = Instant::now();
            let mut pos = 0usize; // frames sent, across loops
            let mut slept_ns = 0u64;
            while !stop.load(Ordering::Relaxed) {
                let at = pos % frames;
                if at == 0 && pos > 0 && !looped {
                    let _ = tx.send(Event::Eof);
                    return;
                }
                let n = step.min(frames - at);
                let t = pos as f64 / wav.rate as f64;
                if let Some((sleep_at, sleep_for)) = sleep
                    && slept_ns == 0
                    && t >= sleep_at
                {
                    slept_ns = (sleep_for * 1e9) as u64;
                }
                let awake = anchor.awake_ns + (t * 1e9) as u64;
                let healthy = !healed.load(Ordering::Relaxed);
                let dead = dead_at.is_some_and(|d| t >= d) && healthy;
                let zeros = zeros_at.is_some_and(|z| t >= z) && healthy;
                let chunks = [
                    (Ch::Mic, mic_on, &wav.data[0]),
                    (Ch::Call, call_on && !call_silent && !dead, &wav.data[1]),
                ];
                for (ch, on, data) in chunks {
                    if !on {
                        continue;
                    }
                    let samples = if ch == Ch::Call && zeros {
                        vec![0.0; n]
                    } else {
                        data[at..at + n].to_vec()
                    };
                    let c = crate::source::Chunk {
                        ch,
                        awake_ns: awake,
                        rate: wav.rate,
                        heard: samples.iter().any(|v| *v != 0.0),
                        samples,
                    };
                    if tx.send(Event::Chunk(c)).is_err() {
                        return;
                    }
                }
                pos += n;
                let end_t = pos as f64 / wav.rate as f64;
                let end_awake = anchor.awake_ns + (end_t * 1e9) as u64;
                let tick = Now {
                    awake_ns: end_awake,
                    cont_ns: anchor.cont_ns + (end_t * 1e9) as u64 + slept_ns,
                };
                if tx.send(Event::Tick(tick)).is_err() {
                    return;
                }
                if speed > 0.0 {
                    let due = Duration::from_secs_f64(end_t / speed);
                    let el = t0.elapsed();
                    if due > el {
                        std::thread::sleep(due - el);
                    }
                }
            }
        }));
    }

    fn rebuild(&mut self, ch: Ch) -> Result<Vec<String>, String> {
        if ch == Ch::Call && self.faults.rebuild_heals() {
            self.healed.store(true, Ordering::Relaxed);
        }
        Ok(vec![])
    }

    fn probe_call(&mut self) {
        // The probe listens to the output: it hears audio while the simulated output plays. It
        // answers at once, through `probe_answered`: sent as an event it would queue behind the
        // audio this source is ahead of the engine by (seconds of file at `--speed 0`, or when
        // the engine is slow), and be timed there, or be dropped when that queue is full.
        self.answer = Some(self.output_running() == Some(true));
    }

    fn probe_answered(&mut self) -> Option<bool> {
        self.answer.take()
    }

    fn status(&mut self) -> Status {
        Status {
            output_running: self.output_running(),
            mic_running: self.mic_on,
            default_input: None,
            default_output: None,
        }
    }

    fn close(mut self: Box<Self>) {
        self.stop.store(true, Ordering::Relaxed);
        // The worker may be blocked sending into a full queue that nobody drains any more;
        // dropping our sender does not free it, so it is detached rather than joined.
        drop(self.tx.take());
        drop(self.worker.take());
    }
}
