//! No clipped ends (docs/ux/DICTATION.md DC-N4): the warm mic, the pre-roll ring, the readiness
//! gate and the post-roll.
//!
//! - While the stream is open the last `RING_MS` of the mic are kept. A session's audio starts at
//!   the key-down minus the ring, so the first syllable, spoken as the key goes down, is in it.
//!   While a modifier-only press waits to be confirmed (`HOLD_MS`), the ring keeps everything
//!   from the key-down minus `RING_MS`, so the wait costs nothing.
//! - `dictation.warmMic`: `off` opens the stream at key-down and closes it after the session;
//!   `auto` (the default) opens it at the first key-down and closes it `WARM_HOLD_MS` after the
//!   last session; `always` keeps it open. A Bluetooth mic is never kept warm: it holds the
//!   headset in its low-quality profile.
//! - The readiness gate: when the stream opens at key-down, `Started` waits for the first real
//!   sample, never a timer, so the pill says `listening` only once audio arrives.
//! - Capture runs `POST_ROLL_MS` past the release; a cancel ends at once.
//!
//! Times are nanoseconds on one monotonic timeline (the host clock, or the file under
//! `--from-wav`); audio is 16 kHz mono.

use std::collections::VecDeque;

pub const RING_MS: u64 = 500;
pub const POST_ROLL_MS: u64 = 250;
pub const WARM_HOLD_MS: u64 = 30_000;
/// How long past the post-roll a stream that stopped delivering may hold the session open.
const STALL_GRACE_MS: u64 = 100;
pub const RATE: u64 = 16_000;
const NS_PER_FRAME: u64 = 1_000_000_000 / RATE;
/// `level` 20 times a second.
const LEVEL_FRAMES: usize = (RATE / 20) as usize;
const MS: u64 = 1_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Warm {
    Off,
    Auto,
    Always,
}

impl Warm {
    pub fn parse(s: &str) -> Result<Warm, String> {
        match s {
            "off" => Ok(Warm::Off),
            "auto" => Ok(Warm::Auto),
            "always" => Ok(Warm::Always),
            _ => Err(format!("warm must be off, auto or always, not {s}")),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum MicEvent {
    /// Open (true) or close (false) the device stream.
    Stream(bool),
    /// The session's first sample is at `capture_ns`.
    Started {
        capture_ns: u64,
    },
    Audio {
        capture_ns: u64,
        file_seconds: f64,
        samples: Vec<f32>,
    },
    Level(f64),
    Ended {
        reason: &'static str,
    },
    /// The session ended before any audio arrived: it never started, so nothing is reported.
    Vanished,
}

struct Session {
    down_ns: u64,
    started: bool,
    sent: u64,
    end: Option<(u64, &'static str)>,
    level_sq: f64,
    level_n: usize,
}

pub struct Mic {
    warm: Warm,
    bluetooth: bool,
    ring_ns: u64,
    open: bool,
    /// A sample arrived since the stream opened.
    flowing: bool,
    ring: VecDeque<f32>,
    /// The time just past the last sample in the ring.
    ring_end: u64,
    /// While a press is pending: keep every sample from here.
    hold_from: Option<u64>,
    session: Option<Session>,
    close_at: Option<u64>,
}

impl Mic {
    pub fn new(warm: Warm, bluetooth: bool, ring_ms: u64) -> Mic {
        Mic {
            warm,
            bluetooth,
            ring_ns: ring_ms * MS,
            open: false,
            flowing: false,
            ring: VecDeque::new(),
            ring_end: 0,
            hold_from: None,
            session: None,
            close_at: None,
        }
    }

    /// Whether the device stream should be open now.
    pub fn is_open(&self) -> bool {
        self.open
    }

    fn keeps_warm(&self) -> bool {
        !self.bluetooth
    }

    /// The helper started (or the warm mode changed): `always` opens the stream now.
    pub fn set_warm(&mut self, warm: Warm, t_ns: u64, out: &mut Vec<MicEvent>) {
        self.warm = warm;
        if self.session.is_none() && self.hold_from.is_none() {
            self.idle(t_ns, out);
        }
    }

    /// The device changed transport (a headset connected): a Bluetooth mic stops being warm.
    pub fn set_bluetooth(&mut self, bluetooth: bool, t_ns: u64, out: &mut Vec<MicEvent>) {
        self.bluetooth = bluetooth;
        if self.session.is_none() && self.hold_from.is_none() {
            self.idle(t_ns, out);
        }
    }

    fn open(&mut self, out: &mut Vec<MicEvent>) {
        self.close_at = None;
        if !self.open {
            self.open = true;
            self.flowing = false;
            self.ring.clear();
            out.push(MicEvent::Stream(true));
        }
    }

    fn close(&mut self, out: &mut Vec<MicEvent>) {
        self.close_at = None;
        if self.open {
            self.open = false;
            self.flowing = false;
            self.ring.clear();
            out.push(MicEvent::Stream(false));
        }
    }

    /// What the stream does with no session and no press: the warm policy.
    fn idle(&mut self, t_ns: u64, out: &mut Vec<MicEvent>) {
        match self.warm {
            Warm::Always if self.keeps_warm() => self.open(out),
            Warm::Auto if self.keeps_warm() && self.open => {
                self.close_at = Some(t_ns + WARM_HOLD_MS * MS);
            }
            _ => self.close(out),
        }
    }

    /// The hotkey went down: open a cold stream, and keep the ring from here minus `RING_MS`.
    pub fn arm(&mut self, t_ns: u64, out: &mut Vec<MicEvent>) {
        self.hold_from = Some(t_ns.saturating_sub(self.ring_ns));
        self.open(out);
    }

    /// The press was not a dictation.
    pub fn disarm(&mut self, t_ns: u64, out: &mut Vec<MicEvent>) {
        self.hold_from = None;
        if self.session.is_none() {
            self.idle(t_ns, out);
        }
    }

    /// A session starts, its audio from `down_ns` minus the ring. With samples already flowing it
    /// starts now; otherwise at the first sample (the readiness gate).
    pub fn start(&mut self, down_ns: u64, out: &mut Vec<MicEvent>) {
        self.hold_from = Some(down_ns.saturating_sub(self.ring_ns));
        self.open(out);
        self.session = Some(Session {
            down_ns,
            started: false,
            sent: 0,
            end: None,
            level_sq: 0.0,
            level_n: 0,
        });
        if self.flowing {
            self.begin_session(out);
        }
    }

    fn ring_start(&self) -> u64 {
        self.ring_end - self.ring.len() as u64 * NS_PER_FRAME
    }

    fn begin_session(&mut self, out: &mut Vec<MicEvent>) {
        let Some(s) = self.session.as_mut() else {
            return;
        };
        let ring_start = self.ring_end - self.ring.len() as u64 * NS_PER_FRAME;
        let from = s.down_ns.saturating_sub(self.ring_ns).max(ring_start);
        let skip = ((from - ring_start) / NS_PER_FRAME) as usize;
        let pre: Vec<f32> = self.ring.iter().skip(skip).copied().collect();
        let first = self.ring_end - pre.len() as u64 * NS_PER_FRAME;
        s.started = true;
        self.hold_from = None;
        out.push(MicEvent::Started { capture_ns: first });
        if !pre.is_empty() {
            self.send(first, pre, false, out);
        }
    }

    fn send(&mut self, t_ns: u64, samples: Vec<f32>, live: bool, out: &mut Vec<MicEvent>) {
        let Some(s) = self.session.as_mut() else {
            return;
        };
        if live {
            for &x in &samples {
                s.level_sq += f64::from(x) * f64::from(x);
                s.level_n += 1;
                if s.level_n == LEVEL_FRAMES {
                    out.push(MicEvent::Level((s.level_sq / LEVEL_FRAMES as f64).sqrt()));
                    s.level_sq = 0.0;
                    s.level_n = 0;
                }
            }
        }
        let file_seconds = s.sent as f64 / RATE as f64;
        s.sent += samples.len() as u64;
        out.push(MicEvent::Audio {
            capture_ns: t_ns,
            file_seconds,
            samples,
        });
    }

    /// The session ends at `t_ns`. A cancel or a stop ends at once; anything else after the
    /// post-roll.
    pub fn end(&mut self, t_ns: u64, reason: &'static str, out: &mut Vec<MicEvent>) {
        let Some(s) = self.session.as_mut() else {
            return;
        };
        if !s.started {
            self.session = None;
            out.push(MicEvent::Vanished);
            self.idle(t_ns, out);
            return;
        }
        if reason == "cancel" || reason == "stop" {
            self.finish(t_ns, reason, out);
        } else {
            s.end = Some((t_ns + POST_ROLL_MS * MS, reason));
        }
    }

    fn finish(&mut self, t_ns: u64, reason: &'static str, out: &mut Vec<MicEvent>) {
        self.session = None;
        out.push(MicEvent::Ended { reason });
        if self.hold_from.is_none() {
            self.idle(t_ns, out);
        }
    }

    /// Samples from the device, the first at `t_ns`.
    pub fn push(&mut self, t_ns: u64, samples: &[f32], out: &mut Vec<MicEvent>) {
        if !self.open || samples.is_empty() {
            return;
        }
        if !self.ring.is_empty() && t_ns.abs_diff(self.ring_end) > MS {
            // The stream skipped; what the ring held is no longer just before this.
            self.ring.clear();
        }
        self.flowing = true;
        self.ring.extend(samples.iter().copied());
        self.ring_end = t_ns + samples.len() as u64 * NS_PER_FRAME;
        let keep_from = self
            .hold_from
            .unwrap_or(self.ring_end.saturating_sub(self.ring_ns))
            .min(self.ring_end.saturating_sub(self.ring_ns));
        let drop = (keep_from.saturating_sub(self.ring_start()) / NS_PER_FRAME) as usize;
        self.ring.drain(..drop.min(self.ring.len()));

        let Some(s) = self.session.as_ref() else {
            return;
        };
        if !s.started {
            self.begin_session(out);
            return;
        }
        let end = s.end;
        let take = match end {
            Some((at, _)) => {
                (at.saturating_sub(t_ns) / NS_PER_FRAME).min(samples.len() as u64) as usize
            }
            None => samples.len(),
        };
        if take > 0 {
            self.send(t_ns, samples[..take].to_vec(), true, out);
        }
        if let Some((at, reason)) = end
            && self.ring_end >= at
        {
            self.finish(at, reason, out);
        }
    }

    /// Time passes with or without samples: a stalled stream still ends its session, and an
    /// `auto` stream closes `WARM_HOLD_MS` after the last session.
    pub fn tick(&mut self, t_ns: u64, out: &mut Vec<MicEvent>) {
        if let Some(Session {
            end: Some((at, reason)),
            ..
        }) = self.session
            && t_ns >= at + STALL_GRACE_MS * MS
        {
            self.finish(t_ns, reason, out);
        }
        if self.close_at.is_some_and(|c| t_ns >= c)
            && self.session.is_none()
            && self.hold_from.is_none()
        {
            self.close(out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake mic world: a tone ("the word") between two times on a silent timeline, delivered in
    /// 10 ms chunks whenever the stream is open, from `delay_ms` after it opened (a slow device).
    struct World {
        mic: Mic,
        word: (u64, u64),
        delay_ms: u64,
        opened_at: Option<u64>,
        events: Vec<(u64, MicEvent)>,
    }

    const WORD_AMP: f32 = 0.5;

    impl World {
        fn new(warm: Warm, bluetooth: bool, ring_ms: u64, word: (u64, u64)) -> World {
            let mut w = World {
                mic: Mic::new(warm, bluetooth, ring_ms),
                word,
                delay_ms: 0,
                opened_at: None,
                events: Vec::new(),
            };
            w.act(0, |m, out| m.set_warm(warm, 0, out));
            w
        }

        fn act(&mut self, ms: u64, f: impl FnOnce(&mut Mic, &mut Vec<MicEvent>)) {
            let mut out = Vec::new();
            f(&mut self.mic, &mut out);
            self.record(ms, out);
        }

        fn record(&mut self, ms: u64, out: Vec<MicEvent>) {
            for e in out {
                match e {
                    MicEvent::Stream(true) => self.opened_at = Some(ms),
                    MicEvent::Stream(false) => self.opened_at = None,
                    _ => {}
                }
                self.events.push((ms, e));
            }
        }

        /// Runs the world from `from` to `to` ms (exclusive).
        fn run(&mut self, from: u64, to: u64) {
            for ms in (from..to).step_by(10) {
                if self.opened_at.is_some_and(|o| ms >= o + self.delay_ms) {
                    let chunk: Vec<f32> = (0..160)
                        .map(|i| {
                            let t = ms * MS + i * NS_PER_FRAME;
                            if t >= self.word.0 * MS && t < self.word.1 * MS {
                                WORD_AMP
                            } else {
                                0.0
                            }
                        })
                        .collect();
                    let mut out = Vec::new();
                    self.mic.push(ms * MS, &chunk, &mut out);
                    self.record(ms, out);
                }
                let mut out = Vec::new();
                self.mic.tick(ms * MS, &mut out);
                self.record(ms, out);
            }
        }

        /// The session's audio as (capture_ns of each sample, value).
        fn audio(&self) -> Vec<(u64, f32)> {
            self.events
                .iter()
                .filter_map(|(_, e)| match e {
                    MicEvent::Audio {
                        capture_ns,
                        samples,
                        ..
                    } => Some(
                        samples
                            .iter()
                            .enumerate()
                            .map(|(i, &x)| (capture_ns + i as u64 * NS_PER_FRAME, x))
                            .collect::<Vec<_>>(),
                    ),
                    _ => None,
                })
                .flatten()
                .collect()
        }

        fn word_frames(&self) -> usize {
            self.audio().iter().filter(|(_, x)| *x == WORD_AMP).count()
        }

        fn when(&self, pick: fn(&MicEvent) -> bool) -> Vec<u64> {
            self.events
                .iter()
                .filter(|(_, e)| pick(e))
                .map(|(ms, _)| *ms)
                .collect()
        }
    }

    const WORD_FRAMES: usize = 300 * 16;

    /// DC-N4: with `always`, a word at 0 ms and the key down at 400 ms is in the session's audio;
    /// with the ring off the same session loses it (the positive control).
    #[test]
    fn dc_n4_the_ring_keeps_the_first_syllable() {
        let press = |ring_ms| {
            let mut w = World::new(Warm::Always, false, ring_ms, (0, 300));
            w.run(0, 400);
            w.act(400, |m, out| m.start(400 * MS, out));
            w.run(400, 1200);
            w.act(1200, |m, out| m.end(1200 * MS, "release", out));
            w.run(1200, 1600);
            w
        };
        let w = press(RING_MS);
        assert_eq!(
            w.word_frames(),
            WORD_FRAMES,
            "the whole word is in the session"
        );
        assert_eq!(
            w.audio()[0].0,
            0,
            "the audio starts at the key-down minus the ring"
        );
        assert_eq!(w.when(|e| matches!(e, MicEvent::Started { .. })), vec![400]);
        let control = press(0);
        assert_eq!(
            control.word_frames(),
            0,
            "without the ring the word is lost"
        );
    }

    /// DC-N4: a modifier press confirmed 300 ms after its key-down still starts the audio at the
    /// key-down minus the ring, because the ring holds from the arm.
    #[test]
    fn dc_n4_the_confirmation_wait_of_a_modifier_press_costs_no_audio() {
        let mut w = World::new(Warm::Always, false, RING_MS, (100, 400));
        w.run(0, 500);
        w.act(500, |m, out| m.arm(500 * MS, out));
        w.run(500, 800);
        w.act(800, |m, out| m.start(500 * MS, out));
        w.run(800, 1000);
        w.act(1000, |m, out| m.end(1000 * MS, "release", out));
        w.run(1000, 1400);
        assert_eq!(w.audio()[0].0, 0, "from 500 ms minus the 500 ms ring");
        assert_eq!(w.word_frames(), WORD_FRAMES);
    }

    /// DC-N4 with `auto`: the first key-down opens the stream; a session 10 s after the first
    /// finds it open; one 40 s after finds it closed and opens it again.
    #[test]
    fn dc_n4_auto_keeps_the_stream_warm_for_30_s_after_a_session() {
        let mut w = World::new(Warm::Auto, false, RING_MS, (0, 0));
        assert!(w.events.is_empty(), "auto does not open at start");
        let session = |w: &mut World, at: u64| {
            w.act(at, |m, out| m.start(at * MS, out));
            w.run(at, at + 500);
            w.act(at + 500, |m, out| m.end((at + 500) * MS, "release", out));
            w.run(at + 500, at + 1000);
        };
        session(&mut w, 1000);
        w.run(2000, 12_000);
        session(&mut w, 12_000);
        w.run(13_000, 53_000);
        session(&mut w, 53_000);
        let opens = w.when(|e| *e == MicEvent::Stream(true));
        let closes = w.when(|e| *e == MicEvent::Stream(false));
        assert_eq!(opens, vec![1000, 53_000]);
        assert_eq!(closes, vec![12_750 + 30_000]);
        let started = w.when(|e| matches!(e, MicEvent::Started { .. }));
        assert_eq!(started, vec![1000, 12_000, 53_000]);
    }

    /// DC-N4 with `off` and a device that takes 300 ms to deliver: `Started` waits for the first
    /// sample (the readiness gate), and the word spoken after it is in the session.
    #[test]
    fn dc_n4_the_readiness_gate_waits_for_the_first_sample() {
        let mut w = World::new(Warm::Off, false, RING_MS, (750, 1000));
        w.delay_ms = 300;
        w.run(0, 400);
        w.act(400, |m, out| m.start(400 * MS, out));
        w.run(400, 1200);
        w.act(1200, |m, out| m.end(1200 * MS, "release", out));
        w.run(1200, 1600);
        assert_eq!(w.when(|e| *e == MicEvent::Stream(true)), vec![400]);
        let started: Vec<_> = w
            .events
            .iter()
            .filter_map(|(ms, e)| match e {
                MicEvent::Started { capture_ns } => Some((*ms, *capture_ns)),
                _ => None,
            })
            .collect();
        assert_eq!(started, vec![(700, 700 * MS)]);
        assert_eq!(w.word_frames(), 250 * 16);
        assert_eq!(
            w.when(|e| *e == MicEvent::Stream(false)),
            vec![1440],
            "off closes after the post-roll"
        );
    }

    /// DC-N4: capture runs 250 ms past the release, so a word ending 100 ms after it is whole;
    /// `session.ended` comes at the end of the post-roll. A cancel ends at once.
    #[test]
    fn dc_n4_the_post_roll_keeps_the_last_syllable() {
        let mut w = World::new(Warm::Always, false, RING_MS, (900, 1100));
        w.run(0, 500);
        w.act(500, |m, out| m.start(500 * MS, out));
        w.run(500, 1000);
        w.act(1000, |m, out| m.end(1000 * MS, "release", out));
        w.run(1000, 1500);
        assert_eq!(w.word_frames(), 200 * 16);
        assert_eq!(
            w.when(|e| matches!(e, MicEvent::Ended { reason: "release" })),
            vec![1240]
        );
        let last = w.audio().last().unwrap().0;
        assert_eq!(
            last + NS_PER_FRAME,
            1250 * MS,
            "audio ends at the post-roll"
        );

        let mut c = World::new(Warm::Always, false, RING_MS, (0, 0));
        c.run(0, 500);
        c.act(500, |m, out| m.start(500 * MS, out));
        c.run(500, 800);
        c.act(800, |m, out| m.end(800 * MS, "cancel", out));
        assert_eq!(
            c.when(|e| matches!(e, MicEvent::Ended { reason: "cancel" })),
            vec![800]
        );
    }

    /// DC-N4: a Bluetooth mic is never kept warm, under `always` or `auto`.
    #[test]
    fn dc_n4_a_bluetooth_mic_is_never_kept_warm() {
        let w = World::new(Warm::Always, true, RING_MS, (0, 0));
        assert!(
            w.events.is_empty(),
            "always does not open a Bluetooth mic at start"
        );
        let mut w = World::new(Warm::Auto, true, RING_MS, (0, 0));
        w.act(100, |m, out| m.start(100 * MS, out));
        w.run(100, 600);
        w.act(600, |m, out| m.end(600 * MS, "release", out));
        w.run(600, 1000);
        assert_eq!(w.when(|e| *e == MicEvent::Stream(false)), vec![840]);
        // Positive control: the same session on a built-in mic stays open.
        let mut b = World::new(Warm::Auto, false, RING_MS, (0, 0));
        b.act(100, |m, out| m.start(100 * MS, out));
        b.run(100, 600);
        b.act(600, |m, out| m.end(600 * MS, "release", out));
        b.run(600, 1000);
        assert!(b.when(|e| *e == MicEvent::Stream(false)).is_empty());
    }

    #[test]
    fn levels_come_20_times_a_second_and_a_session_with_no_audio_vanishes() {
        let mut w = World::new(Warm::Always, false, RING_MS, (0, 10_000));
        w.run(0, 100);
        w.act(100, |m, out| m.start(100 * MS, out));
        w.run(100, 1100);
        let levels: Vec<f64> = w
            .events
            .iter()
            .filter_map(|(_, e)| match e {
                MicEvent::Level(r) => Some(*r),
                _ => None,
            })
            .collect();
        assert_eq!(levels.len(), 20);
        assert!(
            levels
                .iter()
                .all(|r| (*r - f64::from(WORD_AMP)).abs() < 1e-6)
        );

        let mut v = World::new(Warm::Off, false, RING_MS, (0, 0));
        v.delay_ms = 1000;
        v.act(0, |m, out| m.start(0, out));
        v.run(0, 200);
        v.act(200, |m, out| m.end(200 * MS, "release", out));
        assert!(v.events.iter().any(|(_, e)| *e == MicEvent::Vanished));
        assert!(
            !v.events
                .iter()
                .any(|(_, e)| matches!(e, MicEvent::Started { .. }))
        );
    }
}
