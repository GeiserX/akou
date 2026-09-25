# Changelog

All notable changes to akou. Versions follow [semantic versioning](https://semver.org); while the version is 0.x, every release is a prerelease.

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
