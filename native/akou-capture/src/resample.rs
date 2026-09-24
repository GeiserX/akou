//! Resampling. One continuous resampler per stream, never one per chunk (a closed hark trap, kept
//! as an invariant): chunk boundaries must not leave clicks or drop fractional samples.
//!
//! - `StreamResampler`: device rate to 48 kHz through rubato's asynchronous sinc resampler, whose
//!   ratio the aligner nudges by at most 0.1 % to follow clock skew (DESIGN 2.1).
//! - `Decimator3`: the aligned 48 kHz channels to 16 kHz for the recognizer, a fixed 3:1 FIR.

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{
    Adjustable, Async, FixedAsync, Resampler, SincInterpolationParameters, WindowFunction,
};

/// Input frames per resampler call: about 5 ms at 48 kHz.
const CHUNK: usize = 256;
/// Bound of the relative ratio the resampler accepts; the aligner stays within 0.1 %.
const MAX_RELATIVE: f64 = 1.01;

pub struct StreamResampler {
    inner: Async<f32>,
    pending: Vec<f32>,
    scratch: Vec<f32>,
    in_rate: u32,
}

impl StreamResampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Result<Self, String> {
        if in_rate == 0 {
            return Err("sample rate 0".into());
        }
        let params = SincInterpolationParameters::new(128, WindowFunction::BlackmanHarris2);
        let inner = Async::<f32>::new_sinc(
            out_rate as f64 / in_rate as f64,
            MAX_RELATIVE,
            &params,
            CHUNK,
            1,
            FixedAsync::Input,
        )
        .map_err(|e| format!("resampler {in_rate} -> {out_rate}: {e}"))?;
        let scratch = vec![0.0; inner.output_frames_max()];
        Ok(StreamResampler {
            inner,
            pending: Vec::with_capacity(CHUNK * 4),
            scratch,
            in_rate,
        })
    }

    pub fn in_rate(&self) -> u32 {
        self.in_rate
    }

    /// Output frames the resampler lags its input by; the first this many outputs after a reset
    /// are its startup, not audio.
    pub fn delay(&self) -> usize {
        self.inner.output_delay()
    }

    /// Input frames held until a full chunk arrives.
    pub fn buffered(&self) -> usize {
        self.pending.len()
    }

    /// Sets the ratio relative to the nominal one (1.001 = 0.1 % more output).
    pub fn set_relative(&mut self, rel: f64) {
        let rel = rel.clamp(1.0 / MAX_RELATIVE, MAX_RELATIVE);
        let _ = self.inner.set_resample_ratio_relative(rel, true);
    }

    pub fn reset(&mut self) {
        self.inner.reset();
        self.pending.clear();
        let _ = self.inner.set_resample_ratio_relative(1.0, false);
    }

    /// Feeds input; appends every output frame now available.
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        self.pending.extend_from_slice(input);
        let mut used = 0;
        loop {
            let need = self.inner.input_frames_next();
            if self.pending.len() - used < need {
                break;
            }
            let max = self.inner.output_frames_max();
            if self.scratch.len() < max {
                self.scratch.resize(max, 0.0);
            }
            let src = &self.pending[used..used + need];
            let (Ok(inp), Ok(mut outp)) = (
                InterleavedSlice::new(src, 1, need),
                InterleavedSlice::new_mut(&mut self.scratch[..max], 1, max),
            ) else {
                break;
            };
            match self.inner.process_into_buffer(&inp, &mut outp, None) {
                Ok((n_in, n_out)) => {
                    out.extend_from_slice(&self.scratch[..n_out]);
                    used += n_in.max(1);
                }
                Err(_) => {
                    // Cannot happen with the sizes above; drop the chunk rather than spin.
                    used += need;
                }
            }
        }
        self.pending.drain(..used);
    }
}

/// A 3:1 decimator, 48 kHz to 16 kHz: a 127-tap Blackman-windowed sinc low-pass at 7 kHz, then
/// every third sample. Its delay is 63 input samples (21 output samples, 1.3 ms), the same on
/// both channels.
pub struct Decimator3 {
    taps: Vec<f32>,
    hist: Vec<f32>,
    pos: usize,
}

const TAPS: usize = 127;

impl Default for Decimator3 {
    fn default() -> Self {
        Self::new()
    }
}

impl Decimator3 {
    pub fn new() -> Self {
        let fs = 48_000.0f64;
        let fc = 7_000.0f64;
        let m = (TAPS - 1) as f64 / 2.0;
        let mut taps: Vec<f64> = (0..TAPS)
            .map(|n| {
                let x = n as f64 - m;
                let sinc = if x == 0.0 {
                    2.0 * fc / fs
                } else {
                    (2.0 * std::f64::consts::PI * fc / fs * x).sin() / (std::f64::consts::PI * x)
                };
                let w = 0.42
                    - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / (TAPS - 1) as f64).cos()
                    + 0.08 * (4.0 * std::f64::consts::PI * n as f64 / (TAPS - 1) as f64).cos();
                sinc * w
            })
            .collect();
        let sum: f64 = taps.iter().sum();
        for t in &mut taps {
            *t /= sum;
        }
        Decimator3 {
            taps: taps.into_iter().map(|t| t as f32).collect(),
            hist: vec![0.0; TAPS - 1],
            pos: TAPS - 1,
        }
    }

    /// Appends the 16 kHz samples that `input` completes.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        self.hist.extend_from_slice(input);
        while self.pos < self.hist.len() {
            let end = self.pos;
            let mut acc = 0.0f32;
            for (k, t) in self.taps.iter().enumerate() {
                acc += t * self.hist[end - k];
            }
            out.push(acc);
            self.pos += 3;
        }
        let keep_from = self.pos.saturating_sub(TAPS - 1).min(self.hist.len());
        self.hist.drain(..keep_from);
        self.pos -= keep_from;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, rate: f64, n: usize, amp: f32) -> Vec<f32> {
        (0..n)
            .map(|i| amp * (2.0 * std::f64::consts::PI * freq * i as f64 / rate).sin() as f32)
            .collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
    }

    /// Frequency by zero crossings, over the steady middle of a signal.
    fn freq(x: &[f32], rate: f64) -> f64 {
        let mid = &x[x.len() / 4..x.len() * 3 / 4];
        let crossings = mid.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        crossings as f64 * rate / mid.len() as f64
    }

    #[test]
    fn decimator_keeps_speech_band_and_rejects_alias_band() {
        let mut d = Decimator3::new();
        let mut out = Vec::new();
        d.process(&sine(1000.0, 48_000.0, 48_000, 0.5), &mut out);
        assert_eq!(out.len(), 16_000);
        let steady = &out[1000..];
        assert!(
            (rms(steady) - 0.5 / 2f32.sqrt()).abs() < 0.01,
            "{}",
            rms(steady)
        );
        assert!((freq(steady, 16_000.0) - 1000.0).abs() < 5.0);
        let mut d = Decimator3::new();
        let mut hi = Vec::new();
        d.process(&sine(11_000.0, 48_000.0, 48_000, 0.5), &mut hi);
        // 11 kHz would alias to 5 kHz without the filter.
        assert!(rms(&hi[1000..]) < 0.5 * 0.01, "{}", rms(&hi[1000..]));
    }

    #[test]
    fn decimator_output_does_not_depend_on_chunking() {
        let x = sine(700.0, 48_000.0, 9_600, 0.3);
        let mut whole = Vec::new();
        Decimator3::new().process(&x, &mut whole);
        let mut d = Decimator3::new();
        let mut parts = Vec::new();
        let mut at = 0;
        for size in [1usize, 7, 960, 2, 3, 500].iter().cycle() {
            if at >= x.len() {
                break;
            }
            let end = (at + size).min(x.len());
            d.process(&x[at..end], &mut parts);
            at = end;
        }
        assert_eq!(whole, parts);
    }

    /// [F1.17] one continuous resampler per stream: odd chunk sizes give the same output as one
    /// call with everything.
    #[test]
    fn resampler_output_does_not_depend_on_chunking() {
        let x = sine(1000.0, 44_100.0, 44_100, 0.4);
        let mut a = StreamResampler::new(44_100, 48_000).unwrap();
        let mut whole = Vec::new();
        a.push(&x, &mut whole);
        let mut b = StreamResampler::new(44_100, 48_000).unwrap();
        let mut parts = Vec::new();
        let mut at = 0;
        for size in [441usize, 1, 17, 1024, 3].iter().cycle() {
            if at >= x.len() {
                break;
            }
            let end = (at + size).min(x.len());
            b.push(&x[at..end], &mut parts);
            at = end;
        }
        assert_eq!(whole.len(), parts.len());
        for (p, q) in whole.iter().zip(&parts) {
            assert!((p - q).abs() < 1e-6);
        }
        // 44.1 kHz in, 48 kHz out: the right count (less what is still buffered) and pitch.
        let expected = (x.len() - a.buffered()) as f64 * 48_000.0 / 44_100.0;
        // Within a few frames: the resampler holds back a little input for its filter.
        assert!(
            (whole.len() as f64 - expected).abs() < 8.0,
            "{} vs {expected}",
            whole.len()
        );
        assert!((freq(&whole, 48_000.0) - 1000.0).abs() < 5.0);
    }

    #[test]
    fn a_relative_ratio_nudge_changes_the_output_count_by_that_much() {
        let x = sine(440.0, 48_000.0, 480_000, 0.4);
        let mut nominal = StreamResampler::new(48_000, 48_000).unwrap();
        let mut n_out = Vec::new();
        nominal.push(&x, &mut n_out);
        let mut nudged = StreamResampler::new(48_000, 48_000).unwrap();
        nudged.set_relative(1.001);
        let mut u_out = Vec::new();
        nudged.push(&x, &mut u_out);
        let extra = u_out.len() as f64 - n_out.len() as f64;
        assert!((extra - 480.0).abs() < 10.0, "{extra}");
    }
}
