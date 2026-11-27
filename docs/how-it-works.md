# How it works

akou is one app with a few small helpers around it. This page follows a call from the microphone to your notes, and says what runs where and what can reach it. The full design is [docs/DESIGN.md](https://github.com/GeiserX/akou/blob/main/docs/DESIGN.md) on GitHub.

```mermaid
flowchart LR
    MIC[Microphone] --> CAP[akou-capture helper<br/>mic and call, two channels]
    CALL[System audio<br/>or one app] --> CAP
    CAP -->|audio packets| LIVE[Live pass<br/>Parakeet or streaming Nemotron]
    CAP -->|Opus file| DISK[(Call folder)]
    LIVE --> LOG[(Event log<br/>events.jsonl)]
    DISK --> FINAL[Final pass after the call<br/>its own Worker]
    FINAL --> LOG
    LOG --> API[Local API<br/>127.0.0.1, bearer token]
    API --> WIN[The window]
    API --> CLI[akou CLI]
    API --> MCP[akou mcp, skills]
    API --> ASK[Ask: a small context,<br/>then your provider]
    LOG --> OUT[Export folder, hooks,<br/>signed webhook, pull]
```

## Capture

The `akou-capture` helper is a small Rust program the app starts for each recording. It records your microphone and the call audio on two separate channels: the call side is the whole computer's sound or one app's, taken with the system's own audio capture, so there is no virtual audio driver to install and no bot in the meeting. It writes the audio to an Opus file in the call's folder and streams it to the app.

The helper runs as its own process so that a stuck audio device can never freeze the app: akou gives it a few seconds to stop, then ends it. To restart a recording, akou starts a new helper before stopping the old one, so there is no gap in the audio.

## The live pass

While the call runs, a recognizer in a background thread of the app turns each channel into text. On a Mac with a GPU and 16 GB of memory it is streaming Nemotron by default, which shows words about half a second after they are spoken and never takes one back. With less memory it is Parakeet TDT 0.6B v3, which re-reads each stretch of speech between pauses, so a word on screen can still change. The default prefers what is already on disk, a downloaded Nemotron first, else a downloaded Parakeet, so a Mac that has only Parakeet keeps Parakeet. Your channel is labelled with your name; the call channel is split into speakers as they talk.

A line still being spoken is marked `DRAFT` until it settles.

## The final pass

After the call, akou reads the whole recording again for the accurate transcript: Qwen3-ASR on a Mac with a GPU and 16 GB of memory, Parakeet with less (again, the default prefers what is already on disk: a downloaded Qwen3-ASR first, else a downloaded Parakeet), and speaker labels from Nemotron 3 Diarization and TitaNet. It runs in its own Worker, one call at a time, and frees the models' memory when it ends, so a long call does not leave the app large. The final text replaces the live text in the window and in every export, and every line keeps its time of day.

All of this runs on the Mac. The speech models are one download of about 3.0 to 3.7 GB, by what the Mac runs: about 3.7 GB with streaming Nemotron and Qwen3-ASR, about 3.0 GB with Parakeet. Each file is checked against a SHA-256 pinned in akou's code.

## The event log

Every call is a folder under `~/Recordings/akou/<workspace>/` with the audio, the logs and one file, `events.jsonl`, that holds everything that happened: each line of the transcript, each speaker name, each note, each question and answer, each fix. The log is append-only: a correction is a new event, never an edit. The window, the command line and the exports all draw from this one log, so they always agree.

## The local API and its doors

The app serves an API on `http://127.0.0.1:8476/v1`, on this machine's loopback only, with a bearer token kept in a file only you can read. Everything the window can do exists on this API, and every other door is a client of it:

- the `akou` command line, for you and for scripts;
- `akou mcp`, the MCP server your agent talks to;
- the `akou` and `akou-vocab` skills, which teach Claude Code and Codex to use the two above.

So an agent sees the same call you see, and what it does (a note, a speaker name, a fixed word) shows up in the window at once. See [Agents and the command line](agents.md).

## Ask

A question never sends the whole transcript anywhere. akou first builds a small context on the Mac, with no model call: the lines that match the question, the last minutes of the call, your notes and the speakers. Only that goes to the provider you chose: your own Claude Code or Codex, a local model through Ollama, or an API with your key. With the provider set to `none`, Ask becomes "Search this call" and shows the matching lines. See [Providers](providers.md).

## The hand-off

akou keeps no library of your calls. From one call to the next it carries only your vocabulary and the voices of the people you named (see [Voices you named](#voices-you-named)). A finished call leaves through the export folder (Markdown with frontmatter, the event log and the audio), hooks that run your own commands, a signed webhook, or a pull over the API. Each of them is off until you set it up. See [Hand-off to your knowledge system](knowledge-handoff.md).

## Voices you named

When you name a speaker in a call, akou keeps a voiceprint of that voice, so it can name the same person in a later call. A voiceprint is a list of numbers that the speaker model, TitaNet, computes from the voice. It is not a recording.

- **What akou keeps.** One voiceprint per call in which you named the person, at most 8 per person and 150 people, in `voices.yaml` in the config folder (`~/.config/akou/`). Only your user can read the file (mode 0600).
- **Where it goes.** Nowhere. akou computes the voiceprints on this computer and keeps them there. An export leaves them out of the event log, an `ak_` key cannot read them, and no command, route or tool prints one.
- **What it is for.** Only to name a voice again. Nothing trains a model: akou compares a new voice with the voiceprints in the file, and that is all.
- **Who teaches it.** A name you give in the window, its ask box or the `akou` command line. A name from an MCP agent, a name akou found by voice and an imported name teach nothing.
- **How long it stays.** A voiceprint older than 3 years is dropped. Deleting a call for good (Empty trash, or the purge after 30 days in the trash) drops what that call taught. A call in the trash keeps it, so a restore brings it back.
- **How to see and remove it.** In the window, Settings > Voices lists each person with the calls that taught their voice, and has Rename, Forget, Forget this call and Forget all voices. On the command line, `akou voices` lists them, `akou voices rename OLD NEW` renames one person, `akou voices forget NAME` forgets one person, `akou voices forget --call ID` forgets what one call taught, and `akou voices forget --all` deletes `voices.yaml`. The API has `GET /v1/voices`, `POST /v1/voices/rename` and `POST /v1/voices/forget`, and MCP has `akou_voices_list` and `akou_voice_forget`. Only you, on this computer, reach them: an `ak_` key gets 403.
- **Turning it off.** "Recognise voices across calls" in Settings > Speakers (`voices.enabled`) is on by default. Off, akou stops learning and matching voices and keeps `voices.yaml`, and you can still list and forget.
- **Server mode** has no voice recognition. It never learns or names a voice.

## Security

- The desktop app's API listens on 127.0.0.1. Every request needs the token, which lives in a file readable by your user alone; `akou token rotate` replaces it.
- Two listeners go further, and both are off until you turn them on. With `network.enabled`, the app also listens for API keys (`akou keys create`), so a phone can read what each key's scopes allow; the app's token is refused there. A share link serves one call read-only. Each listens on the tailnet by default; set `network.bind` or `share.bind` to `lan` and it is plain HTTP, visible to that network. See [Configuration](configuration.md).
- Settings that name a program akou runs, or an address your audio or transcripts go to, can be written only in the config file or the window, never over the API, so the token cannot be turned into a way to run a command or send your calls elsewhere.
- Text quoted from a call reaches an agent marked as data, never as instructions.
- In server mode, each program gets its own key with scopes, and the server refuses to listen beyond loopback until a reverse proxy with TLS is in front of it. See [Server mode](server.md).
