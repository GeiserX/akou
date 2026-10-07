# Roadmap

Each milestone has exit criteria you can check. A milestone is done when every criterion has a recorded result. Durations assume one engineer working with agents.

## M0: gates (1 to 2 weeks)

Each gate ends in a measured yes or no. The gates block the stable release, not development: a release without a prerelease part (1.0.0 or later) fails unless the summary table of [gates/M0-results.md](gates/M0-results.md) records a plain Pass for every gate from G1 to G8 (`scripts/stamp-version.ts`, [CI-28](CI-CD.md)); a qualified one such as "Pass (M-series half)" does not count. Prereleases never wait on a gate. G3 and G4 stay blockers, because their results can change where capture runs.

| # | Gate | Pass criterion | If it fails |
|---|---|---|---|
| G1 | Shell | An ElectroBun 2.0.1 app with `mainProcess: "bun"` shows a window, a tray item, a global hotkey and registers a login item on macOS arm64, Windows x64 and Linux x64. Starts headless with `AKOU_HEADLESS=1` on all three | Swap the shell on the failing OS; the window is a plain page |
| G2 | Recognition in the packaged app | sherpa-onnx-node loads in a Bun Worker inside the packaged bundle on all three OSes and transcribes a fixture; main-thread timer gaps stay under 100 ms while it runs (a blocked thread waits the whole decode, seconds; sharing a 4-core machine with the recognizer costs a scheduler turn or two, up to about 70 ms on Windows). The limit is 100 ms from 2026-10-05 on: the earlier 20 ms sat below a 4-core runner's scheduler noise | Recognition moves into the Rust crate |
| G3 | Permission attribution | On a Mac with SIP on, the packaged app as released, Developer ID signed and notarized, opened from Finder or `open` and never from a terminal, records through its app-spawned helper. All four must hold: the Microphone and system-audio prompts name the signed app, akou, and System Settings lists both grants under it, not under Terminal or `sshd`; a 2-minute recording finds every chirp of the mic train on the left channel and of the call train on the right; after the app quits and opens again, a second 2-minute recording does the same with no new prompt; after the next signed release installs over this one, a third recording does the same with no new prompt. G3 passes only once the update half has its evidence too | Build the capture crate as the in-process addon |
| G4 | Two-clock capture | The Rust tap plus a separate cpal mic through the aligner for 60 minutes on a real Mac: left-right offset under 200 ms per hour, no gaps over 20 ms, mic frames flowing while the tap is silent from the start, first words after silence not lost; with the call source muted for 10 minutes, memory flat and both channels equal length. Also run on a macOS 14.2 or 14.3 machine to decide whether the 14.4 floor can drop. The drift-analysis output is committed, so the baseline is on record | The macOS helper uses hark's mic-mastered aggregate |
| G5 | Containment | A debug-only teardown hang and a forced helper crash: the app stays responsive, the log gets `part.ended`, the next start answers 201 within 3 s, seconds of audio lost are measured and under 2 | Fix before M1 |
| G6 | Recognizer speed | Parakeet TDT v3 (fp32 since the benchmark in [research/asr-benchmark.md](research/asr-benchmark.md); M0 measured int8) on both channels, decoded with `modified_beam_search` and a 12-word decode list, the slower of the two `asr.parakeet.decoding` modes (greedy, with no list, is the default): committed line within 1.5 s of utterance end, real-time factor under 0.25 on an M-series Mac and under 0.5 on a 4-core x64 laptop. The vocabulary spike measured beam search at +9 % over greedy and a real-time factor of about 0.03 on 8 s clips with 6 threads on an M4 Pro. The earlier 2.4 % figure was a 20M English zipformer | Moonshine for live, Parakeet for final. Moonshine is English only and gets no decode biasing, so a non-English workspace keeps Parakeet at a higher lag or uses Whisper tiny/base |
| G7 | Harness provider | `claude -p --output-format stream-json` and `codex exec --json --sandbox read-only -` spawned from the packaged app with the login-shell PATH, streaming tokens into a test box; a fake exhausted-window exit shows excerpts only; time to first token measured with the harness's global context (user-level instruction file, memory, skills) loaded, as the per-spawn cost | User-set path; harness path becomes opt-in |
| G8 | Cold start | `akou start` with the app not running answers 201 in under 3 s p95 on the reference Mac | Profile; pre-warm the aggregate |

Results so far, on the reference Mac mini (M4, macOS 26.6, SIP off), are in [gates/M0-results.md](gates/M0-results.md):

- G3: partial. The app-spawned helper records the tap on the right channel (10 minutes, every call chirp found). Over SSH the mic is silent for lack of a Microphone grant. The criterion above, on the signed 0.6.1 and then the signed update after it, has not been run.
- G4: failed as run. The call channel held the host clock within 0.16 ms for an hour, and positive controls show the analysis catches a 75 ms per hour drift. But one tap death cost 10.5 s before the dead-call rule rebuilt it, and in a run with a really quiet tap the first start lost 20 ms of speech: the rule rebuilt a tap that had just started. Mic frames flow while the tap is silent, and helper memory stayed flat through a 10-minute mute. Left-right drift between two clocks was not measured: it needs a Mac with a real input device, because a BlackHole mic runs on the host clock.
- G5: pass, re-run with a runner that measures call audio by content. Hang, crash and a real SIGKILL each lose at most 1.25 s, and a new call starts in 78 ms while a teardown still hangs.
- G6: pass on the M-series half. Real-time factor 0.081 for both channels, committed line 1.02 s median and 1.14 s worst after the utterance ends. The 4-core x64 half is open.
- G7: partial. On the signed, notarized 0.6.2 app the fake run passes 5 of 5 (control `missing`, recorded streams answer, usage limits give excerpts only), and with no harness on the app's `PATH` it finds both through the login shell. Neither harness found there had a live sign-in on the machine (claude: OAuth session expired and not refreshable; codex: 401), so the real answer and its time to first token are not recorded.
- G8: pass. Cold p95 193 ms over 20 separate app launches, warm p95 159 ms. The first tap after a reboot is not measured.

Status on main: the summary table in [gates/M0-results.md](gates/M0-results.md) is the current verdict. G5, G6 (M-series half) and G8 pass; G3 is partial; G4 is partial since its re-run after the capture fixes; G7 is partial (real harnesses had no live sign-in on the machine); G1 and G2 have no recorded result. Every release so far is a 0.x prerelease, which the gates do not block.

Also in M0: pin ElectroBun 2.0.1 with its bundled Bun 1.4.0 for the app runtime, and pin Hutch to the version whose `hutch --version` produced the working signed build; re-run the soak ([TESTING.md](TESTING.md) TS-24, not built yet) on Bun and Cottontail and keep the output; verify the `Info.plist` patch and re-sign; verify both sherpa dylibs land in the bundle; confirm the WebKit GPU helper exclusion removes the window's audio from the call channel.

## M1: macOS v0.1, replaces hark and hark-viewer (4 to 6 weeks)

In: the capture helper for macOS (system, per-app with a fallback to the whole computer when every tapped app exits, mic, mute, pause, dead-call monitor, stall recovery, device watch, keep-awake, bounded teardown); stereo Opus; the event log with parts, pauses, clocks and crash recovery; live transcription, from streaming Nemotron by default (`asr.live` `auto`, measured in Spanish in [research/asr-architecture.md section 3.1](research/asr-architecture.md#31-what-replaces-the-12-s-windows)) or from Parakeet with the provisional line where no streaming model is downloaded; live speaker clusters, names, merge and unmerge; the final pass with whole-call diarization and name mapping; window parity with hark-viewer plus notepad, ask box (excerpts plus the harness provider), speaker chips, level meters, playback; query engine (header, memo slot, recency, BM25, vocabulary, wall-clock citations, cursors); vocabulary layers 1 and 2 (the YAML files, decode biasing on Parakeet with the `bpe.vocab` built from the model's tokenizer, read-time correction in the fold, `vocab.*` events, "Fix this word", `--vocab` on start, the `vocab` CLI, `/vocab` routes and `akou_vocab_*` tools, import of the older list formats, the nightly vocabulary evaluation); providers `harness`, `openai-compatible`, `anthropic`, `none`; CLI, HTTP API with the security suite, MCP, the skill and `akou skill install`; export folder and hooks; `akou import hark-viewer`; `akou doctor`; the DMG with the updater; the cask, pushed to the tap with a fine-scoped token. Since 0.6.1, macOS builds are Developer ID signed and notarized.

Status on main: the 0.x prereleases ship the macOS capture helper, the event log, live and final transcription, speaker labels and names, the window with notepad and ask box, the query engine, vocabulary layers 1 and 2, the four providers, the CLI, the HTTP API, MCP, the skill and `akou skill install`, export and hooks, `akou import hark-viewer` and `akou doctor`. The cask ([CI-25](CI-CD.md)) and the updater wiring ([DK-U1](ux/DESKTOP.md)) are not built.

The hardware release checklist includes the Bluetooth probe-click listening test ([TRAPS](TRAPS.md), [DESIGN risk F12](DESIGN.md#12-risks-and-falsifiers)).

Exit criteria:

- [ ] A real call of at least 60 minutes recorded end to end on the reference Mac, both channels present, final pass done, exported.
- [ ] Every window parity row in the design ([section 7](DESIGN.md#7-the-window)) passes the Playwright suite against a fake helper.
- [ ] Security suite green with the positive control proven to fail.
- [ ] An 8-hour soak from recorded fixtures on a spare machine: no gaps, no memory growth over 10 %, no helper wedge.
- [ ] The 60-minute drift test green on the release build.
- [ ] Start p95 under 1 s warm and 3 s cold, measured on the release build.
- [ ] Pack build p95 under 50 ms on a synthetic 3-hour log.
- [ ] Replay evaluation: the answering segment is in the pack for at least 85 % of questions over 5 real calls with 30 questions each (the first calls are the author's own; the fixtures are not committed).
- [ ] One week of the author's real calls with the old skill retired.
- [ ] `akou import hark-viewer` converts every part of a multi-part predecessor folder and the result answers a question correctly.
- [ ] Every version string equals the tag in the release job.
- [x] Per-app capture falls back to the whole computer, with a banner and a notification, when every tapped app exits; it never stops the call.
- [ ] Vocabulary evaluation on the release build, with beam decoding at the constant boost of 1.5 (the figures below were measured at boost 3 and must be re-measured): on the synthetic set, hits at least 90 of 140 (measured 94) with at most 4 insertions on the control clips; on the real-call clips, at least 20 of 30 (measured 22) with at most 2 of 30 negatives carrying an insertion; the boost 5 positive control breaches the ceiling; the tokenization check reports 0 mismatches on the list.
- [ ] A word added over MCP mid-call appears in the next segment's decode list and corrects an earlier segment's rendering, with the raw text unchanged, in the fold suite and in a live test.
- [ ] Decode list sizes 12, 24, 48 and 96 measured on both sets, and the cap set from the result (24 is the placeholder).

## M2: the notes loop (2 to 3 weeks)

In: enhanced notes with templates, "Enhance so far", the citation check, re-enhance after the final layer, rolling memo (provider-driven; opt-in for the harness), presets, harness session reuse (`--resume`), the undo-stop toast while the meeting app holds the microphone, optional echo cancellation on the recognizer's copy of the mic, the signed webhook, `docs/providers.md` with the terms-of-service statement. Vocabulary layer 3: the post-call pass on the provider (same policy as Enhance), `vocab.propose` events, the "Words to review" list, `akou vocab pass`, and the `akou-vocab` learning skill (calendar attendees before the call, documents and repositories, exports, web confirmation of spellings, corrections becoming heard forms).

Status on main: the five templates, the citation check, re-enhance after the final layer, the rolling memo, harness session reuse, the signed webhook and vocabulary layer 3 (the post-call pass, `vocab.propose` events, "Words to review", `akou vocab pass` and the `akou-vocab` skill) are built. Enhance stays reachable through `akou enhance`, the API and MCP, and is hidden in the window ([WINDOW.md](ux/WINDOW.md#63-enhanced)). Optional echo cancellation is not built.

Exit criteria:

- [ ] Five templates ship; a standup call enhanced through the harness keeps every user line verbatim and every AI bullet cites an existing segment.
- [ ] The citation check drops a deliberately bad citation from a fake provider.
- [ ] Rolling memo through an OpenAI-compatible local model stays under 1,000 tokens over a 2-hour call, with every anchor valid.
- [ ] Session reuse measured: tokens per follow-up question through the harness at least 40 % lower than without it, or the feature stays off.
- [ ] Undo-stop resumes as the next part within 10 s in a window test.
- [ ] Webhook signature verified by the example receiver; three retries observed on a failing endpoint.
- [ ] The post-call pass on a real call through the harness: every correction it applied names a span that exists in the segment, a deliberately bad span from a fake provider is dropped, and at least one proposal reaches the review list and, once approved, lands in the workspace file with `source: call:<id>`.
- [ ] The learning skill, given an invite and a folder of documents, proposes attendees and product names with web-confirmed spellings and adds nothing as confirmed without the user's yes.
- [ ] Stacked layers on the real-call clips: at least 26 of 30 after the pass (layers 1 and 2 alone measured 28 with an in-sample table; the pass must reach 26 with no table).

## M-UX: the UX principles

In: the ranked [P0 list](ux/PRINCIPLES.md#the-p0-list), then the P1 rows of the surface docs ([WINDOW](ux/WINDOW.md), [DESKTOP](ux/DESKTOP.md), [CLI](ux/CLI.md), [PROGRAMMABILITY](ux/PROGRAMMABILITY.md), [SERVER](ux/SERVER.md), [DICTATION](ux/DICTATION.md), [TESTING](TESTING.md), [CI-CD](CI-CD.md)). This milestone points at those ids and does not copy them: each id's priority, acceptance and status live in its owning doc.

Exit criteria:

- [ ] Every id in the P0 list has its acceptance recorded in its owning doc.
- [ ] Every P1 row in the surface docs has its acceptance recorded in its owning doc.

Status on main: the P0 list is mostly built, and most P1 rows are still partial or missing. The status cell of each id in its owning doc is the record.

## M3: Windows (3 to 4 weeks)

In: the capture helper for Windows (process loopback in exclude mode on the app tree, endpoint loopback fallback, mic, device notifications, `Pro Audio` thread priority, `SetThreadExecutionState`), the installer, autostart, code signing (SignPath or Azure Trusted Signing; unsigned with a documented step until then), the updater test.

Status on main: the Windows capture helper (process loopback in exclude mode, endpoint loopback fallback, mic) is built and recorded in CI on a virtual cable, and the release ships a Windows CLI binary. The installer, autostart, code signing and the updater test are not built.

Exit criteria:

- [ ] A real call on a Windows 11 machine with WebView2: left = mic, right = call, window audio absent from the call channel. The app's process tree (Bun, ElectroBun's launcher, the WebView2 processes, the helper) is recorded once, and the root the app passes with `--exclude-responsible` is pinned to it.
- [ ] Endpoint loopback fallback verified on a Windows 10 build below 20348.
- [ ] Default-device change mid-call rebuilds the stream with under 1 s of lost audio.
- [ ] The updater applies a patch release on Windows (issue #535 covered), or the full-installer link is shown.
- [ ] The 24-hour soak on Windows: no gaps, no wedge.
- [ ] `capture-windows` CI job loads the helper and addon and enumerates devices.

## M4: Linux and sharing v1 (2 to 3 weeks)

In: the capture helper for Linux (PipeWire default source and sink monitor, PulseAudio fallback, logind inhibitor), AppImage, `.deb`, the CLI-only tarball (`bun build --compile` on Bun 1.4.2 or newer, with an ad-hoc `codesign` and `codesign --verify --strict` step), the systemd user unit, the `local-link` share transport with the visible pill and audit events, Wayland hotkey through the portal where available.

Status on main: the Linux capture helper (over the PulseAudio protocol, which PipeWire and PulseAudio both serve), the CLI-only binary in the release and the `local-link` share link with its pill are built. AppImage, `.deb` and the systemd user unit are not.

Exit criteria:

- [ ] `capture-linux` CI job: null sink plus virtual source, left = mic tone, right = call tone, skew under 20 ms.
- [ ] A headless Ubuntu 24.04 server: `akou start` from the tarball records, `akou context` answers, no WebKitGTK installed.
- [ ] Share link over a tailnet address shows the live transcript in a browser with a 2 s delay or less; `akou share off` invalidates the token immediately; the pill is visible the whole time.
- [ ] Share never binds `0.0.0.0` unless typed; LAN bind shows the warning.
- [ ] AppImage runs on Ubuntu 24.04 and Fedora 42.

## Later, on demand

- The self-hosted hub (`hub` transport) when someone needs viewers who cannot reach the laptop.
- Embeddings through the provider, only if the replay evaluation falls under 85 %.
- Per-app capture on Linux.
- Meeting detection with a "Record this call?" prompt from OS signals (a process holding the microphone), never auto-recording unless opted in per app.
- Moving recognition into the Rust crate if the Worker path proves fragile across ElectroBun releases.
- Decode biasing for the streaming live engine once a sherpa-onnx release carries streaming hotwords (merged upstream after 1.13.8, the release akou pins): beam search with the decode list at score 1.5, the one setting measured to add names without over-firing ([research/asr-architecture.md section 3.1](research/asr-architecture.md#31-what-replaces-the-12-s-windows)).
- Decode biasing for Whisper workspaces through whisper.cpp's initial prompt (measured as strong as Parakeet hotwords on short lists) only if a Whisper workspace needs layer 1 badly enough to justify a second speech engine.
- Switching the `bpe.vocab` workaround to an upstream sherpa-onnx encoder that runs real BPE, or accepts token ids, when one exists.
