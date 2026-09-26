# Positioning

akou is an open-source alternative to [Granola](https://www.granola.ai). It keeps Granola's loop of capture without a bot, rough notes during the call and clean notes after, and runs the rest on hardware and accounts you own. Transcription is local. Your own AI agent in the terminal follows and questions the call through MCP or the `akou` command, whether it is Claude Code, Codex or any other. The built-in brain uses your Claude Code or Codex subscription or any OpenAI-compatible or Anthropic endpoint. Notes land in your own tools, on macOS, Windows and Linux, or on a [server you host](ux/SERVER.md).

## Who akou is for

People who spend their day in calls and already use a coding agent. They want the call recorded on their own machine, a live transcript they can glance at, and a notepad that turns into clean notes afterwards. They want to ask "what did she say about the deadline?" while the call is still going, from the app or from the terminal where their agent lives. They already keep their knowledge in Obsidian, Logseq, a Git repository, a wiki or a RAG index, and want the call to land there as plain files.

akou is also for the agent itself. An agent can start a recording, follow it, name a speaker, add a note and answer a question about the live call through a command line, a local API or MCP, with no window open.

## What akou does

- Records the microphone and the call audio on separate channels, with no bot in the meeting and no virtual audio driver, on macOS, Windows and Linux.
- Transcribes live on the machine, with a provisional line for the words being spoken, and produces an accurate transcript with speaker labels after the call.
- Keeps a timestamped notepad during the call and enhances it into clean notes afterwards, using a template per meeting type.
- Answers questions about the current call, during the call, from a small context built locally, citing wall-clock times.
- Its default brain is the coding-agent subscription you already pay for: Claude Code or Codex, run locally. A local model or your own API key work the same way. There is no akou cloud.
- Hands every finished call to your own system as Markdown with frontmatter, the event log and the audio, plus hooks, an optional signed webhook, and API pull.
- Optionally shares a read-only live link on your network. Off by default, visible when on.

## Comparison

| | akou | [Granola](https://www.granola.ai) | [Minutes](https://github.com/silverstein/minutes) | [anarlog](https://github.com/fastrepl/anarlog) | [Meetily](https://github.com/Zackriya-Solutions/meetily) | [Otter](https://otter.ai) |
|---|---|---|---|---|---|---|
| Licence | GPL-3.0 | Closed | MIT | MIT (commercial parts separate) | MIT (pro tier closed) | Closed |
| Desktop app on | macOS, Windows, Linux | macOS, Windows | macOS (CLI on all three) | macOS, Windows, Linux | macOS, Windows (Linux from source) | Web, macOS, Windows |
| Captures without a bot | Yes | Yes | Yes | Yes | Yes | Desktop app or bot |
| Mic and call kept separate | Yes, end to end | Not exposed | Yes | Yes | No, pre-mixed | No |
| Transcription runs locally | Yes, all three OSes | No, cloud | Yes | Apple Silicon only | Yes | No |
| Live transcript to an agent | Yes: CLI, API, MCP, skill | Read-only MCP after the call | Yes: MCP and a skill | Read-only | No | No |
| Agent can start a recording | Yes | No | Yes | No | No | No |
| Ask about the call during the call | Yes, local retrieval that stays flat past two hours | Yes, in their cloud | Time window plus cursor | Whole transcript in context | Not yet | Yes, in their cloud |
| Notes enhanced after the call | Yes, with your model or agent | Yes, in their cloud | Summaries | Yes | Summaries | Yes, in their cloud |
| Where your data goes | Your disk, your export folder | Their cloud | Your disk | Your disk (cloud optional) | Your disk | Their cloud |
| Cross-meeting knowledge base | No, by design | Yes | Yes (search across meetings) | Yes | Some | Yes |
| Price | Free | Free tier, paid plans | Free | Free, paid cloud | Free, paid tier | Free tier, paid plans |

The table reflects public information as of September 2026 and may be out of date.

## How akou differs, in one paragraph each

**Granola** made the core loop we adopt: capture without a bot, type rough notes during the call, get clean notes after. Granola does the thinking in its cloud with vendor speech recognition. akou does the same loop with local transcription and your own model or agent, on Linux too, and keeps your notes in files you own.

**Minutes** is the closest open project: a Rust core, a wide CLI, an MCP server and a skill that follows the live transcript. It is macOS-first on the desktop and its live retrieval is a time window. akou ships a desktop app on all three OSes, builds a retrieval pack for each question from names, memo, recency and keyword search so questions stay cheap on long calls, and deliberately has no cross-meeting search.

**anarlog** has the best cross-OS capture code in the open and a careful agent skill, but agents cannot start a recording, in-app chat stuffs the whole transcript, and local recognition is Apple Silicon only.

**Meetily** captures on macOS and Windows but mixes the channels into one track and has no agent surface or in-call chat yet.

**Otter** is a cloud service with a meeting bot and a desktop recorder. Everything happens on its servers. akou is the opposite end of that trade.

## Non-goals

- **No built-in knowledge base.** No library of past meetings, no search across meetings, no people or topic database, no idea lists, no weekly rollups, no voiceprints kept across calls. akou records, transcribes, takes notes and answers about the current call or one past call you name, then hands the result to the system you already use. Integration is the feature.
- **No vendor cloud.** Nothing leaves your machine unless you switch on a remote provider, a webhook or a share link, and the app says so when you do.
- **No meeting bot.** akou never joins a call. It hears what your computer hears.
- **No API key required.** The default brain is the coding-agent subscription you already have, run locally. Whether a third-party app may drive that tool on your behalf is a terms-of-service question we state openly in the docs and will verify before release.
- **No Intel Mac.** The desktop shell is Apple Silicon only.

## Consent

Recording a call needs the other side's agreement in many places. akou reminds you once per call, gives you a notice you can paste, and explains the duties in its privacy document. Following the law where you are is up to you.
