# Changelog

All notable changes to akou. Versions follow [semantic versioning](https://semver.org); while the version is 0.x, every release is a prerelease.

## 0.2.0 — server mode

akou now also runs as a transcription server. The Docker image, for amd64 and arm64, takes audio files from other programs and returns their transcripts. The app, the CLI and the agent tools grew too: a player you can drive from the keyboard, a floating recording indicator, `akou watch`, and MCP answers that never outgrow an agent's context.

### Server mode
- Image `geiserx/akou:0.2.0` for linux/amd64 and linux/arm64, built from the [Dockerfile](Dockerfile). It runs `akou serve`. There is no `latest` tag. `akou models pull fast` fetches the models into a volume before the first start, with no server running. See [docs/install.md](docs/install.md#the-server).
- File jobs. `POST /v1/jobs` takes an audio file, such as an Ogg Opus voice note, M4A, MP3 or WebM. Wait on it with `?wait=`, read the result, or cancel and delete it. A retried submit with the same `Idempotency-Key` gets the first job back. Queued jobs survive a restart.
- Results arrive three ways: long poll, an event feed (`GET /v1/events`, JSON or Server-Sent Events), or signed webhooks (Standard Webhooks, retried for up to 24 h).
- An OpenAI-compatible `POST /v1/audio/transcriptions`, so an OpenAI client pointed at akou transcribes files.
- One key per program. `akou keys create|list|revoke` issues keys with a `jobs` or `admin` scope and a list of hosts their webhooks may call. akou stores only a hash of each key, and refuses a revoked key on its next request.
- An admin can log in from another machine with a password (`akou admin set-password`) or an admin key.
- Uploads up to 512 MB (`server.max_upload_mb`) stream to disk, so a large file never sits in memory.
- `GET /healthz` for container health checks. `GET /v1/server` lists presets, engines and how many days a job's result is kept.
- `akou transcribe <file>` transcribes a file through the local server.
- `AKOU_URL` with a key from `AKOU_API_KEY` or `AKOU_API_KEY_FILE` points the CLI and `akou mcp` at an akou on another machine.

### API
- akou serves its own OpenAPI file at `GET /v1/openapi.json`, with no key needed. akou generates it from its route table, and CI fails when the committed [docs/api/openapi.json](docs/api/openapi.json) differs. `?scope=jobs` returns only the job operations, which Executor loads as tools.

### Transcript
- Parakeet now decodes greedily by default. Beam search with name boosts dropped stretches of meeting speech and inserted names nobody said. On AMI meetings beam lost 651 words where greedy lost none. Pooled over the public sets we measured, word error rate fell from 11.23% to 9.50% ([docs/research/asr-architecture.md](docs/research/asr-architecture.md)). `asr.parakeet.decoding` set to `beam` brings beam back, with a lower boost. Your word list still corrects the transcript as before.
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

### Agents
- `akou skill install` also registers `akou mcp` with Claude Code and Codex. `akou skill uninstall` removes both.
- Call text reaches an agent inside a marked block that says it is quoted speech, not instructions.
- MCP tools carry read-only and destructive hints and typed output. No answer passes 8,000 tokens, and `akou_get_call` pages through long calls.
- The repository is a Claude Code plugin with its own marketplace ([.claude-plugin](.claude-plugin)).

### Known limitations
- **Unsigned macOS build.** The first open needs a manual step, and macOS may ask for the microphone and system audio again after an update. See [docs/install.md](docs/install.md).
- **macOS only as an app.** The release ships the macOS app (Apple Silicon), the CLI and the server image. There is still no packaged desktop app for Windows or Linux. The Linux and Windows CLI archives manage models, the skill and the settings, but cannot record.
- **Server mode and the image are new in this release.** CI builds the image on amd64 and arm64 and transcribes a spoken sentence in each. Nobody has run it for long on a real server yet. The design and what is still missing are in [docs/ux/SERVER.md](docs/ux/SERVER.md). A container refuses to start until you set `server.behind_proxy`, because akou has no TLS of its own. See [docs/install.md](docs/install.md#the-server).
- **The server's web page is not built yet.** After the admin login it shows the call window. There are no Jobs, Models or Keys pages yet, so you manage keys with the CLI.
- **Models are not fetched on demand.** Pull them before the first start. akou refuses a job for a model it does not have, `auto` always means `fast`, and akou never deletes a model nobody uses. The `lite`, `best` and `fusion` presets exit with an error, because their engines do not exist yet.
- **The single-file CLI cannot transcribe.** Its `akou serve` answers the API but carries no speech engine, and says so when it starts. Use the image, or a source checkout.
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
