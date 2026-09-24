//! Stall and silent-from-start (DESIGN 2.5).
//!
//! - **Stall.** A source that has delivered audio and then delivers nothing for 3 s *while the
//!   OS reports the device present and running* is rebuilt, retrying every 3 s. A quiet tap during
//!   silence is not a stall: with no output running, a tap delivers nothing by design.
//! - **Silent from start.** If neither stream has delivered anything 2 s after `capturing`, the
//!   helper reports `no-buffers` once for each open channel; the app shows a banner and asks for
//!   one rebuild of each.

pub const STALL_S: f64 = 3.0;
pub const NO_BUFFERS_S: f64 = 2.0;

#[derive(Clone, Debug, PartialEq)]
pub enum StallAction {
    /// Entered the stalled state: report it.
    Stalled { silent_for: f64 },
    /// Rebuild the source now.
    Rebuild { rebuilds: u32 },
    /// Delivery resumed after a stall.
    Recovered { rebuilds: u32 },
}

#[derive(Default)]
pub struct StallMonitor {
    ever: bool,
    last: Option<f64>,
    next_retry: f64,
    stalled: bool,
    pub rebuilds: u32,
}

impl StallMonitor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn tick(
        &mut self,
        t: f64,
        delivered: bool,
        device_running: bool,
        paused: bool,
    ) -> Vec<StallAction> {
        if paused {
            // Paused time is not a stall; the clock restarts at the next tick.
            self.last = None;
            return vec![];
        }
        if delivered {
            self.ever = true;
            self.last = Some(t);
            if self.stalled {
                self.stalled = false;
                return vec![StallAction::Recovered {
                    rebuilds: self.rebuilds,
                }];
            }
            return vec![];
        }
        if !self.ever {
            return vec![];
        }
        let last = *self.last.get_or_insert(t);
        let silent_for = t - last;
        if !device_running || silent_for < STALL_S || t < self.next_retry {
            return vec![];
        }
        self.next_retry = t + STALL_S;
        self.rebuilds += 1;
        let mut out = vec![];
        if !self.stalled {
            self.stalled = true;
            out.push(StallAction::Stalled { silent_for });
        }
        out.push(StallAction::Rebuild {
            rebuilds: self.rebuilds,
        });
        out
    }
}

/// Fires once, `NO_BUFFERS_S` after `capturing`, when no channel has delivered anything.
#[derive(Default)]
pub struct NoBuffers {
    done: bool,
}

impl NoBuffers {
    pub fn tick(&mut self, since_capturing: f64, any_delivered: bool) -> bool {
        if self.done {
            return false;
        }
        if any_delivered {
            self.done = true;
            return false;
        }
        if since_capturing >= NO_BUFFERS_S {
            self.done = true;
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ticks every 0.5 s from 0 to `to`.
    fn run(
        m: &mut StallMonitor,
        to: f64,
        delivered: impl Fn(f64) -> bool,
        running: bool,
    ) -> Vec<(f64, StallAction)> {
        let mut out = vec![];
        let mut t = 0.0;
        while t <= to {
            for a in m.tick(t, delivered(t), running, false) {
                out.push((t, a));
            }
            t += 0.5;
        }
        out
    }

    #[test]
    fn a_source_that_stops_while_running_is_rebuilt_every_3_s_then_recovers() {
        let mut m = StallMonitor::new();
        let log = run(&mut m, 20.0, |t| !(5.0..14.0).contains(&t), true);
        let rebuilds: Vec<f64> = log
            .iter()
            .filter(|(_, a)| matches!(a, StallAction::Rebuild { .. }))
            .map(|(t, _)| *t)
            .collect();
        // Last delivery at 4.5: stalled from 7.5, retried every 3 s until audio at 14.
        assert_eq!(rebuilds, vec![7.5, 10.5, 13.5]);
        assert_eq!(
            log.iter()
                .filter(|(_, a)| matches!(a, StallAction::Stalled { .. }))
                .count(),
            1
        );
        assert_eq!(
            log.last().unwrap(),
            &(14.0, StallAction::Recovered { rebuilds: 3 })
        );
    }

    #[test]
    fn positive_control_a_quiet_tap_with_the_device_not_running_is_not_a_stall() {
        let mut m = StallMonitor::new();
        assert!(run(&mut m, 60.0, |t| t < 5.0, false).is_empty());
        let mut control = StallMonitor::new();
        assert!(!run(&mut control, 60.0, |t| t < 5.0, true).is_empty());
    }

    #[test]
    fn a_source_that_never_delivered_is_not_a_stall() {
        let mut m = StallMonitor::new();
        assert!(run(&mut m, 60.0, |_| false, true).is_empty());
    }

    #[test]
    fn paused_time_is_not_a_stall() {
        let mut m = StallMonitor::new();
        m.tick(0.0, true, true, false);
        for i in 1..100 {
            assert!(m.tick(i as f64, false, true, true).is_empty());
        }
        // After the pause the 3 s count starts again.
        assert!(m.tick(100.0, false, true, false).is_empty());
        assert!(m.tick(102.0, false, true, false).is_empty());
        assert!(!m.tick(103.0, false, true, false).is_empty());
    }

    #[test]
    fn t0_16_no_buffers_fires_once_at_2_s_and_never_once_anything_arrived() {
        let mut n = NoBuffers::default();
        let fired: Vec<u32> = (0..10).filter(|&i| n.tick(i as f64 * 0.5, false)).collect();
        assert_eq!(fired, vec![4]);
        let mut m = NoBuffers::default();
        assert!(!m.tick(0.5, true));
        assert!(!m.tick(3.0, false));
    }
}
