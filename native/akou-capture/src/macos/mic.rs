//! The microphone as its own stream (DESIGN 2.1 and 2.2), through cpal's Core Audio host.
//!
//! The device opens at its own default configuration: cpal on macOS writes a requested format
//! onto the physical device, so asking for anything else would re-clock the user's headset in the
//! middle of a call. The aligner resamples instead.
//!
//! A cpal stream is created, used and dropped on one worker thread that lives for the helper's
//! lifetime, with one cpal host (DESIGN 2.2); the engine talks to it through messages with
//! deadlines, so a hung open or teardown never blocks capture.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender, SyncSender};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::clock;
use crate::convert::{Format, SampleKind, to_mono};
use crate::health::device_watch::{MicTarget, mic_target};
use crate::protocol::{Ch, MicInfo};
use crate::source::{Chunk, Event, OpenError};

pub fn kind_of(f: cpal::SampleFormat) -> Option<SampleKind> {
    Some(match f {
        cpal::SampleFormat::U8 => SampleKind::U8,
        cpal::SampleFormat::I16 => SampleKind::I16,
        cpal::SampleFormat::I24 => SampleKind::I24InI32,
        cpal::SampleFormat::I32 => SampleKind::I32,
        cpal::SampleFormat::F32 => SampleKind::F32,
        cpal::SampleFormat::F64 => SampleKind::F64,
        _ => return None,
    })
}

enum Msg {
    Open(Sender<Result<MicInfo, OpenError>>),
    Close(Sender<()>),
}

pub struct MicWorker {
    tx: Sender<Msg>,
    pub running: Arc<AtomicBool>,
    pub dropped: Arc<AtomicU64>,
    handle: Option<JoinHandle<()>>,
}

fn device_id(d: &cpal::Device) -> String {
    d.id().map(|i| i.id().to_string()).unwrap_or_default()
}

fn device_name(d: &cpal::Device) -> String {
    d.description()
        .map(|x| x.name().to_string())
        .unwrap_or_else(|_| "microphone".into())
}

impl MicWorker {
    pub fn spawn(requested: String, events: SyncSender<Event>) -> MicWorker {
        let (tx, rx) = mpsc::channel::<Msg>();
        let running = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicU64::new(0));
        let (run, drop_count) = (running.clone(), dropped.clone());
        let handle = std::thread::spawn(move || {
            let host = cpal::default_host();
            let mut stream: Option<cpal::Stream> = None;
            for msg in rx {
                match msg {
                    Msg::Open(reply) => {
                        stream = None;
                        run.store(false, Ordering::Relaxed);
                        let r = open(&host, &requested, &events, &run, &drop_count);
                        let _ = reply.send(r.map(|(s, info)| {
                            stream = Some(s);
                            info
                        }));
                    }
                    Msg::Close(reply) => {
                        run.store(false, Ordering::Relaxed);
                        drop(stream.take());
                        let _ = reply.send(());
                        return;
                    }
                }
            }
        });
        MicWorker {
            tx,
            running,
            dropped,
            handle: Some(handle),
        }
    }

    /// Opens (or re-opens) the microphone, waiting at most `budget`.
    pub fn open(&self, budget: Duration) -> Result<MicInfo, OpenError> {
        let (reply, rx) = mpsc::channel();
        self.tx
            .send(Msg::Open(reply))
            .map_err(|_| OpenError::unavailable("the microphone worker is gone"))?;
        rx.recv_timeout(budget)
            .map_err(|_| OpenError::unavailable("the microphone did not open in time"))?
    }

    /// Stops the stream within `budget`; a stuck worker is left behind.
    pub fn close(mut self, budget: Duration) {
        let (reply, rx) = mpsc::channel();
        if self.tx.send(Msg::Close(reply)).is_ok()
            && rx.recv_timeout(budget).is_ok()
            && let Some(h) = self.handle.take()
        {
            let _ = h.join();
        }
    }
}

fn open(
    host: &cpal::Host,
    requested: &str,
    events: &SyncSender<Event>,
    running: &Arc<AtomicBool>,
    dropped: &Arc<AtomicU64>,
) -> Result<(cpal::Stream, MicInfo), OpenError> {
    let inputs: Vec<cpal::Device> = host
        .input_devices()
        .map(|d| d.collect())
        .unwrap_or_default();
    let ids: Vec<String> = inputs.iter().map(device_id).collect();
    let device = match mic_target(requested, &ids) {
        MicTarget::Pinned(id) => inputs.into_iter().find(|d| device_id(d) == id),
        MicTarget::Default => host.default_input_device(),
        MicTarget::FallbackFromPinned(id) => {
            let _ = events.try_send(Event::Health {
                ch: Ch::Mic,
                state: "fallback",
                detail: format!("microphone {id} is not connected; using the default input"),
            });
            host.default_input_device()
        }
    }
    .ok_or_else(|| OpenError::no_device("no input device"))?;
    let config = device
        .default_input_config()
        .map_err(|e| OpenError::unavailable(format!("microphone configuration: {e}")))?;
    let kind = kind_of(config.sample_format()).ok_or_else(|| {
        OpenError::unavailable(format!(
            "microphone sample format {:?} is not supported",
            config.sample_format()
        ))
    })?;
    let rate = config.sample_rate();
    let format = Format {
        kind,
        channels: config.channels() as usize,
        interleaved: true,
    };
    let tx = events.clone();
    let err_tx = events.clone();
    let run = running.clone();
    let err_run = running.clone();
    let drop_count = dropped.clone();
    let stream = device
        .build_input_stream_raw(
            config.config(),
            config.sample_format(),
            move |data: &cpal::Data, info: &cpal::InputCallbackInfo| {
                let mut samples = Vec::new();
                let heard = to_mono(format, &[data.bytes()], &mut samples);
                if samples.is_empty() {
                    return;
                }
                // cpal's capture instant is the buffer's host time on the awake clock.
                let ns = info.timestamp().capture.as_nanos() as u64;
                let awake_ns = if ns > 0 { ns } else { clock::now().awake_ns };
                run.store(true, Ordering::Relaxed);
                let chunk = Chunk {
                    ch: Ch::Mic,
                    awake_ns,
                    rate,
                    samples,
                    heard,
                };
                if tx.try_send(Event::Chunk(chunk)).is_err() {
                    drop_count.fetch_add(1, Ordering::Relaxed);
                }
            },
            move |e| {
                err_run.store(false, Ordering::Relaxed);
                let _ = err_tx.try_send(Event::Lost {
                    ch: Ch::Mic,
                    detail: e.to_string(),
                });
            },
            None,
        )
        .map_err(|e| {
            let msg = format!("microphone: {e}");
            if msg.to_lowercase().contains("permission") {
                OpenError::permission(msg)
            } else {
                OpenError::unavailable(msg)
            }
        })?;
    stream
        .play()
        .map_err(|e| OpenError::unavailable(format!("starting the microphone: {e}")))?;
    running.store(true, Ordering::Relaxed);
    let info = MicInfo {
        id: if requested == "default" {
            "default".into()
        } else {
            device_id(&device)
        },
        name: device_name(&device),
        rate,
    };
    Ok((stream, info))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpal_formats_map_to_the_converter() {
        assert_eq!(kind_of(cpal::SampleFormat::F32), Some(SampleKind::F32));
        assert_eq!(kind_of(cpal::SampleFormat::I24), Some(SampleKind::I24InI32));
        assert_eq!(kind_of(cpal::SampleFormat::I16), Some(SampleKind::I16));
        assert_eq!(kind_of(cpal::SampleFormat::DsdU8), None);
    }
}
