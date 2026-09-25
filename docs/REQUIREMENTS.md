# Requirements traceability

This file lists every feature and interface of the predecessors (hark, hark-viewer and the call skill) that a user or an agent relies on, and what akou does with each. Ids point into the design inventory: `F<reader>.<n>` is a feature, `I<reader>.<n>` an interface (reader 0 = capture, 1 = transcription and control, 2 = hark-viewer, 3 = skills, 4 = review notes).

Status words:

- **carried (M#)**: akou has it, first shipped in that milestone.
- **changed (M#)**: akou has the need, met a different way; the line says how.
- **dropped**: akou does not have it; the line says why.

## Capture sources and channels

- F0.0, I0.0 five sources (mic, chosen device, all system audio, named apps, everything except named apps): **changed (M1)**. `--call system | app:<id> | none` and `--mic <id> | none`. "Exclude named apps" becomes automatic exclusion of akou's own audio; a user exclusion list comes with per-app capture on each OS.
- F0.1, I0.1 two backends, ScreenCaptureKit and Core Audio, with `auto`: **dropped**. Core Audio process tap only on macOS. SCKit needs a screen-recording grant, stops on lock, and its automatic selection once failed with no fallback.
- F0.2 private, unmuted, global-or-per-app process tap: **carried (M1)**, ported to Rust in the capture helper; hark's design is the reference.
- F0.3 tap read through a private aggregate; mic as clock master: **changed (M1)**. Tap-only aggregate. The mic is an independent stream; alignment is by host timestamp. hark's aggregate is the M0 fallback if the drift test fails.
- F0.4 mixing mic into the tap signal: **dropped**. akou never mixes mic and call. A mixed playback can still come from the stereo file.
- F0.5 per-source streams for attribution: **carried (M1)**, the only mode.
- F0.6, I0.3, I0.11 stereo tracks, mic left, call right: **carried (M1)**, the only recording layout. `mixed` is dropped.
- F0.7 mic from default or chosen device, survives route changes and sleep: **carried (M1)** with a device watch and fallback to the default when a pinned device vanishes.
- F0.8 ScreenCaptureKit capture: **dropped** (see F0.1).
- F0.9, I0.2 requested rate, bits and channels: **changed (M1)**. Devices open at their native rate; the file is always 48 kHz stereo Opus. No user-selectable rate, bits or channel count.
- F0.11 stop when every tapped app exits: **carried (M1 on macOS, M3 on Windows)** for per-app capture, as a `health {state: tapped-apps-exited}` event plus an automatic stop with a toast.
- F0.12 exact `--duration`: **dropped**. A UI recorder has Stop; the CLI can `sleep N && akou stop`.
- F0.17 keep-awake: **changed (M1)**. Always on while recording, on every OS.
- F0.18 SIGINT/SIGTERM graceful, SIGPIPE tolerated: **changed (M1)**. The helper handles signals; the app finalizes from its before-quit path because ElectroBun swallows signals. `akou quit` is the public stop.
- I0.14 OS objects (aggregate and tap names): **carried (M1)** with `akou-capture` and `akou-probe` names and random UIDs, and a test that a killed helper leaves none behind.

## Formats, files and encoding

- F0.20, I0.4 five audio formats, WAV stream to stdout, `--raw`: **changed (M1)**. Recording is Ogg Opus only. `akou export` can transcode through the export setting. Streaming PCM is the helper protocol, not a user feature.
- F0.21 WAV writer: **dropped** (WAV cannot survive a crash and clamps at 4 GB).
- F0.22, F0.23 m4a, FLAC, MP3: **dropped** for recording. LAME (LGPL) is not carried.
- F0.24, I0.10 Ogg Opus with pre-skip and tags: **carried (M1)** in Rust with the `opus` crate (MIT/Apache-2.0) over libopus (BSD-3) and `ogg` (BSD-3-Clause).
- F0.25, I0.5, I0.12 splitting by duration or silence: **dropped**. Only a restart splits a call into parts.
- F4.0, I4.0 existing-file policy (ask, error, overwrite, unique): **dropped as a class**. Call folders are unique by construction, so akou never overwrites anything.
- F4.1, I4.1 `hark info`: **dropped**. `akou show CALL --format json` reports duration, parts and channels.
- F4.2, I4.2 transcode a file: **dropped**; `ffmpeg` does it. Playback uses the app.
- F4.3 `-C` working directory: **dropped**; akou has a recordings root per workspace.

## Controls and interactive use

- F0.10, F1.43 mute keeps the timeline, pause drops audio: **carried (M1)** with the same semantics; both are app concerns recorded as events with anchors.
- F1.42, F4.14 interactive terminal keys: **changed (M1)**. The window, tray, hotkey and CLI replace terminal keys. "Copy transcript so far" is a window action.
- F4.15 signal watcher: **changed (M1)**, see F0.18.

## Capture health

- F0.13 stall watchdog: **carried (M1)** in the helper, with the OS "device present and running" signal so a quiet tap is not a stall.
- F0.14, F1.37, I0.8 dead-tap monitor with throwaway probe, backoff and cap; `callAudio` status: **carried (M1)** on all OSes as `health {ch: call}` events, with an added "output is running" condition and automatic restart after 60 s dead.
- F0.15, F1.38 one bounded teardown budget: **changed (M1)**. The helper gets 5 s then is killed; the app is never blocked.
- F0.16 "captured only silence" permission warning: **carried (M1)** as the `permission-suspect` health state with the settings pane named.
- I0.9 `POST /start` capture fields: **changed (M1)**. `POST /calls {workspace, title, template, call, mic}`.
- F0.27, I0.8 `capturing` and `callAudio` in status: **carried (M1)** as `POST /calls` answering only after `capturing`, and `health` in status.
- I0.7 recovery environment variables: **changed (M1)**. Settings in the one schema (`capture.stallSeconds`, `capture.tapSilenceSeconds`, `capture.recover`); no environment variables.

## Devices and permissions

- F0.19, I0.6 `hark devices`, `hark apps`: **carried (M1)** as `akou devices` and `akou apps` with `--json`, on every OS.
- F0.26 three TCC services with a bounded microphone wait: **changed (M1)**. Two grants (microphone, system audio), both prompted by the signed app; `akou doctor --grant` checks them.
- I0.13, I1.16, F1.45 sysexits exit codes: **carried (M1)**, plus 3 (nothing live) and 75 (already recording).

## Engines and models

- F1.0, I1.0 engine registry (whisper, apple, whisperkit, parakeet, cloud): **changed (M1)**. One engine layer, sherpa-onnx, with Parakeet TDT v3, Moonshine and Whisper as models. Apple Speech, WhisperKit and the cloud stub are dropped; nothing platform-specific.
- F1.1 to F1.3 whisper.cpp batch and server: **dropped**; Whisper runs through sherpa-onnx.
- F1.4 Apple Speech: **dropped** (macOS-only).
- F1.5 WhisperKit: **dropped** (macOS-only).
- F1.6 Parakeet v3 through FluidAudio: **changed (M1)**. Same model family through sherpa-onnx on every OS. FluidAudio's Neural Engine speed is given up in v1.
- F1.7 one shared engine instance: **carried (M1)**, one recognizer per model behind a queue.
- F1.41, I1.15 model management and folders: **carried (M1)** as `akou models list | pull | import`, pinned SHA-256, one models folder.
- F1.40 hint when a model belongs to another engine: **dropped** (one engine).
- F1.20 to F1.22 streaming recognizer with fallbacks and ignored-flag notices: **dropped**. Live text comes from segmented Parakeet plus a re-decoded provisional line, which was better in Spanish. A streaming model stays a later option behind the same interface.
- F1.23 to F1.25 streaming sink runtime, line cutting, open-line publishing: **changed (M1)**. The provisional line has the same contract (sequence, newest wins, cleared on close, 3 s expiry).
- F1.6 language auto-detection: **changed (M1)**. Parakeet transcribes 25 languages with no language switch, but sherpa-onnx does not report which language it heard for this model, so akou fills the segment's `lang` only when the model reports it (Whisper). A separate language-id step is an open item.

## Batch and file transcription

- F1.8 transcribe a file: **carried, as a job** ([SERVER.md SV-D1](ux/SERVER.md#2-decisions-this-reverses)). A file is a job, `POST /v1/jobs` in server mode, and `akou transcribe FILE` is the same job from the command line. F1.9, F1.10 read audio from stdin, Unix piping: **changed (M1)**. `akou finalize CALL` re-runs the accurate pass on a call; `akou import hark-viewer` covers old folders.
- F1.11, F1.12, I1.12, I1.13 txt, srt, json transcript formats: **changed (M1)**. The log is the format; `akou show` and the export render `md | json | txt`. SRT is dropped.
- F1.29 offline diarization during live capture: **changed (M1)**. The final pass runs after every call automatically.
- F1.30 batch diarization with threshold and max speakers: **changed (M1)**. The final pass runs Nemotron 3 Diarization over the whole call, which finds up to 8 speakers itself with no threshold to tune; `asr.diarizer` `embeddings` keeps pyannote with its clustering threshold.
- F1.31, I3.13 source attribution on a two-channel file: **carried (M1)** as the final pass's explicit per-channel decode (left = you, right = call).

## Live transcription

- F1.13 segmented live path, serial worker, one failing segment skipped: **carried (M1)**.
- F1.14 Silero VAD default, amplitude fallback: **changed (M1)**. Silero VAD only, on every OS; the amplitude segmenter is dropped.
- F1.15 VAD covers the whole timeline: **carried (M1)** as the whole-timeline rule for live and final.
- F1.16 amplitude segmenter: **dropped**.
- F1.17 one continuous resampler per stream: **carried (M1)** in the helper.
- F1.18 gain on the engine copy only: **carried (M1)**.
- F1.19, I1.1 segment pause and window, validated ranges: **carried (M1)** in the settings schema.
- I1.2 `--live-streaming`: **dropped** (see F1.20).

## Speakers

- F1.26, I1.3 speaker plan (none, source only, source diarized, single diarized): **changed (M1)**. Always source-attributed (mic = you) plus live speaker labels on the call channel and whole-call diarization after.
- F1.27 streaming diarization (LS-EEND): **changed (M1)**. Nemotron 3 Diarization (Streaming Sortformer v3) at 2.0 s latency, in the `akou-diarize` helper, is the default (`asr.diarizer`); embedding clustering stays as the `embeddings` choice. Measured on eight real two-channel calls (6.6 h): Nemotron's final pass at 8.7 to 11.1 % DER against 54 to 64 % for the pyannote pass, the right speaker count on 10 of 11 files against none, and its live labels as accurate as its final pass. Those live numbers come from a benchmark path with whole-stream features; the shipped helper's live mode was checked against NeMo on synthetic speech only (DESIGN 3.4). Centroids are still persisted in the log, to carry names across a stream that starts over.
- F1.28 two-source live attribution with shared writer and engine: **carried (M1)**.
- F3.4 `You` and `Speaker N`, names only when the user gives one, numbers restart per part: **changed (M1)**. `you` and `c<N>`; ids continue across parts; names persist as events and survive compaction.

## Remote control and API

- F1.32, I1.4 remote-control agent on a port, one recording at a time: **changed (M1)**. The app's local API, always on while the app runs.
- F1.33 optional bearer token: **changed (M1)**. Token always required, on every request.
- F1.34, I1.10 session lifecycle, 409 busy or finishing: **changed (M1)**. 409 `already_recording` only; "finishing" cannot happen because a new part is a new helper.
- F1.35, I1.9 `POST /start` waits for capture before 201: **carried (M1)**.
- F1.36 output collision resolution on start: **dropped as a class**.
- I1.8 `GET /status` shape with partial and callAudio: **changed (M1)**. `GET /v1/status` and `GET /v1/calls/live`; the provisional line comes over SSE.
- I1.11 HTTP status mapping: **carried (M1)** with akou's codes.
- I1.14 whisper-server IPC: **dropped**.
- I1.17 consumer contract (start body, trust `capturing` and `callAudio`): **carried (M1)** in the API.

## Configuration

- F1.39, I1.5, I1.7 config file with precedence and `config show | set | unset | path`: **carried (M1)** as `akou config`, one JSON file validated by the same schema that validates `config set` and API bodies.
- I1.6 `HARK_*` environment variables: **dropped**. Only `AKOU_HEADLESS` and `AKOU_HOME` (tests) exist.
- F1.44 startup status block: **changed (M1)**. `akou status` and the window header report the same fields.

## hark-viewer page server

- F2.0, F2.1 loopback bind without reverse DNS: **carried (M1)**.
- F2.2 DNS-rebinding guard: **carried (M1)**.
- F2.3 CSRF guard by custom header: **changed (M1)**. Token on every request plus refusal of any browser `Origin` or `Sec-Fetch-*` header. The known cross-origin `/stop` hole becomes a regression test with a positive control.
- F2.4 no caching, no listings: **carried (M1)**; nothing is served from the recordings root.
- F2.5, F2.6, F2.12, F2.16 starting, relaunching and killing the hark agent: **dropped as a class**. There is no second agent process; the helper is a child the app owns.
- F2.7 proxy bypass and timeouts for loopback calls: **carried (M1)** for the CLI, MCP and the app's own client.
- F2.8, F2.9 start body and Opus on purpose: **carried (M1)**.
- F2.10, F2.11 call folder naming and `current` symlink: **changed (M1)**. Same folder naming from local start time; the symlink is dropped, `live` in the API replaces it.
- F2.13 reconciling a badly answered start against reality: **dropped as a class**; `201` is the helper's `capturing`, or an error.
- F2.14 `active` definition: **carried (M1)** as `state: recording | paused` in status.
- F2.15, I2.2 restart into the same folder with numbered parts: **carried (M1)**, make before break, no gap.
- F2.17, I2.3 controls forwarded: **carried (M1)** as `POST /calls/{id}/…`.
- F2.18 `patience` timeout hint: **dropped**; starts answer within 3 s or fail.
- F2.19, F2.20 watcher: final pass on every ending, after a grace period, and at boot: **carried (M1)**.
- F2.21 detached final job: **changed (M1)**. A Worker in the app; a call that ended while akou was down is finalized at the next start.
- I2.1 `POST /api/new` with the viewer header and its error codes: **changed (M1)**. `POST /v1/calls`, answering 201, 409, 403 or 503 as in [DESIGN](DESIGN.md) 6.2; the bearer token replaces the custom header.
- I2.5, I2.15 the hark agent endpoint the viewer consumed, and the external hark commands the launcher, offline pass and diarizer ran: **dropped as a class**. There is no second agent process and no external hark command; the hark stdout dialect in DESIGN 2.4 (M0 and M1 fallback) is the only remaining use.
- F2.22, I2.0 `GET /api/status` shape: **changed (M1)**, see I1.8.
- F2.23, I2.4, I3.2 transcript join across parts on one clock: **carried (M1)**; one log holds every part, so no join is needed.
- I2.9 environment settings (root, ports, binary, browser): **changed (M1)**, settings schema.

## Accurate pass and post-processing

- F2.24, I2.13 post-process outputs and status file: **changed (M1)**. `final.*` events in the log; no side files.
- F2.25 once-per-call lock, `--force`: **carried (M1)** as `final.started {pid}` plus `akou finalize --force`.
- F2.26 settle wait until audio stops changing: **dropped**. Stop returns after the helper finalized the file, so there is nothing to wait for; a crashed part is finalized at boot.
- F2.27 final transcript per part, Microphone and Others, on the call's clock: **carried (M1)** as the final layer with `you` and diarized clusters, all parts diarized together.
- F2.28 retry a refused part in halving pieces down to 20 s: **carried (M1)**.
- F2.29 warning when every accurate line is on one channel: **carried (M1)** as a `final.done` warning.
- F2.30, F2.31 language detection with a one-line verdict: **changed (M1)**. Languages are listed in status and the export only when a model reported them (Whisper); with Parakeet there is no verdict until a language-id step exists.
- F2.32, I2.14 third-party comparison transcript lane: **dropped**; nothing downstream read it, and it was macOS-only.
- F2.33, F2.34 job liveness by pid, cleanup on signals: **changed (M1)**. The final pass is a Worker; boot reconciliation restarts an unfinished one.
- F2.35, I2.7 `relabel`: **dropped**. Whole-call diarization plus click-to-rename, merge and unmerge replace it.
- I2.10, I2.11, I2.12 folder layout, JSONL transcripts, `meta.json`: **changed (M1)**. One `events.jsonl` per call; `akou import hark-viewer` reads the old layout.

## Launcher and CLI

- F2.36, I2.6, I2.7, I3.0 `hark-viewer [workspace] [title]`, `open | stop | restart | quit | finalize`, exit 0 recording / 75 already recording: **carried (M1)** as `akou start | open | stop | restart | quit | finalize` with the same exit contract.
- F2.37 start the server if needed: **carried (M1)**; the CLI launches the app headless.
- F2.38 `quit` stops, settles, hands off the final pass, kills the agent: **changed (M1)**. `akou quit` asks the app to stop the helper, finalize and exit; the final pass runs at the next start if needed.
- I2.8, I4.8 settings file sourced by the launcher: **dropped**; one config file.
- I2.18 launcher JSON output: **carried (M1)**, `{call, folder, url}` and `{call, folder, part, url}`.

## Window (hark-viewer page)

- F2.39 layout: header, notice bar, transcript, toast, back-to-live: **carried (M1)**.
- F2.40 dark and light, 22 px base: **carried (M1)**.
- F2.41 header state and dot colour: **carried (M1)**.
- F2.42 append-only rows, speaker label on change, last 3 bright, rise animation: **carried (M1)**; the time column shows wall clock instead of offsets.
- F2.43 stable speaker hues: **carried (M1)**, same palette; a renamed speaker keeps its hue.
- F2.44 grey provisional line: **carried (M1)**.
- F2.45 health banners (red, amber, grey, green): **carried (M1)** on every OS, plus lag and permission banners.
- F2.46 final transcript note: **carried (M1)** with a progress bar.
- F2.47 Record, Mute, Pause, Stop, Restart behaviour, "Stop the other call": **carried (M1)**.
- F2.48 workspace picker: **carried (M1)**, plus template picker.
- F2.49, I2.16 follow the live or last call, `?call=` pin: **changed (M1)**. A sidebar of calls by date and title; deep links `akou://call/<id>` and `akou open`.
- F2.50 poll every second: **changed (M1)**. RPC push from the main process; SSE with a cursor for other clients.
- F2.51 pinned auto-scroll, back-to-live, font size keys: **carried (M1)**.
- F2.52 empty state: **carried (M1)**.

## Agent skill and agent behaviour

- F2.53, F3.0 skill discovery and symlinks: **changed (M1)**. `skills/akou/SKILL.md` in the repo, installed by `akou skill install` (DESIGN 6.1) into the harness's skills folder; it refuses a skill whose version differs from the app's.
- F3.1 origin requirements (live transcript to ask an agent during a meeting, accurate transcript after): **carried (M1)**; every part of the design exists for them.
- F3.2 start a recording from the skill with workspace and title: **carried (M1)**, and it is the skill's first action.
- F3.3, I2.17, I3.1 answer questions by reading the transcript through the server: **changed (M1)**. `akou_context` builds a small pack; the agent never reads the whole transcript or the disk.
- F3.5 the agent watches `callAudio` and acts on `dead`: **carried (M1)**; akou restarts automatically after 60 s, the agent informs the user.
- F3.6 restart keeps one call: **carried (M1)**.
- F3.7 stop, quit, post-call: **carried (M1)**; the hand-off runs by itself.
- F3.8 consent reminder: **carried (M1)** in the skill and the window.
- F3.29 observed good behaviour (right workspace, verify active, report folder and URL, periodic health checks): **carried (M1)** as skill rules.
- I3.3 POST endpoints with a custom header: **changed (M1)**, see F2.3.
- I3.4 folder layout the skill relied on: **changed (M1)**; the skill has no folder knowledge.

## Distribution, CI and validation

- F2.54, F4.9, F4.17 test suites with fakes, minimum test counts, CI on pull requests: **carried (M1)**; every job asserts a minimum executed-test count and the report lists gated tests as skipped.
- F0.28, F4.16 validation scripts (60-minute drift test, per-app isolation, live pipeline checks): **carried (M0)** as `scripts/drift-test.ts` and the hardware release checklist, run on real devices, never through speakers.
- F4.7, I4.3 Homebrew one-repo tap and `brew services`: **changed (M1)**. A formula-only tap with a cask; the app registers its own login item. No `brew services`.
- F4.8, I4.4 release pipeline with Developer ID signing and notarization: **carried (M1)** with the `Info.plist` patch and nested signing added.
- F4.10, I4.5 Makefile targets and demo: **dropped**; `bun` and `cargo` are the interface. A demo recording ships in the README.
- F4.11 export-control self-classification: **carried (M1)** in `docs/legal.md`, updated for the new dependencies.
- F4.12 third-party notices: **carried (M1)** in `NOTICE`.
- F4.13 project conventions: **changed (M1)**; `AGENTS.md` states akou's own.
- F4.18 requirements and install notes: **carried (M1)** in the README per OS.

## Examples

- F4.4, F4.5, I4.6 shell recipes for meetings, notes and dictation: **dropped**. akou is an app; `akou start` plus hooks cover the meeting recipe.
- F4.6, I4.7 Google Meet userscript: **dropped**. Meeting detection, if built, uses OS signals, never page DOM.

## Custom vocabulary (new, no predecessor feature)

The predecessors had a read-time word list (they called it a glossary) applied by the user's own scripts after the call. akou makes the list a product feature, calls it vocabulary everywhere, and builds it in three layers. The design is in DESIGN.md, section 3 and the read path.

- V1 one user-owned word list, global plus per workspace plus extra files, YAML, each entry with term, heard forms, source, confirmed flag and date: **new (M1)**.
- V2 decode-time biasing of the live and final recognizer with a short per-call list: **new (M1)**, Parakeet only, and only with `asr.parakeet.decoding` `beam` (sherpa-onnx hotwords, boost 1.5, cap 24, `bpe.vocab` built by akou from the model's tokenizer). Greedy, the default, and Moonshine and Whisper get none.
- V3 read-time correction in every view, with the raw text kept in the log and shown beside the correction: **new (M1)**, in the fold, through `vocab.add` events and the files.
- V4 "Fix this word" in the window, mid-call adds from the CLI, the API and MCP, `--vocab` on start: **new (M1)**.
- V5 `akou vocab list | add | remove | approve | reject | suggest | check | import`, the `/vocab` routes and the `akou_vocab_*` tools: **new (M1)**.
- V6 the post-call pass on the configured provider, correcting known terms and proposing new entries, with a review list: **new (M2)**.
- V7 the `akou-vocab` learning skill (calendar attendees before the call, the user's documents, repositories and exports, web confirmation of spellings, every correction becoming a heard form), always ending in a proposal the user approves: **new (M2)**.
- V8 the nightly vocabulary evaluation with a hit floor, an insertion ceiling and a positive control: **new (M1)**.

## Downstream knowledge pipelines

- F3.9 to F3.28 and I3.5 to I3.17 describe the user's own post-call pipelines (archive formats, word-list harvesting, a search index, a second recording source, transcript merging, classification): **out of scope by decision**, except the word list, which V1 to V7 above bring into akou. akou has no knowledge base. Each of the others consumes akou's hand-off: the Markdown export with frontmatter, the event log, the hook JSON on stdin, and API pull. The predecessor's `Canonical <= variant | variant` list format is accepted by `akou vocab import`.
