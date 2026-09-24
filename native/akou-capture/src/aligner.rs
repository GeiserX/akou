//! The aligner (DESIGN 2.1): two independent host-timestamped streams onto one 48 kHz stereo
//! timeline.
//!
//! - The timeline is driven by the awake host clock: frame 0 is the anchor (`capturing`), and
//!   time spent paused is cut out of it.
//! - Each source is placed by its own timestamps through one continuous resampler, so the mic
//!   never waits for the call side and the call side never clocks the mic (TRAPS T0.16).
//! - Every 20 ms slot is emitted when the host clock passes it (plus a small latency for the
//!   device buffers to arrive). A source that delivered nothing for the slot is zeros, flagged.
//! - Each source holds at most `CAP` frames ahead of the emit cursor; anything later than the
//!   cursor or further ahead than that is dropped and counted. Memory is fixed whatever a source
//!   does (TRAPS T0.15).
//! - Clock skew between a device and the host clock is measured from the timestamps and followed
//!   by nudging that source's resampler ratio by at most 0.1 %. A placement error beyond 50 ms is
//!   a discontinuity (a gap, a restarted device) and re-anchors the source instead.
//! - A source is placed right from its first audio. A rebuilt source is a new stream, so the
//!   engine restarts it and its next buffer anchors it by its own timestamp. And in the first
//!   second after any anchor, a step beyond 5 ms re-anchors once instead of being slewed away at
//!   0.1 % (a 33 ms step took about 40 s): a buffer of the old stream still queued after a
//!   restart, or a first buffer stamped by a late arrival. Past that second a step is skew or
//!   jitter, and is slewed as before.

use crate::protocol::Ch;
use crate::resample::StreamResampler;

pub const RATE: u32 = 48_000;
/// One Opus packet and one packet per channel: 20 ms.
pub const SLOT: usize = 960;
/// Frames each source may hold ahead of the emit cursor: 2 s.
pub const CAP: usize = RATE as usize * 2;
/// A placement error beyond this re-anchors the source: 50 ms.
pub const RESYNC_FRAMES: f64 = 2_400.0;
/// Largest ratio nudge for clock skew.
pub const MAX_NUDGE: f64 = 0.001;
/// After an anchor, a placement step beyond `STEP_FRAMES` within this many frames re-anchors
/// the source once: 1 s.
pub const SETTLE_FRAMES: f64 = RATE as f64;
/// A step this large (5 ms) is not clock skew: skew moves a source 1 ms a second at most.
pub const STEP_FRAMES: f64 = 240.0;
/// The skew controller removes a placement error over about this many seconds.
const CORRECT_OVER_S: f64 = 10.0;
const ERR_SMOOTHING: f64 = 0.05;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrackStats {
    /// Frames that arrived after their slot was emitted: a source slower than the emit latency.
    pub late: u64,
    /// Frames from before the timeline (captured before `capturing` or while paused): expected
    /// from a device opened early, and dropped without counting as late.
    pub before: u64,
    /// Frames beyond the cap ahead of the cursor.
    pub ahead: u64,
    /// Times the source was re-anchored after a discontinuity.
    pub resyncs: u64,
    /// Chunks received.
    pub chunks: u64,
}

struct Track {
    resampler: Option<StreamResampler>,
    ring: Vec<f32>,
    filled: Vec<bool>,
    /// The frame came from a buffer the edge found audible (any channel non-zero).
    loud: Vec<bool>,
    /// The edge verdict of the last buffer, for the resampler's tail at a flush.
    last_heard: bool,
    /// Timeline frame of the next resampled sample.
    next: i64,
    synced: bool,
    /// Resampler startup outputs still to drop after a re-anchor.
    skip: usize,
    /// Expected timeline position of the next input sample, from what was pushed.
    nominal: f64,
    /// Timeline frame up to which a step still re-anchors; `NEG_INFINITY` once it has.
    settle_until: f64,
    err: f64,
    rel: f64,
    scratch: Vec<f32>,
    stats: TrackStats,
}

impl Track {
    fn new() -> Self {
        Track {
            resampler: None,
            ring: vec![0.0; CAP],
            filled: vec![false; CAP],
            loud: vec![false; CAP],
            last_heard: false,
            next: 0,
            synced: false,
            skip: 0,
            nominal: 0.0,
            settle_until: f64::NEG_INFINITY,
            err: 0.0,
            rel: 1.0,
            scratch: Vec::new(),
            stats: TrackStats::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SlotCh {
    pub samples: Vec<f32>,
    /// The source delivered at least one frame for this slot.
    pub delivered: bool,
    /// Part of the slot came from a buffer with a non-zero sample on some device channel. Taken
    /// at the edge, before the channels were averaged, so opposite channels cannot cancel out.
    pub heard: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Slot {
    /// Timeline frame of the first sample.
    pub frame: i64,
    /// Awake-clock time of the first sample.
    pub awake_ns: u64,
    /// `[mic, call]`.
    pub ch: [SlotCh; 2],
}

impl Slot {
    pub fn len(&self) -> usize {
        self.ch[0].samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn file_seconds(&self) -> f64 {
        self.frame as f64 / RATE as f64
    }
}

pub struct Aligner {
    anchor_ns: u64,
    paused_ns: u64,
    paused_at: Option<u64>,
    /// First frame of the next slot to emit.
    emitted: i64,
    /// Frames placed before this (before the anchor, or captured while paused) are not audio of
    /// the timeline.
    start: i64,
    tracks: [Track; 2],
}

impl Aligner {
    /// A timeline whose frame 0 is `anchor_awake_ns`.
    pub fn new(anchor_awake_ns: u64) -> Self {
        Aligner {
            anchor_ns: anchor_awake_ns,
            paused_ns: 0,
            paused_at: None,
            emitted: 0,
            start: 0,
            tracks: [Track::new(), Track::new()],
        }
    }

    /// Frames written to the timeline so far.
    pub fn frames(&self) -> i64 {
        self.emitted
    }

    pub fn file_seconds(&self) -> f64 {
        self.emitted as f64 / RATE as f64
    }

    pub fn paused(&self) -> bool {
        self.paused_at.is_some()
    }

    pub fn stats(&self, ch: Ch) -> &TrackStats {
        &self.tracks[ch.index()].stats
    }

    /// The current skew correction of a source (1.0 = none).
    pub fn ratio(&self, ch: Ch) -> f64 {
        self.tracks[ch.index()].rel
    }

    fn frame_f(&self, awake_ns: u64) -> f64 {
        let d = awake_ns as i128 - self.anchor_ns as i128 - self.paused_ns as i128;
        (d * RATE as i128) as f64 / 1e9
    }

    /// Awake-clock time of a timeline frame.
    pub fn awake_of(&self, frame: i64) -> u64 {
        let ns = frame as i128 * 1_000_000_000 / RATE as i128;
        (self.anchor_ns as i128 + self.paused_ns as i128 + ns).max(0) as u64
    }

    /// One buffer from a source: mono float at `rate`, first sample at `awake_ns`; `heard` is the
    /// edge's verdict on it. Dropped while paused (the app asked the helper to drop audio).
    pub fn push(&mut self, ch: Ch, awake_ns: u64, rate: u32, samples: &[f32], heard: bool) {
        if self.paused_at.is_some() || samples.is_empty() {
            return;
        }
        let expected = self.frame_f(awake_ns);
        let emitted = self.emitted;
        let start = self.start;
        let t = &mut self.tracks[ch.index()];
        t.stats.chunks += 1;
        if t.resampler.as_ref().map(|r| r.in_rate()) != Some(rate) {
            match StreamResampler::new(rate, RATE) {
                Ok(r) => t.resampler = Some(r),
                Err(_) => {
                    t.resampler = None;
                    return;
                }
            }
            t.synced = false;
        }
        let Some(rs) = t.resampler.as_mut() else {
            return;
        };
        let step = (expected - t.nominal).abs();
        // An anchoring push always opens a fresh window: a restart inside the old one must not
        // use it up.
        let settling = t.synced && expected < t.settle_until && step > STEP_FRAMES;
        if !t.synced || step > RESYNC_FRAMES || settling {
            if t.synced {
                t.stats.resyncs += 1;
            }
            rs.reset();
            t.next = expected.round() as i64;
            t.skip = rs.delay();
            t.nominal = expected;
            t.err = 0.0;
            t.rel = 1.0;
            t.synced = true;
            // One settling re-anchor per anchor, so jitter cannot keep re-anchoring.
            t.settle_until = if settling {
                f64::NEG_INFINITY
            } else {
                expected + SETTLE_FRAMES
            };
        } else {
            let e = expected - t.nominal;
            t.err = t.err * (1.0 - ERR_SMOOTHING) + e * ERR_SMOOTHING;
            t.rel = 1.0 + (t.err / (CORRECT_OVER_S * RATE as f64)).clamp(-MAX_NUDGE, MAX_NUDGE);
            rs.set_relative(t.rel);
        }
        t.nominal += samples.len() as f64 * RATE as f64 / rate as f64 * t.rel;
        t.last_heard = heard;
        t.scratch.clear();
        rs.push(samples, &mut t.scratch);
        for i in 0..t.scratch.len() {
            if t.skip > 0 {
                t.skip -= 1;
                continue;
            }
            let frame = t.next;
            t.next += 1;
            if frame < start {
                t.stats.before += 1;
            } else if frame < emitted {
                t.stats.late += 1;
            } else if frame >= emitted + CAP as i64 {
                t.stats.ahead += 1;
            } else {
                let at = frame.rem_euclid(CAP as i64) as usize;
                t.ring[at] = t.scratch[i];
                t.filled[at] = true;
                t.loud[at] = heard;
            }
        }
    }

    /// The next full slot, once the host clock minus `latency_ns` has passed its end.
    pub fn pop_due(&mut self, now_awake_ns: u64, latency_ns: u64) -> Option<Slot> {
        if self.paused_at.is_some() {
            return None;
        }
        let due = self
            .frame_f(now_awake_ns.saturating_sub(latency_ns))
            .floor() as i64;
        if self.emitted + SLOT as i64 <= due {
            Some(self.take(SLOT))
        } else {
            None
        }
    }

    /// At stop: every slot up to `now_awake_ns`, the last one short. A short slot's length is a
    /// multiple of 3, so it maps to whole 16 kHz samples.
    pub fn flush(&mut self, now_awake_ns: u64) -> Vec<Slot> {
        let mut out = Vec::new();
        if self.paused_at.is_some() {
            return out;
        }
        self.drain_resamplers();
        while let Some(s) = self.pop_due(now_awake_ns, 0) {
            out.push(s);
        }
        let due = self.frame_f(now_awake_ns).floor() as i64;
        let rest = ((due - self.emitted).max(0) as usize).min(SLOT - 1) / 3 * 3;
        if rest > 0 {
            out.push(self.take(rest));
        }
        out
    }

    /// Pushes the audio still inside each resampler (its filter lookahead and partial chunk)
    /// onto the timeline, by feeding it silence. What the silence itself produces lands after
    /// the last real frame and is never emitted as audio: `flush` stops at the host clock.
    fn drain_resamplers(&mut self) {
        let emitted = self.emitted;
        let first = emitted.max(self.start);
        for t in &mut self.tracks {
            let Some(rs) = t.resampler.as_mut() else {
                continue;
            };
            if !t.synced {
                continue;
            }
            let rate = rs.in_rate() as usize;
            let n = rs.buffered() + 512 + (rs.delay() * rate).div_ceil(RATE as usize);
            // `nominal` is where the next real input sample would land: the end of real audio.
            let end = t.nominal.round() as i64;
            t.scratch.clear();
            rs.push(&vec![0.0; n], &mut t.scratch);
            for i in 0..t.scratch.len() {
                if t.skip > 0 {
                    t.skip -= 1;
                    continue;
                }
                let frame = t.next;
                t.next += 1;
                if frame >= end {
                    break;
                }
                if frame >= first && frame < emitted + CAP as i64 {
                    let at = frame.rem_euclid(CAP as i64) as usize;
                    t.ring[at] = t.scratch[i];
                    t.loud[at] = t.last_heard;
                    t.filled[at] = true;
                }
            }
            t.synced = false;
        }
    }

    fn take(&mut self, len: usize) -> Slot {
        let frame = self.emitted;
        let awake_ns = self.awake_of(frame);
        let mut chans = [
            SlotCh {
                samples: vec![0.0; len],
                delivered: false,
                heard: false,
            },
            SlotCh {
                samples: vec![0.0; len],
                delivered: false,
                heard: false,
            },
        ];
        for (t, c) in self.tracks.iter_mut().zip(chans.iter_mut()) {
            for j in 0..len {
                let at = (frame + j as i64).rem_euclid(CAP as i64) as usize;
                if t.filled[at] {
                    let v = t.ring[at];
                    c.samples[j] = v;
                    c.delivered = true;
                    c.heard |= t.loud[at];
                    t.filled[at] = false;
                    t.loud[at] = false;
                    t.ring[at] = 0.0;
                }
            }
        }
        self.emitted += len as i64;
        Slot {
            frame,
            awake_ns,
            ch: chans,
        }
    }

    /// The source was rebuilt: its next buffer comes from a new stream on its own clock, and
    /// anchors it by its own timestamp.
    pub fn restart(&mut self, ch: Ch) {
        self.tracks[ch.index()].synced = false;
    }

    /// Stops the timeline at `now`; nothing is pushed or emitted until `resume`.
    pub fn pause(&mut self, now_awake_ns: u64) {
        if self.paused_at.is_none() {
            self.paused_at = Some(now_awake_ns);
        }
    }

    /// Continues the timeline where it stopped: the paused time is cut out.
    pub fn resume(&mut self, now_awake_ns: u64) {
        if let Some(at) = self.paused_at.take() {
            self.paused_ns += now_awake_ns.saturating_sub(at);
            self.start = self.frame_f(now_awake_ns).floor() as i64;
            for t in &mut self.tracks {
                t.synced = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;
    const T0: u64 = 50_000 * MS;
    /// Emission latency the tests use: covers the resampler's lookahead and partial chunk.
    const LAT: u64 = 20 * MS;

    /// Pushes 10 ms buffers of a constant per source, then emits what is due.
    struct Feed {
        al: Aligner,
        now: u64,
        slots: Vec<Slot>,
    }

    impl Feed {
        fn new() -> Self {
            Feed {
                al: Aligner::new(T0),
                now: T0,
                slots: Vec::new(),
            }
        }

        fn step(&mut self, mic: Option<(u32, f32)>, call: Option<(u32, f32)>) {
            for (ch, src) in [(Ch::Mic, mic), (Ch::Call, call)] {
                if let Some((rate, v)) = src {
                    let n = rate as usize / 100;
                    self.al.push(ch, self.now, rate, &vec![v; n], v != 0.0);
                }
            }
            self.now += 10 * MS;
            while let Some(s) = self.al.pop_due(self.now, LAT) {
                self.slots.push(s);
            }
        }

        fn delivered(&self, ch: Ch) -> usize {
            self.slots
                .iter()
                .filter(|s| s.ch[ch.index()].delivered)
                .map(|s| s.len())
                .sum()
        }
    }

    #[test]
    fn both_sources_at_48k_come_out_frame_aligned_and_flagged_delivered() {
        let mut f = Feed::new();
        for _ in 0..100 {
            f.step(Some((48_000, 0.5)), Some((48_000, -0.25)));
        }
        // 1 s pushed, 20 ms held back for the resampler: 49 slots.
        assert_eq!(f.slots.len(), 49);
        assert_eq!(f.slots[0].frame, 0);
        assert_eq!(f.slots[0].awake_ns, T0);
        assert_eq!(f.slots[1].awake_ns, T0 + 20 * MS);
        for s in &f.slots {
            assert!(s.ch[0].delivered && s.ch[1].delivered);
        }
        // Past the resampler's step response, the level is exact.
        for s in &f.slots[1..] {
            assert!(s.ch[0].samples.iter().all(|v| (v - 0.5).abs() < 0.01));
            assert!(s.ch[1].samples.iter().all(|v| (v + 0.25).abs() < 0.01));
        }
    }

    /// [T0.16] A tap silent from the start never blocks the mic: the mic is delivered from the
    /// first slot, and the call side is zeros flagged as not delivered.
    #[test]
    fn t0_16_silent_from_start_call_side_never_holds_the_mic_back() {
        let mut f = Feed::new();
        for _ in 0..100 {
            f.step(Some((48_000, 0.5)), None);
        }
        assert_eq!(f.slots.len(), 49);
        assert!(f.slots[0].ch[0].delivered);
        for s in &f.slots {
            assert!(!s.ch[1].delivered);
            assert!(s.ch[1].samples.iter().all(|v| *v == 0.0));
        }
    }

    /// [T0.15] One source delivers nothing for ten minutes while the other keeps going: the
    /// timeline keeps both channels at the same length, the silent side is zeros, and memory
    /// does not grow.
    #[test]
    fn t0_15_ten_minutes_of_one_silent_source_stays_aligned_and_bounded() {
        let mut f = Feed::new();
        let steps = 10 * 60 * 100;
        let (mut mic, mut call) = (0usize, 0usize);
        for i in 0..steps {
            // The call side delivers only in the first and the last second.
            let on = i < 100 || i >= steps - 100;
            f.step(Some((48_000, 0.5)), on.then_some((44_100, 0.3)));
            // Slots are consumed as they are made; nothing piles up anywhere else.
            mic += f.delivered(Ch::Mic);
            call += f.delivered(Ch::Call);
            f.slots.clear();
        }
        // 600 s less the 20 ms held back.
        assert_eq!(f.al.frames(), 28_799_040);
        assert_eq!(mic, 28_799_040);
        // About 2 s of call audio, in whole slots at the edges.
        assert!((call as i64 - 96_000).abs() <= 3 * SLOT as i64, "{call}");
        for t in &f.al.tracks {
            assert_eq!(t.ring.len(), CAP);
            assert_eq!(t.ring.capacity(), CAP);
        }
        assert_eq!(f.al.stats(Ch::Call).ahead, 0);
        assert_eq!(f.al.stats(Ch::Call).resyncs, 1);
    }

    #[test]
    fn positive_control_a_source_far_in_the_future_is_capped_not_buffered() {
        let mut al = Aligner::new(T0);
        // One minute ahead of the cursor: beyond the cap, dropped and counted.
        al.push(Ch::Call, T0 + 60_000 * MS, 48_000, &vec![0.1; 48_000], true);
        assert!(al.stats(Ch::Call).ahead > 0);
        let mut al = Aligner::new(T0);
        al.push(Ch::Call, T0 + 500 * MS, 48_000, &vec![0.1; 4_800], true);
        assert_eq!(al.stats(Ch::Call).ahead, 0);
    }

    /// The capture spike's placement test: the call side misses 1.5 s; the gap is zeros in the
    /// right place and the audio after it is re-anchored, not shifted.
    #[test]
    fn a_gap_in_one_source_is_zeros_in_the_right_place() {
        let mut f = Feed::new();
        for i in 0..400 {
            let call = !(100..250).contains(&i);
            f.step(Some((48_000, 0.5)), call.then_some((48_000, 0.25)));
        }
        let gap: Vec<&Slot> = f.slots.iter().filter(|s| !s.ch[1].delivered).collect();
        let first = gap.first().unwrap().frame;
        let last = gap.last().unwrap().frame + SLOT as i64;
        assert!((first - 48_000).abs() <= SLOT as i64, "{first}");
        assert!((last - 120_000).abs() <= SLOT as i64, "{last}");
        assert_eq!(gap.len(), (last - first) as usize / SLOT);
        assert_eq!(f.al.stats(Ch::Call).resyncs, 1);
        // After the gap the level is right again from the second slot on.
        let after = f
            .slots
            .iter()
            .find(|s| s.frame >= last + SLOT as i64)
            .unwrap();
        assert!(after.ch[1].samples.iter().all(|v| (v - 0.25).abs() < 0.01));
    }

    #[test]
    fn a_source_at_another_rate_is_resampled_onto_the_timeline() {
        let mut f = Feed::new();
        for _ in 0..200 {
            f.step(Some((44_100, 0.5)), Some((16_000, 0.5)));
        }
        for s in &f.slots[2..] {
            for c in &s.ch {
                assert!(c.delivered);
                assert!(
                    c.samples.iter().all(|v| (v - 0.5).abs() < 0.02),
                    "{:?}",
                    &c.samples[..4]
                );
            }
        }
    }

    /// Clock skew: a device that runs 0.05 % fast against the host clock is followed by the
    /// ratio nudge, within the 0.1 % bound, without re-anchoring.
    #[test]
    fn skew_is_followed_by_a_bounded_ratio_nudge() {
        let mut al = Aligner::new(T0);
        let real_rate = 48_024.0; // the device's true rate against the host clock
        let mut sent = 0u64;
        let mut now = T0;
        for _ in 0..(120 * 100) {
            let n = 480;
            let at = T0 + (sent as f64 / real_rate * 1e9) as u64;
            al.push(Ch::Mic, at, 48_000, &vec![0.2; n], true);
            sent += n as u64;
            now += 10 * MS;
            while al.pop_due(now, LAT).is_some() {}
        }
        let r = al.ratio(Ch::Mic);
        assert!(r < 1.0 && r > 1.0 - MAX_NUDGE, "{r}");
        assert!((r - 48_000.0 / real_rate).abs() < 1e-4, "{r}");
        assert_eq!(al.stats(Ch::Mic).resyncs, 0);
    }

    #[test]
    fn positive_control_skew_beyond_the_bound_is_clamped() {
        let mut al = Aligner::new(T0);
        let real_rate = 48_480.0; // 1 % fast: more than the nudge may correct
        let mut sent = 0u64;
        for _ in 0..(60 * 100) {
            let at = T0 + (sent as f64 / real_rate * 1e9) as u64;
            al.push(Ch::Mic, at, 48_000, &vec![0.2; 480], true);
            sent += 480;
        }
        assert!((al.ratio(Ch::Mic) - (1.0 - MAX_NUDGE)).abs() < 1e-9);
        // It cannot keep up, so it re-anchors instead of drifting without bound.
        assert!(al.stats(Ch::Mic).resyncs > 0);
    }

    #[test]
    fn pause_cuts_the_paused_time_out_of_the_timeline() {
        let mut f = Feed::new();
        for _ in 0..50 {
            f.step(Some((48_000, 0.5)), Some((48_000, 0.5)));
        }
        let before = f.al.frames();
        assert_eq!(before, 23_040);
        f.al.pause(f.now);
        for _ in 0..300 {
            f.step(Some((48_000, 0.5)), Some((48_000, 0.5)));
        }
        assert_eq!(f.al.frames(), before, "nothing is written while paused");
        f.al.resume(f.now);
        for _ in 0..50 {
            f.step(Some((48_000, 0.5)), Some((48_000, 0.5)));
        }
        // The file continues from where it paused: one second of audio in all, not four.
        assert_eq!(f.al.frames(), 47_040);
        let s = f.slots.iter().find(|s| s.frame == 24_000).unwrap();
        assert_eq!(s.awake_ns, T0 + 3_500 * MS);
    }

    #[test]
    fn flush_emits_everything_pushed_with_the_last_slot_short() {
        let mut al = Aligner::new(T0);
        al.push(Ch::Mic, T0, 48_000, &vec![0.5; 1_000], true);
        let slots = al.flush(T0 + 1_000 * 1_000_000_000 / 48_000);
        let lens: Vec<usize> = slots.iter().map(|s| s.len()).collect();
        assert_eq!(lens, vec![960, 39]);
        assert_eq!(al.frames(), 999);
        // The resampler's tail came out: the last frames are audio, not zeros.
        let last = &slots[1].ch[0];
        assert!(last.delivered);
        let mean = last.samples.iter().sum::<f32>() / last.samples.len() as f32;
        assert!(mean > 0.3, "{:?}", last.samples);
    }

    #[test]
    fn audio_before_the_anchor_is_dropped_but_is_not_late() {
        let mut al = Aligner::new(T0);
        al.push(Ch::Mic, T0 - 100 * MS, 48_000, &vec![0.5; 480], true);
        // A device opened before `capturing` delivers audio from before the timeline: expected,
        // not a sign of a slow source.
        assert_eq!(al.stats(Ch::Mic).late, 0);
        assert!(al.stats(Ch::Mic).before > 0);
    }

    #[test]
    fn audio_behind_the_emit_cursor_is_dropped_and_counted_late() {
        let mut al = Aligner::new(T0);
        // One second of the timeline goes out with nothing from the mic.
        while al.pop_due(T0 + 1_000 * MS, LAT).is_some() {}
        al.push(Ch::Mic, T0 + 500 * MS, 48_000, &vec![0.5; 480], true);
        assert!(al.stats(Ch::Mic).late > 0);
        assert_eq!(al.stats(Ch::Mic).before, 0);
    }

    /// Pushes 10 ms call buffers of `v`, stamped from `from_ns` (a source's own clock), until
    /// `until_ns`; emits what is due on a host clock that follows the stamps, with the engine's
    /// 100 ms device latency.
    fn call_stream(al: &mut Aligner, out: &mut Vec<f32>, from_ns: u64, until_ns: u64, v: f32) {
        let mut at = from_ns;
        while at < until_ns {
            al.push(Ch::Call, at, 48_000, &[v; 480], v != 0.0);
            at += 10 * MS;
            while let Some(s) = al.pop_due(at, 100 * MS) {
                out.extend_from_slice(&s.ch[1].samples);
            }
        }
    }

    /// First timeline frame at or after `from` whose call sample is at least `level`.
    fn first_at(out: &[f32], from: usize, level: f32) -> i64 {
        out[from..].iter().position(|v| *v >= level).unwrap() as i64 + from as i64
    }

    /// [G4 quiet-tap run] A rebuilt tap is a new stream: its first buffer is placed by its own
    /// timestamp at once. Kept on the old stream's clock instead, a new stream 21 ms later than
    /// the old one ended lands 21 ms early and is slewed back at 1 ms a second, which is how the
    /// first start after a silent tap stayed off for about 40 s.
    #[test]
    fn a_restarted_source_is_placed_by_its_own_timestamps_at_once() {
        let end = T0 + 2_000 * MS;
        let new_at = end + 21 * MS;
        let expected = (new_at - T0) as i64 * 48 / 1_000_000;
        for restart in [true, false] {
            let mut al = Aligner::new(T0);
            let mut out = Vec::new();
            call_stream(&mut al, &mut out, T0, end, 0.25);
            if restart {
                al.restart(Ch::Call);
            }
            call_stream(&mut al, &mut out, new_at, new_at + 3_000 * MS, 0.75);
            let got = first_at(&out, 90_000, 0.5);
            if restart {
                assert!((got - expected).abs() <= 48, "{got} vs {expected}");
                // The 21 ms the rebuild lost are zeros where they belong, not closed up.
                assert!(
                    out[(expected - 500) as usize..(expected - 100) as usize]
                        .iter()
                        .all(|v| *v == 0.0)
                );
            } else {
                // Positive control: without the restart the old clock holds it 21 ms early.
                assert!(expected - got > 900, "{got} vs {expected}");
            }
        }
    }

    /// A buffer of the old stream that was still queued when the source was restarted anchors
    /// it on the old clock; the new stream's first buffer is then a step, and a step in the first
    /// second after an anchor re-anchors rather than slewing.
    #[test]
    fn a_stale_buffer_after_a_restart_does_not_hold_the_new_stream_to_the_old_clock() {
        let end = T0 + 2_000 * MS;
        // The new stream's clock reads 33 ms earlier than the old stream's for the same instant.
        let new_at = end + 10 * MS - 33 * MS;
        let expected = (new_at - T0) as i64 * 48 / 1_000_000;
        let mut al = Aligner::new(T0);
        let mut out = Vec::new();
        call_stream(&mut al, &mut out, T0, end, 0.25);
        al.restart(Ch::Call);
        call_stream(&mut al, &mut out, end, end + 10 * MS, 0.25);
        call_stream(&mut al, &mut out, new_at, new_at + 3_000 * MS, 0.75);
        let got = first_at(&out, 90_000, 0.5);
        assert!((got - expected).abs() <= 48, "{got} vs {expected}");
        assert_eq!(al.stats(Ch::Call).resyncs, 1);
    }

    /// The first buffer of a stream stamped by its arrival can be late by up to a delivery
    /// period; the next ones are not. The step shows within the first second and re-anchors
    /// there, so alignment is right from the second buffer, not 15 s later. Past the first
    /// second the same step is clock skew or jitter and is slewed as before (positive control).
    #[test]
    fn a_step_in_the_first_second_re_anchors_and_a_later_one_is_slewed() {
        for (step_at_ms, snaps) in [(10u64, true), (1_500, false)] {
            let mut al = Aligner::new(T0);
            let mut out = Vec::new();
            // Buffers up to `step_at` are stamped 15 ms late; the rest on time.
            let mut at = T0;
            while at < T0 + 3_000 * MS {
                let stamp = if at < T0 + step_at_ms * MS {
                    at + 15 * MS
                } else {
                    at
                };
                let v = if at >= T0 + 2_500 * MS { 0.75 } else { 0.25 };
                al.push(Ch::Call, stamp, 48_000, &[v; 480], true);
                at += 10 * MS;
                while let Some(s) = al.pop_due(at + 15 * MS, LAT) {
                    out.extend_from_slice(&s.ch[1].samples);
                }
            }
            let expected: i64 = 2_500 * 48;
            let got = first_at(&out, 100_000, 0.5);
            if snaps {
                assert!((got - expected).abs() <= 48, "{got} vs {expected}");
                assert_eq!(al.stats(Ch::Call).resyncs, 1);
            } else {
                assert!((got - expected).abs() > 300, "{got} vs {expected}");
                assert_eq!(al.stats(Ch::Call).resyncs, 0);
            }
        }
    }

    /// A source restarted inside the first second after its anchor gets a settle window of its
    /// own: the new stream's late-stamped first buffer re-anchors on the next one, as it would
    /// for a restart later on (positive control), instead of being slewed at 1 ms a second.
    #[test]
    fn a_restart_inside_the_settle_window_opens_a_window_for_the_new_stream() {
        for restart_ms in [1_500u64, 500] {
            let mut al = Aligner::new(T0);
            let mut out = Vec::new();
            let end = T0 + restart_ms * MS;
            call_stream(&mut al, &mut out, T0, end, 0.25);
            al.restart(Ch::Call);
            let new_at = end + 50 * MS;
            // The new stream's first buffer is stamped 20 ms late, the next ones on time.
            al.push(Ch::Call, new_at + 20 * MS, 48_000, &[0.25; 480], true);
            call_stream(
                &mut al,
                &mut out,
                new_at + 10 * MS,
                new_at + 1_500 * MS,
                0.25,
            );
            call_stream(
                &mut al,
                &mut out,
                new_at + 1_500 * MS,
                new_at + 3_000 * MS,
                0.75,
            );
            let expected = (new_at + 1_500 * MS - T0) as i64 * 48 / 1_000_000;
            let got = first_at(&out, (expected - 24_000) as usize, 0.5);
            assert!(
                (got - expected).abs() <= 48,
                "restart at {restart_ms} ms: {got} vs {expected}"
            );
            assert_eq!(al.stats(Ch::Call).resyncs, 1, "restart at {restart_ms} ms");
        }
    }

    /// The settle window lasts a second after the anchor, not one buffer: a first buffer stamped
    /// early makes the next one a step later than the anchor, and that step re-anchors too.
    #[test]
    fn a_first_buffer_stamped_early_re_anchors_on_the_next_one() {
        let mut al = Aligner::new(T0);
        let mut out = Vec::new();
        let start = T0 + 100 * MS;
        al.push(Ch::Call, start - 15 * MS, 48_000, &[0.25; 480], true);
        call_stream(&mut al, &mut out, start + 10 * MS, start + 1_500 * MS, 0.25);
        call_stream(
            &mut al,
            &mut out,
            start + 1_500 * MS,
            start + 3_000 * MS,
            0.75,
        );
        let expected = (start + 1_500 * MS - T0) as i64 * 48 / 1_000_000;
        let got = first_at(&out, (expected - 24_000) as usize, 0.5);
        assert!((got - expected).abs() <= 48, "{got} vs {expected}");
        assert_eq!(al.stats(Ch::Call).resyncs, 1);
    }

    #[test]
    fn audio_captured_while_paused_is_not_late_after_resume() {
        let mut al = Aligner::new(T0);
        while al.pop_due(T0 + 500 * MS, LAT).is_some() {}
        al.pause(T0 + 500 * MS);
        al.resume(T0 + 2_000 * MS);
        // A buffer captured during the pause that the device hands over after the resume.
        al.push(Ch::Mic, T0 + 1_950 * MS, 48_000, &vec![0.5; 480], true);
        assert_eq!(al.stats(Ch::Mic).late, 0);
    }
}
