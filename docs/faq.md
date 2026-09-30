# FAQ

The questions people ask first. Each answer points at the page with the detail.

??? question "How is this different from Granola?"

    akou keeps the loop Granola made popular: it captures the call without a bot, you take rough notes during the call, and you can ask about it. The rest runs on hardware and accounts you own. Transcription runs on your Mac, there is no account and no akou cloud, and your own terminal agent (Claude Code, Codex or anything that speaks MCP) can start, follow and question the call. The code is GPL-3.0-or-later.

??? question "Does anything leave my Mac?"

    Not unless you turn it on. The audio, the transcript, the notes and the speech models stay on your disk. Ask sends a small excerpt of the call to the provider you picked: your own Claude Code or Codex, a local model (which stays on your machine), or an API with your key. The provider `none` sends nothing. The export folder, hooks and the signed webhook go only where you point them. See [Providers](providers.md) and [Hand-off to your knowledge system](knowledge-handoff.md).

??? question "Does it work on Windows or Linux?"

    The app is macOS only today, on Apple silicon with macOS 14.4 or later. The Windows and Linux downloads are the `akou` command line alone: they manage models and settings and drive a remote akou, but cannot record. The transcription server runs on Linux in Docker. See [Getting started](getting-started.md) and [Server mode](server.md).

??? question "Why is the app unsigned?"

    Apple lets an app open without a warning only when it is signed with a paid Developer ID and notarized. The 0.x builds carry an ad-hoc signature instead, so the first open needs your OK once, and an update may ask for the microphone and system audio grants again. Check the download against `SHA256SUMS`. See [Why macOS refuses it](getting-started.md#why-macos-refuses-it).

??? question "Does it record Zoom, Meet or Teams?"

    It records whatever your Mac plays, so any meeting app works: the call audio is the whole computer or one app you pick, and your microphone is kept on a separate channel. Nothing joins the meeting as a bot, and akou never talks to a meeting service. Tell the others you are recording.

??? question "Can it search across my calls?"

    No, by design. akou records, transcribes and answers questions about one call. Searching across meetings belongs to the system you already keep your knowledge in, an Obsidian vault, a Git repository or a wiki, and akou hands every finished call to it. See [Hand-off to your knowledge system](knowledge-handoff.md).

??? question "Does it use my Claude Code subscription?"

    Only if you pick it. The `harness` provider runs your own Claude Code or Codex, so questions are answered on your subscription, and only when you ask: the rolling memo that would run on its own is off for the harness. Whether the vendors' consumer terms cover this is an open question we record before each release. See [Terms of service: an open risk](providers.md#terms-of-service-an-open-risk).

??? question "How big is the download?"

    The app is a normal DMG. The speech models are one more download of about 3.0 GB on the first run, into Application Support, each file checked against a pinned SHA-256. The optional dictation model (Qwen3-ASR) is about 2.5 GB more.

??? question "Can I use it without a model provider or an agent?"

    Yes. Recording, the live and final transcripts, notes, speakers and the hand-off all run without one. With the provider set to `none`, the ask box becomes "Search this call" and finds the exact words with their times.

??? question "Is there a mobile app?"

    No. akou runs on a Mac, and as a server in Docker.
