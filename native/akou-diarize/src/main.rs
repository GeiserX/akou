//! `akou-diarize`: who speaks when on the call channel (docs/DESIGN.md section 3.4), with NVIDIA's
//! Nemotron 3 Diarization on ONNX Runtime, in its own process so a model that crashes or hangs
//! never takes the app or the recording with it.
//!
//! ```text
//! akou-diarize run --model <nemotron3_diar_v3.onnx> --mode final|live [--threads N]
//! akou-diarize --version
//! ```
//!
//! The protocol on stdin and stdout is in `lib.rs`. Exit codes: 0 at the end of input, 64 for bad
//! arguments, 66 when the model cannot be loaded, 70 when inference fails, 74 on a broken frame
//! or pipe.

use std::io::{self, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use akou_diarize::{
    Frame, Mode, RATE, RESET_LINE, Timeline, at_line, error_line, read_frame, ready_line,
    turn_line, whole_chunk_pad,
};
use parakeet_rs::ExecutionConfig;
use parakeet_rs::sortformer::{DiarizationConfig, Sortformer, SpeakerSegment, StreamingProfile};

const USAGE: &str = "usage: akou-diarize run --model FILE --mode final|live [--threads N]\n       akou-diarize --version";

struct Args {
    model: PathBuf,
    mode: Mode,
    threads: usize,
}

fn parse(argv: &[String]) -> Result<Args, String> {
    let mut it = argv.iter();
    match it.next().map(String::as_str) {
        Some("run") => {}
        Some(other) => return Err(format!("unknown command {other}")),
        None => return Err("missing command".into()),
    }
    let mut model = None;
    let mut mode = None;
    let mut threads = 2;
    while let Some(a) = it.next() {
        let mut val = || {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{a} needs a value"))
        };
        match a.as_str() {
            "--model" => model = Some(PathBuf::from(val()?)),
            "--mode" => {
                let v = val()?;
                mode = Some(Mode::parse(&v).ok_or_else(|| format!("unknown mode {v}"))?);
            }
            "--threads" => {
                let v = val()?;
                threads = v
                    .parse::<usize>()
                    .ok()
                    .filter(|t| (1..=32).contains(t))
                    .ok_or_else(|| format!("--threads takes 1 to 32, not {v}"))?;
            }
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(Args {
        model: model.ok_or("--model is required")?,
        mode: mode.ok_or("--mode is required")?,
        threads,
    })
}

struct Out<W: Write> {
    w: W,
}

impl<W: Write> Out<W> {
    fn line(&mut self, s: &str) -> io::Result<()> {
        self.w.write_all(s.as_bytes())?;
        self.w.write_all(b"\n")
    }

    /// Writes turns, each moved onto the caller's timeline (and clipped to its audio) by `map`.
    fn turns(
        &mut self,
        segs: &[SpeakerSegment],
        map: impl Fn(u64, u64) -> Option<(u64, u64)>,
    ) -> io::Result<()> {
        for s in segs {
            if let Some((a, b)) = map(s.start, s.end) {
                self.line(&turn_line(s.speaker_id, a, b))?;
            }
        }
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.w.flush()
    }
}

enum Fail {
    Io(io::Error),
    Model(String),
}

impl From<io::Error> for Fail {
    fn from(e: io::Error) -> Fail {
        Fail::Io(e)
    }
}

fn model_err(e: impl std::fmt::Display) -> Fail {
    Fail::Model(e.to_string())
}

fn serve(sf: &mut Sortformer, mode: Mode, out: &mut Out<impl Write>) -> Result<(), Fail> {
    let mut input = BufReader::with_capacity(1 << 16, io::stdin().lock());
    let mut held: Vec<f32> = Vec::new();
    let mut t = Timeline::new(mode.geometry());
    while let Some(frame) = read_frame(&mut input)? {
        match (frame, mode) {
            (Frame::Audio(x), Mode::Final) => held.extend_from_slice(&x),
            (Frame::Audio(x), Mode::Live) => {
                let segs = sf.feed(&x).map_err(model_err)?;
                let stepped = t.push(x.len());
                out.turns(&segs, |a, b| t.turn(a, b))?;
                if stepped {
                    out.line(&at_line("decided", t.decided()))?;
                    out.flush()?;
                }
            }
            (Frame::Flush, Mode::Final) => {
                let mut audio = std::mem::take(&mut held);
                let at = audio.len() as u64;
                if !audio.is_empty() {
                    audio.resize(audio.len() + whole_chunk_pad(audio.len()), 0.0);
                    // The whole stream at once, as NeMo's `diarize()` runs it: plain 0.5
                    // threshold, no smoothing (akou smooths where it cuts, section 3.3). Turns
                    // are clipped to the real audio, never the padding.
                    let (preds, _) = sf.predict_raw(audio, RATE as u32, 1).map_err(model_err)?;
                    let segs = Sortformer::post_process(&DiarizationConfig::default(), &preds, at);
                    out.turns(&segs, |a, b| (b > a).then_some((a, b)))?;
                }
                sf.reset_state();
                out.line(&at_line("flushed", at))?;
                out.flush()?;
            }
            (Frame::Flush, Mode::Live) => {
                // Silence up to the next hop when the remainder would hit parakeet-rs's
                // multiple-of-8 bug; it can take a step, so check again until none is needed.
                loop {
                    let pad = t.pad_needed();
                    if pad == 0 {
                        break;
                    }
                    let segs = sf.feed(&vec![0.0; pad]).map_err(model_err)?;
                    t.padded(pad);
                    out.turns(&segs, |a, b| t.turn(a, b))?;
                }
                let segs = sf.flush().map_err(model_err)?;
                out.turns(&segs, |a, b| t.turn(a, b))?;
                t.flushed();
                out.line(&at_line("flushed", t.decided()))?;
                out.flush()?;
            }
            (Frame::Reset, _) => {
                held.clear();
                sf.reset_state();
                t.reset();
                // Every line after this one belongs to the new stream.
                out.line(RESET_LINE)?;
                out.flush()?;
            }
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(String::as_str) == Some("--version") {
        println!("akou-diarize {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let args = match parse(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("akou-diarize: {e}\n{USAGE}");
            return ExitCode::from(64);
        }
    };
    let mut out = Out {
        w: BufWriter::new(io::stdout().lock()),
    };
    // Before any session exists: ONNX Runtime reports nothing to anyone.
    let _ = ort::init().with_telemetry(false).commit();
    let config = ExecutionConfig::default()
        .with_intra_threads(args.threads)
        .with_inter_threads(1);
    let g = args.mode.geometry();
    let loaded = Sortformer::with_config(&args.model, Some(config), DiarizationConfig::default())
        .and_then(|mut sf| {
            sf.set_profile(StreamingProfile {
                chunk_len: g.chunk_len,
                right_context: g.right_context,
                fifo_len: g.fifo_len,
                spkcache_update_period: g.spkcache_update_period,
                spkcache_len: g.spkcache_len,
            })?;
            Ok(sf)
        });
    let mut sf = match loaded {
        Ok(sf) => sf,
        Err(e) => {
            let msg = format!("cannot load {}: {e}", args.model.display());
            let _ = out.line(&error_line(&msg));
            let _ = out.flush();
            eprintln!("akou-diarize: {msg}");
            return ExitCode::from(66);
        }
    };
    if out
        .line(&ready_line(env!("CARGO_PKG_VERSION"), args.mode))
        .and_then(|_| out.flush())
        .is_err()
    {
        return ExitCode::from(74);
    }
    match serve(&mut sf, args.mode, &mut out) {
        Ok(()) => {
            let _ = out.flush();
            ExitCode::SUCCESS
        }
        Err(Fail::Io(e)) => {
            let _ = out.line(&error_line(&e.to_string()));
            let _ = out.flush();
            eprintln!("akou-diarize: {e}");
            ExitCode::from(74)
        }
        Err(Fail::Model(e)) => {
            let _ = out.line(&error_line(&e));
            let _ = out.flush();
            eprintln!("akou-diarize: {e}");
            ExitCode::from(70)
        }
    }
}
