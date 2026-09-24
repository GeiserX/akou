//! Device watch (DESIGN 2.2 and 2.5): a changed default input or output rebuilds that source onto
//! the new default, and a pinned microphone that vanished falls back to the default.
//!
//! The front end polls the OS for the current default device once a second (a property read,
//! which never prompts) and hands it here; this decides whether anything changed.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceId {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    /// A new default device: rebuild onto it.
    Changed(DeviceId),
    /// No default device at all any more.
    Lost,
}

#[derive(Default)]
pub struct DeviceWatch {
    seen: bool,
    last: Option<String>,
}

impl DeviceWatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// A watch whose baseline is the device a source actually opened; with none, the first
    /// reading is the baseline.
    pub fn starting_at(opened: Option<&DeviceId>) -> Self {
        DeviceWatch {
            seen: opened.is_some(),
            last: opened.map(|d| d.id.clone()),
        }
    }

    /// One reading of the current default. The first reading is the baseline.
    pub fn observe(&mut self, current: Option<&DeviceId>) -> Option<Change> {
        let id = current.map(|d| d.id.clone());
        if !self.seen {
            self.seen = true;
            self.last = id;
            return None;
        }
        if id == self.last {
            return None;
        }
        self.last = id;
        Some(match current {
            Some(d) => Change::Changed(d.clone()),
            None => Change::Lost,
        })
    }
}

/// Which microphone to open: the pinned one while it exists, else the default.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MicTarget {
    Default,
    Pinned(String),
    /// The pinned device is gone; the default is used and `health` says so.
    FallbackFromPinned(String),
}

pub fn mic_target(requested: &str, available: &[String]) -> MicTarget {
    match requested {
        "default" => MicTarget::Default,
        id if available.iter().any(|a| a == id) => MicTarget::Pinned(id.to_string()),
        id => MicTarget::FallbackFromPinned(id.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(id: &str) -> DeviceId {
        DeviceId {
            id: id.into(),
            name: format!("{id} name"),
        }
    }

    #[test]
    fn the_first_reading_is_the_baseline_and_only_a_different_id_is_a_change() {
        let mut w = DeviceWatch::new();
        assert_eq!(w.observe(Some(&dev("a"))), None);
        assert_eq!(w.observe(Some(&dev("a"))), None);
        assert_eq!(w.observe(Some(&dev("b"))), Some(Change::Changed(dev("b"))));
        assert_eq!(w.observe(None), Some(Change::Lost));
        assert_eq!(w.observe(None), None);
        assert_eq!(w.observe(Some(&dev("a"))), Some(Change::Changed(dev("a"))));
    }

    #[test]
    fn a_default_that_changed_while_the_source_opened_is_a_change_at_the_first_reading() {
        let mut w = DeviceWatch::starting_at(Some(&dev("a")));
        assert_eq!(w.observe(Some(&dev("b"))), Some(Change::Changed(dev("b"))));
        let mut same = DeviceWatch::starting_at(Some(&dev("a")));
        assert_eq!(same.observe(Some(&dev("a"))), None);
        // Positive control: without the opened device the first reading is the baseline.
        assert_eq!(
            DeviceWatch::starting_at(None).observe(Some(&dev("b"))),
            None
        );
    }

    #[test]
    fn a_vanished_pinned_microphone_falls_back_to_the_default() {
        let avail = vec!["usb".to_string(), "builtin".to_string()];
        assert_eq!(mic_target("default", &avail), MicTarget::Default);
        assert_eq!(mic_target("usb", &avail), MicTarget::Pinned("usb".into()));
        assert_eq!(
            mic_target("headset", &avail),
            MicTarget::FallbackFromPinned("headset".into())
        );
    }
}
