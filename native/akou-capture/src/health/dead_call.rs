//! The dead-call-side rule (DESIGN 2.5, TRAPS T0.2 and T1.29), ported from the reference in
//! `src/main/capture/health.ts` with the same test table.
//!
//! The call stream can be silent in two ways, and they cost differently:
//!
//! - **Buffers of zeros.** The stream runs and carries silence. Real calls have minutes of it, so
//!   only 10 s of zeros while the OS says output is running leads to a probe.
//! - **No buffers at all**, after the stream has delivered: its IO callback stopped. While output
//!   runs that is a dead tap almost every time, so it is probed after 1 s instead of 10. It is
//!   still probed first: a tap on one quiet app delivers nothing while other apps play, and the
//!   probe, which listens to the same processes, hears nothing then. Where the probe hears the
//!   whole output instead (Windows and Linux) and only some apps are captured, it would hear the
//!   other apps, so there the engine turns this fast path off (`stopped_rule`) and no buffers
//!   waits the 10 s like zeros.
//!
//! - Either silence counts only while output runs, from the tick output was first seen running:
//!   a tap that was quiet while nothing played, and starts as the call starts, is never "silent
//!   for 35 s" at its first tick of output (the quiet-tap run in docs/gates/M0-results.md).
//! - Action: probe for up to 3 s. If the probe hears audio, rebuild the call stream and report
//!   `dead`. Rebuilds back off 10, 30, 60 s, then every minute, at most 5 per part, whichever
//!   silence asked for them.
//! - A probe is dropped when the stream shows it is alive before the verdict: audio for either
//!   probe, any buffer for a probe of a stopped stream. A tap that just started is never rebuilt.
//! - Audio returning after `dead` reports `ok`. Nothing runs while paused, and one tick never asks
//!   for two rebuilds.
//!
//! Also here, because it watches the same stream: **permission suspect**. A tap that opens but
//! has delivered only zeros for 20 s while output is running is how a missing System Audio
//! Recording grant looks (no error, just silence), so it is reported once with the pane to open.

pub const DEAD_AFTER_S: f64 = 10.0;
/// No buffers at all for this long, while output runs, after the stream delivered: probe now.
pub const STOPPED_AFTER_S: f64 = 1.0;
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
    /// The call stream delivered any buffer since the last tick, zeros included.
    pub delivered: bool,
    pub paused: bool,
}

/// Which silence a probe is about.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Why {
    Zeros,
    Stopped,
}

pub struct DeadCallMonitor {
    /// Start of the current stretch of output running with no audio from the stream.
    silent_since: Option<f64>,
    /// Start of the current stretch of output running with no buffer at all from a stream that
    /// has delivered before.
    stopped_since: Option<f64>,
    ever_delivered: bool,
    /// No buffers at all is probed after `STOPPED_AFTER_S`; off, it waits like zeros.
    pub stopped_rule: bool,
    probing: Option<Why>,
    next_allowed: f64,
    dead: bool,
    pub rebuilds: u32,
}

impl DeadCallMonitor {
    pub fn new(start: f64) -> Self {
        DeadCallMonitor {
            silent_since: Some(start),
            stopped_since: None,
            ever_delivered: false,
            stopped_rule: true,
            probing: None,
            next_allowed: f64::NEG_INFINITY,
            dead: false,
            rebuilds: 0,
        }
    }

    pub fn probing(&self) -> bool {
        self.probing.is_some()
    }

    /// One observation. Returns the actions for this tick, in order.
    pub fn tick(&mut self, o: Tick) -> Vec<Action> {
        if o.paused {
            // Paused time is not silence.
            self.silent_since = None;
            self.stopped_since = None;
            return vec![];
        }
        if o.delivered || o.heard {
            self.ever_delivered = true;
            self.stopped_since = None;
            if self.probing == Some(Why::Stopped) {
                // The stream is running again: its callback did not stop for good.
                self.probing = None;
            }
        }
        if o.heard {
            self.silent_since = None;
            // A probe asked before this audio arrived would only rebuild a tap that works.
            self.probing = None;
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
        if !o.output_running {
            // Silence with nothing playing is not a symptom; the count starts again when
            // output runs.
            self.silent_since = None;
            self.stopped_since = None;
            return vec![];
        }
        let silent_for = o.t - *self.silent_since.get_or_insert(o.t);
        let stopped_for = if self.stopped_rule && !o.delivered && self.ever_delivered {
            o.t - *self.stopped_since.get_or_insert(o.t)
        } else {
            0.0
        };
        if self.probing.is_some() || o.t < self.next_allowed || self.rebuilds >= MAX_REBUILDS {
            return vec![];
        }
        let why = if stopped_for >= STOPPED_AFTER_S {
            Why::Stopped
        } else if silent_for >= DEAD_AFTER_S {
            Why::Zeros
        } else {
            return vec![];
        };
        self.probing = Some(why);
        vec![Action::Probe]
    }

    /// The probe's verdict, within `PROBE_S` of the `Probe` action.
    pub fn probe_result(&mut self, t: f64, heard_audio: bool) -> Vec<Action> {
        let Some(why) = self.probing.take() else {
            return vec![];
        };
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
        let last = self.rebuilds >= MAX_REBUILDS;
        let detail = match (why, last) {
            (Why::Zeros, false) => "output running, probe heard audio, rebuilding",
            (Why::Zeros, true) => {
                "output running, probe heard audio, rebuilding (last automatic rebuild for this part)"
            }
            (Why::Stopped, false) => {
                "the call stream stopped delivering while output runs, probe heard audio, rebuilding"
            }
            (Why::Stopped, true) => {
                "the call stream stopped delivering while output runs, probe heard audio, rebuilding (last automatic rebuild for this part)"
            }
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

    /// Runs the monitor once a second from `from` to `to`; the probe answers `probe_hears`. The
    /// stream delivers buffers every tick (zeros when not `heard`).
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
                delivered: true,
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
            delivered: true,
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

    /// One observation every `step` seconds from `from` to `to`, each input a function of time;
    /// a probe is answered at once with `probe_hears`.
    struct Script {
        running: fn(f64) -> bool,
        heard: fn(f64) -> bool,
        delivered: fn(f64) -> bool,
        probe_hears: bool,
    }

    fn script(
        m: &mut DeadCallMonitor,
        from: f64,
        to: f64,
        step: f64,
        s: &Script,
    ) -> Vec<(f64, Action)> {
        let mut out = vec![];
        let mut i = 0u32;
        loop {
            let t = from + i as f64 * step;
            if t > to + 1e-9 {
                return out;
            }
            i += 1;
            for a in m.tick(Tick {
                t,
                output_running: (s.running)(t),
                heard: (s.heard)(t),
                delivered: (s.delivered)(t) || (s.heard)(t),
                paused: false,
            }) {
                let probe = a == Action::Probe;
                out.push((t, a));
                if probe {
                    for r in m.probe_result(t, s.probe_hears) {
                        out.push((t, r));
                    }
                }
            }
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    /// [T0.2] A stream whose callback stops (no buffers at all) while output runs is probed and
    /// rebuilt within a second, not after the 10 s kept for zeros; the rebuilds still back off
    /// 10, 30, 60 s and stop at 5 per part.
    #[test]
    fn t0_2_a_stream_that_stops_delivering_is_rebuilt_within_a_second() {
        let mut m = DeadCallMonitor::new(0.0);
        let log = script(
            &mut m,
            0.0,
            400.0,
            0.1,
            &Script {
                running: |_| true,
                heard: |t| t < 5.0,
                delivered: |t| t < 5.0,
                probe_hears: true,
            },
        );
        let times = rebuild_times(&log);
        // Last buffer at 4.9: stopped from 5.0, probed and rebuilt at 6.0.
        assert!(close(times[0], 6.0), "{times:?}");
        let gaps: Vec<f64> = times.windows(2).map(|w| (w[1] - w[0]).round()).collect();
        assert_eq!(gaps, vec![10.0, 30.0, 60.0, 60.0]);
        assert_eq!(times.len() as u32, MAX_REBUILDS);
        let detail = log.iter().find_map(|(_, a)| match a {
            Action::Health { detail, .. } => Some(*detail),
            _ => None,
        });
        assert!(detail.unwrap().contains("stopped delivering"), "{detail:?}");
    }

    /// [T0.2] Positive control for the fast path: the same silence as buffers of zeros keeps the
    /// probe-first 10 s rule (real calls have minutes of zeros).
    #[test]
    fn t0_2_positive_control_buffers_of_zeros_wait_the_full_10_s() {
        let mut m = DeadCallMonitor::new(0.0);
        let log = script(
            &mut m,
            0.0,
            30.0,
            0.1,
            &Script {
                running: |_| true,
                heard: |t| t < 5.0,
                delivered: |_| true,
                probe_hears: true,
            },
        );
        let times = rebuild_times(&log);
        assert!(close(times[0], 15.0), "{times:?}");
    }

    /// With the fast path off (a probe that hears the whole output, per-app capture), no
    /// buffers waits the 10 s like zeros.
    #[test]
    fn without_the_stopped_rule_no_buffers_waits_like_zeros() {
        let mut m = DeadCallMonitor::new(0.0);
        m.stopped_rule = false;
        let log = script(
            &mut m,
            0.0,
            30.0,
            0.1,
            &Script {
                running: |_| true,
                heard: |t| t < 5.0,
                delivered: |t| t < 5.0,
                probe_hears: true,
            },
        );
        let times = rebuild_times(&log);
        assert!(close(times[0], 15.0), "{times:?}");
    }

    /// A stream that stopped while nothing plays is not probed: no output, no symptom.
    #[test]
    fn a_stream_with_no_buffers_while_output_is_off_is_never_probed() {
        let mut m = DeadCallMonitor::new(0.0);
        let log = script(
            &mut m,
            0.0,
            120.0,
            0.1,
            &Script {
                running: |_| false,
                heard: |t| t < 5.0,
                delivered: |t| t < 5.0,
                probe_hears: true,
            },
        );
        assert!(log.is_empty(), "{log:?}");
    }

    /// A tap on one quiet app delivers nothing while other apps play; the probe listens to the
    /// same app and hears nothing, so the fast path never rebuilds it and asks again only every
    /// 10 s.
    #[test]
    fn t1_29_a_quiet_app_that_delivers_nothing_is_probed_but_never_rebuilt() {
        let mut m = DeadCallMonitor::new(0.0);
        let log = script(
            &mut m,
            0.0,
            60.0,
            0.1,
            &Script {
                running: |_| true,
                heard: |t| t < 5.0,
                delivered: |t| t < 5.0,
                probe_hears: false,
            },
        );
        assert!(rebuild_times(&log).is_empty());
        let probes = log.iter().filter(|(_, a)| *a == Action::Probe).count();
        assert!((5..=6).contains(&probes), "{probes}");
    }

    /// [T0.16] The quiet-tap run: the tap was silent for 35 s with nothing playing, then the
    /// call started. Output is seen running a little before the tap's first buffer reaches the
    /// monitor. That is not 35 s of silence: no probe, no rebuild.
    #[test]
    fn a_tap_that_starts_with_the_call_is_not_probed_for_the_silence_before() {
        let mut m = DeadCallMonitor::new(0.0);
        let log = script(
            &mut m,
            0.0,
            60.0,
            0.02,
            &Script {
                running: |t| t >= 34.9,
                heard: |t| t >= 35.2,
                delivered: |t| t >= 35.2,
                probe_hears: true,
            },
        );
        assert!(log.is_empty(), "{log:?}");
        // Positive control: when the tap stays silent for 10 s of that output, it is probed and
        // rebuilt as before.
        let mut control = DeadCallMonitor::new(0.0);
        let log = script(
            &mut control,
            0.0,
            60.0,
            0.02,
            &Script {
                running: |t| t >= 34.9,
                heard: |t| t >= 45.0,
                delivered: |t| t >= 45.0,
                probe_hears: true,
            },
        );
        assert!(
            !rebuild_times(&log).is_empty(),
            "silence while output runs still counts"
        );
    }

    /// Audio that arrives after the probe was asked for and before its verdict proves the tap
    /// works: the verdict is dropped, nothing is rebuilt (the quiet-tap run's rebuild).
    #[test]
    fn audio_during_the_probe_drops_its_verdict() {
        let mut m = DeadCallMonitor::new(0.0);
        let tick = |t: f64, heard: bool, delivered: bool| Tick {
            t,
            output_running: true,
            heard,
            delivered,
            paused: false,
        };
        assert!(m.tick(tick(5.0, false, true)).is_empty());
        assert_eq!(m.tick(tick(10.0, false, true)), vec![Action::Probe]);
        assert!(m.tick(tick(10.5, true, true)).is_empty());
        assert!(m.probe_result(11.0, true).is_empty());
        assert_eq!(m.rebuilds, 0);
        // Any buffer drops a probe of a stopped stream; zeros do not drop a probe of zeros.
        let mut s = DeadCallMonitor::new(0.0);
        assert!(s.tick(tick(0.0, false, true)).is_empty());
        assert!(s.tick(tick(0.5, false, false)).is_empty());
        assert_eq!(s.tick(tick(1.5, false, false)), vec![Action::Probe]);
        assert!(s.tick(tick(1.6, false, true)).is_empty());
        assert!(s.probe_result(1.7, true).is_empty());
        let mut z = DeadCallMonitor::new(0.0);
        assert_eq!(z.tick(tick(10.0, false, true)), vec![Action::Probe]);
        assert!(z.tick(tick(10.1, false, true)).is_empty());
        let r = z.probe_result(10.2, true);
        assert!(
            r.iter().any(|a| matches!(a, Action::Rebuild { .. })),
            "{r:?}"
        );
    }

    #[test]
    fn permission_suspect_after_20_s_of_running_zeros_once_and_never_after_audio() {
        let tick = |t: f64, running: bool, heard: bool| Tick {
            t,
            output_running: running,
            heard,
            delivered: true,
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
