# M0 gate results on the reference Mac mini

This page records what the M0 gates measured on real hardware, gate by gate: what ran, the numbers, the verdict against the pass criterion in [ROADMAP.md](../ROADMAP.md), and what is still open. The raw outputs sit next to it in this folder. No audio is kept.

**The machine.** The reference Mac mini: Apple M4, 10 cores, 16 GB, macOS 26.6, with System Integrity Protection (SIP) turned off. It was running other work during every measurement (a virtual machine and compile jobs, load average 5 to 8 on 10 cores). So every speed figure here is a figure under background load.

**The setup.** akou at commit `f6cabfc`, the helper built with `cargo build --release` and, for G5, `--features simulate`, the app run as `bun src/main/index.ts` with `AKOU_HEADLESS=1`, launched by `akou start` exactly as the CLI does it. The mic was the BlackHole 2ch virtual device: a signal played into its output comes back on its input. The call side was the process tap listening to everything the Mac plays, with "Mac mini Speakers" as the default output.

## Summary

| Gate | Verdict | Key numbers |
|---|---|---|
| G3 (lite) | Partial | The app-spawned helper recorded real call audio from the tap on the right channel. The mic came through as digital silence over SSH, and no single session could record both (see below). |
| G4 | Fail as run | 62 minutes. The call channel held the host clock to within 0.16 ms for the whole hour. One gap of 10.5 s at minute 52, when the tap died and the dead-call rule took 10.4 s to rebuild it. Left-right drift could not be measured: the mic channel was silent. |
| G5 | Pass | Hang: killed at the 5 s budget, `part.ended {reason: killed}`, next start 102 ms. Crash: new part in 69 ms, 0.11 s lost. Real device helper SIGKILLed: new part in 96 ms, 1.13 s lost. The API never missed a poll. |
| G6 | Pass (M-series half) | Real-time factor 0.081 for both channels, worst case. Committed line 1.02 s after the utterance ends (median), 1.14 s at worst. |
| G8 | Pass | Cold `akou start` p95 257 ms, warm p95 145 ms, 20 runs each. |

## Recording from SSH versus the console session

This decides how every capture gate can run on a remote box, so it comes first.

macOS decides microphone and system-audio access per "responsible process". For anything started over SSH that is `sshd-keygen-wrapper`. For anything started in a Terminal window on the console, it is Terminal. On this Mac, `sshd-keygen-wrapper` holds a Screen Recording grant and no Microphone grant. Terminal holds a Microphone grant and no system-audio grant.

| How the helper ran | Process tap (call side) | BlackHole input (mic side) |
|---|---|---|
| Plain SSH, and the app spawned by `akou start` over SSH | Real audio, no prompt | Digital silence (-120 dBFS in the helper's level lines) with no error and no prompt |
| `sudo launchctl asuser 501 sudo -u <user> …` | Not tried | Digital silence, same as SSH |
| A Terminal window on the console (`open -a Terminal x.command`), `--call none` | Not opened | Real audio: the -40 dBFS pilot tone read -44.9 dBFS |
| A Terminal window on the console, `--call system` | Blocked: macOS showed "Terminal would like access to record your system audio", and the helper gave up after its 15 s open budget (`warn open: the process tap did not open in time`) | Not reached |

Four things we learned the hard way, and they belong in [TRAPS.md](../TRAPS.md) once M1 needs them:

- **SIP off does not suppress the system-audio prompt.** The prompt appeared on the console for Terminal.
- **One pending system-audio prompt blocks every process tap on the Mac.** While the Terminal prompt waited for a click, the tap also failed to open from SSH. The first G4 attempt got `503 capture_failed {stage: "open"}` after the 10 s cold budget. We cleared it by ending the user's `tccd` (SIGKILL, because it ignored SIGTERM). No decision was recorded. The dialog window is still on screen, orphaned. We did not click it, and clicking it now probably does nothing.
- **A muted BlackHole output makes its input silent.** BlackHole's output was muted in the system's volume settings, and that zeroes the loopback. We unmuted it for the gates and muted it again afterwards.
- **A missing microphone grant looks exactly like a quiet microphone.** Over SSH the mic stream opened, delivered buffers on time, sent `first_audio`, and every sample was zero. Nothing in the protocol says "denied". This is the mic-side twin of the `permission-suspect` rule in DESIGN 2.5, and akou has no mic-side rule yet.

So on this box, a recording with both a real mic and a real tap needs one of two things. A person answers the system-audio prompt for Terminal at the console, or the Microphone grant exists for whatever runs over SSH. We changed neither, because both are security settings.

## G3 (lite): the app-spawned helper captures real audio

**What ran.** `akou start` over SSH, with the app not running. The CLI launched the app headless and the app spawned the helper. A signal source ([`drift-signal`](../../native/akou-capture/examples/drift-signal.rs)) played into BlackHole and the speakers. Then 36 s of recording, stop, quit, and the Opus file measured per channel.

**Numbers.** 201 after 0.24 s, including launching the app; the helper reported audio 91 ms after spawn. The right channel, the call side, had RMS -30.1 dBFS, peak -3.0 dBFS. The call-side chirps were found at their expected places with correlation 0.98 or better, here and over the whole G4 hour. The left channel, the mic side, had RMS -93 dBFS and peak -51 dBFS. That is digital silence plus a little Opus stereo crosstalk from the right channel, because the SSH session has no Microphone grant (previous section).

**Verdict: partial.** The tap works through the app-spawned helper and lands on the correct channel. Real mic audio through the same helper was not shown in any one session on this box. Permission attribution to a signed app cannot be judged on a SIP-off box: nothing here is signed, and the prompts that did appear named Terminal, the process that launched everything.

**Still open.** The full G3: a signed test app on a SIP-on Mac, prompts that name akou, grants that survive a re-signed update.

## G4: two-clock capture for an hour

**What ran.** The signal source played two marker trains from one process into two devices, scheduled on the host clock, so both trains share one clock whatever each device's clock does. Into BlackHole (the mic): a 500 Hz pilot tone at -40 dBFS and a 3 to 4.5 kHz chirp every 10 s. Into the speakers (the call): a 900 Hz pilot and a 1.5 to 2.5 kHz chirp every 10 s, 5 s after the mic chirp. The call side stayed silent for the first 35 s, paused from minute 35 to minute 45, and each time it started it played a spoken clip ("First words after the silence…") from its very first sample.

The recording ran through the real path: `akou start` over SSH, then the app-spawned helper for 3,721 s, then stop. [`scripts/drift-test.ts`](../../scripts/drift-test.ts) finds every chirp by cross-correlation and compares it with its scheduled host time. The raw output is [g4-drift.json](g4-drift.json), and the memory samples (every 30 s) are in [g4-memory.csv](g4-memory.csv).

**Numbers.**

| Check | Result |
|---|---|
| Call channel against the host clock | 307 of 308 chirps found (the missing one fell in the gap below). Latency 8.29 to 8.45 ms over the hour, a spread of 0.16 ms, fitted slope 0.00 ms per hour. The alignment was the same after the gap and after the 10-minute pause. |
| File length against wall time | 3,720.977 s of audio for 3,720.997 s of wall time: 20 ms short over the hour |
| Gaps over 20 ms | **One, 10.5 s long, at 3,120.4 s (minute 52).** None over 5 ms anywhere else on the call channel. |
| First words after silence | Both starts, after the first 35 s and after the 10-minute pause: 0 ms lost. The clip's first 20 ms of speech matched at 0.97. |
| Memory with the call source paused for 10 minutes | Helper 11.7 to 12.1 MB during the pause, 8.4 to 13.8 MB over the hour, no growth. |
| Both channels the same length | 3,720.977 s each. |
| Left-right offset under 200 ms per hour | **Not measured**: the mic channel was digital silence (see above). |
| Mic frames flowing while the tap is silent from the start | **Not measured.** The mic was silent, and the global tap also hears the signal source's BlackHole output, so the tap was not silent at the start either. The helper did report `first_audio` for both channels at file position 0. |
| macOS 14.2 or 14.3 run | Not done: no such machine. |

**The gap.** At 3,120 s the mic stream reported `A buffer underrun or overrun occurred` and the helper rebuilt it (`device mic lost`, then `rebuilt`). At the same moment the tap stopped delivering anything. The dead-call rule then waited its 10 s, probed, heard audio, rebuilt the tap after 10.4 s silent, and reported `health ok`. The signal source also logged two underruns during the run, so something disturbed Core Audio on this loaded machine. The helper did what DESIGN 2.5 says: silence alone does not trigger a rebuild before 10 s. The result is still 10.5 s of lost call audio, and the gate says no gap over 20 ms.

**App memory.** With no recognizer loaded, the app grew from 144 MB to a peak of 400 MB in the first 16 minutes, then moved in a sawtooth between 229 and 372 MB for the rest of the hour, with no upward trend: 291 to 372 MB during the pause. It looks like garbage collection timing rather than a leak. The helper is the part the gate asks about.

**Verdict: fail as run.** The two-clock aligner held the call channel to the host clock within 0.16 ms for an hour, and first words survived both silences. But one 10.5 s gap breaks "no gaps over 20 ms", and the left-right drift, the number the gate exists for, was not measured.

**Still open.**

- Re-run with a real mic channel. A person allows system-audio recording for Terminal at the console, then the same run starts from a Terminal window: `drift-signal` as above, `akou start`, 62 minutes, `drift-test.ts`.
- Decide what a dead tap may cost. The 10 s rule is there so real silences are never "repaired". But a tap that dies while other audio plays, the case the probe detects, could be probed sooner. Today every tap death costs at least 10 s.
- The macOS 14.2 or 14.3 run.
- The source for the "tap silent from the start" case must not play through any output device, because the global tap hears all of them.

## G5: containment

**What ran.** [`scripts/gates/g5-containment.ts`](../../scripts/gates/g5-containment.ts) against the real app, polling `GET /v1/status` every 100 ms the whole time. It ran two ways. First, the `simulate` build of the helper in file mode, switched per start between `--simulate hang-on-stop` and `--simulate crash-at=20` ([g5-simulated.json](g5-simulated.json)). Second, the shipping helper on real devices, killed with SIGKILL 20 s into a call ([g5-kill-real.json](g5-kill-real.json)).

**Numbers.**

| Case | `part.ended` | Next part or next start | Audio lost | API during it |
|---|---|---|---|---|
| Hang on stop | `killed`, 5,079 ms after the stop was asked (the 5 s budget, then the kill) | Next `akou start`: 201 in 102 ms | 0.01 s | 195 polls, 0 failed, slowest 5.7 ms |
| Crash at 20 s (exit 70) | `helper-exit` | Automatic new part 69 ms later; next `akou start` 201 in 74 ms | 0.11 s | 339 polls, 0 failed, slowest 6.6 ms |
| Real device helper, SIGKILL | `helper-exit` | Automatic new part 96 ms later; next `akou start` 201 in 105 ms | 1.13 s: the unflushed last Opus page (0.93 s) plus the restart | 344 polls, 0 failed, slowest 4.2 ms |

**Verdict: pass.** The app stayed responsive, every part got its `part.ended`, the next start answered 201 well within 3 s, and at most 1.13 s of audio was lost, under the 2 s limit. One detail for M1: a SIGKILLed helper is logged as `helper-exit`, the same reason as a helper that exits on its own. The schema has a `crashed` reason that nothing wrote here.

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

**Still open.** The 4-core x64 laptop half, whose target is under 0.5. And a vocabulary note for M1: "akou" was heard as "ACA" and "Aka" even with the word in the decode list at boost 3. Every other listed word came out right.

## G8: cold start

**What ran.** [`scripts/gates/g8-start.ts`](../../scripts/gates/g8-start.ts) ([g8-start.json](g8-start.json)), with the shipping helper on real devices and the models present, so the app starts loading them at launch the way it will for users. Each figure is the whole `akou start --json` process, from spawn to exit. Cold means the app was quit and its process gone before each run; every cold run launched a fresh app (21 distinct app processes). Warm means the app was already running.

**Numbers.**

| | Runs | 201 | p50 | p95 | Worst | Helper audio after spawn |
|---|---|---|---|---|---|---|
| Cold | 20 | 20 | 186 ms | 257 ms | 264 ms | 66 to 170 ms |
| Warm | 20 | 20 | 129 ms | 145 ms | 145 ms | 73 to 101 ms |

**Verdict: pass.** The target is under 3 s p95 cold. Warm also meets the M1 target of 1 s.

**Still open.** The first tap after a reboot, where a cold Core Audio open once took over 12 s, was not measured: we do not reboot a shared machine. The runs were over SSH, where the mic opens but is silent. A granted microphone may add time to the open, and that was not measured either.

## How to re-run

Everything above can be repeated from the repository: build `akou-capture`, plus `--features simulate` for G5, build the signal source with `cargo build --release --example drift-signal`, then the scripts named in each section. Each script's header gives its arguments. The machine-specific parts are three: default input BlackHole 2ch with its output unmuted, default output the built-in speakers, and a session that has both the Microphone and the system-audio grant.
