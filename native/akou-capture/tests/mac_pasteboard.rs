//! The macOS pasteboard and keyboard layouts behind `dictate`'s paste (docs/ux/DICTATION.md DC-N6),
//! run on the main thread: AppKit serves a pasteboard promise only on the main run loop, and the
//! layout calls need the main thread too. The default test harness runs each test on another
//! thread, so this file is its own `main` (`harness = false`) and prints libtest's result lines,
//! which the CI floor counts.
//!
//! Everything here uses a private named pasteboard, never the one the user copies to; nothing is
//! posted and no grant is asked, so it runs on a developer's Mac as it does in CI. The promise is
//! read by another process (`osascript`), as a real paste target reads it.

#[cfg(target_os = "macos")]
mod mac {
    use std::process::Command;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use akou_capture::dictate::insert::{Clipboard, Snapshot};
    use akou_capture::dictate::live::Msg;
    use akou_capture::dictate::mac_insert::{CONCEALED, Pasteboard, TEXT, layout, wait};

    fn name() -> String {
        format!("akou-capture-test-{}", std::process::id())
    }

    /// Runs a JavaScript for Automation snippet in another process while this thread turns the
    /// main run loop through the worker's own `wait`, as the dictate process does.
    fn elsewhere(js: String) -> String {
        let (tx, rx) = mpsc::channel::<Msg>();
        let reader = std::thread::spawn(move || {
            let out = Command::new("/usr/bin/osascript")
                .args(["-l", "JavaScript", "-e", &js])
                .output()
                .expect("osascript runs");
            drop(tx);
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        });
        let start = Instant::now();
        while !reader.is_finished() {
            assert!(
                start.elapsed() < Duration::from_secs(30),
                "the other process never got an answer"
            );
            let _ = wait(&rx, Duration::from_millis(10));
        }
        reader.join().unwrap()
    }

    fn read_elsewhere(ty: &str) -> String {
        elsewhere(format!(
            "ObjC.import('AppKit'); var s = $.NSPasteboard.pasteboardWithName('{}').stringForType('{ty}'); s.isNil() ? '<nil>' : s.js",
            name()
        ))
    }

    fn sorted(mut s: Snapshot) -> Snapshot {
        s.sort();
        s
    }

    /// DC-N6: the text is a promise another process can read, and that read (only a read of the
    /// text, not of a marker) is the receipt; a read changes nothing on the pasteboard.
    pub fn dc_n6_the_promise_is_served_to_another_process_and_its_read_counted() {
        let mut pb = Pasteboard::named(&name()).unwrap();
        let count = pb.publish("hello from akou").unwrap();
        assert!(pb.reads().is_empty());
        read_elsewhere(CONCEALED);
        assert!(
            pb.reads().is_empty(),
            "a marker read is a clipboard manager, not the target"
        );
        assert_eq!(read_elsewhere(TEXT), "hello from akou");
        assert_eq!(pb.reads().len(), 1, "one read of the text");
        assert_eq!(pb.change_count(), count);
    }

    /// DC-N6: every item and every type comes back after the text took the pasteboard, as
    /// another process sees it.
    pub fn dc_n6_a_snapshot_restores_every_item_and_type() {
        let mut pb = Pasteboard::named(&name()).unwrap();
        let before: Snapshot = vec![
            (format!("0\t{TEXT}"), b"first".to_vec()),
            ("0\tcom.example.akou-test".into(), vec![1, 2, 3, 0, 255]),
            (format!("1\t{TEXT}"), b"second".to_vec()),
        ];
        pb.restore(&before);
        let snap = pb.snapshot();
        assert_eq!(sorted(snap.clone()), sorted(before.clone()));
        let c0 = pb.change_count();
        pb.publish("the dictation").unwrap();
        assert!(pb.change_count() > c0);
        assert_eq!(read_elsewhere(TEXT), "the dictation");
        pb.restore(&snap);
        assert_eq!(sorted(pb.snapshot()), sorted(before));
        let items = elsewhere(format!(
            "ObjC.import('AppKit'); $.NSPasteboard.pasteboardWithName('{}').pasteboardItems.count",
            name()
        ));
        assert_eq!(items, "2", "two items again, seen from outside");
        let second = elsewhere(format!(
            "ObjC.import('AppKit'); $.NSPasteboard.pasteboardWithName('{}').pasteboardItems.objectAtIndex(1).stringForType('{TEXT}').js",
            name()
        ));
        assert_eq!(second, "second", "each item keeps its own text");
    }

    /// DC-N8: a copy the helper chose for a password field carries the concealed marker; an
    /// ordinary one does not (positive control).
    pub fn dc_n8_a_concealed_copy_carries_the_marker() {
        let mut pb = Pasteboard::named(&name()).unwrap();
        let has_marker =
            |pb: &mut Pasteboard| pb.snapshot().iter().any(|(k, _)| k.ends_with(CONCEALED));
        pb.write("hunter2", true).unwrap();
        assert!(has_marker(&mut pb));
        assert_eq!(read_elsewhere(TEXT), "hunter2", "still a lasting copy");
        pb.write("plain", false).unwrap();
        assert!(!has_marker(&mut pb));
    }

    /// DC-N6: the V of the paste chord comes from the layout with Command held: Dvorak types V
    /// on the key QWERTY calls period (47), "Dvorak - QWERTY Command" switches to QWERTY under
    /// Command (9), and US is 9. The layouts are read installed, never selected.
    pub fn dc_n6_the_paste_key_comes_from_the_layout() {
        for (id, want) in [
            ("com.apple.keylayout.US", 9),
            ("com.apple.keylayout.Dvorak", 47),
            ("com.apple.keylayout.DVORAK-QWERTYCMD", 9),
        ] {
            assert_eq!(layout::keycode_in(id, 'v'), Some(Some(want)), "{id}");
        }
        assert_eq!(layout::keycode_in("com.example.no-such-layout", 'v'), None);
        assert!(
            layout::keycode('v').is_some(),
            "the active layout, or its fallback"
        );
    }

    pub fn run() -> bool {
        let tests: [(&str, fn()); 4] = [
            (
                "dc_n6_the_promise_is_served_to_another_process_and_its_read_counted",
                dc_n6_the_promise_is_served_to_another_process_and_its_read_counted,
            ),
            (
                "dc_n6_a_snapshot_restores_every_item_and_type",
                dc_n6_a_snapshot_restores_every_item_and_type,
            ),
            (
                "dc_n8_a_concealed_copy_carries_the_marker",
                dc_n8_a_concealed_copy_carries_the_marker,
            ),
            (
                "dc_n6_the_paste_key_comes_from_the_layout",
                dc_n6_the_paste_key_comes_from_the_layout,
            ),
        ];
        println!("\nrunning {} tests", tests.len());
        let mut failed = 0;
        for (n, f) in tests {
            let ok = std::panic::catch_unwind(f).is_ok();
            failed += usize::from(!ok);
            println!(
                "test mac_pasteboard::{n} ... {}",
                if ok { "ok" } else { "FAILED" }
            );
        }
        if let Some(pb) = Pasteboard::named(&name()) {
            pb.release_globally();
        }
        println!(
            "\ntest result: {}. {} passed; {failed} failed",
            if failed == 0 { "ok" } else { "FAILED" },
            4 - failed
        );
        failed == 0
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    if !mac::run() {
        std::process::exit(101);
    }
}
