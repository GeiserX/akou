//! The dead-call-side rule (DESIGN 2.5, TRAPS T0.2 and T1.29), ported from the reference in
//! `src/main/capture/health.ts` with the same test table.
//!
//! - Condition: the OS says output is running **and** the call stream has delivered exact zeros
//!   or nothing for 10 s. Silence alone never triggers anything; real calls have minutes of zeros.
//! - Action: probe for up to 3 s. If the probe hears audio, rebuild the call stream and report
//!   `dead`. Rebuilds back off 10, 30, 60 s, then every minute, at most 5 per part.
//! - Audio returning after `dead` reports `ok`. Nothing runs while paused, and one tick never asks
//!   for two rebuilds.
//!
//! Also here, because it watches the same stream: **permission suspect**. A tap that opens but
//! has delivered only zeros for 20 s while output is running is how a missing System Audio
//! Recording grant looks (no error, just silence), so it is reported once with the pane to open.

pub const DEAD_AFTER_S: f64 = 10.0;
pub const PROBE_S: f64 = 3.0;
pub const BACKOFF_S: [f64; 3] = [10.0, 30.0, 60.0];
pub const EVERY_MINUTE_S: f64 = 60.0;
pub const MAX_REBUILDS: u32 = 5;

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Probe,
    Rebuild {
        rebuilds: u32,
    },
    Health {
        state: &'static str,
        silent_for: f64,
        rebuilds: u32,
        detail: &'static str,
    },
}

#[derive(Clone, Copy, Debug)]
pub struct Tick {
    /// Seconds on a monotonic clock.
    pub t: f64,
    /// The OS reports the output device running.
    pub output_running: bool,
    /// The call stream delivered non-zero audio since the last tick.
    pub heard: bool,
    pub paused: bool,
}

pub struct DeadCallMonitor {
    silent_since: Option<f64>,
    probing: bool,
    next_allowed: f64,
    dead: bool,
    pub rebuilds: u32,
}

impl DeadCallMonitor {
    pub fn new(start: f64) -> Self {
        DeadCallMonitor {
            silent_since: Some(start),
            probing: false,
            next_allowed: f64::NEG_INFINITY,
            dead: false,
            rebuilds: 0,
        }
    }

    pub fn probing(&self) -> bool {
        self.probing
    }

    /// One observation. Returns the actions for this tick, in order.
    pub fn tick(&mut self, o: Tick) -> Vec<Action> {
        if o.paused {
            // Paused time is not silence.
            self.silent_since = None;
            return vec![];
        }
        if o.heard {
            self.silent_since = None;
            if self.dead {
                self.dead = false;
                return vec![Action::Health {
                    state: "ok",
                    silent_for: 0.0,
                    rebuilds: self.rebuilds,
                    detail: "call audio is back",
                }];
            }
            return vec![];
        }
        let since = *self.silent_since.get_or_insert(o.t);
        let silent_for = o.t - since;
        if !self.probing
            && o.output_running
            && silent_for >= DEAD_AFTER_S
            && o.t >= self.next_allowed
            && self.rebuilds < MAX_REBUILDS
        {
            self.probing = true;
            return vec![Action::Probe];
        }
        vec![]
    }

    /// The probe's verdict, within `PROBE_S` of the `Probe` action.
    pub fn probe_result(&mut self, t: f64, heard_audio: bool) -> Vec<Action> {
        if !self.probing {
            return vec![];
        }
        self.probing = false;
        let silent_for = self.silent_since.map_or(0.0, |s| t - s);
        if !heard_audio {
            // Output running but nothing audible anywhere: a quiet call, not a dead tap.
            self.next_allowed = t + DEAD_AFTER_S;
            return vec![];
        }
        let wait = BACKOFF_S
            .get(self.rebuilds as usize)
            .copied()
            .unwrap_or(EVERY_MINUTE_S);
        self.rebuilds += 1;
        self.next_allowed = t + wait;
        self.dead = true;
        let detail = if self.rebuilds >= MAX_REBUILDS {
            "output running, probe heard audio, rebuilding (last automatic rebuild for this part)"
        } else {
            "output running, probe heard audio, rebuilding"
        };
        vec![
            Action::Health {
                state: "dead",
                silent_for,
                rebuilds: self.rebuilds,
                detail,
            },
            Action::Rebuild {
                rebuilds: self.rebuilds,
            },
        ]
    }
}

pub const PERMISSION_SUSPECT_S: f64 = 20.0;
pub const PERMISSION_PANE: &str =
    "open System Settings > Privacy & Security > Screen & System Audio Recording";

/// Reports once when a tap that never delivered audio has given only zeros for 20 s of output
/// running. Any audio clears it for the rest of the part.
pub struct PermissionSuspect {
    running_silent: f64,
    last_t: Option<f64>,
    done: bool,
}

impl Default for PermissionSuspect {
    fn default() -> Self {
        Self::new()
    }
}

impl PermissionSuspect {
    pub fn new() -> Self {
        PermissionSuspect {
            running_silent: 0.0,
            last_t: None,
            done: false,
        }
    }

    /// Returns true once, when the suspicion is reached.
    pub fn tick(&mut self, o: Tick) -> bool {
        let dt = self.last_t.map_or(0.0, |l| (o.t - l).max(0.0));
        self.last_t = Some(o.t);
        if self.done || o.paused {
            return false;
        }
        if o.heard {
            self.done = true;
            return false;
        }
        if o.output_running {
            self.running_silent += dt;
        }
        if self.running_silent >= PERMISSION_SUSPECT_S {
            self.done = true;
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the monitor once a second from `from` to `to`; the probe answers `probe_hears`.
    fn run(
        m: &mut DeadCallMonitor,
        from: i32,
        to: i32,
        output_running: bool,
        heard: impl Fn(f64) -> bool,
        probe_hears: bool,
        paused: impl Fn(f64) -> bool,
    ) -> Vec<(f64, Action)> {
        let mut out = vec![];
        for t in from..=to {
            let t = t as f64;
            for a in m.tick(Tick {
                t,
                output_running,
                heard: heard(t),
                paused: paused(t),
            }) {
                let probe = a == Action::Probe;
                out.push((t, a));
                if probe {
                    for r in m.probe_result(t, probe_hears) {
                        out.push((t, r));
                    }
                }
            }
        }
        out
    }

    fn rebuild_times(log: &[(f64, Action)]) -> Vec<f64> {
        log.iter()
            .filter(|(_, a)| matches!(a, Action::Rebuild { .. }))
            .map(|(t, _)| *t)
            .collect()
    }

    const NEVER: fn(f64) -> bool = |_| false;

    #[test]
    fn t0_2_output_running_and_the_call_silent_for_10_s_probe_rebuild_report_dead() {
        let mut m = DeadCallMonitor::new(0.0);
        let log = run(&mut m, 0, 30, true, |t| t < 20.0, true, NEVER);
        let first = log.iter().find(|(_, a)| *a == Action::Probe).unwrap();
        assert_eq!(first.0, 30.0);
        let health = log
            .iter()
            .find(|(_, a)| matches!(a, Action::Health { .. }))
            .unwrap();
        assert!(matches!(
            health.1,
            Action::Health {
                state: "dead",
                rebuilds: 1,
                ..
            }
        ));
    }

    #[test]
    fn t0_2_backs_off_10_30_60_then_every_minute_and_stops_after_5_rebuilds() {
        let mut m = DeadCallMonitor::new(0.0);
        let log = run(&mut m, 0, 1000, true, NEVER, true, NEVER);
        let times = rebuild_times(&log);
        assert_eq!(times, vec![10.0, 20.0, 50.0, 110.0, 170.0]);
        assert_eq!(times.len() as u32, MAX_REBUILDS);
    }

    #[test]
    fn t0_2_positive_control_the_same_zeros_with_output_not_running_never_rebuild() {
        let mut m = DeadCallMonitor::new(0.0);
        assert!(run(&mut m, 0, 600, false, NEVER, true, NEVER).is_empty());
        let mut control = DeadCallMonitor::new(0.0);
        let log = run(&mut control, 0, 600, true, NEVER, true, NEVER);
        assert!(!rebuild_times(&log).is_empty());
    }

    #[test]
    fn t1_29_a_probe_that_hears_nothing_is_a_quiet_call_not_a_dead_tap() {
        let mut m = DeadCallMonitor::new(0.0);
        let log = run(&mut m, 0, 120, true, NEVER, false, NEVER);
        assert!(log.iter().any(|(_, a)| *a == Action::Probe));
        assert!(rebuild_times(&log).is_empty());
    }

    #[test]
    fn audio_coming_back_after_dead_reports_ok_once() {
        let mut m = DeadCallMonitor::new(0.0);
        let log = run(&mut m, 0, 40, true, |t| t > 25.0, true, NEVER);
        let states: Vec<&str> = log
            .iter()
            .filter_map(|(_, a)| match a {
                Action::Health { state, .. } => Some(*state),
                _ => None,
            })
            .collect();
        assert_eq!(states, vec!["dead", "dead", "ok"]);
    }

    #[test]
    fn health_monitors_do_nothing_while_paused() {
        let mut m = DeadCallMonitor::new(0.0);
        assert!(run(&mut m, 0, 300, true, NEVER, true, |_| true).is_empty());
    }

    #[test]
    fn one_tick_never_asks_for_two_rebuilds() {
        let mut m = DeadCallMonitor::new(50.0);
        let t = |t| Tick {
            t,
            output_running: true,
            heard: false,
            paused: false,
        };
        assert!(m.tick(t(55.0)).is_empty());
        assert_eq!(m.tick(t(60.0)), vec![Action::Probe]);
        assert!(m.tick(t(61.0)).is_empty());
        let r = m.probe_result(61.0, true);
        assert_eq!(
            r.iter()
                .filter(|a| matches!(a, Action::Rebuild { .. }))
                .count(),
            1
        );
        assert!(m.probe_result(61.0, true).is_empty());
    }

    #[test]
    fn permission_suspect_after_20_s_of_running_zeros_once_and_never_after_audio() {
        let tick = |t: f64, running: bool, heard: bool| Tick {
            t,
            output_running: running,
            heard,
            paused: false,
        };
        let mut p = PermissionSuspect::new();
        let fired: Vec<i32> = (0..60)
            .filter(|&t| p.tick(tick(t as f64, true, false)))
            .collect();
        assert_eq!(fired, vec![20]);
        // Positive control: output not running for the same time never fires.
        let mut q = PermissionSuspect::new();
        assert!(!(0..60).any(|t| q.tick(tick(t as f64, false, false))));
        // A tap that has delivered audio is not a missing grant.
        let mut r = PermissionSuspect::new();
        r.tick(tick(0.0, true, true));
        assert!(!(1..60).any(|t| r.tick(tick(t as f64, true, false))));
    }
}
