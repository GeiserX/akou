# DC-N6: where macOS serves a pasteboard promise

The question from [DICTATION.md](../ux/DICTATION.md) DC-N6. The paste publishes the text as a promise (`declareTypes:owner:`), and the target's read of it is the receipt that restores the old clipboard. The owner learns of the read when AppKit calls `pasteboard:provideDataForType:`. On which thread does that call arrive, in a process with no `NSApplication`, such as `akou-capture dictate`?

Result: pass

## Answer

- AppKit serves a promise **only on the main thread's run loop**, whichever thread declared it. A promise declared on another thread is still served on the main run loop. A promise whose process never turns its main run loop is never served, and the reader waits.
- So the dictate worker stays on the main thread and turns the main run loop while it waits for its next message ([mac_insert.rs](../../native/akou-capture/src/dictate/mac_insert.rs) `wait`, through [live.rs](../../native/akou-capture/src/dictate/live.rs) `serve_with`). A read is answered within one 10 ms step. The keyboard layout calls the paste chord needs (`TISCopyCurrentKeyboardLayoutInputSource`, `UCKeyTranslate`) also want the main thread, so the same choice serves both.
- The key tap has its own thread and run loop and never touches the pasteboard (DC-N1), so the worker waiting on the run loop never delays the tap's answer.
- While the worker is blocked elsewhere (opening the microphone, at most 3 s; an accessibility read, at most 200 ms), a read waits until it is free. The read's time is stamped when the owner answers, so the receipt rules still count it.

## The check

- Date: 2026-09-27, on a Mac with macOS 27, with a private named pasteboard (`NSPasteboard(name:)`), never the general one. Nothing was posted and no grant was asked.
- A Swift program declared `public.utf8-plain-text` plus `org.nspasteboard.TransientType` with itself as the owner, then another process read the text with `osascript -l JavaScript` (`$.NSPasteboard.pasteboardWithName(…).stringForType(…)`). Each case waited up to 5 s.

| case | declared on | main thread | reader got | owner called |
|---|---|---|---|---|
| A | main | turns the run loop in 10 ms slices | the text, 0.31 s | once, on the main thread |
| B | a background thread | turns the run loop | the text, 0.08 s | once, on the main thread |
| C | a background thread that turns its own run loop | sleeps | nothing in 6 s | never |
| D | main | sleeps | nothing in 5 s | never |

The same rule is checked on every macOS CI run by [tests/mac_pasteboard.rs](../../native/akou-capture/tests/mac_pasteboard.rs), a test that is its own `main` (`harness = false`) because the default test harness runs tests off the main thread. It publishes on a private pasteboard, reads it from `osascript` while turning the run loop through the worker's own `wait`, and counts one receipt for the text and none for a marker. With `wait` changed to never turn the run loop, the read times out and the test fails.

## The paste on a real text view

The helper job in [ci.yml](../../.github/workflows/ci.yml) runs the shipping helper on a GitHub macOS runner against a throwaway AppKit window holding an `NSTextView`. The helper brings the window to the front (`focus`), pastes with Enter as the send key, then types a second piece with an accent and an emoji. The field must hold both, and the clipboard must hold what it held before. That runner trusts the processes a CI step starts for Accessibility ([dc-k1-accessibility-grant.md](dc-k1-accessibility-grant.md)), so it is the only place a real paste runs. A test on a developer's Mac never pastes, types or changes the clipboard.

First run: <https://github.com/GeiserX/akou/actions/runs/36296855992> (job `helper (macos-latest)`). The target read the promise 26 ms after the chord (`"receipt_ms":26`), Enter followed the read, the typed piece arrived whole, and the clipboard came back. The run before it is the positive control. Its window had no Edit menu, so Command+V never reached the text view and nothing read the promise. The helper answered `insert.failed no-receipt` after 8 s, and the step failed. This is also a trap for any other test target: in AppKit, Command+V pastes through the menu's key equivalent, and a window with no menu ignores it.

## Still open

- **The pasteboard privacy alert.** Apple announced with macOS 15.4 that macOS will alert when an app reads the general pasteboard without the user pasting, with a per-app `accessBehavior` (ask, always allow, never allow) and a developer preview switch (`EnablePasteboardPrivacyDeveloperPreview`). The paste's snapshot reads every type of the general pasteboard before publishing, so under "ask" every dictation may alert, attributed to akou. Under "never allow" the reads come back empty; an empty snapshot now leaves the dictation on the clipboard as a lasting copy instead of restoring nothing, which would have cleared it. Needs a real Mac with the setting on: if the alert shows, the snapshot must check `accessBehavior` first, and DC-N3's onboarding must ask for "always allow" once.
- **Electron and Chromium targets.** A dormant accessibility tree reads as `unknown`, which the focus guard (DC-N9) sends to the draft box. Paste into Slack on a real Mac before calling DC-N6 done on macOS.
- **The layout fallback on a non-Latin layout.** The chord's V comes from the active layout with Command held, else from the ASCII-capable layout. Measured here on installed layouts without selecting them: US 9, Dvorak 47, "Dvorak - QWERTY Command" 9. A paste with Russian or Greek selected on a real Mac is not yet checked.
