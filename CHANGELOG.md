# Changelog

All notable changes to akou. Versions follow [semantic versioning](https://semver.org); while the version is 0.x, every release is a prerelease.

## 0.3.0 — the best preset, on the GPU the box has

The server now runs the `best` preset, on Qwen3-ASR with speaker labels, and uses the GPU it finds: Intel or AMD through Vulkan, NVIDIA through CUDA, Apple silicon through Metal. A server that has no fitting GPU can hand its jobs to another akou, such as a Mac mini. A backlog of tens of thousands of files can drain without a client flooding the server.

### Server mode
- `best` runs Qwen3-ASR-1.7B, the most accurate open model akou knows for English and Spanish, through llama.cpp's `llama-server` (release b11200, every file pinned by SHA-256). A job asks for it with `preset=best`, or `server.default_model` makes it the default. `diarize=true` adds Nemotron speaker labels. The model and its llama-server download on demand, like any model. `asr.languages` keeps Qwen's automatic language choice inside the languages you list. See [docs/install.md](docs/install.md#the-best-preset).
- GPU images: `drumsergio/akou:<version>-vulkan` for Intel (integrated or Arc) and AMD GPUs, with `--device /dev/dri` and the render node's group, and `drumsergio/akou:<version>-cuda` for NVIDIA, with `--gpus all`. The plain `drumsergio/akou:<version>` runs on the CPU. All three are built for amd64 and arm64. See [docs/install.md](docs/install.md#a-gpu).
- `asr.accelerator` (`auto` by default, or `AKOU_ACCELERATOR`) picks the GPU: Metal on Apple silicon, CUDA for an NVIDIA card, Vulkan for an Intel or AMD GPU, else the CPU. llama-server then confirms the device itself. `GET /v1/server` reports `gpu` and `accelerator`, with the device's name, or the reason it runs on the CPU.
- Sending jobs to another akou: `server.remotes` names other akou servers, their key files and the presets to send them first. A job this server cannot run goes to a remote that offers it. The client still sees one server, with its own job ids, feed, webhooks and metadata. When a remote goes down, its jobs go back to the queue and never fail for that reason. See [docs/install.md](docs/install.md#sending-jobs-to-another-akou).
- A Mac as the server: `akou serve` from a source checkout uses Metal, with steps for a LaunchDaemon that starts it at boot. CI runs it on a macOS arm64 runner. See [docs/install.md](docs/install.md#a-mac-as-the-server).
- A large backlog: `server.concurrency` runs jobs in parallel, `server.queue_max` and `server.queue_max_per_key` cap the queue, and a submit past a limit gets `429 queue_full` with `Retry-After` before the upload is read. A job may carry `priority` from -10 to 10. `GET /v1/server` and `/healthz` report the queue's depth, throughput and ETA. See [docs/install.md](docs/install.md#a-large-backlog).

The Telegram-Archive contract does not change: the event feed, `Idempotency-Key`, the job fields and the error shape are as in 0.2.1. `priority` is new and optional.

### Known limitations
- **GPU speed is measured on Apple silicon only.** A Mac mini M4 runs `best` with speaker labels at a real-time factor of 0.16, natively on Metal. The Vulkan image on an Intel UHD 770 and the CUDA image on a real NVIDIA card have passed CI with no GPU, but nobody has timed them yet.
- **A Mac serves from a source checkout.** Docker on a Mac has no GPU, and the single-file CLI's `akou serve` still carries no speech engine.
- **`best`'s nightly accuracy checks are not in CI yet.** CI covers it with a fake llama-server. Qwen's per-word confidences do not reach the result yet.
- Every item under 0.2.0's Known limitations still applies, except the one that said only `fast` had an engine and the image used no GPU.

## 0.2.1 — the first published 0.2 release

The `v0.2.0` tag exists, but 0.2.0 never published a Docker image or a GitHub release. Docker Hub refused the push to `geiserx/akou`, a namespace that does not exist, and the release waits for the image. 0.2.1 ships everything listed under 0.2.0, under the image name that works.

### Changed
- The server image is now `drumsergio/akou:<version>`, starting with `drumsergio/akou:0.2.1` for linux/amd64 and linux/arm64. There is still no `latest` tag. The [Dockerfile](Dockerfile), [docs/install.md](docs/install.md#the-server), the [compose example](examples/compose/telegram-archive/compose.akou.yml) and the release workflow all use the new name.

### Added
- akou has a logo. The mark is a lowercase a that holds the red recording dot.
- The mark is the menu bar and tray icon, the macOS app icon in the Dock and Finder, and the favicon of akou's web pages. The idle tray icon has no red dot, so it never looks like it is recording.

### Known limitations
Every item under 0.2.0's Known limitations, below, still applies to 0.2.1.

## 0.2.0 — server mode

akou now also runs as a transcription server. The Docker image, for amd64 and arm64, takes audio files from other programs and returns their transcripts. It fetches the models it needs and has its own web page. The app, the CLI and the agent tools grew too: a player you can drive from the keyboard, a floating recording indicator, `akou watch`, and MCP answers that never outgrow an agent's context.

### Server mode
- Image for linux/amd64 and linux/arm64, built from the [Dockerfile](Dockerfile). It was meant to be `geiserx/akou:0.2.0`, but that name was never published: see 0.2.1. It runs `akou serve`. There is no `latest` tag. `akou models pull fast` fetches the models into a volume before the first start, with no server running. See [docs/install.md](docs/install.md#the-server).
- File jobs. `POST /v1/jobs` takes an audio file, such as an Ogg Opus voice note, M4A, MP3 or WebM. Wait on it with `?wait=`, read the result, or cancel and delete it. A retried submit with the same `Idempotency-Key` gets the first job back. Queued jobs survive a restart. A file longer than 240 minutes fails as `too_long` (`server.max_audio_minutes`).
- A job can name its model. Without one, akou uses `server.default_model`, then `fast`. A model akou does not have is downloaded while the job waits in the queue, and every file is checked against its pinned SHA-256. `server.auto_download` set to `false` turns that off. `server.default_language` and `server.default_diarize` apply when a request does not say.
- akou deletes on its own. A job, its result and its events go after `server.retain_days`, 7 by default. A model nobody has used for 30 days goes too (`server.models_unused_days`, 0 for never), but never the default model or one a job needs. A download that would take the models folder past 40 GB is refused (`server.models_max_gb`).
- Results arrive three ways: long poll, an event feed (`GET /v1/events`, JSON or Server-Sent Events), or signed webhooks (Standard Webhooks, retried for about three days).
- An OpenAI-compatible `POST /v1/audio/transcriptions`, so an OpenAI client pointed at akou transcribes files.
- One key per program. `akou keys create|list|revoke` issues keys with a `jobs` or `admin` scope and a list of hosts their webhooks may call. akou stores only a hash of each key, and refuses a revoked key on its next request.
- A web page for the server. An admin logs in from another machine with a password (`akou admin set-password`) or an admin key. The page has Jobs (watch, open, cancel and delete jobs), Keys (create and revoke), Settings (the server's defaults) and Models (state and download). The same key routes are at `/v1/keys`.
- Uploads up to 512 MB (`server.max_upload_mb`) stream to disk, so a large file never sits in memory.
- `GET /healthz` for container health checks. `GET /v1/server` lists presets, engines and how many days a job's result is kept.
- `akou transcribe <file>` sends a file to a server-mode akou and prints the transcript. That akou can be the image, `akou serve` in a source checkout, or one `AKOU_URL` names. The desktop app takes no file jobs.
- `AKOU_URL` with a key from `AKOU_API_KEY` or `AKOU_API_KEY_FILE` points the CLI and `akou mcp` at an akou on another machine.
- A compose example runs akou beside Telegram-Archive ([examples/compose/telegram-archive/compose.akou.yml](examples/compose/telegram-archive/compose.akou.yml)). CI runs the pair end to end: a voice note goes in, and its transcript comes back through the signed webhook.
- A data or models folder akou cannot write stops the start with one line naming the folder and the uid, not a stack trace later.

### API
- akou serves its own OpenAPI file at `GET /v1/openapi.json`, with no key needed. akou generates it from its route table, and CI fails when the committed [docs/api/openapi.json](docs/api/openapi.json) differs. `?scope=jobs` returns only what a `jobs` key may call, which Executor loads as tools.

### Transcript
- Parakeet now decodes greedily by default. Beam search with name boosts dropped stretches of meeting speech and inserted names nobody said. On AMI meetings beam lost 651 words where greedy lost none. Pooled over the public sets we measured, word error rate fell from 11.23% to 9.50% ([docs/research/asr-architecture.md](docs/research/asr-architecture.md)). `asr.parakeet.decoding` set to `beam` brings beam back, with a lower boost. Your word list still corrects the transcript after decoding, but under greedy its per-word decode boosts are not used.
- Groundwork for more speech engines: one engine interface, and a model catalog that knows which platforms each model runs on. Nothing changes for you yet.

### Window
- The player has Play and Pause, and Space toggles it. `[` and `]` set the speed from 0.75x to 2x, and `Shift+←` and `Shift+→` seek 5 s. The line being played stays highlighted and in view until you scroll away.
- A live speaker label is marked as a guess (`c1?`, dashed) until the final pass or until you name the speaker.
- Right-click a line, or press `Shift+F10`, for Play from here, Copy line, Copy with time and speaker, Name this speaker… and Fix a word….
- Fixes: the Notes, Ask and Enhanced tabs no longer show all at once. A note edit saves when you click away and after a 2 s pause. Copy transcript so far works.

### Desktop
- Quitting during a recording asks "A call is recording. Stop it and quit?" first.
- A small always-on-top indicator shows the recording time, both levels, Mute and Stop while the akou window is not in front. It never shows transcript text, so it can stay up during a screen share. `app.floatingIndicator` turns it off.
- The menu bar item shows an icon while idle. akou notifies you when an agent or the CLI starts a recording, when a start is refused, and when capture dies.
- Clicking the Dock icon opens the window, and the window comes back where you left it.
- On macOS, the Edit menu makes copy, paste and undo work in the notepad and the ask box, and `⌘,` opens Settings.
- akou menu > Install Command-Line Tool… puts `akou` on your PATH.
- Windows and Linux: the default global hotkey is now `Control+Shift+F9`, no longer `Control+Alt+R`, which is AltGr on many European layouts and could swallow a typed character. If you relied on the old default, set `app.hotkey` to `Control+Alt+R` in Settings.

### CLI
- `akou watch` follows a live call in the terminal. Type a question to ask the call, or a `/` command to run against it.
- `akou wait --for final.done|enhanced|exported` returns when the call reaches that stage, so a script no longer polls.
- Every command that works on a call takes `-c/--call`. Help comes from the command registry, so every accepted flag shows, and every command has an example.
- `akou config set KEY -` reads a secret from stdin. akou refuses a secret passed as an argument, because it is already in your shell history.
- Colour on a terminal only, off with `NO_COLOR` or a pipe.
- `akou doctor --grant` works. It used to exit with "not built".

### Agents
- `akou skill install` also registers `akou mcp` with Claude Code and Codex. `akou skill uninstall` removes both.
- Call text reaches an agent inside a marked block that says it is quoted speech, not instructions.
- MCP tools carry read-only and destructive hints and typed output. No answer passes 8,000 tokens, and `akou_get_call` pages through long calls.
- The repository is a Claude Code plugin with its own marketplace ([.claude-plugin](.claude-plugin)).

### Known limitations
- **Unsigned macOS build.** The first open needs a manual step, and macOS may ask for the microphone and system audio again after an update. See [docs/install.md](docs/install.md).
- **macOS only as an app.** The release ships the macOS app (Apple Silicon), the CLI and the server image. There is still no packaged desktop app for Windows or Linux. The Linux and Windows CLI archives manage models, the skill and the settings, but cannot record. The new `linux-arm64` archive has not been run on a Raspberry Pi yet.
- **Server mode and the image are new in this release.** CI builds the image on amd64 and arm64 and transcribes a spoken sentence in each. Nobody has run it for long on a real server yet. The design and what is still missing are in [docs/ux/SERVER.md](docs/ux/SERVER.md). A container refuses to start until you set `AKOU_BEHIND_PROXY=true` and put a reverse proxy with TLS in front of it, because akou has no TLS of its own. See [docs/install.md](docs/install.md#the-server).
- **The server's web page is partly built.** The Models page shows the models' state and a download button, but not each model's size, last use, deletion date or a Delete button. There is no preset picker yet, and the Jobs page polls twice a second instead of following the event feed.
- **One engine, on the CPU.** Only the `fast` preset has an engine. `lite`, `best` and `fusion` are refused, and akou does not choose by hardware yet. The image uses no GPU. Results carry no word times or confidences: `words` is empty and both confidence fields are null.
- **Transcribing a file needs server mode.** The single-file CLI's `akou serve` answers the API but carries no speech engine, and says so when it starts. On a Mac, use the image or a source checkout.
- **The window is tested in Chromium, but the app draws it in WebKit.** CI runs the window tests in headless Chromium. The WebKit run is manual while some of its tests still fail there, so the new player, line menu and indicator are not tested in the app's own webview.
- **Drift between two clocks is not measured.** One recording can take the mic and the call from two devices with separate clocks. How far they drift apart over an hour has not been measured on real hardware yet. See [docs/gates/M0-results.md](docs/gates/M0-results.md).
- **The 1 s rebuild has not been seen on a real device.** It is proven in simulated capture, but no call audio died during the hour-long run on a real Mac.
- **Large first download.** The speech and speaker models are about 3.0 GB, downloaded on first run.

## 0.1.0 — first prerelease

akou records a call from the window, the CLI, the local API or an agent (Claude Code or Codex, through MCP and the akou skill). It transcribes the call live and lets you or an agent ask questions about it while it is still going. After the call it hands the call to your own notes and tools. akou has no knowledge base of its own.

### Recording
- Mic and call audio recorded on separate channels by a native helper, in parts, so a crash loses little: 1.25 s when we killed the helper outright. The app never freezes waiting on capture.
- macOS through a process tap. Windows through process loopback, with akou's own audio left out. Linux through PulseAudio or PipeWire. Tested with real audio: Windows and Linux in CI, macOS on a reference Mac.
- A call side that stops delivering audio is rebuilt within about a second, down from 10 s. A silent first start no longer loses the first word.

### Transcript
- Live transcript, then a final pass over the whole call.
- Speech recognition with Parakeet TDT 0.6B v3 at full precision. On FLEURS it gets 6.0% of English words wrong where the compressed build gets 8.5%, and 3.1% of Spanish where it gets 4.0%. See [docs/research/asr-benchmark.md](docs/research/asr-benchmark.md).
- Speaker labels from NVIDIA Nemotron 3 Diarization, live and in the final pass. On our test calls, the share of speech with a wrong or missing label fell from over half to about a tenth.
- Your own word list corrects names and terms live and in the final pass. A learning step proposes new words from calls and documents, and adds nothing until you approve it.

### Asking and notes
- Ask about the call while it runs. akou builds a small context pack of the relevant lines instead of sending the whole transcript.
- Answers and enhanced notes come from your own Claude Code or Codex subscription by default. Any OpenAI-compatible or Anthropic endpoint works too, and so does no model at all.
- Hand-off to your own tools: export files, hooks and webhooks.

### Programmability
- `akou` CLI, a local HTTP API (`/v1`, loopback only, with a token), MCP tools and skills for Claude Code and Codex.

### Known limitations
- **Unsigned macOS build.** The first open needs a manual step, and macOS may ask for the microphone and system audio again after an update. See [docs/install.md](docs/install.md).
- **macOS only as an app.** The release ships the macOS app (Apple Silicon) and the CLI. Windows and Linux capture is tested in CI, but there is no packaged app for them yet.
- **Drift between two clocks is not measured.** One recording can take the mic and the call from two devices with separate clocks. How far they drift apart over an hour has not been measured on real hardware yet. See [docs/gates/M0-results.md](docs/gates/M0-results.md).
- **The 1 s rebuild has not been seen on a real device.** It is proven in simulated capture, but no call audio died during the hour-long run on a real Mac.
- **Large first download.** The speech and speaker models are about 3.0 GB, downloaded on first run.
