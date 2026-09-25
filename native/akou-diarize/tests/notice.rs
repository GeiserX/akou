//! NOTICE credits every crate statically linked into the shipping diarization helper: MIT and BSD ask that
//! their notice travel with the binary, and a pointer to `cargo tree` does not travel.

use std::collections::BTreeSet;
use std::process::Command;

/// The targets the helper builds for. No Intel Mac: ort-sys has no prebuilt ONNX Runtime for
/// `x86_64-apple-darwin`, so the helper does not build there without its own `ORT_LIB_LOCATION`.
const TARGETS: [&str; 5] = [
    "aarch64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
];

/// `name vX.Y.Z` of every crate linked into the binary on some shipping target (build-time
/// proc-macros excluded, the helper itself excluded).
fn linked_crates() -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for t in TARGETS {
        let o = Command::new(env!("CARGO"))
            .args([
                "tree",
                "--locked",
                // CI sets CARGO_TERM_COLOR=always; a coloured `(*)` would survive the trim below.
                "--color",
                "never",
                "--manifest-path",
                concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml"),
                "--target",
                t,
                "-e",
                "normal,no-proc-macro",
                "--prefix",
                "none",
                "--format",
                "{p}",
            ])
            .output()
            .expect("cargo tree");
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            let p = line.trim_end_matches(" (*)").trim();
            if p.is_empty() || p.starts_with("akou-diarize ") {
                continue;
            }
            out.insert(p.to_string());
        }
    }
    out
}

#[test]
fn notice_names_every_crate_linked_into_a_shipping_helper_with_its_version() {
    let notice = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../NOTICE"))
        .expect("NOTICE at the repository root");
    let crates = linked_crates();
    assert!(crates.len() > 10, "{crates:?}");
    let missing: Vec<&String> = crates
        .iter()
        .filter(|c| {
            !notice
                .lines()
                .any(|l| l.trim_start().starts_with(c.as_str()))
        })
        .collect();
    assert!(missing.is_empty(), "missing from NOTICE: {missing:?}");
}
