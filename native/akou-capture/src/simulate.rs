//! Fault switches for the app's trap tests (`--simulate <switch>[=value]`), the same set
//! `scripts/fake-helper.ts` offers, so those tests can run against the real helper.
//!
//! They compile only with the `simulate` feature (DESIGN 2.5: fault injection is never in a
//! shipping binary). Without it `Faults` is an empty struct whose answers are constants, the
//! fault branches compile away, and `--simulate` is a usage error; a test proves both.
//!
//! Times are seconds of audio on the file timeline, as in the fake helper.
//!
//! - `capturing-delay=MS`          a slow open before `capturing` (a stop cancels it)
//! - `exit-before-capturing=N`     exit with code N before `capturing` (77 = permission)
//! - `call-silent`                 the call side delivers nothing and output is not running
//! - `call-omit`                   no call packets at all on stdout (a helper without an aligner)
//! - `call-dead-at=S`              the call side goes silent at S while output keeps running
//! - `rebuild-heals`               a call rebuild brings a dead call side back
//! - `hang-on-stop`                `stop` and closing stdin are ignored: a hung teardown
//! - `crash-at=S`                  exit 70 at S, without `stopped`
//! - `stall-at=S`                  stop sending anything at S, stay alive
//! - `sleep-at=S`, `sleep-for=S`   the continuous host clock jumps (machine sleep)

#[cfg(feature = "simulate")]
mod imp {
    #[derive(Clone, Debug, Default)]
    pub struct Faults {
        capturing_delay_ms: Option<u64>,
        exit_before_capturing: Option<i32>,
        call_silent: bool,
        call_omit: bool,
        call_dead_at: Option<f64>,
        rebuild_heals: bool,
        hang_on_stop: bool,
        crash_at: Option<f64>,
        stall_at: Option<f64>,
        sleep_at: Option<f64>,
        sleep_for: f64,
    }

    pub const AVAILABLE: bool = true;

    fn num<T: std::str::FromStr>(name: &str, v: Option<&str>) -> Result<T, String> {
        v.and_then(|v| v.parse().ok())
            .ok_or_else(|| format!("--simulate {name} needs a number: {name}=N"))
    }

    impl Faults {
        /// No faults.
        pub fn none() -> Self {
            Self::default()
        }

        pub fn apply(&mut self, spec: &str) -> Result<(), String> {
            let (name, v) = match spec.split_once('=') {
                Some((n, v)) => (n, Some(v)),
                None => (spec, None),
            };
            match name {
                "capturing-delay" => self.capturing_delay_ms = Some(num(name, v)?),
                "exit-before-capturing" => self.exit_before_capturing = Some(num(name, v)?),
                "call-silent" => self.call_silent = true,
                "call-omit" => self.call_omit = true,
                "call-dead-at" => self.call_dead_at = Some(num(name, v)?),
                "rebuild-heals" => self.rebuild_heals = true,
                "hang-on-stop" => self.hang_on_stop = true,
                "crash-at" => self.crash_at = Some(num(name, v)?),
                "stall-at" => self.stall_at = Some(num(name, v)?),
                "sleep-at" => self.sleep_at = Some(num(name, v)?),
                "sleep-for" => self.sleep_for = num(name, v)?,
                _ => return Err(format!("unknown --simulate switch {name}")),
            }
            Ok(())
        }
        pub fn any(&self) -> bool {
            self.capturing_delay_ms.is_some()
                || self.exit_before_capturing.is_some()
                || self.call_silent
                || self.call_omit
                || self.call_dead_at.is_some()
                || self.rebuild_heals
                || self.hang_on_stop
                || self.crash_at.is_some()
                || self.stall_at.is_some()
                || self.sleep_at.is_some()
        }
        pub fn capturing_delay_ms(&self) -> Option<u64> {
            self.capturing_delay_ms
        }
        pub fn exit_before_capturing(&self) -> Option<i32> {
            self.exit_before_capturing
        }
        pub fn call_silent(&self) -> bool {
            self.call_silent
        }
        pub fn call_omit(&self) -> bool {
            self.call_omit
        }
        pub fn call_dead_at(&self) -> Option<f64> {
            self.call_dead_at
        }
        pub fn rebuild_heals(&self) -> bool {
            self.rebuild_heals
        }
        pub fn hang_on_stop(&self) -> bool {
            self.hang_on_stop
        }
        pub fn crash_at(&self) -> Option<f64> {
            self.crash_at
        }
        pub fn stall_at(&self) -> Option<f64> {
            self.stall_at
        }
        /// `(at, seconds)` of the simulated sleep.
        pub fn sleep(&self) -> Option<(f64, f64)> {
            self.sleep_at.map(|a| (a, self.sleep_for))
        }
    }
}

#[cfg(not(feature = "simulate"))]
mod imp {
    /// A shipping build: no fault can be set, every answer is "none".
    #[derive(Clone, Debug, Default)]
    pub struct Faults;

    pub const AVAILABLE: bool = false;

    impl Faults {
        /// No faults (the only value a shipping build has).
        pub const fn none() -> Self {
            Faults
        }

        pub fn apply(&mut self, _spec: &str) -> Result<(), String> {
            Err("this build has no fault switches (--simulate needs the `simulate` feature)".into())
        }
        pub const fn any(&self) -> bool {
            false
        }
        pub const fn capturing_delay_ms(&self) -> Option<u64> {
            None
        }
        pub const fn exit_before_capturing(&self) -> Option<i32> {
            None
        }
        pub const fn call_silent(&self) -> bool {
            false
        }
        pub const fn call_omit(&self) -> bool {
            false
        }
        pub const fn call_dead_at(&self) -> Option<f64> {
            None
        }
        pub const fn rebuild_heals(&self) -> bool {
            false
        }
        pub const fn hang_on_stop(&self) -> bool {
            false
        }
        pub const fn crash_at(&self) -> Option<f64> {
            None
        }
        pub const fn stall_at(&self) -> Option<f64> {
            None
        }
        pub const fn sleep(&self) -> Option<(f64, f64)> {
            None
        }
    }
}

pub use imp::{AVAILABLE, Faults};

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(feature = "simulate"))]
    #[test]
    fn a_shipping_build_refuses_every_fault_switch() {
        let mut f = Faults::none();
        for s in [
            "hang-on-stop",
            "crash-at=1",
            "call-dead-at=0.5",
            "stall-at=1",
        ] {
            assert!(f.apply(s).is_err(), "{s}");
        }
        assert!(!f.any());
        const { assert!(!AVAILABLE) };
    }

    #[cfg(feature = "simulate")]
    #[test]
    fn a_test_build_parses_every_fault_switch() {
        let mut f = Faults::none();
        for s in [
            "capturing-delay=3000",
            "exit-before-capturing=77",
            "call-silent",
            "call-omit",
            "call-dead-at=0.5",
            "rebuild-heals",
            "hang-on-stop",
            "crash-at=0.3",
            "stall-at=0.5",
            "sleep-at=0.5",
            "sleep-for=3600",
        ] {
            f.apply(s).unwrap();
        }
        assert_eq!(f.capturing_delay_ms(), Some(3000));
        assert_eq!(f.exit_before_capturing(), Some(77));
        assert_eq!(f.sleep(), Some((0.5, 3600.0)));
        assert!(f.apply("crash-at").is_err());
        assert!(f.apply("teleport").is_err());
        const { assert!(AVAILABLE) };
    }
}
