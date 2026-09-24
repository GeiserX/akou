//! Health monitors (DESIGN 2.5). Each is a pure state machine driven by a clock in seconds, so
//! the rules are tested without devices; the engine feeds them observations and carries out
//! what they ask for. Nothing runs while paused, and one tick never asks for two rebuilds.

pub mod dead_call;
pub mod device_watch;
pub mod stall;
