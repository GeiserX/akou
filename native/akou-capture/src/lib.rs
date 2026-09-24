//! akou's capture helper (docs/DESIGN.md sections 1.3 and 2).
//!
//! Two independent sources, mic and call, each timestamped by the host clock, go through one
//! pipeline on every OS: convert to float at the edge, place on a 48 kHz timeline (`aligner`),
//! write one stereo Ogg Opus file (`opus_writer`), and send both channels at 16 kHz to the app as
//! `akou-capture/1` packets (`protocol`). The health monitors (`health`) watch the sources and ask
//! the front end to rebuild them.
//!
//! The front ends differ per OS (`macos`, `linux`, `windows`); what the Linux and Windows ones
//! decide before calling the OS lives in `pulse_rules` and `wasapi_rules`, which every OS tests.
//! A file front end (`file_source`) feeds the same pipeline from a stereo WAV, so the whole
//! helper runs end to end without devices.
//!
//! DESIGN 1.3 plans a napi addon entry point in this file as a fallback to the child process; it
//! is not built yet, so this is a plain library the binary and the tests share.

pub mod aligner;
pub mod clock;
pub mod convert;
pub mod engine;
pub mod file_source;
pub mod health;
pub mod json;
pub mod opus_writer;
pub mod protocol;
pub mod pulse_rules;
pub mod resample;
pub mod simulate;
pub mod source;
pub mod wasapi_rules;
pub mod wav;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

/// The device front end for this OS.
pub fn device_frontend(
    cfg: &source::DeviceConfig,
) -> Result<Box<dyn source::Frontend>, source::OpenError> {
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(macos::MacFrontend::new(cfg.clone())))
    }
    #[cfg(target_os = "linux")]
    {
        linux::frontend(cfg)
    }
    #[cfg(target_os = "windows")]
    {
        windows::frontend(cfg)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = cfg;
        Err(source::OpenError::unsupported("this operating system"))
    }
}

/// Every input and output this OS reports, for `akou-capture devices`. Opens no stream.
pub fn list_devices() -> Result<source::Endpoints, source::OpenError> {
    #[cfg(target_os = "macos")]
    {
        macos::list_devices()
    }
    #[cfg(target_os = "linux")]
    {
        linux::list_devices()
    }
    #[cfg(target_os = "windows")]
    {
        windows::list_devices()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Err(source::OpenError::unsupported("this operating system"))
    }
}

#[cfg(test)]
mod tests {
    /// [T0.27] Backend selection without a fallback: akou never depends on Screen Capture Kit for
    /// audio. No source file, manifest or locked dependency of the capture crate names it.
    #[test]
    fn t0_27_no_screen_capture_kit_anywhere_in_the_capture_crate() {
        let needle = ["Screen", "Capture", "Kit"].concat().to_lowercase();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = vec![root.join("Cargo.toml"), root.join("Cargo.lock")];
        let mut dirs = vec![root.join("src"), root.join("tests")];
        while let Some(d) = dirs.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    dirs.push(p);
                } else {
                    files.push(p);
                }
            }
        }
        assert!(files.len() > 10, "the scan found the sources");
        for f in files {
            let text = std::fs::read_to_string(&f).unwrap().to_lowercase();
            assert!(!text.contains(&needle), "{} mentions it", f.display());
        }
        // Positive control: the same check finds the name when it is there.
        assert!(
            format!("uses {}", ["Screen", "Capture", "Kit"].concat())
                .to_lowercase()
                .contains(&needle)
        );
    }
}
