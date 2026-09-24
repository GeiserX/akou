//! The Windows front end (DESIGN 2.2): WASAPI process loopback excluding akou's own process tree
//! for the call side and the default communications device for the mic. It arrives in M3; until
//! then device capture reports "unsupported on this OS yet" through the protocol and exits 69,
//! and the file source (`--from-wav`) runs the whole pipeline here.

use crate::source::{DeviceConfig, Frontend, OpenError};

pub fn frontend(_cfg: &DeviceConfig) -> Result<Box<dyn Frontend>, OpenError> {
    Err(OpenError::unsupported("Windows"))
}
