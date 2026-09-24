# M0 gate results on the reference Mac mini

This page records what the M0 gates measured on real hardware, gate by gate: what ran, the numbers, the verdict against the pass criterion in [ROADMAP.md](../ROADMAP.md), and what is still open. The raw outputs sit next to it in this folder. No audio is kept.

**The machine.** The reference Mac mini: Apple M4, 10 cores, 16 GB, macOS 26.6, with System Integrity Protection (SIP) turned off. It was running other work during every measurement (a virtual machine and compile jobs, load average 5 to 9 on 10 cores). So every speed figure here is a figure under background load.

**The setup.** akou at commit `f6cabfc` (the G5 re-run at the later commit that fixed its runner), the helper built with `cargo build --release` and, for G5, `--features simulate`, the app run as `bun src/main/index.ts` with `AKOU_HEADLESS=1`, launched by `akou start` exactly as the CLI does it. The Mac mini has no microphone and no other input device, so the mic was the BlackHole 2ch virtual device: a signal played into its output comes back on its input. The call side was the process tap listening to everything the Mac plays, with "Mac mini Speakers" as the default output.

There are three rounds. The first ran G3 to G8. The second re-ran G3-lite and G8 so their raw output is on record, added a 14-minute run in which the tap is really quiet (for the first-words and muted-memory checks, which the hour run could not test), and added positive controls for the drift analysis. Where the two rounds differ, this page gives the second round's numbers. The third re-ran G4 at commit `331c7e6`, after the two capture fixes in [#13](https://github.com/GeiserX/akou/pull/13), on the same machine under heavier background load (load average 4 to 20); its numbers sit next to the old ones in [the G4 re-run](#the-re-run-after-the-capture-fixes).

## Summary

| Gate | Verdict | Key numbers |
|---|---|---|
| G3 (lite) | Partial | The app-spawned helper recorded real call audio from the tap on the right channel for 10 minutes. The mic came through as digital silence over SSH, and no single session could record both (see below). |
| G4 | Partial | Re-run after the capture fixes. Quiet-tap run: the first start after a silent tap now costs no gap, no lost speech and no misalignment (before: a 21 ms gap, the first 20 ms of the first word, and 33 ms off for about 40 s). Hour run: no gap over 5 ms, and the call channel held the host clock to within 0.14 ms (before: one 10.5 s gap at minute 52 when the tap died). No tap died this time, so the 1 s rebuild was not seen live; simulated tests cover it. Left-right drift between two clocks was not measured, and cannot be on this machine. |
| G5 | Pass | Re-run with a stricter runner. Hang: killed at the 5 s budget, `part.ended {reason: killed}`, and a new call started in 78 ms while the teardown still hung. Crash: new part in 79 ms, 0.13 s of call audio lost. Real device helper SIGKILLed: new part in 81 ms, 1.25 s lost. The API never missed a poll. |
| G6 | Pass (M-series half) | Real-time factor 0.081 for both channels, worst case. Committed line 1.02 s after the utterance ends (median), 1.14 s at worst. |
| G8 | Pass | Cold `akou start` p95 193 ms (20 runs, 20 separate app processes), warm p95 159 ms. |

## Recording from SSH versus the console session

This decides how every capture gate can run on a remote box, so it comes first.

macOS decides microphone and system-audio access per "responsible process". For anything started over SSH that is `sshd-keygen-wrapper`. For anything started in a Terminal window on the console, it is Terminal. On this Mac, `sshd-keygen-wrapper` holds a Screen Recording grant and no Microphone grant. Terminal holds a Microphone grant and no system-audio grant.

| How the helper ran | Process tap (call side) | BlackHole input (mic side) |
|---|---|---|
| Plain SSH, and the app spawned by `akou start` over SSH | Real audio, no prompt | Digital silence (-120 dBFS in the helper's level lines) with no error and no prompt |
| `sudo launchctl asuser 501 sudo -u <user> …` | Not tried | Digital silence, same as SSH |
| A Terminal window on the console (`open -a Terminal x.command`), `--call none` | Not opened | Real audio: the -40 dBFS pilot tone read -44.9 dBFS |
| A Terminal window on the console, `--call system` | Blocked: macOS showed "Terminal would like access to record your system audio", and the helper gave up after its 15 s open budget (`warn open: the process tap did not open in time`) | Not reached |

Five things we learned the hard way, and they belong in [TRAPS.md](../TRAPS.md) once M1 needs them:

- **SIP off does not suppress the system-audio prompt.** The prompt appeared on the console for Terminal.
- **One pending system-audio prompt blocks every process tap on the Mac.** While the Terminal prompt waited for a click, the tap also failed to open from SSH. The first G4 attempt got `503 capture_failed {stage: "open"}` after the 10 s cold budget. We cleared it by ending the user's `tccd` (SIGKILL, because it ignored SIGTERM). No decision was recorded. The dialog window is still on screen, orphaned. We did not click it, and clicking it now probably does nothing.
- **A muted BlackHole output makes its input silent.** BlackHole's output was muted in the system's volume settings, and that zeroes the loopback. We unmuted it for the gates and muted it again afterwards.
- **The call train must play to the default output, and a muted one is fine.** The dead-call rule reads "output running" from the default output device only. Played into another device (BlackHole, say), the call never sets that flag, the rule can never fire, and any check of it passes without being tested. The tap hears what processes play before the device's mute, so the G4 re-run played the call train to the built-in speakers, muted, and nothing was audible, while the hour run's call channel read -35.7 dBFS RMS.
- **A missing microphone grant looks exactly like a quiet microphone.** Over SSH the mic stream opened, delivered buffers on time, sent `first_audio`, and every sample was zero. Nothing in the protocol says "denied". This is the mic-side twin of the `permission-suspect` rule in DESIGN 2.5, and akou has no mic-side rule yet.

So on this box, a recording with both a real mic and a real tap needs one of two things. A person answers the system-audio prompt for Terminal at the console, or the Microphone grant exists for whatever runs over SSH. We changed neither, because both are security settings.

## G3 (lite): the app-spawned helper captures real audio

**What ran.** [`scripts/gates/record-call.ts`](../../scripts/gates/record-call.ts) over SSH, with the app not running: it timed `akou start`, which launched the app headless, and the app spawned the helper. A signal source ([`drift-signal`](../../native/akou-capture/examples/drift-signal.rs)) played its mic train into BlackHole and its call train into the speakers. Then 612 s of recording, stop, quit, and the Opus file measured per channel by [`drift-test.ts`](../../scripts/drift-test.ts). The raw output is [g3-lite.json](g3-lite.json).

**Numbers.** 201 after 179 ms, including launching the app. The helper reported audio 92 ms after spawn. The right channel, the call side, had RMS -35.7 dBFS and peak -4.2 dBFS. All 59 call chirps were found where they should be, matched at 0.973 or better, with no gap over 5 ms. The left channel, the mic side, had RMS -105.1 dBFS and peak -50.8 dBFS. That is digital silence plus a little Opus stereo crosstalk from the right channel, because the SSH session has no Microphone grant (previous section). The first round's 36 s run gave the same picture (201 after 0.24 s, audio at 91 ms, right RMS -30.1 dBFS, left -93 dBFS) but kept no raw output, so those figures are superseded by this run.

**Verdict: partial.** The tap works through the app-spawned helper and lands on the correct channel. Real mic audio through the same helper was not shown in any one session on this box. Permission attribution to a signed app cannot be judged on a SIP-off box: nothing here is signed, and the prompts that did appear named Terminal, the process that launched everything.

**Still open.** The full G3: a signed test app on a SIP-on Mac, prompts that name akou, grants that survive a re-signed update.

## G4: two-clock capture

G4 ran as three pieces: an hour run, a 14-minute run with a really quiet tap, and positive controls for the analysis.

**What a BlackHole mic can and cannot measure.** BlackHole is a virtual device. It has no crystal of its own: its clock is the host clock. So a recording with BlackHole as the mic can only bound the tap against the host clock. It cannot measure what G4 exists for, one real device's clock drifting against another's. That needs a real input device with its own clock, a USB mic or a USB audio interface, and this Mac mini has none. Even with every grant in place, a re-run on this machine with BlackHole would not close G4.

### The hour run

**What ran.** The signal source played two marker trains from one process into two devices, scheduled on the host clock. Into BlackHole (the mic): a 500 Hz pilot tone at -40 dBFS and a 3 to 4.5 kHz chirp every 10 s. Into the speakers (the call): a 900 Hz pilot and a 1.5 to 2.5 kHz chirp every 10 s, 5 s after the mic chirp. The call side stayed silent for the first 35 s and paused from minute 35 to minute 45, and each time it started it played a spoken clip ("First words after the silence…") from its very first sample.

The recording ran through the real path: `akou start` over SSH, then the app-spawned helper for 3,721 s, then stop. [`scripts/drift-test.ts`](../../scripts/drift-test.ts) finds every chirp by cross-correlation and compares it with its scheduled host time. The raw output is [g4-drift.json](g4-drift.json), and the memory samples (every 30 s) are in [g4-memory.csv](g4-memory.csv).

The global tap hears every output device, BlackHole included. So during this hour the mic train was also in the call channel (366 of 373 mic chirps were found there), and the tap was never quiet: not in the first 35 s, and not during the 10-minute pause. That makes this run blind to the checks that need a quiet tap. They are covered by the quiet-tap run below.

**Numbers.**

| Check | Result |
|---|---|
| Call channel against the host clock | 307 of 308 chirps found (the missing one fell in the gap below). Latency 8.29 to 8.45 ms over the hour, a spread of 0.16 ms, fitted slope 0.00 ms per hour. The alignment was the same after the gap and after the pause. The positive controls below show the analysis does report a slope when one exists. |
| File length against wall time | 3,720.977 s of audio for 3,720.997 s of wall time: 20 ms short over the hour |
| Gaps over 20 ms | **One, 10.5 s long, at 3,120.4 s (minute 52).** None over 5 ms anywhere else on the call channel. |
| Both channels the same length | 3,720.977 s each. |
| First words after silence | Not measured here: the tap kept hearing the mic train, so it never went quiet. See the quiet-tap run. |
| Memory with the call source muted for 10 minutes | Not measured here, for the same reason. The helper held 8.4 to 13.8 MB over the hour. |
| Left-right offset under 200 ms per hour | **Not measured**: the mic channel was digital silence over SSH, and a BlackHole mic could not measure two-clock drift anyway (above). |
| macOS 14.2 or 14.3 run | Not done: no such machine. |

**The gap.** At 3,120 s the mic stream reported `A buffer underrun or overrun occurred` and the helper rebuilt it (`device mic lost`, then `rebuilt`). At the same moment the tap stopped delivering anything. The dead-call rule then waited its 10 s, probed, heard audio, rebuilt the tap after 10.4 s silent, and reported `health ok`. The signal source also logged two underruns during the run, so something disturbed Core Audio on this loaded machine. The helper did what DESIGN 2.5 says: silence alone does not trigger a rebuild before 10 s. The result is still 10.5 s of lost call audio, and the gate says no gap over 20 ms.

**App memory.** With no recognizer loaded, the app grew from 144 MB to a peak of 400 MB in the first 16 minutes, then moved in a sawtooth between 229 and 372 MB for the rest of the hour, with no upward trend. It looks like garbage collection timing rather than a leak.

### The quiet-tap run

**What ran.** The same path, 825 s, with the signal source's mic side switched off (`--mic-device none`), so nothing at all played while the call side was silent. The call side started at 30 s, paused from 150 s to 750 s (10 minutes), and ended at 810 s, playing the spoken clip at each start. The recording was driven by [`record-call.ts`](../../scripts/gates/record-call.ts), which also sampled memory every 30 s. The raw output is [g4-quiet.json](g4-quiet.json) and [g4-quiet-memory.csv](g4-quiet-memory.csv).

**The tap really was quiet.** The call channel was exact digital zero in both quiet windows (0.5 to 34.6 s and 155.3 to 754.4 s of the file: RMS and peak minus infinity, shown as `null` in the JSON). The helper's `first_audio` for the call came 34.8 s into the file: the tap delivered no buffers at all until something played.

**Numbers.**

| Check | Result |
|---|---|
| Mic frames flowing while the tap is silent from the start | Yes, at the frame level: the mic's `first_audio` was at file position 0, 34.8 s before the tap's, and the file grew with wall time throughout (825.078 s of audio for 825.105 s of wall time). The mic content itself was digital silence, because SSH has no Microphone grant. |
| First words after 30 s of silence from the start | **20 ms lost.** The first 20 ms slice of speech matched at 0.22, the next seven at 0.92 or better. The clip sat 37 ms earlier than the chirps before it predicted, which is the misalignment below, and its first slice fell into the gap. |
| First words after the 10-minute pause | 0 ms lost. Every slice matched at 0.96 or better, at the expected place (lag 0.04 ms). |
| Gaps over 20 ms while the call played | **One, 21.3 ms, at 35.19 s**, right after the first start. None over 5 ms anywhere else in the 179 s the call played. |
| Call alignment after the first start | **Off by 33 ms, settling over about 40 s.** The first chirp after the start sat at -24.5 ms against the host clock, then -14.5, -4.5, +3.6, then the steady 8.35 ms. After the pause it was 8.35 ms from the first chirp. |
| Helper memory with the call source muted for 10 minutes | Flat: 12.3 MB at the start of the pause, 11.9 MB at the end, 11.0 to 13.6 MB over the whole run. |
| App memory in the same window | 122 MB to 262 MB. This run is 14 minutes, all inside the app's warm-up ramp that the hour run showed flattening after about 16 minutes, so it says nothing either way about the app. |
| Both channels the same length | 825.078 s each. |

**What happened at the first start.** The helper reported the tap `dead` with `silent_for` 35.19 s, "output running, probe heard audio, rebuilding", then `ok`. So the dead-call rule rebuilt a tap that had just started delivering: the output device began running when the call started, the rule saw 35 s of silence with output running, probed, heard the new call audio, and rebuilt. The rebuild is the 21 ms gap and the lost 20 ms of speech, and the aligner then slewed the new tap back to the host clock at about 1 ms per second. At the second start, after the 10-minute pause, the rule did not fire. It looks like a race between the output-running flag and the tap's first buffer, and a real call that begins with a silent tap would hit it every time.

### Positive controls for the analysis

**What ran.** [`scripts/gates/g4-controls.ts`](../../scripts/gates/g4-controls.ts) on the 10-minute G3-lite recording, whose call channel holds both trains. It copies the call channel onto the left three times: unchanged, delayed by 50 ms, and sped up by 1/48000 (`asetrate=48001,aresample=48000`, 75.0 ms per hour). Then it runs the unchanged `drift-test.ts` on each copy. The raw output is [g4-controls.json](g4-controls.json).

| Injected | Recovered | Expected |
|---|---|---|
| 50 ms delay, left-right offset | -50.00 ms | -50 ms |
| 50 ms delay, call train on the left | +50.00 ms | +50 ms |
| 75.0 ms per hour, call train slope | -74.99 ms per hour | -75 ms per hour |
| 75.0 ms per hour, left-right slope | +73.53 ms per hour | +75 ms per hour |
| 75.0 ms per hour, mic train slope | -73.67 ms per hour | -75 ms per hour |

The analysis recovers an injected offset exactly, and an injected drift to 0.01 ms per hour on the call train. On the mic train it reads 2 % low: that train reaches the tap degraded (some chirps matched only at 0.5), and a poor match moves the peak. So a future two-device run should check the match scores before trusting a slope. The controls were also seen to fail: the first version asked `asetrate` for 48001.44 Hz, expecting 108 ms per hour, and got 75. `asetrate` takes whole hertz and truncates silently, which a click-train check confirmed.

### The re-run after the capture fixes

**What changed.** [#13](https://github.com/GeiserX/akou/pull/13) (commit `331c7e6`) made two claims about the gaps above:

1. A call tap that stops delivering buffers while output runs is probed after 1 s instead of 10, so a dead tap is rebuilt within about a second.
2. The silence before output starts running no longer counts, so a tap that starts with the call is not rebuilt; and a rebuilt stream is placed by its own clock at once rather than slewed back at 0.1 %.

**What ran.** The same two recordings with the same arguments, at `331c7e6`, through `akou start` over SSH: the quiet-tap run (825 s, `--mic-device none`, call side from 30 to 150 s, paused until 750 s, ended at 810 s) and the hour run (3,726 s, both trains, call side from 35 s, paused from minute 35 to 45). Then `g4-controls.ts` on the new hour recording, and a short check that forces rebuilds. One thing differs from the first rounds. The app now refuses to start without the speech models, so [`record-call.ts`](../../scripts/gates/record-call.ts) passes `--without-models`, and the app ran with no recognizer, as it did in the earlier runs. The call train played to the built-in speakers, muted (see the traps above). The raw output is [g4-quiet-rerun.json](g4-quiet-rerun.json), [g4-quiet-rerun-memory.csv](g4-quiet-rerun-memory.csv), [g4-drift-rerun.json](g4-drift-rerun.json), [g4-memory-rerun.csv](g4-memory-rerun.csv), [g4-controls-rerun.json](g4-controls-rerun.json), [g4-controls-rerun-red.json](g4-controls-rerun-red.json) and [g4-rebuild.json](g4-rebuild.json).

**Quiet-tap run.**

| Check | Before (`f6cabfc`) | After (`331c7e6`) |
|---|---|---|
| Tap quiet before the call and in the pause | Exact digital zero in both windows | The same |
| Dead-call rule at the first start | `dead` with `silent_for` 35.19 s, probe, rebuild | Nothing: no `health` or `device` line in the whole run |
| Gaps while the call played | One of 21.3 ms at 35.19 s | None over 5 ms in the 178.5 s scanned |
| First words after 30 s of silence | 20 ms lost; the first slice matched at 0.22 | 0 ms lost; the first slice matched at 0.97, at the expected place (lag 0 ms) |
| First words after the 10-minute pause | 0 ms lost | 0 ms lost |
| Call alignment after the first start | First chirp at -24.5 ms, settling to 8.35 ms over about 40 s (spread 32.8 ms) | First chirp at 8.40 ms; all 18 chirps between 8.36 and 8.43 ms (spread 0.07 ms) |
| Mic frames while the tap is silent from the start | Mic from file position 0, tap 34.8 s later | The same |
| Helper memory, call source muted for 10 minutes | 12.3 MB to 11.9 MB | 13.1 MB to 12.2 MB (11.3 to 13.3 MB over the run) |
| Both channels the same length | 825.078 s each | 825.088 s each |

**Hour run.**

| Check | Before (`f6cabfc`) | After (`331c7e6`) |
|---|---|---|
| Call chirps found | 307 of 308 | 308 of 308 |
| Call channel against the host clock | 8.29 to 8.45 ms (spread 0.16 ms), slope 0.00 ms per hour | 8.33 to 8.46 ms (spread 0.14 ms), slope 0.06 ms per hour |
| Gaps over 20 ms on the call channel | One, 10.5 s, at minute 52 | None, and none over 5 ms in the 3,721 s scanned |
| Tap deaths and rebuilds | One: a mic underrun, then the tap stopped; rebuilt after 10.4 s | None: no `health` or `device` line in the whole hour |
| Mic train heard in the tap | 366 of 373 chirps | 373 of 373, spread 0.002 ms |
| File length against wall time | 20 ms short over the hour | 37 ms short over 3,726 s |
| Both channels the same length | 3,720.977 s each | 3,726.157 s each |
| Helper memory | 8.4 to 13.8 MB | 11.0 to 13.0 MB; 11.1 to 11.5 MB while the call source was muted |
| App memory, no recognizer | 144 MB, peak 400 MB at minute 16, then a sawtooth | 70 MB, peak 399 MB at minute 28, 255 to 399 MB after minute 16, fitted slope after minute 16 -64 MB per hour: a sawtooth, no upward trend |

The tap was never quiet in the hour run (it hears the mic train), so its two first-word checks, both 0 ms lost, are not the after-silence check; the quiet-tap run is. The mic channel was digital silence again (-122.9 dBFS), because SSH has no Microphone grant.

**Forced rebuilds.** No tap died in the hour, and a tap death cannot be forced on a real device. But the helper's `rebuild_call` command runs the same rebuild the dead-call rule does (the engine's `rebuild`, which restarts the stream on the aligner). So we started the helper directly, played the call train for 127 s, and sent that command three times, 30 s apart. Each rebuild lost 72 to 88 ms of call audio, the time a new tap takes to open. All 13 chirps sat between 8.33 and 8.40 ms (spread 0.07 ms), including the first one about 4 s after each rebuild. The aligner placed the rebuilt stream at once. Before the fix, a rebuilt tap 33 ms off, as in the first quiet-tap run, slewed back at about 1 ms per second, and would still have read about 29 ms off at that chirp.

**The 1 s rule, not seen live.** With no tap death in the hour, the claim that a dead tap is rebuilt within about a second rests on the simulated tests. The Rust ones pass at `331c7e6` on this Mac (`cargo test --features simulate`), and the TypeScript table passes under `bun test`:

- `faults::t0_2_a_call_side_that_stops_delivering_is_rebuilt_within_a_second` ([tests/engine.rs](../../native/akou-capture/tests/engine.rs)): the helper's call side stops delivering at 1 s; `dead` comes after 1.0 to 1.5 s of silence, the stream is rebuilt, and the next rebuild waits for the backoff. Its positive control, `t0_2_a_call_side_of_zeros_waits_the_full_10_s_before_the_probe`, shows buffers of zeros still wait the full 10 s.
- `t0_2_a_stream_that_stops_delivering_is_rebuilt_within_a_second` and `t0_2_positive_control_buffers_of_zeros_wait_the_full_10_s` in [dead_call.rs](../../native/akou-capture/src/health/dead_call.rs), and the same table in [tests/capture-health.test.ts](../../tests/capture-health.test.ts).
- For the second claim: `the_first_start_after_a_silent_tap_keeps_the_first_word_whole_and_aligned` and `a_rebuilt_call_stream_is_aligned_from_its_first_audio` (tests/engine.rs), and `a_restarted_source_is_placed_by_its_own_timestamps_at_once` and `a_step_in_the_first_second_re_anchors_and_a_later_one_is_slewed` in [aligner.rs](../../native/akou-capture/src/aligner.rs).

From those numbers, a tap death should now cost about 1 to 1.5 s of silence plus the 72 to 88 ms a rebuild took here, against 10.5 s before.

**Positive controls on the new hour recording.** We ran the same script on the hour recording, whose call channel holds both trains. The mic train reached the tap cleanly this time (matched at 0.89 or better, against 0.5 in the 10-minute recording), and the 2 % shortfall on that train is gone:

| Injected | Before (10-minute recording) | After (hour recording) | Expected |
|---|---|---|---|
| 50 ms delay, left-right offset | -50.00 ms | -50.00 ms | -50 ms |
| 50 ms delay, call train on the left | +50.00 ms | +50.00 ms | +50 ms |
| 75.0 ms per hour, call train slope | -74.99 ms per hour | -75.00 ms per hour | -75 ms per hour |
| 75.0 ms per hour, left-right slope | +73.53 ms per hour | +75.07 ms per hour | +75 ms per hour |
| 75.0 ms per hour, mic train slope | -73.67 ms per hour | -75.09 ms per hour | -75 ms per hour |

The controls were also seen to fail. A copy of the script with the drift left out (`asetrate=48000`) recovered 0.00 ms per hour on all three slopes, failed those three checks and exited 1 ([g4-controls-rerun-red.json](g4-controls-rerun-red.json)).

**Verdict: partial.** On this Mac, the two fixes do what they claim wherever a real device could show it. The first start after a silent tap no longer triggers a rebuild, loses no speech and is aligned from its first chirp. An hour ran with no gap over 5 ms. A forced rebuild is placed at once and costs 72 to 88 ms. The 1 s rebuild of a dead tap was not seen live, because no tap died; only the simulated tests cover it. The gate still does not pass. Nobody measured the left-right drift between two clocks, the number the gate exists for, and this machine cannot. The macOS 14.2 or 14.3 run was not done either.

**Still open.**

- A two-clock run on a Mac with a real input device (a USB mic or audio interface) and a session holding both the Microphone and the system-audio grant: `drift-signal` with the mic train into that device's loopback or played acoustically into the mic, `akou start`, 62 minutes, `drift-test.ts`, then `g4-controls.ts`.
- A real tap death under the new rule: the next one that happens on a real device should show `dead` with `silent_for` near 1 s and a gap near 1 s.
- The macOS 14.2 or 14.3 run.

## G5: containment

**What ran.** [`scripts/gates/g5-containment.ts`](../../scripts/gates/g5-containment.ts) against the real app, polling `GET /v1/status` every 100 ms the whole time. It ran two ways. First, the `simulate` build of the helper in file mode, switched per start between `--simulate hang-on-stop` and `--simulate crash-at=20` ([g5-simulated.json](g5-simulated.json)). Second, the shipping helper on real devices, killed with SIGKILL 20 s into a call ([g5-kill-real.json](g5-kill-real.json)).

**Re-run.** The first run passed, but a review of its runner found three ways it could have passed without testing the behaviour, so the numbers below come from a second run with a stricter runner, on the same machine and setup:

- **Audio lost was measured on file length, not content.** A part holding encoded silence where the call should be counted as captured. The runner now puts a known tone on the call side (900 Hz at -30 dBFS: the right channel of the file in simulate mode, and played through the speakers with `afplay` so the tap hears it in the real-device run), and counts a 20 ms slice as captured only when the tone is in it. Before any call, a positive control runs the same measure on Opus files it writes: an intact one reads 0 s lost, one with a 1.5 s hole in the call tone reads 1.5 s, and one whose call channel is silent throughout reads 6 s. The run stops if any of the three is off by more than 0.06 s. A copy of the runner that counted every slice was seen to stop there.
- **The next start came after the hanging teardown had finished.** The first run waited for `akou stop` (5.1 s) before it started the next call, so an app that refuses starts during a teardown would still have passed. The runner now sends the stop, waits until the call has left the live state, starts the next call, and fails unless that start both began and answered while the stop was still pending.
- **The helper it killed was found by name only.** The first match of `akou-capture … run` could have been another capture, and if none matched the kill was skipped silently. The runner now picks the one helper whose `--out` is inside this call's folder, fails if there is not exactly one or if it survives the SIGKILL, and fails if the call's first part did not end after the kill.

The runner also checks that each fault really fired (`part.ended {reason: killed}` for the hang, `helper-exit` for the crash) and writes a verdict per scenario against the four criteria.

**Numbers.**

| Case | `part.ended` | Next part or next start | Call audio lost | API during it |
|---|---|---|---|---|
| Hang on stop | `killed`, 5,067 ms after the stop was asked (the 5 s budget, then the kill) | Next `akou start`: 201 in 78 ms, sent and answered while the teardown still hung | 0.03 s | 194 polls through the whole hang, 0 failed, slowest 20.1 ms |
| Crash at 20 s (exit 70) | `helper-exit` | Automatic new part 79 ms later; next `akou start` 201 in 73 ms | 0.13 s | 338 polls, 0 failed, slowest 7.3 ms |
| Real device helper, SIGKILL | `helper-exit` | Automatic new part 81 ms later; next `akou start` 201 in 102 ms | 1.25 s: the killed part logged 19.94 s but decodes to 18.98 s (949 slices, 18.96 s of them with tone), so its unflushed last Opus page (about 0.96 s) is gone, plus the restart | 340 polls, 0 failed, slowest 5.0 ms |

In the real-device run the tone was in 948 of 949 slices of the killed part and 748 of 749 of the new part: the one miss in each is the part's first 20 ms.

The first run measured the same picture on file length: 0.01 s, 0.11 s and 1.13 s lost, next start 102 ms after the hang's stop had returned.

**Verdict: pass.** The app stayed responsive, every part got its `part.ended`, a new call started 78 ms into a hanging teardown and the next start always answered 201 well within 3 s, and at most 1.25 s of call audio was lost, under the 2 s limit. The real-device kill is the closest to the limit, and almost all of it is the Opus page the helper had not yet written. One detail for M1: a SIGKILLed helper is logged as `helper-exit`, the same reason as a helper that exits on its own. The schema has a `crashed` reason that nothing wrote here.

## G6: recognizer speed

**Models.** `akou models pull` fetched 688 MB in 16.3 s: 8 files, every checksum matched.

**What ran.** Two halves, both in the production setting: Parakeet TDT v3 int8, `modified_beam_search`, 2 threads as `asr.threads` defaults to, and a 12-word decode list (akou, Parakeet, Datadog, Grafana, Silero, Terraform, Kubernetes, Zendesk, TitaNet, pyannote, ElectroBun, Opus). All 12 words passed the tokenization check.

- Offline speed ([`g6-asr-speed.ts`](../../scripts/gates/g6-asr-speed.ts), [g6-offline.json](g6-offline.json)): 24 synthesized English sentences (66.3 s), each decoded through the app's own `SherpaModels` after one warm-up pass.
- Live latency ([`g6-live-latency.ts`](../../scripts/gates/g6-live-latency.ts), [g6-live.json](g6-live.json)): the same 24 sentences laid out on a 58 s stereo timeline, alternating and overlapping between mic and call. The helper played them in file mode at real-time speed, a cold app ran the real live path (VAD, provisional re-decodes, beam search with the list), and each committed line's log time was compared with the moment its utterance ended.

**Numbers.**

| Measure | Result | Target |
|---|---|---|
| Real-time factor, one channel | 0.040 (2.67 s of decoding for 66.3 s of speech) | |
| Real-time factor, both channels, speech on both all the time | 0.081 | under 0.25 |
| Decode time per utterance | median 114 ms, at most 134 ms | |
| Committed line after the utterance ends | median 1.02 s, 90th percentile 1.06 s, worst 1.14 s, best 0.81 s; 24 of 24 committed | within 1.5 s |
| Recognizer load | 1.17 s | |

The live latency includes the 0.7 s of silence that closes a segment (`asr.segmentPause`), so decoding and writing take about 0.3 s of it. File mode skips the device path. On devices that adds about 8 to 12 ms, which is the chirp latency G4 measured.

**Verdict: pass on the M-series half**, with room to spare, on a machine under background load.

**Still open.** The 4-core x64 laptop half, whose target is under 0.5. And a vocabulary note for M1: in the live run, 10 of the 12 listed words came out right every time they were said. "pyannote" was right once and heard once as "pyanode" (utterance s08, [g6-live.json](g6-live.json); the offline pass got both right). "akou" was never right: it was heard as "ACA" and "Aka", even with the word in the decode list at boost 3.

## G8: cold start

**What ran.** [`scripts/gates/g8-start.ts`](../../scripts/gates/g8-start.ts) ([g8-start.json](g8-start.json)), with the shipping helper on real devices and the models present, so the app starts loading them at launch the way it will for users. Each figure is the whole `akou start --json` process, from spawn to exit. Cold means the app was quit before each run. The runner records the app's pid from `runtime.json` after every start, fails if the previous app is still alive 10 s after quit, and fails if a cold start answers from a pid it has already seen. The 20 cold runs came from 20 different app processes; the 20 warm runs all came from one. Warm means the app was already running.

**Numbers.**

| | Runs | 201 | p50 | p95 | Worst | Helper audio after spawn |
|---|---|---|---|---|---|---|
| Cold | 20 | 20 | 185 ms | 193 ms | 199 ms | 65 to 82 ms |
| Warm | 20 | 20 | 140 ms | 159 ms | 168 ms | 70 to 95 ms |

The first round, without the pid checks, measured cold p95 257 ms and warm p95 145 ms.

**Verdict: pass.** The target is under 3 s p95 cold. Warm also meets the M1 target of 1 s.

**Still open.** The first tap after a reboot, where a cold Core Audio open once took over 12 s, was not measured: we do not reboot a shared machine. The runs were over SSH, where the mic opens but is silent. A granted microphone may add time to the open, and that was not measured either.

## How to re-run

Everything above can be repeated from the repository: build `akou-capture`, plus `--features simulate` for G5, build the signal source with `cargo build --release --example drift-signal`, then the scripts named in each section. Each script's header gives its arguments; on a machine without the speech models, `record-call.ts` needs `--without-models`. On the machine: the default output is the built-in speakers, muted so nothing is heard, and the call train plays to it; the session holds both the Microphone and the system-audio grant; and the mic is a real input device for G4's two-clock number. BlackHole 2ch (with its output unmuted) is enough for everything else, but for G4 it only bounds the tap against the host clock.
