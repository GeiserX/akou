<p align="center">
  <img src="docs/images/banner.svg" alt="akou" width="100%">
</p>

# akou

<p>
  <a href="https://github.com/GeiserX/akou/releases"><img src="https://img.shields.io/github/v/release/GeiserX/akou?include_prereleases" alt="Release"></a>
  <a href="https://github.com/GeiserX/akou/actions/workflows/ci.yml"><img src="https://github.com/GeiserX/akou/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/GeiserX/akou" alt="License"></a>
</p>

akou is an open-source alternative to [Granola](https://www.granola.ai): a desktop app that records your calls on your own computer, transcribes them on the machine, and answers questions about a call while it is still running. Your own terminal agent (Claude Code, Codex or anything that [speaks MCP or can run the `akou` command](docs/ux/PROGRAMMABILITY.md)) can follow and question the call, and the notes land in the tools you already use. It runs on macOS, Windows and Linux, and as a [transcription server](docs/ux/SERVER.md) you host yourself.

## Status

Early. The 0.x releases are prereleases for macOS on Apple silicon: the app is not signed by Apple yet, so the first open needs one extra step. The documents in this repository cover the architecture, the requirements, the known traps and the roadmap.

## Features

- Captures the microphone and the call audio on separate channels, with no bot in the meeting.
- Shows a live transcript and keeps a timestamped notepad while the call runs.
- The recording never leaves your machine, and the app has no cloud.
- Your agent can start a call, follow it, name a speaker and ask about it from the terminal, over a local API or MCP.
- The ask box answers with the Claude Code or Codex subscription you already pay for, or with [any OpenAI-compatible or Anthropic endpoint](docs/providers.md).
- Answers come from a small context built locally, with no model call and no re-reading of the call, so a late question in a three-hour call costs about the same as one in a ten-minute call.
- One word list you own fixes rare names and product terms; your agent adds new words to it with your approval.
- A finished call becomes Markdown, an event log and the audio, and lands in your own files: no built-in knowledge base.

## Quick start

Download `akou-<version>-macos-arm64.dmg` from the [latest release](https://github.com/GeiserX/akou/releases), drag akou into Applications and open it once. The build is not signed by Apple yet: on macOS 14, Control-click akou and choose Open; on macOS 15 and later, go to System Settings > Privacy & Security after the refusal and click Open Anyway. Needs a Mac with Apple silicon and macOS 14.4 or later.

The first window downloads the speech models (about 3.0 GB, each file checked against a pinned SHA-256). [Getting started](docs/getting-started.md) covers checksums, permissions, the command line and uninstalling.

## Documentation

- [Getting started](docs/getting-started.md): installing the app and the command line, the first open, models, permissions, uninstalling
- [Providers](docs/providers.md): what answers questions and writes notes
- [Handing calls to your own knowledge system](docs/knowledge-handoff.md)
- Design record: [index](docs/index.md), [design](docs/DESIGN.md), [requirements](docs/REQUIREMENTS.md), [traps](docs/TRAPS.md), [roadmap](docs/ROADMAP.md), [positioning](docs/POSITIONING.md)

## License

[GPL-3.0-or-later](LICENSE). akou is written from scratch and replaces [hark](https://github.com/PhantomYdn/hark), whose capture design it carries over in full.
