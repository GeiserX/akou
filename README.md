# akou

akou (Greek: "listen!") is a desktop app that records your calls on your own computer. It shows a live transcript, keeps a timestamped notepad while the call runs, and answers questions about the call while it is still going. It captures the microphone and the call audio on separate channels, with no bot in the meeting, and transcribes on the machine. Its default brain is the coding-agent subscription you already have, Claude Code or Codex, run locally. A finished call becomes Markdown, an event log and the audio, and lands in whatever system you already keep your notes in. It runs on macOS, Windows and Linux.

## Status

Design stage. There is nothing to install yet. The documents in this repository cover the architecture, the requirements, the known traps and the roadmap. The first milestone is a set of measured gates, then a macOS build.

## Why it is different

- The recording never leaves your machine, and the app has no cloud.
- Your agent can start a call, follow it, name a speaker and answer a question about it from the terminal, over a local API or MCP.
- akou answers every question from a small context it builds locally in under 50 ms, so a question late in a three-hour call costs about the same as one in a ten-minute call.
- One word list you own fixes rare names and product terms. akou biases the recognizer toward it, every view corrects with it, and your agent adds new words to it with your approval.
- No built-in knowledge base. The call lands in your own files, and that is the point.

## Documents

Start with [INDEX.md](docs/INDEX.md). The main ones:

- [DESIGN.md](docs/DESIGN.md): the architecture, starting simple and then covering every part in depth.
- [VOCABULARY.md](docs/VOCABULARY.md): how akou spells rare words right, with the measurements.
- [REQUIREMENTS.md](docs/REQUIREMENTS.md): what the predecessors did and what akou does with each feature.
- [TRAPS.md](docs/TRAPS.md): failures that already bit once, written as tests.
- [ROADMAP.md](docs/ROADMAP.md): milestones with exit criteria.
- [POSITIONING.md](docs/POSITIONING.md): who it is for and how it compares.

## Licence and credit

GPL-3.0. akou is written from scratch and replaces [hark](https://github.com/PhantomYdn/hark), the macOS command-line recorder. akou carries over hark's capture design in full. hark's code is the reference, not a dependency.
