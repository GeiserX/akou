//! The Linux front end (DESIGN 2.2): PipeWire capture of the default sink's monitor for the call
//! side and the default source for the mic, with a PulseAudio monitor fallback. It arrives in M4;
//! until then device capture reports "unsupported on this OS yet" through the protocol and exits
//! 69, and the file source (`--from-wav`) runs the whole pipeline here.

use crate::source::{DeviceConfig, Frontend, OpenError};

pub fn frontend(_cfg: &DeviceConfig) -> Result<Box<dyn Frontend>, OpenError> {
    Err(OpenError::unsupported("Linux"))
}
