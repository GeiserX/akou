//! The host clocks (DESIGN 2.1 and 4.4).
//!
//! Two readings of the same moment:
//!
//! - `cont_ns` keeps running during sleep (`mach_continuous_time`, `CLOCK_BOOTTIME`,
//!   `QueryInterruptTimePrecise`). Every
//!   `capture_ns` on the wire is this clock, so the app sees a sleep as a jump of the host clock
//!   that the file position does not show, and writes a `gap`.
//! - `awake_ns` stops during sleep (`mach_absolute_time`, `CLOCK_MONOTONIC`,
//!   `QueryUnbiasedInterruptTimePrecise`). Device timestamps are on this clock, or moved onto it
//!   by `stamp`, and the aligner's timeline follows it, so a sleep never becomes an hour of zeros
//!   in the file.
//!
//! Only differences are meaningful. `cont_ns - awake_ns` grows by exactly the time slept.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Now {
    pub awake_ns: u64,
    pub cont_ns: u64,
}

impl Now {
    /// The continuous-clock reading of an awake-clock instant near this one.
    pub fn cont_of(&self, awake_ns: u64) -> u64 {
        let offset = self.cont_ns.wrapping_sub(self.awake_ns);
        awake_ns.wrapping_add(offset)
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::Now;
    use std::sync::OnceLock;

    #[repr(C)]
    #[derive(Default)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }

    unsafe extern "C" {
        fn mach_absolute_time() -> u64;
        fn mach_continuous_time() -> u64;
        fn mach_timebase_info(info: *mut Timebase) -> i32;
    }

    fn timebase() -> (u64, u64) {
        static TB: OnceLock<(u64, u64)> = OnceLock::new();
        *TB.get_or_init(|| {
            let mut tb = Timebase::default();
            // SAFETY: plain out-parameter call into libSystem.
            let r = unsafe { mach_timebase_info(&mut tb) };
            if r != 0 || tb.denom == 0 {
                (1, 1)
            } else {
                (tb.numer as u64, tb.denom as u64)
            }
        })
    }

    /// Mach host ticks (an `AudioTimeStamp.mHostTime`) to nanoseconds on the awake clock.
    pub fn host_ticks_to_ns(ticks: u64) -> u64 {
        let (n, d) = timebase();
        ((ticks as u128 * n as u128) / d as u128) as u64
    }

    pub fn now() -> Now {
        // SAFETY: both calls read a clock and have no preconditions.
        let (a, c) = unsafe { (mach_absolute_time(), mach_continuous_time()) };
        Now {
            awake_ns: host_ticks_to_ns(a),
            cont_ns: host_ticks_to_ns(c),
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::Now;

    fn read(clock: libc::clockid_t) -> u64 {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: valid clock id and out-pointer.
        unsafe { libc::clock_gettime(clock, &mut ts) };
        ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
    }

    pub fn now() -> Now {
        Now {
            awake_ns: read(libc::CLOCK_MONOTONIC),
            cont_ns: read(libc::CLOCK_BOOTTIME),
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::Now;
    use std::sync::OnceLock;
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    use windows::Win32::System::WindowsProgramming::{
        QueryInterruptTimePrecise, QueryUnbiasedInterruptTimePrecise,
    };

    pub fn now() -> Now {
        // SAFETY: both read a clock and have no preconditions. Units of 100 ns; the unbiased
        // count leaves out time asleep, the other keeps it.
        let (a, c) = unsafe {
            (
                QueryUnbiasedInterruptTimePrecise(),
                QueryInterruptTimePrecise(),
            )
        };
        Now {
            awake_ns: a.saturating_mul(100),
            cont_ns: c.saturating_mul(100),
        }
    }

    /// The performance counter in nanoseconds: the clock of WASAPI's buffer timestamps.
    pub fn qpc_ns() -> u64 {
        static FREQ: OnceLock<u64> = OnceLock::new();
        let freq = *FREQ.get_or_init(|| {
            let mut f = 0i64;
            // SAFETY: plain out-parameter call.
            let ok = unsafe { QueryPerformanceFrequency(&mut f) }.is_ok();
            if ok && f > 0 { f as u64 } else { 10_000_000 }
        });
        let mut t = 0i64;
        // SAFETY: plain out-parameter call.
        let _ = unsafe { QueryPerformanceCounter(&mut t) };
        ((t.max(0) as u128 * 1_000_000_000) / freq as u128) as u64
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod imp {
    //! No device front end here: only the file source runs, and it drives its own clock, so both
    //! readings come from one monotonic clock.
    use super::Now;
    use std::sync::OnceLock;
    use std::time::Instant;

    pub fn now() -> Now {
        static START: OnceLock<Instant> = OnceLock::new();
        let t = START.get_or_init(Instant::now).elapsed().as_nanos() as u64 + 1_000_000_000;
        Now {
            awake_ns: t,
            cont_ns: t,
        }
    }
}

pub use imp::now;

#[cfg(target_os = "macos")]
pub use imp::host_ticks_to_ns;
#[cfg(target_os = "windows")]
pub use imp::qpc_ns;

/// A device timestamp this far behind the moment its buffer is read is not believed.
pub const MAX_DEVICE_LAG_NS: u64 = 2_000_000_000;

/// Duration of `frames` frames at `rate`, in nanoseconds.
pub fn frames_ns(frames: usize, rate: u32) -> u64 {
    (frames as u128 * 1_000_000_000 / rate.max(1) as u128) as u64
}

/// The awake-clock time of the first frame of a buffer read just now.
///
/// `device` is the buffer's own timestamp on another clock whose reading now is `device_now`
/// (WASAPI's performance counter); the two readings are taken together, so the lag carries
/// over. A buffer with no timestamp, or one that is in the future or older than
/// `MAX_DEVICE_LAG_NS`, is stamped by its arrival instead: now, less its own duration.
pub fn stamp(
    awake_now: u64,
    device_now: u64,
    device: Option<u64>,
    frames: usize,
    rate: u32,
) -> u64 {
    match device {
        Some(d) if d <= device_now && device_now - d <= MAX_DEVICE_LAG_NS => {
            awake_now.saturating_sub(device_now - d)
        }
        _ => awake_now.saturating_sub(frames_ns(frames, rate)),
    }
}

/// Stamps a stream whose buffers carry no capture time (the PulseAudio protocol's record data)
/// from when they arrive.
///
/// A buffer can arrive late but never before its audio was captured, so across the stream the
/// lowest "arrival less the audio received so far" is the closest to when the first sample was
/// captured; a late delivery only raises it and is ignored. Buffer `k` then starts at that
/// origin plus the audio before it, so the stamps carry no delivery jitter. Stamping each
/// buffer by its own arrival instead is off by up to a delivery period (20 ms here), and the
/// aligner anchors a source on its first buffer.
///
/// The origin creeps up by 0.05 % of the audio received, faster than any real device clock
/// drifts, so a device clock that runs slow is followed as well as one that runs fast. An arrival
/// more than `ARRIVAL_RESET_NS` after the origin allows (audio the server dropped) starts over.
pub struct ArrivalClock {
    rate: u32,
    frames: u64,
    origin: Option<i128>,
    restarts: u64,
}

/// A gap in a stream beyond this restarts its arrival clock.
pub const ARRIVAL_RESET_NS: i128 = 100_000_000;

impl ArrivalClock {
    pub fn new(rate: u32) -> Self {
        ArrivalClock {
            rate: rate.max(1),
            frames: 0,
            origin: None,
            restarts: 0,
        }
    }

    /// Times a gap started the clock over.
    pub fn restarts(&self) -> u64 {
        self.restarts
    }

    fn ns(&self, frames: u64) -> i128 {
        frames as i128 * 1_000_000_000 / self.rate as i128
    }

    /// Seconds of audio the current origin rests on. Until a stream has delivered a few delivery
    /// periods, the lowest arrival may not have come yet and stamps can still move earlier.
    pub fn seen_s(&self) -> f64 {
        self.frames as f64 / self.rate as f64
    }

    /// The awake-clock time of the first of `frames` frames that arrived at `arrival_ns`.
    pub fn stamp(&mut self, arrival_ns: u64, frames: usize) -> u64 {
        let before = self.frames;
        self.frames += frames as u64;
        let implied = arrival_ns as i128 - self.ns(self.frames);
        let origin = match self.origin {
            None => implied,
            Some(o) => {
                let crept = o + self.ns(frames as u64) / 2_000;
                if implied - crept > ARRIVAL_RESET_NS {
                    // Audio went missing: the frame count no longer describes the time.
                    self.restarts += 1;
                    self.frames = frames as u64;
                    let restarted = arrival_ns as i128 - self.ns(self.frames);
                    self.origin = Some(restarted);
                    return restarted.max(0) as u64;
                }
                crept.min(implied)
            }
        };
        self.origin = Some(origin);
        (origin + self.ns(before)).max(0) as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stream of 20 ms buffers (960 frames at 48 kHz) captured from `start`, delivered after
    /// a fixed 5 ms plus the jitter of each delivery; returns the error of each stamp, ns.
    fn arrival_errors(ppm: f64, jitter: impl Fn(usize) -> u64, buffers: usize) -> Vec<i128> {
        let start: u64 = 50_000_000_000;
        let mut clk = ArrivalClock::new(48_000);
        (0..buffers)
            .map(|k| {
                // The device's 20 ms are 20 ms * (1 + ppm) on the host clock.
                let dur = 20_000_000.0 * (1.0 + ppm * 1e-6);
                let captured = start + (k as f64 * dur) as u64;
                let end = start + ((k + 1) as f64 * dur) as u64;
                let arrival = end + 5_000_000 + jitter(k);
                clk.stamp(arrival, 960) as i128 - (captured as i128 + 5_000_000)
            })
            .collect()
    }

    #[test]
    fn arrival_stamps_carry_no_delivery_jitter() {
        // Up to 15 ms late on most deliveries, on time now and then.
        let jitter = |k: usize| {
            if k.is_multiple_of(7) {
                0
            } else {
                (k as u64 * 7_919 % 15) * 1_000_000
            }
        };
        let errs = arrival_errors(0.0, jitter, 500);
        let worst = errs[7..].iter().map(|e| e.abs()).max().unwrap();
        assert!(worst < 100_000, "stamps off by up to {worst} ns");
        // Positive control: stamping each buffer by its own arrival is off by the jitter.
        let naive_worst = (0..500).map(|k| jitter(k) as i128).max().unwrap();
        assert!(naive_worst >= 14_000_000);
    }

    #[test]
    fn arrival_stamps_follow_a_device_clock_that_runs_slow_or_fast() {
        for ppm in [-200.0, 200.0] {
            // A minute of buffers, each delivered on time.
            let errs = arrival_errors(ppm, |_| 0, 3_000);
            let last = errs.last().unwrap().abs();
            assert!(
                last < 2_000_000,
                "{ppm} ppm: off by {last} ns after a minute"
            );
        }
    }

    #[test]
    fn a_gap_in_the_stream_restarts_the_arrival_clock() {
        let mut clk = ArrivalClock::new(48_000);
        let t = 10_000_000_000u64;
        assert_eq!(clk.stamp(t + 20_000_000, 960), t);
        assert_eq!(clk.stamp(t + 40_000_000, 960), t + 20_000_000);
        assert_eq!(clk.seen_s(), 0.04);
        // 500 ms of audio never arrived: the next buffer is stamped by its own arrival, and the
        // clock settles again from there.
        let after = t + 560_000_000;
        assert_eq!(clk.restarts(), 0);
        assert_eq!(clk.stamp(after + 20_000_000, 960), after);
        assert_eq!(clk.seen_s(), 0.02);
        assert_eq!(clk.restarts(), 1);
        assert_eq!(clk.stamp(after + 40_000_000, 960), after + 20_000_000);
    }

    #[test]
    fn both_clocks_move_forward_and_continuous_is_never_behind() {
        let a = now();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let b = now();
        assert!(b.awake_ns > a.awake_ns);
        assert!(b.cont_ns > a.cont_ns);
        assert!(b.awake_ns - a.awake_ns >= 4_000_000);
    }

    #[test]
    fn a_device_timestamp_moves_to_the_awake_clock_by_its_lag() {
        // Read 30 ms after the device stamped it: 30 ms before the host's now.
        assert_eq!(
            stamp(
                10_000_000_000,
                500_030_000_000,
                Some(500_000_000_000),
                480,
                48_000
            ),
            9_970_000_000
        );
        // No timestamp: arrival less the buffer's own 10 ms.
        assert_eq!(stamp(10_000_000_000, 0, None, 480, 48_000), 9_990_000_000);
    }

    #[test]
    fn a_device_timestamp_that_cannot_be_right_is_replaced_by_arrival() {
        // From the future, and 10 s stale: both fall back to arrival.
        assert_eq!(
            stamp(10_000_000_000, 100, Some(200), 480, 48_000),
            9_990_000_000
        );
        assert_eq!(
            stamp(
                10_000_000_000,
                20_000_000_000,
                Some(10_000_000_000),
                480,
                48_000
            ),
            9_990_000_000
        );
        // Positive control: the same stale stamp inside the bound is believed.
        assert_eq!(
            stamp(
                10_000_000_000,
                11_000_000_000,
                Some(10_000_000_000),
                480,
                48_000
            ),
            9_000_000_000
        );
        assert_eq!(frames_ns(48_000, 48_000), 1_000_000_000);
    }

    #[test]
    fn cont_of_carries_the_sleep_offset() {
        let n = Now {
            awake_ns: 1_000,
            cont_ns: 5_000,
        };
        assert_eq!(n.cont_of(1_500), 5_500);
    }
}
