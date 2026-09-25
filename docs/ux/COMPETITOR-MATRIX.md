# Competitor matrix

Every nicety we found in call recorders, meeting notetakers, dictation apps and desktop tools, with the doc that owns each one. This file is the evidence index. The design, priority, acceptance and today's status of an item live in its owning doc, so nothing here can drift from them. The rules behind the choices, the priority scale and the ranked P0 list are in [PRINCIPLES.md](PRINCIPLES.md). How items get tested is in [TESTING.md](../TESTING.md); how CI runs them is in [CI-CD.md](../CI-CD.md).

Tools compared: Granola, Minutes, anarlog, Meetily, Otter, Fireflies, Fathom, tl;dv, Notion AI Meeting Notes, Google Meet, Microsoft Teams, Zoom, Read.ai, Jamie, Bluedot, Amurex, Open Granola, heed, meeting-transcriber, Screenpipe, Scriberr, noScribe, whishper, MacWhisper, Superwhisper, Wispr Flow, VoiceInk, Buzz, Descript, Aiko, Raycast, Linear, VS Code, Obsidian, plus hark and hark-viewer, which akou replaces. "Intent" means the row comes from what akou is for, not from a competitor. "Audit" means we found the gap by running akou.

## How to read a row

The **Owner** column says where the item lives:

- An id such as `W1.1` or `DK-M1`: the row in [WINDOW.md](WINDOW.md) (`W`), [DESKTOP.md](DESKTOP.md) (`DK`), [CLI.md](CLI.md) (`CLI`), [PROGRAMMABILITY.md](PROGRAMMABILITY.md) (`PG`), [TESTING.md](../TESTING.md) (`TS`) or [CI-CD.md](../CI-CD.md) (`CI`). The first id owns the item; ids after "with" are the other doors' rows that cite it.
- `here`: no surface doc designs it yet, so this file holds its priority and acceptance in [Rows this file owns](#rows-this-file-owns). When a surface doc takes it, they move there.
- `parked`: P3, seen and recorded, no bead until someone asks for it. When a surface doc keeps it in its own parking list, that doc's id follows in brackets.
- `decision`: waits on an [open decision](PRINCIPLES.md#open-decisions). No bead until then.
- `non-goal`: we do not build it. See the [last table](#non-goals-and-their-hand-off).
- `has`: built; the owning id follows when a doc tracks it.

## Window: layout and core controls

| ID | Feature | Seen in | Owner |
|---|---|---|---|
| WIN-01 | Notes, Ask and Enhanced tabs show one pane at a time | Audit | W1.1 |
| WIN-02 | Play, pause and scrub the recording | Buzz, MacWhisper, VoiceInk | W5.2, with W5.3 |
| WIN-03 | Copy transcript so far, copy a line, copy notes as Markdown | hark, Granola, Fathom, Wispr Flow | W12.2, with W4.4 and W6.17 |
| WIN-04 | Standard application menu with Edit roles and Settings (Cmd/Ctrl+,) | ElectroBun, platform guidelines | DK-M1 |
| WIN-05 | Record without models from the window | Audit | W2.5 |
| WIN-06 | Floating always-on-top indicator: dot, elapsed time, level bars, Stop, Mute; no transcript text | Granola, Fireflies, Superwhisper, Wispr Flow, anarlog, heed | DK-F1 |
| WIN-07 | Hide akou's windows from screen sharing and screenshots | Minutes, Wispr Flow, Fireflies | DK-P3 |
| WIN-08 | Find in this call (Cmd/Ctrl+F) with match count and next/previous | Buzz, MacWhisper, Descript, Granola, tl;dv | W7.1 |
| WIN-09 | Follow audio: highlight and scroll to the line being played | Buzz, Scriberr, whishper | W5.6 |
| WIN-10 | Playback speed and replay the current line | Buzz, MacWhisper, VoiceInk, Otter | W5.4, with W5.7 |
| WIN-11 | Click a word to play from it | Scriberr, whishper, Descript | W5.8 |
| WIN-12 | Waveform of both channels in the player | VoiceInk | W5.9 |
| WIN-13 | Remember window size and position | Common desktop practice | DK-M4 |
| WIN-14 | Dock the window beside the call when recording starts | Granola, Wispr Flow | parked |
| WIN-15 | Dock click reopens a closed window | ElectroBun `reopen` | DK-M2 |
| WIN-16 | Confirm Quit while a call is recording | Audit | DK-M3 |
| WIN-17 | Narrow window layout | Audit | W1.3 |
| WIN-18 | Caption or presentation mode | Buzz | parked |
| WIN-19 | Theme override: system, light, dark | VS Code, Obsidian | W15.7 |
| WIN-20 | Deep links into settings and sections | Granola | parked |
| WIN-21 | Warn when Bluetooth playback will lower call quality | Open-source recorder survey; TRAPS T0.29 | parked |
| WIN-22 | Open the window on a given workspace | hark-viewer `?workspace=` | here |

## Keyboard

| ID | Feature | Seen in | Owner |
|---|---|---|---|
| KEY-01 | Window shortcuts for record, stop, mute, pause, mark, focus notes, focus ask, back to live | Otter, Granola, Linear | W14.3 |
| KEY-02 | Shortcut sheet on `?` | Linear, Otter | W14.4 |
| KEY-03 | Command palette (Cmd/Ctrl+K) over every action; unmatched text goes to Ask | Linear, VS Code, Obsidian, Minutes | W14.5 |
| KEY-04 | Global hotkey works on macOS or says why not | ElectroBun issue, audit | DK-K1 |
| KEY-05 | Default hotkey avoids Ctrl+Alt on Windows and Linux | Platform keyboard guidelines | DK-K4 |
| KEY-06 | Hotkey recorder with conflict warning, applied without restart | Raycast | DK-K5, with DK-K3 |
| KEY-07 | More than one global hotkey (mute, mark) | VoiceInk, Superwhisper, Wispr Flow | DK-K6 |
| KEY-08 | Wayland global shortcut through the GlobalShortcuts portal | XDG portal | DK-K7 |

## Tray, notifications and system integration

| ID | Feature | Seen in | Owner |
|---|---|---|---|
| SYS-01 | A real tray icon, visible when idle | Platform guidelines | DK-T1 |
| SYS-02 | Tray icon changes per state: idle, recording, paused, shared, degraded, final pass running | Superwhisper, Granola | DK-T2 |
| SYS-03 | Richer tray menu: title and elapsed time, Mute, Pause, record in workspace, recent calls, Stop sharing | Superwhisper, VoiceInk | DK-T4, with DK-T3 |
| SYS-04 | Native notifications for agent-started calls, dead capture, final pass done or failed, hand-off failures, a share left on; never call content | Platform guidelines | DK-N1, with DK-N2, DK-N3, DK-N4 |
| SYS-05 | Consent reminder also for agent-started calls | hark-viewer | DK-F3 |
| SYS-06 | `akou://` links open the call. The scheme is macOS only in ElectroBun 2.0.1 and registers only for an app in `/Applications` | hark-viewer, REQUIREMENTS | PG-U1 |
| SYS-07 | `akou://start`, `stop`, `ask` for Shortcuts, Raycast and Stream Deck | Superwhisper | parked (PG-U2) |
| SYS-08 | Update notice and in-place update, never while recording; opt-in | ElectroBun Updater, Granola beta channel | DK-U1, with DK-U2 and CI-23 |
| SYS-09 | Beta channel toggle | Granola, anarlog | DK-U4 |
| SYS-10 | Crash notice on next launch and a "Report a problem" bundle with no call content | Meetily, heed | DK-O5 |
| SYS-11 | Linux without a tray (stock GNOME) | GNOME, XDG Background portal | DK-T6 |
| SYS-12 | Lid-closed microphone awareness | VoiceInk | here |
| SYS-13 | Start and stop sounds | anarlog, VoiceInk, Superwhisper | DK-P5 |
| SYS-14 | macOS Shortcuts and App Intents | Aiko, MacWhisper | PG-O3 |
| SYS-15 | Raycast, Alfred and PowerToys Command Palette extensions | Granola, Superwhisper | PG-O4 |
| SYS-16 | Open at login, headless, single instance | hark | has: DK-L1; the onboarding toggle is part of DK-O2 |
| SYS-17 | A left click on the tray icon starts or stops recording | Superwhisper | parked (DK-T7) |
| SYS-18 | Copy the last lines from the tray menu | Superwhisper, VoiceInk | parked |

## Recording lifecycle

| ID | Feature | Seen in | Owner |
|---|---|---|---|
| REC-01 | Silence reminder after N minutes of no audio | Minutes, Wispr Flow | W3.5 |
| REC-02 | Low-disk warning and protective stop | Minutes | here |
| REC-03 | Auto-stop after long silence or a max duration, with a cancellable countdown | Granola, Minutes, anarlog, Wispr Flow | here. A stop when the meeting app lets go of the mic needs the same OS signal as REC-18, so it waits on decision (1) |
| REC-04 | Undo a manual Stop while call audio is still active | Designed (M2) | W2.4 |
| REC-05 | Discard a mistaken recording | Superwhisper, VoiceInk | here |
| REC-06 | Delete a call, to a trash with restore | Granola, Minutes, anarlog | PG-A4, with W13.3 and CLI-26 |
| REC-07 | Rename, retitle and move a call to another workspace | Audit | PG-A4, with W13.2 and CLI-26 |
| REC-08 | Start with the mic muted | Minutes | W3.4 |
| REC-09 | A call with notes and no audio yet: notes-only, or notes written before Record | Minutes, Granola "Coming up" | here |
| REC-10 | Keep audio for N days, keep the transcript | anarlog, Minutes, VoiceInk, Aiko, Granola | W13.5 |
| REC-11 | Transcript-only mode that keeps no audio | Fathom | parked |
| REC-12 | Split one recording into two calls at a line | Granola (limitation) | parked |
| REC-13 | Resume a finished call | Granola | has |
| REC-14 | Record only, process later | meeting-transcriber | has |
| REC-15 | Crash recovery | heed, Meetily | has |
| REC-16 | Mute follows the meeting app's mute | anarlog | parked |
| REC-17 | Ranked microphone priority list | anarlog | parked |
| REC-18 | Meeting detection: "Record this call?" | Granola, Notion, MacWhisper, Minutes, anarlog, heed | decision (1), DK-D1 |
| REC-19 | Calendar title and attendees at start | Granola, anarlog, Open Granola | here |
| REC-20 | Stepped-away marker | Teams, Meet | here |
| REC-21 | Words for this call (attendees, title terms) at start, in every door | Audit | here |
| REC-22 | Workspace and template suggested from the detected meeting app or the invite title | Superwhisper per-app modes | parked |

## Live transcript and speakers

| ID | Feature | Seen in | Owner |
|---|---|---|---|
| TRN-01 | Inline edit of a line | Designed, anarlog, noScribe, Descript | PG-A5, with W4.9 and CLI-29 |
| TRN-02 | True live streaming: a streaming recognizer as the live engine, with stable text | Intent, hark fork, VoiceInk, Buzz | here |
| TRN-03 | Word-level timings in the log | Scriberr, Descript, Buzz | here |
| TRN-04 | Per-word confidence shown on uncertain words | Meetily | W4.6 |
| TRN-05 | Live labels shown as provisional; final labels authoritative | Intent | W4.2 |
| TRN-06 | Nemotron-class diarization in the final pass | Intent, heed, meeting-transcriber | here |
| TRN-07 | Rename with suggestions from this call's attendees | MacWhisper, Descript | W8.3 |
| TRN-08 | Hear a speaker before naming | Buzz | W8.4 |
| TRN-09 | Reassign one line to another speaker | MacWhisper, Descript, anarlog | W4.10 |
| TRN-10 | Change a speaker's colour | MacWhisper, Descript | W8.5 |
| TRN-11 | Echo lines visible on request | Descript | W4.5 |
| TRN-12 | Overlap markers from the separate channels | heed, noScribe | parked |
| TRN-13 | Clean view: fillers and pause markers | VoiceInk, Descript, MacWhisper, noScribe | W4.7 |
| TRN-14 | Language verdict with the times of other-language lines | hark-viewer | here |
| TRN-15 | Warn when a call is in a language the engine does not cover | Wispr Flow | here |
| TRN-16 | Re-transcribe a call with a chosen engine or set of engines | anarlog, Meetily, VoiceInk, Superwhisper | here |
| TRN-17 | Re-finalize many calls with a new engine | Intent | here |
| TRN-18 | Chapters from chunk summaries | tl;dv, Zoom, Open Granola | W6.22 |
| TRN-19 | Screen or slide capture into notes | Otter, Granola, Minutes | decision (4) |
| TRN-20 | Voiceprints across calls | heed, meeting-transcriber, Minutes | non-goal |
| TRN-21 | Streaming diarization for live labels (Sortformer) | Open-source recorder survey; DESIGN F8 | here |
| TRN-22 | Speaker names from the meeting app's participant list | Granola, anarlog | here |
| TRN-23 | Capture the meeting's text chat | anarlog | parked |
| TRN-24 | Warn when the mic hears the call (use headphones) | meeting-transcriber | here |

## Notepad and marks

| ID | Feature | Seen in | Owner |
|---|---|---|---|
| NOT-01 | Mark this moment (button and key), no typing | Otter, tl;dv, Fathom, Descript, MacWhisper | W3.2, with CLI-34 |
| NOT-02 | Note edits save on blur; delete has undo | Audit | W6.2, with W6.3 |
| NOT-03 | Named, coloured mark types | Fathom | parked |
| NOT-04 | Bold, italic and checkbox shortcuts | Granola | W6.4 |
| NOT-05 | Paste an image into the notes | Granola | W6.5 |
| NOT-06 | `/` in the notepad picks the template | Granola | parked |
| NOT-07 | @name in a note goes out in the hook JSON | Fathom, tl;dv | parked |
| NOT-08 | Agent-authored notes styled apart | Intent | has |

## Live ask

| ID | Feature | Seen in | Owner |
|---|---|---|---|
| ASK-01 | Transcript is data, never instructions | Minutes | PG-Z1, with TS-26 |
| ASK-02 | Stop a running question; copy an answer; past questions redrawn from the log | Audit | W6.7, with W6.8 and W6.9 |
| ASK-03 | User presets as Markdown files, shared by window, CLI, MCP prompts and harness slash commands | Granola, Fireflies, Open Granola, Screenpipe | PG-F2, with PG-M7 and PG-K5 |
| ASK-04 | "Last N minutes" and "What should I ask next?" presets | Fireflies, Granola | W6.10, with W6.13 |
| ASK-05 | Proactive alert when your name or a watched word is said | Zoom, Teams | W6.11, with PG-S4 |
| ASK-06 | Live memo pane always visible | Otter, Fathom | W6.14 |
| ASK-07 | Goal-directed live nudges | Minutes, Amurex, Open Granola | parked |
| ASK-08 | Per-question model choice | Granola | parked |
| ASK-09 | Dictate a question | Granola, Otter | W6.15 |
| ASK-10 | Citations you can click; excerpts when no model answers; late-join catch up | Granola, Notion, Amurex | has |
| ASK-11 | Show the model and token count behind each answer | VoiceInk | here |
| ASK-12 | Harness CLI as the provider | VoiceInk | has |

## Notes after the call

| ID | Feature | Seen in | Owner |
|---|---|---|---|
| PST-01 | Copy and export buttons on Enhanced | Granola, Fathom | W6.17 |
| PST-02 | Edit the enhanced notes in the window | Audit | W6.18 |
| PST-03 | Rewrite by instruction, on the whole note or a selection | Granola | W6.19 |
| PST-04 | Agent rewrites staged as proposals with a diff | anarlog | W6.20 |
| PST-05 | Summary output language per workspace | Granola, anarlog, Meetily | W6.21 |
| PST-06 | Follow-up email draft as a template | Granola, tl;dv, Fathom, Amurex | W12.8 |
| PST-07 | Auto-title proposal for untitled calls | heed | W13.4 |
| PST-08 | Save a one-off tweak back to the template | Fathom | parked |
| PST-09 | Detail level and section toggles | Google Meet, anarlog | parked |
| PST-10 | About-me profile for notes and ask | Granola | parked |
| PST-11 | Copy action items for a task tool | Fathom | parked |
| PST-12 | Talk time and monologue stats for this call | tl;dv, Fathom, Minutes | W8.6 |
| PST-13 | Source lookup on every AI bullet; template switch and regenerate | Granola | has |

## Export and import

| ID | Feature | Seen in | Owner |
|---|---|---|---|
| EXP-01 | SRT and VTT export | hark, Buzz, MacWhisper, Descript, Scriberr | decision (2) |
| EXP-02 | DOCX, PDF and HTML export | MacWhisper, Descript, anarlog | parked |
| EXP-03 | Export layout options | Descript, MacWhisper | parked |
| EXP-04 | Export file name template | Buzz | parked |
| EXP-05 | Consent basis in the export frontmatter | Minutes | here |
| EXP-06 | Import an audio file as a call | hark, anarlog, Minutes, MacWhisper, VoiceInk | decision (2) |
| EXP-07 | Watch folder | Minutes, MacWhisper, Scriberr, Buzz | decision (2) |
| EXP-08 | Import from Granola and other tools | Minutes, Open Granola | parked |
| EXP-09 | Dictation to the clipboard | hark, Minutes, anarlog | decision (2) |

## Settings, models and onboarding

| ID | Feature | Seen in | Owner |
|---|---|---|---|
| SET-01 | Pickers for choice settings, defaults shown | VS Code, audit | DK-S1, with DK-S4, PG-A3 and CLI-35 |
| SET-02 | Settings text is true | Audit | CLI-17 |
| SET-03 | Settings take effect or say when | Audit | DK-S1, with DK-K3 and DK-L2 |
| SET-04 | Grouped, searchable settings with modified markers and reset | VS Code | DK-S4 |
| SET-05 | Speech engines section: installed, size, languages, speed; which run live and final; fusion on or off; per workspace | Intent, MacWhisper, Buzz, VoiceInk | DK-S3 |
| SET-06 | Model library: list, select, pull, remove, one-run override | MacWhisper | DK-E2, with DK-E3 |
| SET-07 | Prewarm models on wake | VoiceInk | here |
| SET-08 | Per-engine speed and cost view | VoiceInk | DK-E4 |
| SET-09 | First run: permission screens, a 3 s capture test per channel, model download with cancel, free-space check and time left | Apple guidelines, Granola, designed | DK-O2, with DK-O1, DK-O3 and DK-E2 |
| SET-10 | Demo call from bundled audio | Minutes, Granola | W10.5 |
| SET-11 | Vocabulary import preview and dry run | VoiceInk, Wispr Flow | here |
| SET-12 | Learn vocabulary from the user's own corrections, with approval | VoiceInk, Descript, Wispr Flow | W9.3 |
| SET-13 | English and Spanish UI, locale dates and times | Intent | W16.1, with W16.2 |
| SET-14 | Local model recommended from hardware when no harness exists | heed, Minutes | parked |

## Accessibility

| ID | Feature | Seen in | Owner |
|---|---|---|---|
| A11Y-01 | WCAG AA contrast for faint text and the dark accent button | Audit | W15.2 |
| A11Y-02 | Reduce Motion | Apple guidelines | W15.3 |
| A11Y-03 | State not by colour alone | Audit | W2.2 |
| A11Y-04 | Screen reader: live announcements setting, answer read once, correct ARIA on the speaker popover | Audit | W15.4, with W8.2 |

## CLI

The CLI rows keep the ids [CLI.md](CLI.md) uses. CLI.md also owns CLI-16 onward, which have no competitor evidence to index here. `events` and `wait` are designed in PROGRAMMABILITY, so their rows point there.

| ID | Feature | Seen in | Owner |
|---|---|---|---|
| CLI-01 | `akou events -f` as filtered NDJSON | Stripe CLI, Recall.ai | PG-S3 |
| CLI-02 | `akou wait --for final.done` with exit status | gh | PG-S5 |
| CLI-03 | One way to name a call; the same exit code for the same situation | Audit | CLI-03, with CLI-16 |
| CLI-04 | Human output by default, JSON with `--json` | Audit | CLI-04 |
| CLI-05 | Help lists every flag; `help CMD` works; `-v` prints the version | Audit | CLI-05 |
| CLI-06 | Secrets read from stdin, never argv | clig.dev | CLI-06, with PG-Z2 and DK-S5 |
| CLI-07 | `akou devices` and `akou apps` built | Audit | CLI-07 |
| CLI-08 | Shell completions with call ids, workspaces, templates, speakers | gh, Superwhisper | CLI-08 |
| CLI-09 | "Did you mean" on unknown commands, flags and settings | clig.dev | CLI-09 |
| CLI-10 | `config get KEY` | Audit | CLI-10 |
| CLI-11 | `akou api METHOD PATH` with the token added | gh api | CLI-11 |
| CLI-12 | `--jq` built in | gh | parked (CLI.md) |
| CLI-13 | `finalize` shows progress | MacWhisper | CLI-13 |
| CLI-14 | Capabilities document and a versioned JSON envelope | Minutes, anarlog | parked (CLI.md) |
| CLI-15 | `tail -f`, `--json` everywhere, typed exit codes, streamed ask | Minutes, MacWhisper | has: CLI-15 |

## Agent tools: MCP, skill and harness packaging

| ID | Feature | Seen in | Owner |
|---|---|---|---|
| AGT-01 | One command registers `akou mcp` with Claude Code and Codex | Screenpipe, Minutes, Superwhisper | PG-M1 |
| AGT-02 | Codex skill installed where current Codex reads it | Codex docs | PG-K1 |
| AGT-03 | MCP tool annotations and titles | MCP spec | PG-M2 |
| AGT-04 | Structured content with output schemas | MCP spec | PG-M3 |
| AGT-05 | Claude Code plugin: skills, MCP config, hooks and a monitor in one install | Minutes, Claude Code plugins | PG-K2 |
| AGT-06 | Plugin monitor streams filtered live events into the agent session | Claude Code monitors | PG-K3 |
| AGT-07 | Session-start hook says a call is live | Minutes | PG-K4 |
| AGT-08 | Skill posture: on demand, silent watch, decision tracker; no shell polling loops | Minutes | PG-K6 |
| AGT-09 | MCP resources for the live call and prompts for presets | Minutes, MCP spec | PG-M8, with PG-M7 |
| AGT-10 | MCP parity with the window and CLI; settings are read only over MCP | Audit | PG-M4, with TS-13 |
| AGT-11 | Progress during long enhance | MCP spec | PG-M6 |
| AGT-12 | Bounded output on past calls, at most 8,000 tokens per answer | Claude Code limits | PG-M5 |
| AGT-13 | MCP Apps inline view | Minutes | parked |
| AGT-14 | Streamable HTTP MCP transport | Minutes | parked |
| AGT-15 | Harness slash commands for in-call actions | Minutes, Granola | PG-K5 |
| AGT-16 | More harness hosts (OpenCode, Cursor agent) | Minutes | parked |
| AGT-17 | Live call access over MCP, bounded context budget, cursors | Granola (post-call only) | has |

## Hand-off and sharing

| ID | Feature | Seen in | Owner |
|---|---|---|---|
| HND-01 | Test and redeliver the hand-off | anarlog, Stripe CLI, MacWhisper | PG-H2 (the webhook test and redeliver are merged into it) |
| HND-02 | Timestamp on the webhook for replay protection | anarlog | PG-W4 |
| HND-03 | Calls changed since a time | Granola API | PG-A6 |
| HND-04 | No-code recipes (n8n, Zapier, Obsidian, Notion) | Granola, anarlog | PG-X6, with PG-X2 |
| HND-05 | Redact names in share and export | MacWhisper | decision (3) |
| HND-06 | Post-call link to finished notes | Granola, Fathom | parked |
| HND-07 | Export folder, hooks, signed webhook with retries, live share link with viewer pill | Fireflies, Granola | has: PG-H1, with PG-W1 and W12.6 |

## Rows this file owns

No surface doc designs these yet. Most transcript rows wait for the engine design ([PRINCIPLES.md](PRINCIPLES.md#where-other-docs-still-lag-this-file)); when it lands, they move there.

| ID | Today | Target | P | Acceptance |
|---|---|---|---|---|
| WIN-22 | missing | `akou open -w WS` and `POST /window {workspace}` put that workspace first in the record picker, including a workspace with no calls yet. hark-viewer's `?quiet=` is dropped on purpose: it set how long the page waited before guessing the capture had died, and akou's helper reports a dead call side itself | P2 | Test: `POST /window {workspace: "w"}` on an empty home opens with `w` selected; the next Record files the call under `w` |
| SYS-12 | missing | A health banner naming the closed lid as the cause | P2 | Test with a fake lid signal: the banner text names the closed lid |
| REC-02 | missing | Warn at a free-space threshold. Below a floor, count down on the floating indicator and stop cleanly with a visible reason. DESIGN §4.3 gains the reason | P1 | Test with a fake free-space reading: a warning, then `part.ended {reason: low-disk}` and a banner |
| REC-03 | partial | Opt-in rules for long silence and max duration. A 30 s countdown with Keep recording on the floating indicator ([DESKTOP.md](DESKTOP.md) §7); Keep recording restarts the rule, so there is no separate `extend` command | P2 | Test: with a rule on, the countdown appears and Keep recording keeps it going; with every rule off, nothing stops |
| REC-05 | missing | Within a short window after start, Discard removes the folder before any hand-off | P2 | Test: discard within the window leaves no folder and no export; after the window the action is gone |
| REC-09 | missing | A call created with notes and no capture. Notes, enhance and export accept it. Record later adds a part to the same call | P2 | Test: a notes-only call exports notes and enhanced notes with no audio file; Record on it adds a part to the same folder |
| REC-19 | partial | A skill step reads the calendar through the harness and calls `akou start -t --vocab` | P2 | Skill test: a fake calendar event produces a start with its title and attendee vocabulary |
| REC-20 | missing | A mark event "away" and "back"; Catch me up uses it | P2 | Test: Catch me up after a back mark covers only the span since away |
| REC-21 | partial | The window's start form takes words for this call, as `--vocab` does in the CLI, API and MCP | P2 | UI test: words typed in the start form reach `POST /calls` as `vocab` |
| TRN-02 | partial | A streaming recognizer is a value of `asr.live.engine`, downloaded by akou when chosen. Words confirm when passes agree, so live text stops flickering | P1 | The Spanish floor from real calls is recorded in `docs/gates/`; the replay flicker rate on the evaluation set stays under the committed rate (TS-17, TS-17b) |
| TRN-03 | missing | Word start and end per segment; needed for fusion, click-to-seek and subtitles | P1 | Test: every final segment's words have monotonic times inside the segment (TS-16b) |
| TRN-06 | partial | Replaces pyannote plus ERes2Net in the final pass (PR #15) | P1 | Evaluation: diarization error on the real-call set at or under the target, recorded in `docs/gates/` (TS-20) |
| TRN-14 | partial | A language-id step reports the dominant language and each other-language line | P1 | Test on a mixed fixture: the dominant language and each other-language line's time are reported (TS-18) |
| TRN-15 | missing | Uses language id | P2 | Test on an unsupported-language fixture: one banner, no repeats |
| TRN-16 | partial | `akou finalize --engine`; the new layer sits beside the old | P1 | Test: re-finalizing with another engine writes a new final layer; the old one is still readable |
| TRN-17 | missing | A batch command, then re-export | P2 | Test: the batch run re-finalizes the selected calls and fires the export hook for each |
| TRN-21 | missing | A streaming diarizer as the live-label engine, only if it beats live clustering | P2 | Evaluation on the real-call set: live diarization error under the clustering baseline. If it is not, the row closes with the measurement and clustering stays |
| TRN-22 | missing | Opt-in, macOS Accessibility first. The meeting app's participant names become suggestions for this call only | P2 | Test with a fake roster: the names are suggested in that call and in no other; with the setting off, nothing reads the roster |
| TRN-24 | partial | A `health {state: echo}` verdict and a banner suggesting headphones | P2 | Test on a fixture where the mic carries the call channel for N s: one verdict and one banner |
| ASK-11 | partial | Each completed answer shows the provider, model and token count. Today only the no-provider path shows the pack | P2 | UI test: a completed answer shows the provider, model and token count from its `answer` event |
| EXP-05 | partial | Recorded as an event | P2 | Test: `--consent` lands in the frontmatter |
| SET-07 | partial | Reload the recognizer on wake | P2 | Test: a fake wake event reloads the recognizer before the next start |
| SET-11 | partial | Preview and dry run | P2 | Test: `akou vocab import --dry-run` changes nothing and prints adds and skips |

## Non-goals and their hand-off

Competitors lead with these. akou does not build them; the hand-off and the user's harness cover them.

| Competitor feature | Seen in | What akou does instead |
|---|---|---|
| Chat across all meetings | Granola, Fathom, tl;dv | Export plus `akou_list_calls` and `akou_get_call`; the harness searches the user's own system |
| People and company directories | Granola | Attendee names stay per call |
| Voiceprints across calls | heed, meeting-transcriber, Minutes | Speakers are named per call |
| Pre-meeting briefs | Granola, Jamie | A harness skill over the user's own notes; the vocab skill already reads invites |
| Scheduled reports and keyword trackers | tl;dv | Hooks into the user's own tools |
| Folders, recurring auto-add, related meetings | Granola | Workspaces and template matching by title |
| Sending email, chat or calendar invites | Granola | Drafts only; the harness sends with its own tools |
| Posting a recording notice into the meeting chat | Fathom, tl;dv | The consent reminder (DK-F3) gives a notice to copy; akou never posts |
| Consent emails before the meeting | Fathom, tl;dv | A harness step, not akou |
| Meeting bot | Otter, Fireflies | Never; akou hears the machine |
| Phone and watch capture | Granola, Bluedot, Jamie | decision (6); the share link lets a phone watch a live call |

The ranked P0 list is in [PRINCIPLES.md](PRINCIPLES.md#the-p0-list).
