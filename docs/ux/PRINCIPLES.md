# UX principles and intent

This is what akou is for and how it should behave, written as the rules every screen, command, tool and message follows. When a design choice is unclear, or two docs disagree, this file decides. The competitor evidence behind each item, and which doc owns it, is in [COMPETITOR-MATRIX.md](COMPETITOR-MATRIX.md). The surface designs are [WINDOW.md](WINDOW.md), [DESKTOP.md](DESKTOP.md), [CLI.md](CLI.md) and [PROGRAMMABILITY.md](PROGRAMMABILITY.md). How we prove each rule holds is in [TESTING.md](../TESTING.md) and [CI-CD.md](../CI-CD.md). The architecture behind it is [DESIGN.md](../DESIGN.md).

## The one loop

akou exists so that you, or an agent working for you, can follow a call while it happens and get a correct answer from it mid-call. Everything else serves that loop: capture that never stops on its own, a live transcript that is rough but immediate, a final transcript that is the best we can produce, and notes that land in the system you already use.

A feature that does not make that loop faster, more reliable or more trustworthy waits.

## Principles

Each principle has a check. If we cannot write the check, the principle is too vague to keep. Other docs cite these by number, so the numbers do not change.

1. **Recording never stops silently.** A capture that dies, a device that changes, headphones that reconnect, a machine that sleeps: akou keeps recording or says loudly that it stopped and why. Recovery is quiet and raises no false alarm in a quiet room. *Check:* every stop path writes a `part.ended` with a reason, and the window, the tray and `akou status` show it within 2 s. The trap tests in [TRAPS.md](../TRAPS.md) cover each known path.

2. **Two passes by design.** The live text may be rough, but it has to be fast and it has to be there. The final transcript, written after stop, is the best available, with no regard for RAM or run time. The two never pretend to be each other: live speaker labels look provisional until the final pass replaces them. *Check:* the UI marks every provisional line and label, and the final pass runs after every ending without anyone asking for it.

3. **Every action through every door.** The window, the CLI, the HTTP API, MCP and the skill reach the same actions with the same names. Recording starts from a hotkey, the tray, the window, `akou start`, `akou_start` or the skill, and every one of those can stop it. A feature that exists in only one door is a bug unless its owning doc says why. *Check:* one parity table, `tests/contracts/parity.ts` (TS-13 in [TESTING.md](../TESTING.md)), and one test over it that fails when a door is missing an action. The generated CLI reference prints the same table.

4. **Agentic first, UI equal.** The agent is a first-class user. It starts the call with a workspace and title, follows it through cursors and pushed events, names speakers, writes notes marked as its own, and answers from a small context. It never reads call folders from disk. The window is the same product for a person, not a debug view. *Check:* the skill's first tool call is `akou start`, and every skill step maps to one tool.

5. **Every choice is a setting, and the ambitious path works natively.** The default runs everywhere with no setup. The most ambitious option (several speech engines fused per word, the heaviest diarizer, the slowest and best final pass) is one setting away. akou downloads and verifies whatever that setting needs when you choose it. You never install anything by hand. One engine is the default, not the ceiling. *Check:* every setting comes from one registry that also generates `config show`, the CLI help and the reference table, and CI fails when they drift. A nightly job fails when fewer than five engines load on an OS (TS-16c).

6. **The brain is your own harness.** By default akou asks Claude Code or Codex, run locally on the subscription you already pay for. A local model or an API key work the same way. There is no akou cloud and no key is required. *Check:* a fresh install with a harness on PATH answers a question with no key configured.

7. **Integration, not a knowledge base.** akou knows the current call, or one past call you name. It hands every finished call to your own system in open formats: Markdown with frontmatter, the event log, the audio, hooks, a signed webhook, and pull over API and MCP. It never grows a library, cross-call search, people pages or weekly rollups. That is the line we hold against Granola and Minutes. *Check:* no route, tool or screen reads or searches across calls.

8. **The log is the truth.** Nothing about a call lives only in an agent's chat or only in the window. Raw heard text is never overwritten. Corrections, names and edits are new events. *Check:* deleting every cache and replaying the log reproduces the same transcript, names and notes.

9. **Wall-clock time everywhere.** Times shown to people and models are times of day in the user's time zone, never a bare offset. *Check:* no rendered transcript, citation or answer contains an `mm:ss` offset.

10. **Private by default, visible when not.** Nothing leaves the machine unless you switch it on: a remote provider, a webhook, a share link, the update check. There is no telemetry, ever. A pill shows while a remote provider or a share link is on. Notifications never carry call content. The window hides itself from screen sharing where the OS allows it and a recorded check shows it works. An agent-started recording is announced on the machine. *Check:* a notification snapshot test finds no call content, starting a call from the CLI produces a visible tray change, and a fresh install makes no network request until a feature that needs one is switched on.

11. **Keyboard first during a call.** During a call your hands are on the keyboard and your eyes are on the meeting app. Record, stop, mute, mark a moment, focus the notes and focus the ask box each have a shortcut, and the shortcut sheet lists them. *Check:* a UI test drives each action with keys only.

12. **Glanceable state.** One look at the tray icon, the floating indicator or the header tells you whether akou is recording, paused, degraded, sharing, or still running the final pass. State is never shown by colour alone. *Check:* each state has a distinct icon and text label, tested per state.

13. **Honest text.** Every message names a command, flag, setting or pane that exists, in the door the user is in. The window never tells you to run a CLI command to do something the window could do. *Check:* a test scans user-facing strings for command and flag names and resolves each against the CLI registry.

14. **Accessible.** Text meets WCAG AA contrast in both themes, motion respects Reduce Motion, and controls work with a screen reader and without a mouse. *Check:* an automated contrast and axe pass in the UI suite, in dark and light. axe-core comes in as a dev dependency; it never ships in the app.

15. **Simple systems.** Prefer what already exists: presets and templates are Markdown files, marks are notepad events, automation is a hook. We add machinery only when a check shows the simple thing fails. No feature ships for show.

16. **Claims from real recordings.** Accuracy, language and latency claims come from real audio, never synthetic audio alone. We adopt a new model only when it is measurably better.

## What akou must do

### Recording and capture

- Record from an agent (skill, CLI, MCP) and from the window, tray or hotkey, with the same result.
- Record the whole computer by default, so a call never drops because akou lost track of an app. Per-app capture is an option.
- Keep the mic and the call on separate channels end to end.
- Survive route and device changes (headphones, Bluetooth, docks) without stopping.
- Keep one call in one folder across restarts.
- Run re-diarization and the final pass automatically after every stop, in the app, not in a skill that might forget.
- Carry every hark and hark-viewer feature, or replace it on purpose with a written reason ([REQUIREMENTS.md](../REQUIREMENTS.md)).

### Live query during the call

- Turn any question into a small, correct context in under 50 ms, whether the user asks in the window or an agent asks through the harness.
- Push live events to agents instead of making them poll.
- Let the agent write notes and memory back, marked as the agent's.
- Treat everything said on the call as data, never as instructions to the agent.

### Transcript quality

- The best transcript money and RAM can buy, after the call.
- Any number of speech engines, with at least five working, and a model deciding per word which engine's output to keep. akou downloads and verifies each engine when it is chosen.
- True live streaming as a choice of live engine, with the Spanish floor measured on real calls.
- Nemotron-class diarization in the final pass, and in the live pass too if it measures better than live clustering there.
- A language-id step that drives which model runs per call. Most calls are English, some Spanish. The app detects the language rather than asking.
- Test new models when they appear and adopt them only on evidence.

### Vocabulary

- Custom words per user and per workspace, private, never in the repository.
- A skill that proposes words from calls, documents and the web. Nothing enters the vocabulary without the user's yes.

### Sharing

- Optional and off by default. A read-only live link on the local network or tailnet is the first version. A hub waits for real demand.

### Experience

- Best-in-class window, tray, CLI and agent tools, with every nicety from competing tools that is not a knowledge-base feature.
- Full programmability: CLI, HTTP, MCP and skills, each reference generated from the code.
- Every UX item designed in these docs, with one id, one owner and a testable acceptance criterion, and tracked as a bead from P0 to P2.

### Testing and CI

- Every trap is a test named after its id, with a positive control that proves it can fail.
- A gate that cannot fail is not a gate. Every job fails when fewer tests ran than its minimum.
- CI runs on GitHub-hosted runners on all three OSes, with branch protection and required checks.
- Model-gated tests run for real nightly and are skipped on PRs, never silently passed.
- Details: [TESTING.md](../TESTING.md) and [CI-CD.md](../CI-CD.md).

## Non-goals

- No built-in knowledge base: no library, no cross-call search, no people or company pages, no pre-meeting briefs built from past calls, no voiceprints kept across calls. The harness does these over the user's own system.
- No akou cloud and no required API key.
- No meeting bot. akou hears what the computer hears.
- No auto-recording by default. A per-app opt-in is a setting, off until chosen, and the prompt itself is open decision 1. Auto-stop rules are also opt-in, and each one counts down with a Cancel button, so none of them stops a recording silently (principle 1).
- No sending on the user's behalf, and that includes a recording notice posted into the meeting chat. akou drafts. Email, chat and trackers belong to the user's tools and harness.
- No Intel Mac.
- Downstream archive pipelines are the user's, fed by the hand-off.

## The moat

Other tools keep your meetings in their cloud and sell search over them. akou records locally, thinks with the agent you already pay for, answers during the call as well as after it, and hands everything to the system you already keep. A question late in a three-hour call costs about the same as one in a ten-minute call. Competitors give agents access once the meeting ends. akou gives it while the meeting runs.

## Quality bars

| Bar | Target |
|---|---|
| Committed live line | Within 1.5 s of the end of the utterance |
| Recognizer speed | Real-time factor under 0.25 on Apple silicon, under 0.5 on a 4-core x64 laptop, for the default live and final engines only |
| Context pack | p95 under 50 ms on a 3-hour call; evidence cards under 300 ms |
| Start | 201 within 1 s warm, 3 s cold |
| Nothing spoken lost | The final pass covers the whole timeline, with padding and no VAD gating |
| Quiet room | Never triggers a false rebuild or a false alarm |
| Speaker labels | The final pass does not confuse participants on the evaluation set |
| Opt-in engines | Memory and speed are never a veto for an engine the user chose. We record their real-time factor and peak memory (DK-E4) and gate on neither |

## Priorities

One scale for every doc:

- **P0:** a control that silently does nothing, lost user data, a privacy or security hole, a broken agent path, or a gate that cannot fail. Only the ranked list below is P0.
- **P1:** required by the intent, or expected of a best-in-class recorder. The next milestone.
- **P2:** a real nicety, after P1.
- **P3:** only on demand. Parked, no bead.
- **decision:** waits on an [open decision](#open-decisions). Parked, no bead.

### The P0 list

Ranked. Fifteen items at most. Any item a surface doc still marks P0 that is missing here is P1.

| # | ID | Doc | Why it cannot wait |
|---|---|---|---|
| 1 | PG-Z1 | [PROGRAMMABILITY.md](PROGRAMMABILITY.md) | Live speech reaches a coding agent that has tools. Call text has to arrive marked as quoted data |
| 2 | DK-N1, with DK-N2 and DK-N4 | [DESKTOP.md](DESKTOP.md) | With the window closed, an agent can start a recording, or capture can die, and nothing on screen says so |
| 3 | CLI-17 | [CLI.md](CLI.md) | `akou status` says `akou start` launches the app, which starts a recording, and other messages name commands that do not exist |
| 4 | PG-M1 | [PROGRAMMABILITY.md](PROGRAMMABILITY.md) | The skill drives `akou_*` tools that nothing registers |
| 5 | PG-K1 | [PROGRAMMABILITY.md](PROGRAMMABILITY.md) | akou writes the Codex skill to `~/.codex/skills`, and Codex's docs name `~/.agents/skills` |
| 6 | W6.2 | [WINDOW.md](WINDOW.md) | Clicking away from a note drops the edit |
| 7 | TS-1 | [TESTING.md](../TESTING.md) | Known flakes keep `main` red, so no check can be required yet |
| 8 | CI-2, then CI-1 | [CI-CD.md](../CI-CD.md) | Nothing protects `main`. One workflow with one aggregate `ci-ok` check, then a ruleset that requires it |
| 9 | TS-2 | [TESTING.md](../TESTING.md) | A job that runs fewer tests than it should still passes |
| 10 | W1.1 | [WINDOW.md](WINDOW.md) | The Notes, Ask and Enhanced tabs show every pane at once |
| 11 | W5.2 | [WINDOW.md](WINDOW.md) | Playback cannot be paused |
| 12 | DK-T5 | [DESKTOP.md](DESKTOP.md) | A tray or hotkey Record that fails writes only a log line |
| 13 | DK-T1 | [DESKTOP.md](DESKTOP.md) | The idle tray item has no icon and may be invisible |
| 14 | DK-M1 | [DESKTOP.md](DESKTOP.md) | Without the Edit roles, copy and paste may not work in the notepad on macOS |
| 15 | W12.2 | [WINDOW.md](WINDOW.md) | "Copy transcript so far", a carried hark requirement, has no button |

These surface-doc P0s are P1 on purpose, so nobody reads them as forgotten:

- DK-K1 (the macOS hotkey that never fires) waits on one check, which process holds the Accessibility grant. It comes first in P1.
- DK-K3 and DK-L2 apply a changed hotkey or login item at the next start instead of at once. That is late, not never.
- DK-S1 and DK-S2 are settings plumbing that other work waits on, and waiting on something does not make it urgent. DK-S2 also waits for the engine design.
- DK-M3 (confirm Quit) guards a deliberate action, and the log keeps everything recorded up to the quit.
- W2.5 (Record without models) works today through `--without-models`. The message names that flag in the wrong door, which is untidy but not broken.
- CLI-16 (one exit code for "no call") changes which failure code a script sees, not whether it sees one.
- PG-U1 (dead `akou://` links) costs a click, not data or trust.
- DK-P3 (hide from capture) depends on a native spike, and a P0 cannot.

## Rulings on conflicts between the surface docs

Where two docs described the same thing two ways, this is the answer. The owning doc changes to match.

| Topic | Ruling | Owner |
|---|---|---|
| Update check | Off by default. Onboarding and Settings offer it as one switch. It uses ElectroBun's `Updater.checkForUpdate()` against the release feed; nothing polls the GitHub API | DK-U1 |
| Floating indicator | One design. It shows state, time, levels, Mute and Stop, and carries no transcript text, so it can stay up during a screen share. Asking goes through the palette (`Mod+K`, "Ask: …", W14.5). Keys are `app.floatingIndicator` and `app.hideFromCapture` | DK-F1, DK-P3 |
| Speaker-name suggestions | From this call's `--vocab` names, names typed in this call, and the user's vocabulary file. Never from other calls' logs (principle 7) | W8.3 |
| Settings over MCP | Read only, through `akou_config_get` with `readOnlyHint`. Writes stay with the CLI, the API and the window, so an agent cannot quietly change the provider or the share bind | PG-M4 |
| Settings registry | DESKTOP owns the group list and the `applies` values (`now`, `next-call`, `next-final`, `restart`). The live-label key is `asr.liveLabels`. WINDOW §11 points at it | DK-S1 |
| First run | One onboarding flow. The engine download starts at the first step | DK-O2 |
| Accessibility scan | axe-core, as a dev dependency | W15.5, TS-15b |
| Tool output budget | 8,000 tokens per MCP answer | PG-M5 |
| Transcript as data | The acceptance is deterministic: the delimited block and the tool-less argv. No test depends on how a real model behaves | PG-Z1, TS-26 |
| Door parity | One table, one test, one generated page. PG-A1, PG-M4 and CLI-31 point at it | TS-13 |
| Window error text | When the page loses the app, it names `akou open`, never `akou start` | W17 table |
| Fusion in CI | The nightly fusion gate runs a deterministic or local-model fuser. The harness never runs in CI | TS-16d |

## Where other docs still lag this file

Each row is one bead labelled `docs-lag`, closed by the PR that fixes the doc.

| Doc | What lags | Fix |
|---|---|---|
| (missing) engine design | No doc names the five engines per OS, the registry schema, word timings on `seg`, the fusion stage or the runtime decision (open decision 7). DK-S2, DK-S3 and TS-16 all cite it | A new engine design, in `docs/ENGINES.md` or DESIGN §3, before any of those beads starts |
| [DESIGN.md](../DESIGN.md) §3, [REQUIREMENTS.md](../REQUIREMENTS.md) | One engine | The single engine becomes the default of an engine registry with a fusion stage |
| [asr-benchmark.md](../research/asr-benchmark.md) | Rejects Qwen partly on memory | A closing paragraph: Parakeet fp32 is the default; Qwen3-ASR 1.7B is an opt-in final engine wherever its runtime exists |
| [ROADMAP.md](../ROADMAP.md), REQUIREMENTS F1.20 | Streaming deferred to "on demand" | A live-engine choice, measured against the Spanish floor (TRN-02 in the matrix) |
| REQUIREMENTS F1.6 | Language id listed as open | Required, because the per-call model switch depends on it |
| DESIGN §3.2, §3.3 | pyannote plus ERes2Net | Nemotron-class diarization for the final pass once PR #15 lands |
| DESIGN §7 | Live labels shown as `c<N>` | Live clustering is a setting (`asr.liveLabels`), and the UI shows live labels as provisional |
| [providers.md](../providers.md), release checklist | Harness terms check still open | A non-prerelease release fails while providers.md has no dated verdict. If the terms rule the harness out, the default provider becomes `none` and the harness stays opt-in |
| ROADMAP M0 | "Nothing else starts until every gate has a result" | Gates block the stable release, not development. A non-prerelease release fails without a recorded pass for every M0 gate in `docs/gates/`; G3 and G4 stay blockers |
| DESIGN §9, ROADMAP M1 | Signing and notarization in M1 | Builds are unsigned for now; signing moves to a later milestone |
| ROADMAP | No UX milestone; shipped work not marked | Add an M-UX milestone whose exit criteria are the P0 and P1 ids, and a "status on main" line per milestone (the share link, templates, memo, vocab pass and webhook are built) |
| REQUIREMENTS F1.42, F0.19, F0.26, F2.49, F2.54, F4.7 to F4.11, F4.17, I1.6 | Marked carried in M1, not built (copy transcript, `devices`, `doctor --grant`, `akou://`, cask, signing, legal doc, demo, the env var list) | Status "designed", naming the owning id |
| DESIGN §6.1 | "Install command-line tool" menu, `doctor` capture test, `devices` and `apps` | Marked planned, pointing at DK-M6, DK-O1, CLI-07; later a pointer to the generated `docs/cli.md` |
| DESIGN §7 "New:" paragraph | Lists inline edit, capture test and several settings as built | Split into built and designed |
| DESIGN §7 | Says the window never polls; the models card polls `GET /models` every second | Say so, or move download progress onto the status push (DK-O3) |
| DESIGN §8.3 | A changed tray icon while shared | Points at DK-P1 |
| DESIGN §1.2, §10, ROADMAP M0 | `scripts/soak.ts`, which does not exist | Points at TS-24 |
| DESIGN §9, §10 | Three CI descriptions and a list of docs that do not exist | §9 points at [CI-CD.md](../CI-CD.md), §10 at [INDEX.md](../INDEX.md); either write the privacy-and-consent doc the consent reminder cites or drop the claim |
| DESIGN §1.5 | Hotkey default | Matches DK-K4 |
| DESIGN §4.3 | No low-disk stop | `part.ended {reason: low-disk}` (REC-02 in the matrix) |
| DESIGN §5.2 vs providers.md | Re-enhance after the final layer is automatic in one and never automatic with the harness in the other | DESIGN 5.2 adds "except with the harness provider" |
| [TRAPS.md](../TRAPS.md) "The boost is a slider" | Names `akou vocab check --boost`, which does not exist | Rewritten against the per-entry `boost`; CLI-17's scan covers TRAPS.md |
| [install.md](../install.md) | No MCP registration step | The manual `claude mcp add` and `codex mcp add` lines until PG-M1 lands |

## Open decisions

Each needs a yes or no before any bead is built on it. Until then the matrix marks it `decision`. The numbers are stable because other docs cite them.

1. A "Record this call?" prompt from OS signals, off by default, versus starting only from the skill, CLI and UI.
2. The predecessor features REQUIREMENTS drops: transcribing arbitrary audio files, SRT and VTT output, dictation to the clipboard, and the engine comparison lane (which the multi-engine work may bring back in another form).
3. Redaction of a span, and how it coexists with an append-only log.
4. Screen or slide capture, which brings back the Screen Recording grant we removed.
5. A sharing hub beyond the local link.
6. Phone or in-person capture.
7. What counts as native for an engine runtime. Either a bundled per-OS runtime is allowed (for example MLX for Qwen3-ASR 1.7B on Apple silicon), or only engines that run through sherpa-onnx count. The five-engine floor depends on the answer.
8. Fusion with the harness as provider. Fusion is meant to run after every call with nobody asking, but providers.md never runs the harness unattended. Either fusion on the harness waits for the terms check, with a local model or a deterministic vote until then, or it is one click after the call.

## How a UX item becomes work

- **One id, one owner.** Every item has one id, defined in one doc: WINDOW (`W`), DESKTOP (`DK`), CLI (`CLI`), PROGRAMMABILITY (`PG`), TESTING (`TS`) or CI-CD (`CI`). That doc holds the item's priority, acceptance and today's status. Another doc that needs the item cites the id and does not restate its priority.
- **The matrix is the evidence index.** A [COMPETITOR-MATRIX.md](COMPETITOR-MATRIX.md) row records which tools have the feature and names the owning id. The matrix owns a row itself only while no surface doc designs it; when a surface doc takes the row, its priority and acceptance move there.
- **Beads from the owning row.** A bead copies the owning id into its title and the acceptance into its acceptance field. It closes only when the acceptance has a recorded result, the same rule [ROADMAP.md](../ROADMAP.md) uses for milestones. P0 to P2 get beads. P3 and `decision` rows are parked and get none until promoted.
- **A lint keeps it honest.** A docs test fails when a matrix owner id does not resolve to a row in the named doc, or when two docs define the same id. The positive control is a matrix row pointing at a made-up id.
