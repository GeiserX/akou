//! The host clocks (DESIGN 2.1 and 4.4).
//!
//! Two readings of the same moment:
//!
//! - `cont_ns` keeps running during sleep (`mach_continuous_time`, `CLOCK_BOOTTIME`). Every
//!   `capture_ns` on the wire is this clock, so the app sees a sleep as a jump of the host clock
//!   that the file position does not show, and writes a `gap`.
//! - `awake_ns` stops during sleep (`mach_absolute_time`, `CLOCK_MONOTONIC`). Device timestamps
//!   are on this clock, and the aligner's timeline follows it, so a sleep never becomes an hour
//!   of zeros in the file.
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

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod imp {
    //! Windows device capture arrives in M3 with `QueryInterruptTime` and
    //! `QueryUnbiasedInterruptTime`. Until then only the file source runs here, and it drives
    //! its own clock, so both readings come from one monotonic clock.
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn cont_of_carries_the_sleep_offset() {
        let n = Now {
            awake_ns: 1_000,
            cont_ns: 5_000,
        };
        assert_eq!(n.cont_of(1_500), 5_500);
    }
}
