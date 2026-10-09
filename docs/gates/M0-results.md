# M0 gate results on the reference Mac mini

This page records what the M0 gates measured on real hardware, gate by gate: what ran, the numbers, the verdict against the pass criterion in [ROADMAP.md](../ROADMAP.md), and what is still open. The raw outputs sit next to it in this folder. No audio is kept.

**The machine.** The reference Mac mini: Apple M4, 10 cores, 16 GB, macOS 26.6, with System Integrity Protection (SIP) turned off. It was running other work during every measurement (a virtual machine and compile jobs, load average 5 to 9 on 10 cores). So every speed figure here is a figure under background load.

G1 and G2 are the exceptions: they ran on GitHub-hosted CI runners, inside the app bundles the release workflow built (G1 on Windows and Linux, G2 on all three operating systems). Their sections say which runners.

**The setup.** akou at commit `f6cabfc` (the G5 re-run at the later commit that fixed its runner), the helper built with `cargo build --release` and, for G5, `--features simulate`, the app run as `bun src/main/index.ts` with `AKOU_HEADLESS=1`, launched by `akou start` exactly as the CLI does it. The Mac mini has no microphone and no other input device, so the mic was the BlackHole 2ch virtual device: a signal played into its output comes back on its input. The call side was the process tap listening to everything the Mac plays, with "Mac mini Speakers" as the default output.

There are three rounds. The first ran G3 to G8. The second re-ran G3-lite and G8 so their raw output is on record, added a 14-minute run in which the tap is really quiet (for the first-words and muted-memory checks, which the hour run could not test), and added positive controls for the drift analysis. Where the two rounds differ, this page gives the second round's numbers. The third re-ran G4 at commit `331c7e6`, after the two capture fixes in [#13](https://github.com/GeiserX/akou/pull/13), on the same machine under heavier background load (load average 4 to 20); its numbers sit next to the old ones in [the G4 re-run](#the-re-run-after-the-capture-fixes). The fourth, on 2026-10-07, re-ran G5 and G8 at commit `36a2237` (release 0.6.2), so their verdicts rest on current code and not on September's; see [the G5 re-run](#re-run-on-current-main) and [the G8 re-run](#re-run-on-current-main-1).

## Summary

| Gate | Verdict | Key numbers |
|---|---|---|
| G1 | Partial | Re-run on 0.6.3 at `500ca8f` (2026-10-07), on GitHub's x64 runners, against the app the release job had just built. Linux x64 (Xvfb with Openbox, X11; Wayland not covered) and Windows x64 (installed with `akou-Setup.exe`) both pass every phase on that run: a window titled akou, a tray item, Control+Shift+F9 starting and stopping a call, the login item written with `AKOU_HEADLESS=1` and removed when turned off, and a headless start, both from the launcher and from the login item's own command, with the tray and the hotkey and no window. Every control came out the other way. A second run on the same code, at `d9f6864`, passed again on Windows but failed on Linux: after a call, `akou quit` never finished ([#351](https://github.com/GeiserX/akou/issues/351)). macOS arm64: not run, so not Pass. |
| G2 | Pass | Ran inside the packaged bundle on macOS arm64, Windows x64 and Linux x64, on the v0.6.2 release's CI runners. The recognizer in a Worker transcribed the clip on all three, and the main thread's longest wait was 26.7 ms, 3.1 ms and 3.8 ms against the 100 ms limit. The same decode on the main thread, the positive control, blocked it for 11,997 ms, 4,085 ms and 2,585 ms. |
| G3 | Pass | Both halves on a Mac with SIP on. First half on the signed, notarized 0.6.2 (2026-10-07): the Microphone and system-audio prompts named akou and nothing else got those grants; a 120 s recording found every call chirp on the right and every mic chirp on the left; after quit and restart, the same with no new prompt. Second half on the signed 0.6.4 copied over it (2026-10-08): no prompt and no grant from the install to the end of a 120 s recording that found 11 of 11 chirps of each train; then a Microphone reset followed by a start raised a prompt again, so the no-prompt check can go red. The earlier G3-lite on the SIP-off Mac mini stays below. |
| G4 | Partial | Re-run after the capture fixes. Quiet-tap run: the first start after a silent tap now costs no gap, no lost speech and no misalignment (before: a 21 ms gap, the first 20 ms of the first word, and 33 ms off for about 40 s). Hour run: no gap over 5 ms on the call channel, which held the host clock to within 0.14 ms (before: one 10.5 s gap at minute 52 when the tap died). No tap died this time, so the 1 s rebuild was not seen live; simulated tests cover it. Left-right drift between two clocks was not measured, and cannot be on this machine. Hour run on a SIP-on Mac through the signed 0.6.2 (2026-10-08): no gap, every chirp of both trains, left-right offset 8.27 ms with a 0.022 ms spread and a 0.01 ms per hour slope; the tap held the host clock, so two real clocks are still unmeasured. |
| G5 | Pass | Re-run at `36a2237` (2026-10-07). Hang: killed at the 5 s budget, `part.ended {reason: killed}`, and a new call started in 154 ms while the teardown still hung. Crash: new part in 79 ms, 0.14 s of call audio lost. Real device helper SIGKILLed: new part in 212 ms, 1.30 s lost. The API never missed a poll. At `f6cabfc`: 78 ms; 79 ms and 0.13 s; 81 ms and 1.25 s. |
| G6 | Partial | Speed passes on both halves (fp32, beam search, 12-word list): real-time factor 0.107 for both channels on a Mac mini M4 (target 0.25) and 0.25 on four x64 cores (target 0.5). Since a call line no longer waits for its speaker (#359), five of eight Mac runs commit every line within 1.5 s (1.18 s at worst with Nemotron, 1.29 s with embeddings); the other three had their first one to three lines, in the first 9 s after a cold start, at 1.52 to 5.77 s, and the rest within 1.5 s. On four x64 cores the line misses on both channels with either diarizer: 1.85 s on the mic, and on the call 2.27 s with Nemotron and 1.82 s with embeddings, at worst; without each channel's first line the x64 mic worst is 1.80 s, and the call worst, 2.27 s, comes mid-call, so the x64 result does not move. |
| G7 | Partial | Fake run 5 of 5 against the signed 0.6.2 app: control `missing`, recorded streams answer (first token 113 ms claude, 62 ms codex), usage limits give excerpts only with `exhausted`. Real run against the signed 0.6.4 app (2026-10-09), with no harness on its `PATH`: it found both harnesses through the login shell, and claude, signed in, streamed its answer with the first token at 2,692 ms and the full answer at 4,063 ms. Codex has no live sign-in on the machine (`errorKind: auth`, HTTP 401), so the codex half is still open. |
| G8 | Pass | Re-run at `36a2237` (2026-10-07), on a quiet machine: cold `akou start` p95 578 ms (20 runs, 20 separate app processes), warm p95 319 ms; `f6cabfc` measured 193 ms and 159 ms. The app now takes about 180 ms longer to answer its API. Under heavy background load (load average 16 to 65) the cold p95 went over 3 s in two of four runs, and warm starts failed on both commits when the helper took over 3 s to open the devices (see below). |

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

## G1: the shell

**What ran.** [`scripts/gates/g1-shell.ts`](../../scripts/gates/g1-shell.ts) in the release workflow's `app-desktop` job on GitHub's Windows and Linux x64 runners, on 2026-10-07, against the app that job had just built (0.6.3, the pull request's merge commit `500ca8f`, run [37621954844](https://github.com/GeiserX/akou/actions/runs/37621954844)), not a source run. A second run on the same code followed (merge commit `d9f6864`, run [37625259313](https://github.com/GeiserX/akou/actions/runs/37625259313)); the branch between the two changed only docs and a test comment. Unlike the gates below it did not run on the reference Mac mini. It gives the app a scratch `AKOU_HOME` and a fake capture helper, so a call records a generated signal and opens no audio device, and it reaches the app only through the `akou` command the bundle carries. Linux starts the built launcher, which unpacks the app into `~/.local/share` the way an installed one does, on an X display (Xvfb with Openbox) and a session bus where the runner owns the StatusNotifierWatcher. Windows runs the release's `akou-Setup.exe`, as a person installs it, then ends the app the installer starts when it finishes, so the controls see no akou and the gate's own start is the only one.

The probes: on Linux, X11 windows by title and the StatusNotifierItem with ElectroBun's id and status Active; on Windows, `EnumWindows` for the window and `Shell_NotifyIcon` against ElectroBun's tray window for the notification-area icon, and the `Run` key for the login item. A screenshot of the screen for each start.

**Result of run 37621954844: pass on both systems, every phase, no problem** ([g1-linux.json](g1-linux.json), [g1-windows.json](g1-windows.json), the run's artifacts `gate-g1-Linux` and `gate-g1-Windows` unchanged).

| Phase | Window | Tray item | Hotkey | Login item |
|---|---|---|---|---|
| Control, before any start | none | none | | none |
| Normal start | one, titled akou (shots: [Linux](g1-linux-shots/1-normal.png), [Windows](g1-windows-shots/1-normal.png)) | present (Linux `electrobun-tray-1`, Active) | no call with no key sent; first press started a call ([Linux](g1-linux-shots/2-recording.png), [Windows](g1-windows-shots/2-recording.png)), second stopped it | none with `app.openAtLogin` off |
| Headless start, `AKOU_HEADLESS=1` | none after 10 s ([Linux](g1-linux-shots/3-headless.png), [Windows](g1-windows-shots/3-headless.png)) | present | start and stop | written: Linux `env AKOU_HEADLESS=1 "<launcher>"`, Windows `cmd /c "set AKOU_HEADLESS=1&& start "" "<launcher.exe>""` |
| The login item's own command | none ([Linux](g1-linux-shots/4-login-item.png), [Windows](g1-windows-shots/4-login-item.png)) | present | start and stop | |
| `app.openAtLogin` off, next start | one | | | removed |

`akou status` read `headless: true` in both headless phases and `false` in the other two, and the registered hotkey was Control+Shift+F9. Setting `app.openAtLogin` through `akou config set` writes the login item at the next start, not at once (DK-L2 in [DESKTOP.md](../ux/DESKTOP.md)); the gate records that and does not judge it.

**The login item started Bun's help, not akou.** The first runs found it: the login item named `process.execPath`, which in the packaged app is the bundled Bun (`bin/bun`, `bin\bun.exe`, `Contents/MacOS/bun`), and Bun started alone prints its help. The login item now names the launcher beside it (`loginProgram` in [`login-item.ts`](../../src/main/window/login-item.ts)), on all three systems. The login-command row above is the proof on Linux and Windows.

**The first Windows run stopped after install.** The installer starts the installed app when it finishes, with the user's real home. That app held the installer's output open for the whole 300 s wait, the controls saw its window and tray icon, and the gate's own start in the scratch home exited at once with code 0. The runner now writes the installer's output to a file and ends that app (`akou quit`, then the process tree if it is still there) before the controls; on the 0.6.3 run `akou quit` alone ended it.

**The second run failed on Linux, in the normal start's quit.** Run 37625259313 gave Windows a pass on every phase again, and Linux `"verdict": "fail"` with one problem: `normal start: the app did not quit within 30 s`. The call had stopped on the second hotkey press. The app logged `quitting` at 13:08:19.386 and `call ... ended` 51 ms later, then never its own `akou 0.6.3 quit` line, and `runtime.json` stayed. The gate ended the launcher 10 s later and the next phases ran and passed. `quitting` before `ended` is the normal order: every quit after a call in both runs logs it that way, and the good ones log `quit` right after `ended` (6 ms after it in run 37621954844's normal start). So the app hangs somewhere in its quit after the call ends, and none of those steps logs, so where is not known yet. That is an app bug on Linux the gate found, tracked in [#351](https://github.com/GeiserX/akou/issues/351). The committed Linux file is the passing run's; the failing run's file is in its `gate-g1-Linux` artifact.

**Verdict: partial.** Windows x64 passes on both runs. Linux x64 on X11 passed every phase on one run and hung in quit after a call on the other. macOS arm64, which [ROADMAP](../ROADMAP.md) also lists under G1, was not run.

**Still open.**

- Linux: `akou quit` hanging after a call ([#351](https://github.com/GeiserX/akou/issues/351)); after the fix, the gate passing on several runs in a row.
- macOS arm64: the same phases on a Mac, which the runner does not support yet (window, tray and login item probes exist for Linux and Windows only).
- Linux on Wayland, and a desktop whose tray is not a StatusNotifierWatcher.

## G2: recognition in the packaged app

**What ran.** The release workflow ([`release.yml`](../../.github/workflows/release.yml)) on the v0.6.2 tag push, run [37560614284](https://github.com/GeiserX/akou/actions/runs/37560614284) at commit `39c8ebd`. On each OS the job built the app with `scripts/build-app.ts`, checked it with `scripts/smoke-app.ts`, then ran [`scripts/gates/g2-worker.ts`](../../scripts/gates/g2-worker.ts). That script downloads the pinned recognizer (`parakeet-tdt-0.6b-v3-fp32`, every file checked against its pin) and the upstream English test clip, unpacks the built bundle, and bundles [`g2-probe.ts`](../../scripts/gates/g2-probe.ts) into the app's main folder with sherpa-onnx-node left to the app's own `node_modules`, the way the app's Workers load it. The app's bundled Bun (1.4.0 on all three) then runs the probe twice while the main thread ticks every 1 ms and records the gap between ticks: once with the recognizer loading and decoding the clip in a Bun Worker (the gate), and once with the same load and decode on the main thread (the positive control, which must leave a gap of 100 ms or more, or the measure could not see a blocked thread). The raw outputs are [g2-macos.json](g2-macos.json), [g2-windows.json](g2-windows.json) and [g2-linux.json](g2-linux.json), copied unchanged from the run's artifacts `gate-g2-macOS`, `gate-g2-Windows` and `gate-g2-Linux`.

**The machines.** GitHub-hosted runners, not the reference Mac mini. macOS arm64 ran on `macos-latest` in the `app` job, against the signed bundle that the release published. Windows x64 and Linux x64 ran on `windows-latest` and `ubuntu-24.04` in the `app-desktop` job, against bundles that are built and checked but not published yet. The criterion names the packaged bundle on all three OSes and no particular machine, so runners meet it. They are shared machines, so the tick figures include whatever else the runner was doing.

**Numbers.** Load and decode are the probe's own timings of the recognizer. The tick columns are the main thread's gaps between 1 ms ticks while the recognizer loaded and decoded.

| OS | Load | Decode | Ticks | Worker run: tick p50 / p99 / longest | Control: longest tick |
|---|---|---|---|---|---|
| macOS arm64 | 12,142 ms | 4,213 ms | 10,365 | 1.4 / 4.1 / 26.7 ms | 11,997.2 ms |
| Windows x64 | 3,486 ms | 631 ms | 2,691 | 1.6 / 1.6 / 3.1 ms | 4,085.1 ms |
| Linux x64 | 2,169 ms | 827 ms | 2,772 | 1.1 / 1.1 / 3.8 ms | 2,584.7 ms |

All six runs, Worker and control on each OS, returned the clip's words: "Ask not what your country can do for you. Ask what you can do for your country." In each control the longest tick matches its own load plus decode (10,221 + 1,773 ms on macOS, 3,501 + 583 ms on Windows, 2,116 + 468 ms on Linux): the main thread waited the whole time, which is what a blocked thread looks like to this measure. Before the recognizer started, the idle tick p50 was 1.9 ms on macOS, 1.5 ms on Windows and 1.1 ms on Linux.

**Verdict: pass on all three.** Each file reads `"verdict": "pass"` with no problems: the Worker heard the clip, its longest tick stayed under the 100 ms limit (26.7 ms at worst, on macOS), and the control proved the measure sees a blocked thread.

**Still open.** Nothing for the criterion. Every tag push re-runs the gate. On Windows and Linux a failed gate fails the job. On macOS the step is `continue-on-error`, because prereleases never wait on a gate, so there the job's colour says nothing about G2 and only the `gate-g2-macOS` file does.

## G3 (lite): the app-spawned helper captures real audio

**What ran.** [`scripts/gates/record-call.ts`](../../scripts/gates/record-call.ts) over SSH, with the app not running: it timed `akou start`, which launched the app headless, and the app spawned the helper. A signal source ([`drift-signal`](../../native/akou-capture/examples/drift-signal.rs)) played its mic train into BlackHole and its call train into the speakers. Then 612 s of recording, stop, quit, and the Opus file measured per channel by [`drift-test.ts`](../../scripts/drift-test.ts). The raw output is [g3-lite.json](g3-lite.json).

**Numbers.** 201 after 179 ms, including launching the app. The helper reported audio 92 ms after spawn. The right channel, the call side, had RMS -35.7 dBFS and peak -4.2 dBFS. All 59 call chirps were found where they should be, matched at 0.973 or better, with no gap over 5 ms. The left channel, the mic side, had RMS -105.1 dBFS and peak -50.8 dBFS. That is digital silence plus a little Opus stereo crosstalk from the right channel, because the SSH session has no Microphone grant (previous section). The first round's 36 s run gave the same picture (201 after 0.24 s, audio at 91 ms, right RMS -30.1 dBFS, left -93 dBFS) but kept no raw output, so those figures are superseded by this run.

**Verdict: partial.** The tap works through the app-spawned helper and lands on the correct channel. Real mic audio through the same helper was not shown in any one session on this box. Permission attribution to a signed app cannot be judged on a SIP-off box: nothing here is signed, and the prompts that did appear named Terminal, the process that launched everything.

**Still open.** Nothing for the criterion. G3 as [ROADMAP](../ROADMAP.md) states it ran in two halves on a Mac with SIP on, in the next two sections: the first on the signed 0.6.2, the second on the signed 0.6.4 copied over it. The G3-lite above stays as the SIP-off record of the tap itself.

### The first half on the signed 0.6.2

**What ran.** On 2026-10-07, on an Apple silicon Mac with SIP on and macOS 27.0.1, not the reference Mac mini. The v0.6.2 release's `akou.app` from its DMG, `TeamIdentifier=624WUVM8B4` and `source=Notarized Developer ID` from `spctl`, was dragged over the ad hoc 0.5.5 that was there, after `tccutil reset Microphone io.github.geiserx.akou` and `tccutil reset AudioCapture io.github.geiserx.akou`. The mic was BlackHole 2ch, a virtual device, and the output a USB microphone's unused headphone jack, so nothing was audible. The signal source played its mic train into BlackHole and its call train into that output. The app ran under a scratch `AKOU_HOME`, started by the release's command-line `akou start`, which opens the bundle through Launch Services: the process that asks for the devices is the app, not a terminal. The TCC daemon's log, `log stream --predicate 'subsystem == "com.apple.TCC"'`, ran for the whole session, and its prompt and grant lines are in [g3-signed-prompts.txt](g3-signed-prompts.txt). Then [`record-call.ts`](../../scripts/gates/record-call.ts) with `--without-models` for a 120 s call, `akou quit`, the same again, and [`drift-test.ts`](../../scripts/drift-test.ts) on each recording, on the Mac mini.

**The prompts.** Two in the whole session and no other. Microphone at the first start, `AUTHREQ_PROMPTING … service=kTCCServiceMicrophone, subject=Sub:{io.github.geiserx.akou}`, and system audio at the first call, `kTCCServiceAudioCapture` with the same subject. The grants the daemon recorded as `TCCDEvent: type=Create` are the same two, keyed by the bundle id `io.github.geiserx.akou`; the only other Create events in the log are two AppleEvents grants for a terminal app, and the terminal, `sshd` and the helper got no Microphone or system-audio grant. One thing to know before the second half: the capture helper raises the system-audio prompt, and the helper lives only as long as the call. When nobody answers within about 10 s the helper's attempt ends and the prompt goes with it. The app's own Microphone prompt stays on screen. No screenshot of System Settings is on record; the daemon's Create events are what that pane shows.

**First recording.** The raw output is [g3-signed-first.json](g3-signed-first.json), the start timing [g3-signed-first-start.json](g3-signed-first-start.json). `akou start` answered in 1154 ms with the app not running, the helper reported audio 335 ms after spawn, 120.3 s were recorded, and neither channel has a gap over 5 ms. Mic train on the left: all 12 chirps inside the file found. The train's first chirp fell 2.8 s before the file and its last three after the end. One of the 12 matched by waveform, at 0.665 and -21.1 ms against host time. The other eleven matched by band energy, ten at 0.849 or better and chirp 11 at 107.2 s at 0.527, the weakest match of the whole session, with a waveform correlation of 0.31. Their median is -23.6 ms, 2.5 ms earlier than the waveform match, which is why the analysis keeps the two kinds of match apart in its timing (`timingFrom`, `envelopeLatencyMs`, `pairsFrom`) and, with a single waveform match as here, times the train from the envelope matches. That fallback is new in `drift-test.ts` and exists because of this run. The call file is 48 kbps stereo Opus, and with both channels carrying signal the codec keeps a 50 ms sweep's energy in its band but not its waveform, so the correlation fell to about 0.3 on chirps that are plainly there: the left channel's RMS is -38.1 dBFS against a pilot at -40 dBFS, and its peak 0 dBFS. A check by hand, not on record, found no crosstalk: the left channel correlates near zero with the right channel's copy of the same chirp. Three controls. On the restart recording with a silent mic, [g3-signed-restart-silent-mic.json](g3-signed-restart-silent-mic.json), the fallback finds nothing on the left. On a copy of this file with the left channel delayed 50 ms, the waveform match moves from -21.1 to +28.9 ms and the envelope median from -23.6 to +26.3 ms. And its thresholds come from the hour run below: chirps the waveform missed scored 0.505 to 0.93, the low end being `minEnvelopeScore` in [g4-signed-hour.json](g4-signed-hour.json), with 42.6 to 50.2 dB of band energy over the window's floor; the high end and the energies are a check by hand, not on record, since the per-match energy is not written out. The correlation does not separate chirps from chirp-free windows: with the expected time shifted 2.5 s so no window holds a chirp, the worst of the hour's 1348 windows, where the first-words clip lands in the tap at 2699 s, scores 0.736 at 19.7 dB, and under the restart's music chirp-free windows reach 0.84, both by hand as well. The 20 dB energy guard is what decides, with 23 dB of room on the chirp side and 0.3 dB on the other, so the match asks for 0.5 and 20 dB. Call train on the right: 11 of 11 by waveform at 0.981 or better, -12.8 ms against host time with a 0.007 ms spread. The tap also heard the mic train, 12 found, as a global tap does with a virtual device.

**Restart with no new prompt.** The raw output is [g3-signed-restart.json](g3-signed-restart.json), the start timing [g3-signed-restart-start.json](g3-signed-restart-start.json). After `akou quit` left no akou process, the next `akou start` took 1564 ms, and from that start to the end of the session the daemon logged no prompt of any kind. Mic train on the left: 11 of the 11 chirps inside the searchable span, all by waveform, lowest 0.693 (chirp 12 fell at 119.51 s, 14 ms past the span's end, which is 1 s before the end of the 120.50 s file, and was not searched), -21.1 ms against host time with a 0.27 ms spread. Call train on the right: 11 of 11, lowest 0.563, median -13.0 ms but an 18.0 ms spread, chirp 6 at -30.8 ms. The lower scores and that spread have a cause: music was playing on the machine during this run and the tap recorded it, right channel RMS -17 dBFS against -35.6 dBFS in the first recording. The first-words clip was still found whole, `lostMs` 0. The left channel has three gaps over 20 ms, the longest 1.02 s at 74.8 s and 0.47 s at 60.8 s, which the first recording did not have. The helper's messages say why: its mic stream was lost twice with "A buffer underrun or overrun occurred" and rebuilt each time, and the signal source printed the same error for its output stream on its console, which is not on record. The machine was in use at the time. A quiet machine is where gaps are judged, in the G4 hour run; a mic stream that dies under load and comes back a second later is a finding for that run to confirm or clear. An earlier restart attempt, kept as [g3-signed-restart-silent-mic.json](g3-signed-restart-silent-mic.json), had its mic come through as digital silence, because the machine's default input had changed to the USB microphone between the two starts and that capsule was muted. It raised no prompt either, and it is the negative control above.

**Verdict: Partial, three of the four conditions met.** Both prompts name the signed app and both grants sit under its bundle id with nothing else granted. The first recording finds every call chirp on the right and every mic chirp on the left, one of them only by its band energy. The recording after a quit and restart finds all 11 of each with no new prompt. The second half, the next signed release installed over this 0.6.2 with one more 120 s recording that finds both trains and raises no prompt, has not run; that session also repeats the first recording on a quiet machine, and runs the positive control, `tccutil reset Microphone io.github.geiserx.akou` followed by a start that prompts again, so the no-prompt check is shown to go red. G3 becomes Pass with that evidence and not before.

### The second half on the signed 0.6.4

**What ran.** On 2026-10-08, on the same Mac with SIP on and macOS 27.0.1, with the 0.6.2 of the first half still installed and its two grants in place. The v0.6.4 release's `akou.app` from its DMG, checksum matching the release's `SHA256SUMS`, `TeamIdentifier=624WUVM8B4` and `source=Notarized Developer ID` from `spctl`, the notarization ticket stapled, was copied over the 0.6.2 bundle with the app quit and no TCC reset, the way the in-app updater and a drag in Finder replace it. Same scratch `AKOU_HOME`, same devices (BlackHole 2ch as the mic, a USB microphone's unused headphone jack as the call output), same signal source, and the same TCC daemon log stream, whose lines for this half are appended to [g3-signed-prompts.txt](g3-signed-prompts.txt). That stream had died with the shell that owned it earlier in the morning and was started again at 10:42, more than an hour before the install, so the window measured here is covered without a hole. Then [`record-call.ts`](../../scripts/gates/record-call.ts) with `--without-models` for a 120 s call and [`drift-test.ts`](../../scripts/drift-test.ts) on the recording, on the Mac mini. The music player was paused for the whole run, but the tap was not quiet: [g3-signed-update-levels.txt](g3-signed-update-levels.txt), the RMS of each channel per 5 s window from ffmpeg, shows the right channel at -35 dBFS for the first 25 s apart from the clip's window, then rising from about 30 s to between -21 and -16 dBFS until the end. Something else was playing into the tap from that point, and nothing on record says what. The left channel keeps its pilot-and-chirp pattern, -43 and -37 dBFS in alternate windows, for the whole file.

**The first start failed.** The release's `akou start`, run against the freshly copied bundle, answered "akou did not answer within 3 s of launching" and exited 1, while the app's own log shows `akou 0.6.4 started` a moment later: the first launch of a new bundle takes longer than the CLI's 3 s window, and a launcher process without a child was left behind. The signal train of that attempt played with no recording. That is a CLI bug, not a permission event, and it is filed as [#356](https://github.com/GeiserX/akou/issues/356). It raised no prompt: the daemon answered the app's Microphone and system-audio checks at 11:55:49, 11:55:53 and 11:55:58 from the grants of the first half. Three minutes later, with the app quit, the same command answered in 1445 ms with the helper reporting audio 378 ms after spawn, and the recording below ran.

**The recording.** The raw output is [g3-signed-update.json](g3-signed-update.json), the start timing [g3-signed-update-start.json](g3-signed-update-start.json). 120.6 s were recorded, and neither channel has a gap over 5 ms. Mic train on the left: 11 of the 11 chirps inside the searchable span found (the train's first chirp fell 0.3 s before the file and chirps 12 to 15 after the span's end at 119.1 s), 9 by waveform at 0.722 or better and 2 by band energy at 0.842 or better, -21.08 ms against host time with a 0.002 ms spread over the waveform matches. Call train on the right: 11 of 11, all by waveform, lowest 0.554, -12.82 ms with a 0.013 ms spread. The left-right offset over the 9 waveform pairs is 8.26 ms with a 0.014 ms spread. The first-words clip was found whole, `lostMs` 0. The left channel's RMS is -38.7 dBFS against the -40 dBFS pilot. The right's is -20.6 dBFS, 15 dB above the first recording and the hour run with the same pilot and clip, because of the extra signal in the tap from 30 s on. Against the first recording of the first half, where one mic chirp in twelve matched by waveform, this run matched nine of eleven that way, and its call chirps' lowest waveform score fell from 0.981 there to 0.554 here, close to the 0.563 of the restart run that had music in the tap; the timing did not move, 0.013 ms of spread. Nothing on record says what moved the left channel's scores between the two runs.

**The prompts.** From the log line before the install to the end of the recording, the daemon logged no `AUTHREQ_PROMPTING` for any app and recorded no `TCCDEvent: type=Create` for any identifier. The whole log still holds exactly the two prompts of the first half. So the signed 0.6.4 over the signed 0.6.2 kept both grants, which is what the updater relies on and what [TRAPS](../TRAPS.md) says about Developer ID-signed updates.

**The check can go red.** After the recording, `tccutil reset Microphone io.github.geiserx.akou` at 12:04:44, then `akou start`: the daemon logged `AUTHREQ_PROMPTING … service=kTCCServiceMicrophone, Sub:{io.github.geiserx.akou}` at 12:04:46.098, one prompt and no other, and the same counter that read 0 across the install read 1 here. A click on Allow put the grant back at 12:04:49, `TCCDEvent: type=Create` for the same bundle id, and the app was quit.

**Verdict: Pass.** All four conditions have evidence from the signed app on a Mac with SIP on: the prompts and grants name akou and nothing else; a 2-minute recording finds every searchable chirp of the mic train on the left and of the call train on the right; a quit and restart raises no prompt; the next signed release installed over it raises no prompt and records both trains. The no-prompt check was shown to go red on a reset.

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

**Verdict: partial.** On this Mac, the two fixes do what they claim wherever a real device could show it. The first start after a silent tap no longer triggers a rebuild, loses no speech and is aligned from its first chirp. The call channel ran an hour with no gap over 5 ms. The mic channel was silent because SSH has no Microphone grant, so its continuity was not tested. A forced rebuild is placed at once and costs 72 to 88 ms. The 1 s rebuild of a dead tap was not seen live, because no tap died; only the simulated tests cover it. The gate still does not pass. Nobody measured the left-right drift between two clocks, the number the gate exists for, and this machine cannot. The macOS 14.2 or 14.3 run was not done either.

**Still open.**

- A two-clock run on a Mac with a real input device (a USB mic or audio interface) and a session holding both the Microphone and the system-audio grant: `drift-signal` with the mic train into that device's loopback or played acoustically into the mic, `akou start`, 62 minutes, `drift-test.ts`, then `g4-controls.ts`.
- A real tap death under the new rule: the next one that happens on a real device should show `dead` with `silent_for` near 1 s and a gap near 1 s.
- The macOS 14.2 or 14.3 run, in a tart VM on an Apple silicon Mac: [`scripts/gates/g4-macos14-vm.sh`](../../scripts/gates/g4-macos14-vm.sh) records 12 s through the helper with a tone playing and 12 s with nothing playing, and passes when the call channel reads above -60 dBFS with the tone and under -90 dBFS without it. The VM has no microphone, so it answers only whether the tap works on 14.3, which is what decides the 14.4 floor. Half done: on 14.3 the tap opens and macOS asks Terminal for access (system audio on the first run, the microphone on the next); the Allow clicks and the measured run are left ([macOS 14.3 in a VM](#macos-143-in-a-vm)).

### Hour run on a Mac with SIP on through the signed app

**What ran.** On 2026-10-08, in the same session as the [G3 first half](#the-first-half-on-the-signed-062): the signed 0.6.2 under a scratch `AKOU_HOME` on an Apple silicon Mac with SIP on, macOS 27.0.1, the mic BlackHole 2ch and the call train on a USB microphone's unused headphone jack, while the machine was idle and nothing else played. The hour run as in [the hour run](#the-hour-run): 3720 s of signal with the call side from 35 s and muted from 2100 s for 600 s, a 3690 s recording, [`record-call.ts`](../../scripts/gates/record-call.ts) sampling memory. Then the quiet-tap run as in [the quiet-tap run](#the-quiet-tap-run): no mic side, the call side from 30 s, muted from 150 s for 600 s, a 795 s recording. Raw output: [g4-signed-hour.json](g4-signed-hour.json) and [g4-signed-hour-start.json](g4-signed-hour-start.json), [g4-signed-quiet.json](g4-signed-quiet.json) and [g4-signed-quiet-start.json](g4-signed-quiet-start.json), [g4-signed-controls.json](g4-signed-controls.json).

**Hour run.** `akou start` answered in 4522 ms with the app not running, the helper reported audio 2445 ms after spawn; the file is 118.9 ms shorter than the wall time of the part. No gap over 5 ms on either channel in 3689 scanned seconds. Mic train on the left: all 369 chirps inside the file found, 345 by waveform (lowest 0.555) at -21.08 ms against host time with a 0.013 ms spread and a 0.00 ms per hour slope, 24 by band energy. Call train on the right: all 305 inside the file found by waveform, lowest 0.976, -12.82 ms with a 0.013 ms spread and a 0.01 ms per hour slope. Left against right over the 284 periods where both matched by waveform: 8.27 ms, spread 0.022 ms, slope 0.01 ms per hour. The tap also heard the mic train, 368 of 369, almost all by band energy. First words after the 10-minute mute: the clip's first 20 ms slice matched at 0.96 with nothing lost, at both call starts. Helper memory over the hour: 19.1 MB to 16.3 MB, slope -0.4 MB per hour; inside the mute, 16.3 MB to 16.0 MB. App memory 152 MB to 71 MB, with a 339 MB peak early in the run.

**Quiet-tap run.** `akou start` in 2834 ms, audio 1418 ms after spawn, 795 s recorded, no gap in the 166 s the call side played. Both quiet windows, 0.5 to 27.9 s and 148.8 to 747.9 s, are digital silence on the call channel (every sample zero, which the analysis prints as `null` for -∞ dBFS). The helper raised `permission-suspect` during the long silence, as the rule in DESIGN 2.5 says it should when a tap stays silent, and the recording went on. The first words after each silence were whole: 0.976 and 0.963 on the first slice, nothing lost. All 17 call chirps inside the file found at 0.986 or better, spread 0.019 ms. Helper memory 19.2 MB to 17.8 MB over the run and 17.6 MB to 19.3 MB inside the mute; app 152 MB to 125 MB.

**Positive controls on this recording.** The same [`g4-controls.ts`](../../scripts/gates/g4-controls.ts) as before, on the hour recording:

| Injected | Recovered | Expected |
|---|---|---|
| 50 ms delay, left-right offset | -50.00 ms | -50 ms |
| 50 ms delay, call train on the left | +50.00 ms | +50 ms |
| 75.0 ms per hour, call train slope | -75.00 ms per hour | -75 ms per hour |
| 75.0 ms per hour, left-right slope | +75.00 ms per hour | +75 ms per hour |
| 75.0 ms per hour, mic train slope | -74.99 ms per hour | -75 ms per hour |

**What this does and does not settle.** Through the signed app on a SIP-on Mac, with a real microphone grant, an hour of capture lost nothing and both trains stayed where their host time put them to within 0.02 ms. That is the gate's hour run on the platform the gate is about. What it does not settle is the two clocks. BlackHole runs on the host clock, and the tap here held the host clock too, so this run bounds the tap against the host and says nothing about a USB device's crystal drifting against it. Had the tap followed the USB output device's clock, the left-right slope would not be 0.01 ms per hour; so on this macOS the system tap delivers audio on the host clock whatever the output device. A real two-clock measurement still needs a USB input device, or a USB interface with a loopback cable, as the mic. G4 stays Partial on that and on the 14.3 clause.

### macOS 14.3 in a VM

This answers half of the 14.2 or 14.3 clause. It ran in tart VMs on an Apple silicon Mac mini, through [`scripts/gates/g4-macos14-vm.sh`](../../scripts/gates/g4-macos14-vm.sh), with the helper built from `36a2237` by `cargo build --locked --release`. That build's minimum macOS is 11.0 (`vtool -show-build`), the same as the helper in the 0.6.2 release, so it loads on 14.3. The host's output was muted for every run, so nothing played aloud. The raw output is in the folder `g4-macos14/` next to this page: a `verdict.json` per run and the helper logs, no audio.

**The image tagged 14.3 runs 14.4.** `ghcr.io/cirruslabs/macos-sonoma-vanilla:14.3` (digest `sha256:57db14ca8a50c992d9213f9c2ce6cca5de63e31f958227383bca17fe7f668b7e`) boots macOS 14.4, build 23E214. The registry dates its upload 2024-03-07, the day 14.4 shipped. The script refused it before recording, as designed ([cirruslabs-14.3-tag/verdict.json](g4-macos14/cirruslabs-14.3-tag/verdict.json)). So we built a clean macOS 14.3 (build 23D56) VM from Apple's restore image; the script's header gives the steps, and the script now uses that VM by default. SIP is on in it.

**A recording straight onto the shared folder never starts.** In the 14.4 VM, both recordings failed at once with `cannot create tone.opus: Inappropriate ioctl for device (os error 25)`. The helper syncs its file with `F_FULLFSYNC`, and tart's shared folder refuses that call. The script now records to a folder on the guest's own disk and copies the file to the share afterwards. A real user records to the internal disk, so this is a fault of the VM setup, not of akou.

**Over SSH the tap delivers zeros, with no prompt.** We then ran the gate over SSH: the 14.4 VM with a copy of the script that accepted 14.4, and the 14.3 VM with the script itself. Both behaved the same. The helper opened the tap (`capturing`). Buffers arrived when the tone started, 2.7 to 3.0 s after `capturing`, where `afplay` starts at 3 s. Every sample was zero: the call channel read -190 dBFS with the tone and -190 dBFS without it. A screenshot of the 14.4 guest during a tone recording over SSH showed no prompt. Verdicts: [14.4-ssh](g4-macos14/14.4-ssh/verdict.json), [14.3-ssh](g4-macos14/14.3-ssh/verdict.json), with the helper logs beside them. macOS asks the responsible process for system-audio access. For a helper started over SSH that is `sshd-keygen-wrapper`, and macOS never asks it. On the reference Mac the same path records real audio only because `sshd-keygen-wrapper` already holds a grant there (see [Recording from SSH versus the console session](#recording-from-ssh-versus-the-console-session)). So the script as merged could not pass on a fresh VM, and its hint was wrong. A tone run that reads silent with no `warn open` line is this, not a broken tap.

**From Terminal, macOS 14.3 asks.** The script now opens each recording in Terminal in the guest's console session, over SSH, and reads the exit status from the share. On 14.3 the guest showed "Terminal Would Like Access To Record Your System Audio". While the prompt waited, the helper gave up after its open budget (`warn open: the process tap did not open in time`), `afplay` blocked as well, and the gate failed with "the recording did not finish" ([14.3-terminal](g4-macos14/14.3-terminal/verdict.json)). We did not click the prompt, by hand or by script.

**The next run asked for the microphone.** We ran the same script again on the same clone, with the fix that stops a stuck recording by process name (`pkill -x`). This time the guest showed "Terminal would like to access the microphone." ([screenshot](g4-macos14/14.3-terminal-rerun/prompt.jpg); the first run's prompt is [here](g4-macos14/14.3-terminal/prompt.jpg)). The helper runs with `--mic none`. It opened the tap at once (`capturing`) and then reported `health no-buffers` on the call channel for the whole recording, levels at -120 dBFS. `afplay` blocked behind the prompt until the script killed it after its timeout, so the tone never played. Both files are digital zeros (call channel -190 dBFS RMS), and the gate failed with "the recording did not finish" ([14.3-terminal-rerun](g4-macos14/14.3-terminal-rerun/verdict.json), helper logs beside it). We did not click this prompt either. Why the second run got a microphone prompt instead of the system-audio one is not established: the guest's permission records were not read.

**What this shows.** On macOS 14.3 the process-tap path runs as far as the permission. Creating the tap and its aggregate device succeeds, the IO starts when output starts, and macOS asks the responsible app for system-audio access, as on 14.4 and later. On the next run it asked for the microphone instead, and the tap opened but delivered no buffers while that prompt waited. Whether the samples are real audio after Allow is not measured yet, so the clause stays open and `MIN_MACOS` stays 14.4.

**What a pass would mean.** If the next run passes (tone above -60 dBFS, silence under -90 dBFS), the tap delivers audio on 14.3, and the floor could drop to 14.3. That is the owner's call, and it is three edits that must move together: `MIN_MACOS` in [scripts/build-app.ts](../../scripts/build-app.ts), `MIN_MACOS` in [scripts/patch-plist.sh](../../scripts/patch-plist.sh) (the bundle's `LSMinimumSystemVersion`, which `smoke-app.ts` checks against the first), and the floor stated in [DESIGN.md](../DESIGN.md). 14.2 would need its own run, on a VM built the same way from the 14.2 restore image.

**Still open.** One click. On the Mac that holds the VM: `VNC=1 TART_HOME=<folder> scripts/gates/g4-macos14-vm.sh <akou-capture> <out>`, open the `vnc://` address tart prints (from another Mac, through an ssh tunnel to that port), click Allow in each prompt that appears (system audio, microphone), let the run finish, then run the same command again without `VNC=1`. The clone `akou-g4-macos14` keeps the grant between runs.

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

### Re-run on current main

**Why.** The numbers above were measured at `f6cabfc` on 2026-09-24. Since then the app has gained streaming Nemotron, the final pass on Qwen3-ASR, the server and dictation, so we ran the gate again at `36a2237` (release 0.6.2) on 2026-10-07, on the same Mac mini (now macOS 26.6.1).

**What ran.** The same runner, unchanged since the re-run above, the same two ways: the `simulate` build in file mode through the `--fault-file` wrapper ([g5-simulated-rerun.json](g5-simulated-rerun.json)), then the shipping helper on real devices, SIGKILLed 20 s into a call ([g5-kill-real-rerun.json](g5-kill-real-rerun.json)). The app ran from source under the Bun the repository pins (1.4.2), started by the source CLI as before. Four things differ from September:

- The speech models are present: the set `akou models pull` fetches with default settings (Nemotron 3.5 at 560 ms for the live transcript, Nemotron 3 diarization, TitaNet small, Silero VAD, and Qwen3-ASR 1.7B with its llama-server for the final pass). So every start loads the live recognizer and every stop runs a final pass, as it does for users.
- `api.port` was 0, because another akou on the machine held the default port.
- The default output was BlackHole 2ch, not the built-in speakers, so the tone played into BlackHole. It read as muted before the run and after it. The tap hears processes before any device, and it heard the tone in every slice.
- Background load average 10 to 12 during the simulated run and 10 to 13 during the real-device run, against 5 to 9 in September.

The positive control matched as before: intact 0 s, 1.5 s hole 1.5 s, silent 6 s.

**Numbers.**

| Case | `part.ended` | Next part or next start | Call audio lost | API during it |
|---|---|---|---|---|
| Hang on stop | `killed`, stop answered after 5,090 ms (before: 5,067 ms) | Next `akou start`: 201 in 154 ms, sent and answered while the teardown still hung (before: 78 ms) | 0.03 s (before: 0.03 s) | 198 polls, 0 failed, slowest 28.3 ms (before: 194, 0, 20.1 ms) |
| Crash at 20 s (exit 70) | `helper-exit` | Automatic new part 79 ms later (before: 79 ms); next `akou start` 201 in 162 ms (before: 73 ms) | 0.14 s (before: 0.13 s) | 356 polls, 0 failed, slowest 10.2 ms (before: 338, 0, 7.3 ms) |
| Real device helper, SIGKILL | `helper-exit` | Automatic new part 212 ms later (before: 81 ms); next `akou start` 201 in 165 ms (before: 102 ms) | 1.30 s (before: 1.25 s): the killed part logged 19.96 s and decodes to 949 slices, 18.98 s, the same unflushed last Opus page as before | 359 polls, 0 failed, slowest 10.7 ms (before: 340, 0, 5.0 ms) |

The tone was in all 949 slices of the killed part and all 741 of the new part; in September the first 20 ms of each part missed it.

A first pass of both runs under Bun 1.3.14, the machine's default Bun, also passed every check ([g5-rerun-bun-1.3.14.json](g5-rerun-bun-1.3.14.json)): next start 166 ms into the hanging teardown, 0.19 s lost in the crash with a new part 129 ms later, and 1.27 s lost in the real-device kill with a new part 187 ms later.

**Verdict: still pass.** Every criterion holds with room to spare. The restarts are slower than in September (a new part 212 ms after the real-device kill against 81 ms, a next start 154 to 165 ms against 73 to 102 ms), on a busier machine with the recognizer loaded; all of them are far inside the 3 s limit. The audio lost moved by 0.01 to 0.05 s. The `helper-exit` versus `crashed` note above still holds: the SIGKILLed helper is again logged as `helper-exit`.

## G6: recognizer speed

**What G6 asks.** Parakeet TDT v3 fp32 on both channels, `modified_beam_search` with a 12-word decode list: the committed line within 1.5 s of the end of the utterance, and a real-time factor under 0.25 on an M-series Mac and under 0.5 on a 4-core x64. The words: akou, Parakeet, Datadog, Grafana, Silero, Terraform, Kubernetes, Zendesk, TitaNet, pyannote, ElectroBun, Opus. All 12 passed the tokenization check on both machines.

**The re-run of 2026-10-07.** The first run measured int8, the model before the benchmark moved akou to fp32, and only on the Mac. We ran it again on fp32, on both machines, at `origin/main` `36a2237d` with Bun 1.4.2.

- **Clips.** [`g6-clips.sh`](../../scripts/gates/g6-clips.sh) speaks the 24 sentences in [`g6-sentences.txt`](../../scripts/gates/g6-sentences.txt) with macOS `say` (voice Samantha, written to a file, nothing played) and converts them to 16 kHz for the speed run and 48 kHz for the live run: 64.2 s of speech. The first run's audio was not kept, so the sentences were recovered from its transcripts, with the misheard words put back.
- **Offline speed** ([`g6-asr-speed.ts`](../../scripts/gates/g6-asr-speed.ts)): each clip decoded through the app's own `SherpaModels` with 2 threads after one warm-up pass, run twice. A positive control: the same run with 1 thread, which must read slower.
- **Live latency** ([`g6-live-latency.ts`](../../scripts/gates/g6-live-latency.ts)): the 24 sentences on a 56 s stereo timeline, alternating and overlapping between mic and call, played by `akou-capture` in file mode at real-time speed into a cold app (`AKOU_HEADLESS=1`, `AKOU_CAPTURE_FILE_ONLY=1`, a scratch `AKOU_HOME`). `capture.helper` points at a two-line wrapper that runs `akou-capture "$@" --from-wav <timeline> --realtime`, because the app adds `run` and its own arguments after the command. Live lines come from Parakeet as G6 states it: `asr.live` is `parakeet` (the default, `auto`, picks streaming Nemotron when its model is downloaded) and `asr.parakeet.decoding` is `beam`. Everything else is the default, so the call channel has the Nemotron stream diarizer (`asr.diarizer` `nemotron`, akou-diarize from the 0.6.2 release). We did not measure the default Nemotron live path.

**The machines.**

- *M-series:* a Mac mini M4, 10 cores, 16 GB, macOS 26.6.1. It was quiet: load average about 2 on 10 cores, no other benchmark running. The same model of machine under CI load is in the files too: there the 1-thread control read *faster* than 2 threads, so those numbers measure the load, not the recognizer, and they are not the verdict.
- *4-core x64:* a Windows 11 x64 desktop, Intel Core i9-12900, 32 GB, pinned to four performance cores with one thread each (processor affinity `0x55`, as in [asr-12-windows.md](asr-12-windows.md)). The affinity was set at launch and inherited: Bun, `akou-capture` and `akou-diarize` all read `0x55` during the runs. CPU load was 0 to 3 % before each run, and no Actions runner process was on the machine. The release ships no Windows helpers, so `akou-capture` and `akou-diarize` were built there with Rust 1.97.1.

**Speed** ([g6-offline-fp32.json](g6-offline-fp32.json), [g6-x64.json](g6-x64.json)).

| | Mac mini M4 | Four x64 cores | Target |
|---|---|---|---|
| Real-time factor, both channels, speech on both all the time | 0.107, again 0.107 | 0.250, again 0.249 | M-series under 0.25, x64 under 0.5 |
| Real-time factor, one channel | 0.054 (3.45 s of decoding for 64.2 s) | 0.125 (8.04 s) | |
| Decode time per utterance | median 143 ms, at most 163 ms | median 332 ms, at most 408 ms | |
| Control: 1 thread, both channels | 0.132 (slower, as it must be) | 0.422 (slower) | |

**Committed line after the utterance ends** ([g6-live-fp32.json](g6-live-fp32.json), [g6-x64.json](g6-x64.json)). Median and worst, 24 of 24 lines committed in every run.

| Run | Mic | Call | All 24 |
|---|---|---|---|
| Mac, beam, default diarizer | 1.06 s, 1.14 s | 1.76 s, **2.42 s** | median 1.13 s, 90th percentile 2.04 s, worst 2.42 s |
| Mac, greedy, default diarizer | 1.00 s, 1.60 s | 1.75 s, 2.44 s | worst 2.44 s |
| Mac, beam, `asr.diarizer` `embeddings` | 1.05 s, 1.14 s | 1.05 s, 1.25 s | worst 1.25 s |
| x64, beam, default diarizer | 1.39 s, 1.75 s | 2.47 s, 4.55 s | median 1.75 s, worst 4.55 s |
| x64, beam, `asr.diarizer` `embeddings` | 1.31 s, 1.99 s | 1.53 s, 1.93 s | median 1.33 s, worst 1.99 s |

Why the call channel is late: with a stream diarizer, the live worker holds each call line until Nemotron has decided the speaker of all of its audio (`src/main/asr/live-worker.ts`, step 5), and Nemotron runs live at about 2 s latency (the `asr.diarizer` setting says so). Two runs show it is the hold and not the recognizer. Greedy decoding leaves the call channel exactly as late, and with the embeddings diarizer, which holds nothing, the call channel matches the mic. The live latency includes the 0.7 s pause that closes a segment (`asr.segmentPause`).

**Verdict: partial.** Speed passes on both halves: 0.107 against 0.25 on the Mac, and 0.25 against 0.5 on four x64 cores. The committed line fails on the call channel in the default setup, 2.42 s at worst on the Mac, because of the diarizer hold. With the embeddings diarizer it passes, 1.25 s at worst. On four x64 cores the line misses 1.5 s with either diarizer. The first run, int8 on the Mac with no stream diarizer yet, measured 0.081 and 1.14 s at worst ([g6-offline.json](g6-offline.json), [g6-live.json](g6-live.json)).

**The re-run of 2026-10-09, after the call-line fix.** Since [#359](https://github.com/GeiserX/akou/pull/359) a call line is written as `c?` when its segment closes, and the speaker Nemotron decides is a later `seg` revision of the same line. G6 times the committed line, so we measured revision 1. The setup is the one above: fp32, beam search, the 12 words, and the same 24 clips and timeline. We ran it at `origin/main` `34a27777` with Bun 1.4.2. `g6-live-latency.ts` now also writes `speakerMs`, the time until a call line first carries a speaker other than `c?`. Every run started a cold app, one run at a time, alternating the two diarizers.

- *M-series:* the same Mac mini M4, with eight runs back to back ([g6-after-hold-mac.json](g6-after-hold-mac.json)). The load average was 3.8 to 7.6 at the start of each run, with a VM and other light work on the machine.
- *4-core x64:* the same Windows x64 box, pinned to four performance cores as above, with six runs ([g6-after-hold-x64.json](g6-after-hold-x64.json)). Every process read `0x55`, and no Actions job ran during any run. The helpers are the builds of 2026-10-07; only their version numbers have changed since.

Median and worst after the utterance ends. Every run committed 24 of 24 lines, and no run wrote `asr.lag`.

| Run | Mic | Call | Call speaker lands |
|---|---|---|---|
| Mac, Nemotron, runs 2 to 4 | 1.05 to 1.06 s, 1.15 s | 1.03 to 1.04 s, **1.18 s** | 1.56 to 1.58 s, 2.42 s |
| Mac, Nemotron, run 1 | 1.05 s, 2.60 s | 1.06 s, 2.01 s | 1.58 s, 2.41 s |
| Mac, embeddings, runs 1 and 2 | 1.03 to 1.05 s, 1.16 s | 1.06 s, **1.29 s** | with the line |
| Mac, embeddings, runs 3 and 4 | 1.04 to 1.06 s, 5.77 s | 1.06 to 1.07 s, 5.11 s | with the line |
| x64, Nemotron, runs 1 to 3 | 1.33 to 1.39 s, **1.85 s** | 1.47 to 1.53 s, **2.27 s** | 2.41 to 2.43 s, 5.22 s |
| x64, embeddings, runs 2 and 3 | 1.31 to 1.32 s, **1.85 s** | 1.55 to 1.56 s, **1.82 s** | with the line |
| x64, embeddings, run 1 | 3.79 s, 4.32 s | 3.88 s, 4.28 s | with the line |

- On the Mac the call line now commits as fast as the mic line. With Nemotron the call median fell from 1.76 s to 1.03 to 1.06 s, and the worst from 2.42 s to 1.18 s. The speaker lands when the line used to: 2.42 s at worst, as on 2026-10-07.
- Three Mac runs had their first one to three lines late, at 1.52 to 5.77 s, all in the first 9 s after a cold start and on both channels; every later line was within 1.5 s. The load at the start does not explain it: embeddings run 4, with the latest lines, started at a load of 4.06, and embeddings run 1, with none, at 7.64. The mic never waits for a speaker and the embeddings diarizer holds nothing, so the speaker labels are not the cause either. Why a cold app's first lines are sometimes late is open.
- On four x64 cores both channels miss with both diarizers, in every run: 7 to 12 of the 24 lines go over 1.5 s, spread over the whole call. The mic misses too, and it never waits for a speaker, so the time goes to the recognizer on four cores. The call worst with Nemotron fell from 4.55 s to 2.27 s. The mic worst is where it was: 1.85 s, against 1.75 s on 2026-10-07.
- In x64 embeddings run 1, every line on both channels was 3.77 to 4.32 s late from the 17 s mark on, without the app writing `asr.lag`, which it does from 10 s behind. It is kept in the file and left out of the verdict.

**Verdict after the fix: partial.** Speed passes as before. On the Mac, five of eight Mac runs commit every line within 1.5 s (1.18 s at worst with Nemotron, 1.29 s with embeddings); the other three had their first one to three lines, in the first 9 s after a cold start, at 1.52 to 5.77 s, and the rest within 1.5 s. It misses on four x64 cores on both channels with either diarizer: 1.85 s on the mic, and on the call 2.27 s with Nemotron and 1.82 s with embeddings, at worst. The 1.85 s is a first mic line; without each channel's first line the x64 mic worst is 1.80 s, and the call worst, 2.27 s, comes mid-call, so the x64 result does not move. That is the open half of G6, and it is the recognizer's speed on four x64 cores, not the speaker labels.

**Still open.**

- The committed line on four x64 cores: 1.85 s on the mic and 2.27 s on the call at worst, against 1.5 s. The latency clause is decided: a call line is shown as `c?` and relabelled when its speaker is decided (#359).
- Vocabulary, for M1: 10 of the 12 listed words came out right every time, in both the speed and the live runs. "akou" was never right ("ACA", "ACAR", "Akao", "Akau"), and on this voice "pyannote" never was either ("pianoed", "Pianote", "Pianode").

## G7: harness provider

**What ran.** [`scripts/gates/g7-harness.ts`](../../scripts/gates/g7-harness.ts) on 2026-10-07, on a Mac mini M4 (macOS 26.6.1), against the released 0.6.2 and not a source build. The v0.6.2 assets `akou-0.6.2-macos-arm64.zip` and `akou-cli-0.6.2-darwin-arm64.tar.gz` matched `SHA256SUMS` (a copy with one byte appended failed the same check). The app was unpacked with `ditto -x -k` into `/Applications`, and `spctl -a -vv` read `accepted, source=Notarized Developer ID` both before and after its first launch. The runner drove the compiled `akou` from the CLI archive, which starts `/Applications/akou.app` through `open`, with a scratch `AKOU_HOME` holding `dictation.enabled: false`, `capture.mic: none` and `capture.call: none`, so the app opened no microphone and no tap. The first case imports a fixture call; every case quits the app, writes the provider settings and lets the next command start it again.

**Which app answered.** A watcher logged the executable of every pid that `runtime.json` named during the runs: all 10 app processes (6 in the fake run, 4 in the real one) were `/Applications/akou.app/Contents/MacOS/bun`, each a child of the bundle's own `launcher`. `open` hands the caller's environment to the app it starts, so `AKOU_HOME` and, in the real run, the cut `PATH` reached it. We checked that with a stand-in app before the runs.

**Fake run** ([g7-fake.json](g7-fake.json)), no subscription spent: 5 of 5 cases passed.

| Case | Expected | Got | First token | Answer |
|---|---|---|---|---|
| Control: `provider.harnessPath` pinned to a file that does not exist | Excerpts only, `errorKind: missing` | `missing`, the fixture's line in the excerpts, no token | none | 31 ms |
| claude, recorded `ok` stream | Streams and answers | Answered, 1 token | 113 ms | 126 ms |
| claude, recorded usage-limit stream, exit 1 | Excerpts only, `errorKind: exhausted` | `exhausted`, no token | none | 82 ms |
| codex, recorded `ok` stream | Streams and answers | Answered, 2 tokens | 62 ms | 73 ms |
| codex, recorded usage-limit stream, exit 1 | Excerpts only, `errorKind: exhausted` | `exhausted`, no token | none | 300 ms |

**Real run on 0.6.4** ([g7-real.json](g7-real.json)), on 2026-10-09 on the same Mac mini, against the released 0.6.4 (raw output of the checks below: [g7-real-checks.txt](g7-real-checks.txt)). The v0.6.4 assets `akou-0.6.4-macos-arm64.zip` and `akou-cli-0.6.4-darwin-arm64.tar.gz` matched `SHA256SUMS`, and a copy with one byte appended failed the same check. We moved the 0.6.2 app out of `/Applications` and unpacked 0.6.4 there with `ditto -x -k`, and `spctl -a -vv` read `accepted, source=Notarized Developer ID`. Afterwards 0.6.2 went back, with the same code directory hash. The runner was `scripts/gates/g7-harness.ts` from the v0.6.4 tag, which main has not changed, run with `--real --yes`. It asked one question per harness ("When is the release?"), with `provider.harnessPath` empty and `PATH=/usr/bin:/bin:/usr/sbin:/sbin` for the CLI and so for the app. The only way the app could find a harness was the login shell. A watcher read `runtime.json` during the run: every app process was `/Applications/akou.app/Contents/MacOS/bun` reporting version 0.6.4, each a child of the bundle's `launcher`.

| Case | Harness the app found | Got | First token | Answer |
|---|---|---|---|---|
| Control: `provider.harnessPath` pinned to a file that does not exist | none | `missing`, excerpts only | none | 42 ms |
| claude | `claude-code/2.1.226` at `~/.local/bin/claude` | Answered, 5 tokens: "The release was on Friday [17:30 Speaker 1]." | 2,692 ms | 4,063 ms |
| codex | `codex/0.147.0` at `~/.local/bin/codex` | Not answered: `errorKind: auth`, "Codex is not logged in" (HTTP 401). Excerpts only | none | 16,602 ms |

**Time to first token: 2,692 ms for claude**, from the request to the first token on the stream; the full answer took 4,063 ms. That is inside the 2 to 5 s that [DESIGN.md](../DESIGN.md) estimates. The figure includes the harness's own global context on that machine, which loads on every spawn: its user settings and plugins. That machine has no user-level instruction file, no skills and no user-scope MCP servers, so a machine with a heavier context will start slower. Codex has no figure, because no token arrived.

**How claude was signed in.** The claude the app finds there answers when it runs from an ssh shell, cut `PATH` or not. Run by the app, the same binary said "OAuth session expired and could not be refreshed", the 2026-10-07 result again ([g7-real-no-wrapper.json](g7-real-no-wrapper.json), same 0.6.4 setup). For the run above, a two-line `claude` script stood in for `~/.local/bin/claude` while the run lasted: it sets `CLAUDE_CONFIG_DIR` to the same `~/.claude` folder and runs the same 2.1.226 binary, so the version and the user context stay the same. With it the app's spawn answered. Afterwards the original `~/.local/bin/claude` went back and nothing else in that folder changed. The likely cause is the keychain. Over ssh the login keychain is locked (`security show-keychain-info` answers "User interaction is not allowed"), so claude reads the credential file in that folder, which is live. The app runs in the console session, where claude reads its default keychain item, which holds the expired session. We did not read either credential to confirm it. Both the terminal and the app run in the console session on a person's Mac, so this split comes from testing over ssh and is not a fault in the app.

**Codex** has no live sign-in anywhere on that machine. Its default home reports "Not logged in", and the two older per-account Codex homes there fail to refresh their tokens ("Your access token could not be refreshed"). So there was nothing to point the app at, and the codex half is still open. With a failed sign-in the app takes about 16 s to fall back to excerpts, because codex retries before it exits.

**The 2026-10-07 real run on 0.6.2** ([g7-real-0.6.2.json](g7-real-0.6.2.json)) found both harnesses the same way and got `errorKind: auth` from both (claude 1,213 ms, codex 15,723 ms), with no token. That is the result the no-wrapper run above repeats on 0.6.4.

**Permission prompts.** None that we saw. The TCC log for the 2026-10-07 run window shows no Microphone or system-audio request from akou, only checks with no prompt. Nobody watched the console during either run.

**Verdict: partial.** The packaged, notarized 0.6.4 app found a real, signed-in claude through the login shell, with no harness on its `PATH` and no pinned path, and streamed its answer with the first token at 2,692 ms. It maps a usage limit to excerpts only (fake run), and the control shows the runner reached the harness setting. Codex did not answer, because no Codex on the machine has a live sign-in, so G7 is not a pass.

**Still open.**

- Sign in a Codex on the reference Mac mini (`codex login` for the one that comes first on the login-shell `PATH`), then re-run `--real --yes --harness codex` and record its time to first token. That is an owner step: we do not touch sign-in state.
- The runner cannot run twice on one `AKOU_HOME`: the second run's import is refused as "already imported", so each run used a fresh scratch home.
- First launch after install, seen on 0.6.2 and again on 0.6.4: the zip's app extracts itself on first launch and relaunches, which takes about 5 s, longer than the CLI's 3 s launch budget. So the first `akou` command after install fails with "akou did not answer within 3 s". The first launcher process then stays alive, idle, with its bundle already replaced, and it is still running after `akou quit`. While it runs, every later `open -a akou.app` treats it as the running app and does not start a new one, and `launch.log` says "Application /Applications/akou.app was already running and so the additional environment variables could not be set". The CLI cannot start the app until that process is stopped. The 0.6.4 runs did one throwaway start first, then stopped that launcher.

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

### Re-run on current main

**Why.** The numbers above were measured at `f6cabfc` on 2026-09-24. The app has grown since (streaming Nemotron, the Nemotron diarizer, the server, dictation), so we ran the gate again at `36a2237` (release 0.6.2) on 2026-10-07, on the same Mac mini (now macOS 26.6.1).

**What ran.** The same runner, unchanged since the pid checks, with 20 cold and 20 warm runs each time, the shipping helper on real devices, and the models `akou models pull` fetches with default settings (listed in [the G5 re-run](#re-run-on-current-main)), so the app loads the live recognizer at launch and runs a final pass after each stop. The first runs came out several times slower than September's while other work pushed the load average past 40. To tell the code from the machine, we ran the same runner against `f6cabfc` as a control, alternating with the current code, with its own models (Parakeet int8, as in September) and the load average logged every 10 s. The repository pins Bun 1.4.2; the machine's default Bun is 1.3.14, which the first three runs used. Every run, its load samples and the split below are in [g8-rerun-series.json](g8-rerun-series.json). The record run is [g8-start-rerun.json](g8-start-rerun.json). In control 1, `f6cabfc`'s code under today's Bun, one app process crashed in Bun and another logged an onnxruntime error while loading models; every start in that run still answered 201.

**The record: a quiet machine, the pinned Bun.** Run 5, at load 6 to 11, with its control straight after at load 5 to 8:

| | Runs | 201 | p50 | p95 | Worst | Helper audio after spawn |
|---|---|---|---|---|---|---|
| Cold, `36a2237` | 20 | 20 | 424 ms | 578 ms | 687 ms | 106 to 306 ms |
| Cold, `f6cabfc` control | 20 | 20 | 277 ms | 322 ms | 338 ms | 111 to 155 ms |
| Cold, `f6cabfc` in September | 20 | 20 | 185 ms | 193 ms | 199 ms | 65 to 82 ms |
| Warm, `36a2237` | 20 | 20 | 199 ms | 319 ms | 324 ms | 107 to 256 ms |
| Warm, `f6cabfc` control | 20 | 20 | 153 ms | 184 ms | 199 ms | 92 to 150 ms |
| Warm, `f6cabfc` in September | 20 | 20 | 140 ms | 159 ms | 168 ms | 70 to 95 ms |

**Where the extra time goes.** Current code is about 150 ms slower to a cold 201 than `f6cabfc` on the same machine the same hour. We split eight cold launches per commit in two: the app spawned directly until `GET /v1/status` answers, then one `akou start` on that fresh app. Booting to a live API took a median 66 ms at `f6cabfc` and 249 ms at `36a2237` (load 6 to 12; 268 ms under the pinned Bun, at a load near 30). The first start on the fresh app took 223 ms and 376 ms. So most of the cost is the app loading more code before its API answers, plus a slower first start.

**Every run, in order.**

| Run | Commit, Bun | Load average (1 min) | Cold 201 | Cold p50 / p95 / worst | Warm 201 | Warm p50 / p95 / worst |
|---|---|---|---|---|---|---|
| 1 | `36a2237`, 1.3.14 | 12 at the start, 41 at the end | 20 of 20 | 718 / 1,273 / 1,385 ms | 20 of 20 | 353 / 1,254 / 1,521 ms |
| control 1 | `f6cabfc`, 1.3.14 | 16 to 35, median 23 | 20 of 20 | 675 / 2,511 / 3,396 ms | 20 of 20 | 321 / 1,881 / 2,504 ms |
| 2 | `36a2237`, 1.3.14 | 16 to 65, median 27 | 19 of 20 | 844 / 4,438 / 5,014 ms | 20 of 20 | 272 / 393 / 405 ms |
| control 2 | `f6cabfc`, 1.3.14 | 8 to 21, median 10 | 20 of 20 | 312 / 488 / 494 ms | 20 of 20 | 185 / 568 / 1,448 ms |
| 3 | `36a2237`, 1.3.14 | 5 to 9, median 7 | 20 of 20 | 721 / 1,033 / 1,191 ms | 20 of 20 | 243 / 741 / 779 ms |
| 4 | `36a2237`, 1.4.2 | 9 to 29, median 17 | 20 of 20 | 855 / 4,873 / 7,199 ms | 12 of 20 | 3,278 / 10,213 / 11,398 ms |
| control 3 | `f6cabfc`, 1.3.14 | 10 to 39, median 27 | 20 of 20 | 545 / 1,543 / 6,497 ms | 18 of 20 | 1,139 / 4,113 / 7,305 ms |
| 5 | `36a2237`, 1.4.2 | 6 to 11, median 7 | 20 of 20 | 424 / 578 / 687 ms | 20 of 20 | 199 / 319 / 324 ms |
| control 4 | `f6cabfc`, 1.3.14 | 5 to 8, median 6 | 20 of 20 | 277 / 322 / 338 ms | 20 of 20 | 153 / 184 / 199 ms |

The percentiles count failed starts too, as the runner always has. Three things failed, and the loaded runs show two weak spots:

- **One cold start missed the 3 s launch budget** (run 2, its second cold run, 5,014 ms). The CLI gave up waiting for the app's API before the app answered: `app.log` shows the API up at 10:40:54.9 local, no call started, and the quit that followed. `f6cabfc`, whose app reaches its API about 180 ms sooner, never missed it in four runs, though under load its single slowest starts also took 3.4 and 6.5 s.
- **Ten warm starts failed on both commits** with `call.failed {stage: open, error: "the capture helper did not start capturing within 3000 ms"}`: 8 of 20 in run 4 and 2 of 20 in control 3, which ran back to back. In the same stretch the helper's first audio on cold starts took up to 3.4 s with current code and 4.3 s with `f6cabfc`. The helper's device open, not the app, set those times, and it slowed down for both commits at once.
- **Under load the cold p95 went over 3 s for current code twice** (runs 2 and 4: 4,438 and 4,873 ms) and never for `f6cabfc` (worst p95 2,511 ms).

**Verdict: still pass.** On the reference Mac under the background load the gate was first measured at, cold p95 is 578 ms with the pinned Bun (1,033 ms under Bun 1.3.14), well inside 3 s, and warm p95 is 319 ms, inside the M1 target of 1 s. But the margin is smaller than September's numbers said. The app takes about 180 ms longer to answer its API than it did at `f6cabfc`, so under heavy load (load average 16 to 65 on 10 cores) the current code went over the 3 s target where `f6cabfc` stayed under it. And on both commits, a warm start fails outright when the helper needs more than 3 s to open the devices, instead of waiting longer.

**Still open.** The two weak spots are filed: the slower path to a live API, and a warm start that fails when the device open passes 3 s. The first tap after a reboot and a granted microphone are still not measured (see above).

## How to re-run

Everything above can be repeated from the repository: build `akou-capture`, plus `--features simulate` for G5, build the signal source with `cargo build --release --example drift-signal`, then the scripts named in each section. Each script's header gives its arguments; on a machine without the speech models, `record-call.ts` needs `--without-models`. On the machine: the default output is the built-in speakers, muted so nothing is heard, and the call train plays to it; the session holds both the Microphone and the system-audio grant; and the mic is a real input device for G4's two-clock number. BlackHole 2ch (with its output unmuted) is enough for everything else, but for G4 it only bounds the tap against the host clock.
