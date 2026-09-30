# The window

This document designs akou's main window: what is on screen, in which state, what every control does, which keys drive it, and what we build next. It extends [DESIGN section 7](../DESIGN.md#7-the-window), which stays the source for the parts already built. The other documents in [this folder](./) own the rest: [DESKTOP.md](DESKTOP.md) the tray, menus, notifications, floating indicator, first run and settings plumbing; [CLI.md](CLI.md) the command line; [PROGRAMMABILITY.md](PROGRAMMABILITY.md) the API, MCP, skills and `akou://`. The rules behind every choice are in [PRINCIPLES.md](PRINCIPLES.md). How each line is tested is in [TESTING.md](../TESTING.md), and how those tests run is in [CI-CD.md](../CI-CD.md).

The window is one of two equal ways to drive akou. The other is the harness, through the skill, the CLI and MCP. Both are first class, so nothing here may become the only way to do something an agent also needs.

## 0. The simple version

- **One window, three columns.** Calls on the left, the transcript in the middle, and on the right Ask on top with the last answer, then Notes, then the note input at the foot. A composer row on top holds the state, the new call's fields, the Mic and Call meters and Record; the open call's header sits over the transcript. A slim player bar sits under the transcript, and only when the open call has a recording.
- **Asking is one keystroke away.** `Mod+J` focuses the ask box, and the command palette turns any text it cannot match into a question. The small floating indicator that stays up while the meeting app is in front belongs to [DESKTOP.md](DESKTOP.md) (DK-F1). It carries no transcript text, so it is safe during a screen share, and its Open transcript button brings this window forward on the live call.
- **One action registry.** Every action (Record, Mute, Find, Copy transcript, Ask "Catch me up", Rename speaker) is one entry with an id, a label, keys and a condition. The buttons, the keyboard map, the command palette, the `?` sheet, the application menu and the tooltips all read that registry. Adding an action adds it everywhere.
- **One message catalog per language.** English and Spanish first. Every string the window, the tray and the notifications show comes from it.
- **The log is the truth.** The window draws the fold of the event log. Everything the user does (an edit, a rename, a note, a question) is an event, so the window never holds state an agent cannot read, and an agent's action shows up in the window at once.

What we leave out on purpose: search across calls' content, a people directory, a library of calls beyond the metadata list, cross-meeting chat, pre-meeting briefs. Those belong to the user's knowledge system ([POSITIONING](../POSITIONING.md), [DESIGN 8.1](../DESIGN.md#81-no-built-in-knowledge-base)). The window answers all of them with the hand-off in section 12.

## How to read the feature tables

Each item has one id and one owning document. This file owns the `W` ids, and its priority for them is the one that counts. [COMPETITOR-MATRIX.md](COMPETITOR-MATRIX.md) indexes them with the competitor evidence. Where a sibling owns a piece the window depends on, the row here is a pointer with no priority of its own, and old `W` ids that moved keep a line in the pointer tables so references to them still resolve.

Columns:

- **ID**: `W<section>.<n>`, stable. A bead names it. Retired ids are never reused.
- **P**: priority, on the same scale as [DESKTOP.md](DESKTOP.md) and [PROGRAMMABILITY.md](PROGRAMMABILITY.md).
  - **P0**: broken today in a way that loses data, hides a failure or makes a control do nothing, or a predecessor feature REQUIREMENTS marks as carried that is not built. Fixable in one small pull request. Before the next release.
  - **P1**: part of the UX milestone: what a user coming from Granola, Minutes or MacWhisper expects, or what the intent needs for the window to be the best way to follow a call.
  - **P2**: after the P1 it builds on. It keeps an acceptance line but gets a bead only when that P1 lands.
  - **P3**: not in the tables. P3 and undecided items sit in the parking list (section 19) with no acceptance line and no bead.
- **From**: `Intent` (our stated product intent), `DESIGN n` or `REQ Fx` (already promised in our docs), `Audit` (a defect found by running or reading origin/main), or the competitor that ships it.
- **Accept**: the check that closes the bead. Unless it says otherwise, it is a test in the Playwright UI suite (`tests/ui/`) over the headless app with the fake helper. "Native smoke" means the packaged-app smoke on a real OS, listed in [TESTING.md](../TESTING.md).
- **Today**: `has`, `partial` or `missing`, from origin/main.

## 1. Information architecture

```
┌──────────────┬ composer row ────────────────────────────┬─────────────────────────────┐
│ akou         │ ● SAVED [work│title……] [Live: Auto ▾]    │ ✦ Ask about this call  ⌄ ↵  │
│ ▮ Calls      │   Mic ▬▬  Call ▬▬   (●) Record ⌥⌘R       ├─────────────────────────────┤
│ [⌕ Search  ] ├ banner, when something needs attention ──┤ What did Ben say?           │
│ ▾ PRODUCT  2 ├ call header ─────────────────────────────┤ ┌ ✦ Answer ───────────────┐ │
│   Weekly…  ● │ Weekly sync       [review] Restart Share │ │ Move the build [15:41 Ben]│ │
│   1:1 Ana    │ Wed, 15:36 · 27 min · work               │ └─────────────────────────┘ │
│ ▸ HIRING   1 │ (● Ben 14 min) (● You 9 min)             ├─────────────────────────────┤
│              ├──────────────────────────────────────────┤ Notes 3                     │
│   Dictation  │ transcript                               │ 15:38 • budget review first │
│   Models     │ 15:41  Ben    we should move the build   │ 15:41 ☐ Ben: move build box │
│   Settings   │ 15:41  You    to the new box? which one  │ 15:44 ? which region        │
│              │ …                                        ├─────────────────────────────┤
│              │ ┆ 15:42  c3?  (still being spoken)  ┆    │ [Type a note, Enter to add] │
│              │                          [↓ Back to live]│ - bullet [] action ? …      │
│              ├ player bar, saved calls only ────────────┤                             │
│ ● Ready      │ ▶ 15:41:07 ──●─── 16:03:40 1.0x mic◂▸call│                             │
└──────────────┴──────────────────────────────────────────┴─────────────────────────────┘
```

| Region | Holds | Reads from |
|---|---|---|
| Composer row | the state word and dot; idle: the workspace chip inside the title field, the live model menu, the Mic and Call meters with their health dots, and the round red Record with the global hotkey where the shell registers one; recording: the live model the call runs (disabled), the elapsed time, the round Stop, and Mute and Pause as icon buttons | `status` push, `GET /models`, the fold |
| Call header | the open call's title; its day and start, length, workspace and what the state adds; the speakers with their talk time; the words to review, languages and shared pills; Restart, Share, Copy transcript | the fold |
| Banner | one message at a time, highest severity first, with at most one action button | `health`, provider, models |
| Sidebar | the wordmark, Calls with a search and the calls grouped by workspace, Dictation, Models and Settings, and the readiness row | the metadata list, `status` |
| Transcript | committed lines, the provisional row, the find bar when open | the fold |
| Side column | on top the ask box with its presets menu, then the last question and its cited answer; under it Notes with its count; at the foot the note input with its markers as hints | the fold and the ask stream |
| Player bar | under the transcript, only for a saved call with a recorded part (never with no call or during a live call): play or pause, position as wall time, speed, balance | the call's audio |
| Dialogs | Words (review and vocabulary), share options, speaker popover, shortcuts sheet, command palette | registry and fold |

Below 1248 px wide the sidebar narrows to 10 rem and the side column to 18 rem, so the transcript keeps at least half the window. The calls column collapsing under 900 px and the side column becoming a drawer under 640 px are W1.3, not built.

On macOS the window draws no title bar ([DESKTOP](DESKTOP.md) DK-M7): the traffic lights sit over the sidebar's top, and the sidebar, the composer row, the ask row and a page's header start 28 px down; a page keeps that strip at its top as it scrolls. That strip and those rows move the window and a double-click on them zooms it; the controls in them do not. Windows and Linux keep their native frame and this spacing.

One accent per screen. The accent fill is the welcome's Download alone (`#welcome button.go`). Every other primary action (Save, Fix, Log in, Back to live) keeps the `go` class and draws as a neutral fill in the text colour. Red means recording: Record and Stop are red discs. Green means ready or saved: the readiness row's Ready and the saved dot. The open call in the sidebar and the line being played use a neutral fill. Info glyphs and the answer's citation chips are teal (`--info`), never a button. The focus ring stays the accent. The light theme follows the same rules with its own values.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W1.1 | The notes pane is Notes alone: no tabs, no Enhanced pane, no Enhance and no "Find misheard words" | P0 | Audit: the Notes and Enhanced panes once showed stacked. Enhance is not part of the window now: a word is fixed on its line (W4.8) ([the pane](design-explorations/built/hide-enhance-notes-dark.png)) | None of those controls is in the DOM, and the side pane names neither. The general "hidden means hidden" invariant with its positive control is TESTING TS-15 | has |
| W1.3 | Narrow layouts: calls column collapses under 900 px, side pane becomes a drawer under 640 px | P2 | Audit: at 800 px the sidebar keeps its width | Screenshots at 1280, 800 and 600 px show the described layout; no horizontal scroll | missing |

Moved: W1.2 (tests assert computed visibility) is TESTING TS-15. W1.4 (remember the window frame) is DESKTOP DK-M4.

## 2. States

The composer row's state word and dot show one of the rows below. The state machine lives in the main process, and the window only draws it. Every state has a way out, and the table names it. The word is lowercase in the markup and drawn in capitals; what the state adds (how long it has recorded, the last line, the failure) is the word's tooltip and the call header's line of facts. The words are English until the catalog (W16.1) brings Spanish.

| State | Word | Dot | Enabled controls | Way out |
|---|---|---|---|---|
| Speech models missing, the welcome on screen | setup | grey | none in the composer row: it shows only the word, and the welcome (section 10) holds the one Download | the download ends → ready, without a reload |
| No call yet | ready | grey | Record, workspace, title, live model | Record |
| Starting | starting | red pulse | Stop | 201 → rec; failure → recording failed |
| Recording | rec | red pulse | Stop, Mute, Pause, Restart; Share, Copy transcript in the call header; Discard in the first 60 s is W2.7, not built | Stop, Pause |
| Mic muted | rec, the tooltip adds "mic muted" | red pulse, the Mute icon crossed | Unmute, Pause, Stop | Unmute |
| Paused | paused | amber | Resume, Stop, Mute, Restart | Resume, Stop |
| Not capturing (no level for 5 s, or both channels proven dead) | not capturing | amber | Stop, Restart | capture comes back, or Restart |
| Stopping | stopping | red pulse | none (under 5 s by design) | → saved, and the final pass runs |
| Final pass running | saved, with the final-pass note and its bar under the composer row | green | Share, Copy transcript; Restart when no other call records | → saved |
| Saved | saved | green | Share, Copy transcript, Record a new call; Restart when no other call records | Record |
| Failed to start | recording failed, the tooltip names the stage and the error | red | Restart, Record | Restart or a new call |
| Ended unexpectedly or interrupted | ended unexpectedly, interrupted | amber | Restart (same call) | Restart |
| Another call recording | another call is recording | grey | Stop the other call | the other call stops |
| App unreachable (browser page, share viewer) | reconnecting | amber | none | reconnects from last `seq` |

Overlays that stack on any state: models missing or downloading (section 10: the readiness row at the foot of the sidebar and the welcome), provider unavailable (the ask pane says why, and Settings shows the agent's state), shared live (red pill with viewer count in the call header).

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W2.1 | States and banners as in hark-viewer | done | DESIGN 7 | Existing parity tests | has |
| W2.2 | State is never shown by colour alone: every dot has a label, every health dot an icon shape and text | P1 | Accessibility | With forced-colors emulated, each state and channel health is still distinguishable by text; the axe scan (W15.5) reports no colour-only state | partial |
| W2.3 | Only errors use `role=alert`; info toasts use `role=status` | P1 | Audit | An info toast is announced politely; a dead-capture banner assertively | partial |
| W2.4 | Stop while the meeting app still uses the mic: "Call audio was active 12 s ago. Stop anyway?" with a 10 s undo | P1 | DESIGN 7 (M2) | Fake helper reports call audio 5 s ago; Stop shows the inline confirm; Undo within 10 s leaves the call recording with no `part.ended` | missing |
| W2.5 | Record never refuses with a CLI hint while the speech models are missing: it is disabled with its reason as a tooltip, and the welcome (section 10) offers the download | P0 | Audit: the toast said "run `akou models pull` … or start with --without-models" | With no models, Record is disabled with "Record needs the speech models: download them first." and the page sends no `POST /calls`; once the download finishes it is enabled without a reload | has |
| W2.7 | Discard a mistaken recording in its first 60 s: stops the call and moves it to the Trash (W13.3) before any hand-off runs | P2 | Superwhisper, VoiceInk; REC-05 | Discard at 30 s leaves no call in the list, no export and no `hook.done`; after 60 s the button is gone and Stop is the only way out | missing |

Moved: W2.6 (confirm Quit during a call) is DESKTOP DK-M3.

## 3. Recording: the composer row and the shell around the window

### 3.1 Starting and controlling a call

The controls are the ones hark-viewer had (DESIGN 7), laid out as the composer row: the status word, the workspace as a chip inside the title field, the live model menu (W3.19), two thin meters labelled Mic and Call, and Record as a round red disc with its word and, where the shell registers one, the global hotkey in dim text, never an accent fill. While a call records, the same spot shows a red dot with the elapsed time, Stop in the same round form, and Mute and Pause as quiet icon buttons. The open call's title, its line of facts and its speakers with their talk time are the call header over the transcript. The title is also how a call is renamed, live or saved, the same way a note is edited: a click or Enter opens it as a field, Enter or leaving the field saves, Escape keeps the old name, and an empty title saves nothing. The rename is a `call.renamed` event with a higher `rev`, never an edit of `call.created`; the header, the sidebar row, its search and the window title follow without a reload, whichever door renamed it (`PATCH /calls/{id}`, `akou calls rename`, `akou_rename_call`). The folder keeps the name it was created with. No debug chips: the clock's zone and the call's decode list are the tooltip of that line, and the agent's state, the speech engine's state and the version are read-only rows in Settings. The additions still to build are the input choice, start-muted, words for the call, and marking a moment.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W3.1 | Record, Mute, Pause, Stop, Restart; workspace and title pickers. The Record row's template picker gave its place to the live model menu (W3.19): notes take the automatic template, and `akou enhance --template T` picks one (the Enhanced tab is hidden, W6.16) | done | DESIGN 7 | Existing tests | has |
| W3.2 | Mark this moment: a button and `Mod+D` star the line being spoken, with an optional label | P1 | Otter, tl;dv, Fathom, MacWhisper | During a call, `Mod+D` writes one `mark` event at the current wall time; the line shows a star; the mark is in the pack for "what did I mark" and in the export | missing |
| W3.3 | Mic and call source picker in the composer row (idle only) | P1 | REQ F0.7, audit: the window cannot pick devices | The picker lists the devices the API reports; the chosen one is sent as `mic`/`call` on start. Depends on CLI-07 and a devices route in [PROGRAMMABILITY.md](PROGRAMMABILITY.md) | missing |
| W3.4 | Start with the mic muted (checkbox beside Record) | P2 | Minutes | Start with the box ticked writes `mute` before the first mic segment; the mic meter shows muted | missing |
| W3.5 | Silence reminder: after N minutes with no audio on either channel, a banner "Nothing heard for 10 min. Keep recording?" with Keep and Stop; never stops by itself unless the user set an auto-stop | P2 | Minutes, Granola, Wispr; intent: no false alarms | Fake helper silent for the set time shows the banner once; Keep resets it; no banner in a quiet but live call where either channel has speech | missing |
| W3.16 | Rename the open call from its title in the call header, live or saved | done | Owner, WR-7 | `tests/ui/window.test.ts` "A live call and a saved one renamed from the header…", which fails when the sidebar row does not follow; `tests/calls-rename.e2e.test.ts` for the API, the CLI, MCP and a restart | has |
| W3.17 | A new live call takes the window over, whichever door started it (the window, the CLI, an agent, the hotkey, the API) and whatever call the user picked before. The user may pick another call afterwards to read it; the next new live call takes over again. A call that ends stays on screen. The start itself never opens or raises the window (only the floating indicator shows, DK-F1); an open window switches without taking the focus. The one exception: a call already live when the page opens on a call it was asked for (`akou open CALL`) keeps the asked-for call | done | Owner: a call started by an agent did not show in a window where an old call had been clicked | `tests/ui/window.test.ts` "[W3.17] …": a CLI start replaces a picked call, a picked call holds until the next one, an ended call stays, a window opened on an old call keeps it. The first check fails with the old condition, the last without its exception. `tests/desktop.test.ts` "a call that starts opens no main window…" | has |
| W3.18 | The Mic and Call meters move like a level meter: drawn per animation frame, a fast rise to a louder level and a slow fall (24 dB/s), not a jump each time a level arrives. The indicator's two bars use the same code | done | Owner: the bars moved "oddly" | `tests/meter.test.ts`: the rise, the fall, settling so the frames stop, and a positive control on the fall | has |
| W3.19 | The live model in the Record row, where the template was: a "Live: <choice>" menu button. The menu lists only the live setups whose models are on this machine, Automatic first whenever one is, then Streaming (Nemotron), Streaming + Qwen rewrite and Parakeet between pauses, each with one plain line and a check on `asr.live`. With none downloaded the button reads "Live: no model" and the menu says so, with Get models opening the Models page. Picking a line saves it as `asr.live` (`PATCH /config`, that key only), so the Models page and the menu agree. Record reads `asr.live` again, after any pick still being saved, and sends it as `live` on `POST /calls`, so a change made in the CLI, the API, another window or the Models page always wins over what the button last read. When `asr.live` names a setup whose models are not all here, no line is checked, the button names what calls run instead and the menu says why in one line; picking Automatic then saves it. The button shrinks and cuts its name with an ellipsis rather than push the row over the state word. While a call records, the button shows the setup that call runs and is disabled; a change applies from the next call. Server mode has no Record row | done | Owner: "Instead of template, that should be where we select the live transcription model" | `tests/ui/live-picker.test.ts`: only the downloaded setups listed, the choice in `PATCH /config` and `POST /calls`, disabled with the running call's setup (a call started elsewhere on another setup shows that one), Get models opening Models with none downloaded, Record after an API change of `asr.live` starting the new setup with the button clear of REC at 1024 px, and a saved setup that is not here checking nothing until Automatic is picked and saved; `tests/ui-live-picker.test.ts` for the lines. Each fails on its mutation | has |
| W3.15 | Words for this call: an optional field beside the title (attendees, product names), sent as `vocab` on start, the window's equal of `akou start --vocab` | P2 | Parity: CLI, API and MCP take `--vocab` at start, the window cannot | Typing "Ben, Vercel" and Record starts a call whose `call.created` carries both words; the speaker popover suggests "Ben" (W8.3) | missing |

### 3.2 Pieces owned by DESKTOP.md and PROGRAMMABILITY.md

The shell decides whether the window can be reached and used, but [DESKTOP.md](DESKTOP.md) owns it, with its priorities. The floating indicator replaces the compact strip this file used to design. It shows no transcript text and has no ask box, so it stays safe during a screen share; asking goes through `Mod+J` or the palette (W14.5) once the indicator brings this window forward.

| Old ID | Piece | Owner |
|---|---|---|
| W3.6 | Floating indicator while recording (was "compact strip") | DK-F1 |
| W3.7 | Hide akou's windows from screen capture (`app.hideFromCapture`) | DK-P3, after its spike |
| W3.8 | Application menu with the Edit roles | DK-M1 |
| W3.9 | Tray icon per state | DK-T1, DK-T2 |
| W3.10 | Dock `reopen` | DK-M2 |
| W3.11 | Notifications for agent-started calls, dead capture, refused starts | DK-N1, DK-N2, DK-N4 |
| W3.12 | Notifications for final pass, hand-off, share | DK-N3 |
| W3.13 | `akou://call/<id>` | PG-U1 |
| W3.14 | Richer tray menu | DK-T3, DK-T4 |

## 4. The transcript

### 4.1 Reading

Rows work as in hark-viewer: a wall-clock time column, a speaker chip on change, the last three lines bright and older ones dim, pinned auto-scroll, "Back to live" after scrolling up 80 px, font 14 to 44 px. The provisional row is grey with a dashed border and expires after 3 s. It is drawn the same way whether the live engine is segmented or streaming; a streaming engine redraws it in place.

Live speaker labels are guesses until the final pass ([DESIGN 3.2](../DESIGN.md#32-live-speaker-labels)), and the window says so. A live cluster's chip is dashed and reads `c3?` until someone names it or the final pass lands. After `final.done` chips are solid. The setting `asr.liveLabels` ([DESKTOP.md](DESKTOP.md) section 14) turns live clustering off, and then live lines show only You and Them by channel.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W4.1 | Rows, chips, hues, provisional row, pinned scroll, font keys | done | DESIGN 7 | Existing tests | has |
| W4.2 | Live speaker labels look provisional until named or final | P1 | Intent: live labels are provisional, the final pass is authoritative | A live cluster chip has the provisional style and `c3?`; after `final.done` the same speaker's chip is solid; a named speaker is solid at once | has |
| W4.3 | With `asr.liveLabels` off, live rows show You or Them by channel | P2 | Intent: every choice a setting | With the setting off, live rows show You or Them and no `c<N>` | missing |
| W4.4 | Right-click (and `Shift+F10`) on a line: Play from here, Copy line, Copy with time and speaker, Edit, Change speaker, Fix this line, Mark | P1 | Descript, anarlog; audit: no context menu | Each item runs its registry action; keyboard users reach the same menu | partial: Play from here, Copy line, Copy with time and speaker, Name this speaker and Fix this line, by mouse, `Shift+F10` and the Menu key; Edit and Change speaker wait for PG-A5, Mark for W3.2 |
| W4.6 | Per-segment confidence shading, once engines report it | P2 | Meetily; intent: multi-engine fusion gives agreement per word | Lines or words under a threshold get a dotted underline; hover shows the agreement; depends on `seg` carrying confidence | missing |

### 4.2 Editing

The log is append-only, so an edit is a new revision, never a rewrite: `seg rev+1 by:user`. The raw heard text stays in the log and shows on hover.

```
15:41  Ben   we should move the build to the new box   ✎
             ┌──────────────────────────────────────────┐
             │ we should move the build to the new Box  │  Enter saves · Esc cancels
             └──────────────────────────────────────────┘
```

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W4.8 | Fix this line: the line's text in one field, the person writes what was said and presses Enter. A name, product or jargon word is learned into the call's and the workspace's vocabulary with no review, and every line of the call with the same heard form reads corrected, unless that form is a common word; a rewording, or a word added or removed, stays on its one word of the line and goes into Notes as `Fixed: heard -> term` (so does a term while the live engine takes no word list); a quiet toast says what was learned, with Undo; writing a corrected word back as heard takes the correction off the call; a line rewritten while the popover was open is shown again ([popover](design-explorations/built/fix-1-popover-dark.png), [learned](design-explorations/built/fix-2-learned-dark.png), [noted](design-explorations/built/fix-3-noted-dark.png)) | done | DESIGN 5.4 "A fix on a line" | The other line with the same heard form reads corrected; the term is in both lists; a rewording is a Notes line marked "from a fix" and changes only its word; a case change of a common word or after a full stop learns nothing; Undo takes all of it back; no raw config key in the popover, the toast or the notes | has |
| W4.9 | Inline edit of a line: `E` or double-click; Enter or blur saves `seg rev+1 by:user`; Esc cancels; an edited line shows a mark and the raw text on hover | P1 | DESIGN 7 (designed, not built), Descript, anarlog | Edit, save, reload: the line shows the new text and the log has one `seg` revision with `by: user`; the raw heard text is still in the log. Needs the segment edit route PG-A5 | partial (style only) |
| W4.10 | Change the speaker of one line: a picker, or keys `1` to `9` on a focused line | P1 | MacWhisper, Descript, anarlog | Pressing `2` on a focused line writes `seg rev+1 {spk}` through PG-A5; the chip updates; merge and unmerge still work on clusters | missing |
| W4.11 | Replace in this call: Find (section 7) plus "Replace all" writes a call-scoped `vocab.add`, the same event as "Everywhere in this call" | P2 | noScribe | Replacing "versal" with "Vercel" changes every match in the view and adds one call-scoped pair; the log keeps raw text | missing |

## 5. Audio sync

The player bar gets real controls. It is a slim bar under the transcript, and it exists only when the open call has a recording: a saved call with at least one part. With no call, and while a call records, the bar is gone, and so is playback: a line's Play button and "Play from here" answer with a toast instead, and Restart on a saved call stops the audio as the bar goes. Line-level sync comes first, because it needs nothing new in the log. Word-level sync waits for word timings, which the multi-engine fusion work needs anyway.

```
 ▶ 15:41:07  ───────●─────────── 16:03:40   1.25x   mic ◂──●──▸ call
```

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W5.1 | Play from any line, mic/call balance | done | DESIGN 7 | Existing tests | has |
| W5.2 | Play and pause: a button and `Space` (outside text fields) | P0 | Audit: the player has no controls and nothing can pause it | Start a line, press Space: `player.paused` is true; press again: it resumes from the same position | has |
| W5.3 | Position shown as wall time, a scrubber over the call | P1 | Buzz, MacWhisper, VoiceInk | Seeking to 50 % shows the wall time of that instant, never a bare offset (TRAPS time rule) | partial: the wall-time position and a scrubber over the part being played (the unit the audio route serves) are built; left: one scrubber across every part of the call, and scrubbing before a line has been played |
| W5.4 | Speed 0.75x to 2x in 0.25 steps, `[` and `]`, remembered | P1 | Buzz, MacWhisper | `]` twice sets 1.5x; reload keeps it | has |
| W5.5 | Seek back or forward 5 s: `Shift+←` / `Shift+→` | P1 | Otter, MacWhisper | Position moves 5 s; clamps at the part bounds | has |
| W5.6 | Follow audio: the line being played is highlighted and kept in view; scrolling by hand pauses following until "Follow" is pressed | P1 | Buzz | With playback running, the highlighted row's `a0 ≤ t < a1`; a manual scroll stops auto-scroll | has |
| W5.7 | Replay the current line: `R` | P2 | MacWhisper | Seeks to the line's `a0` | missing |
| W5.8 | Word-level highlight and click a word to play it | P2 | Descript, Scriberr, whishper | With word timings in `seg`, clicking a word seeks to its start ±50 ms; depends on word timings in the log | missing |

## 6. The side pane

The side column has three parts, top to bottom. Ask is always on top, so asking never hides the notes. Notes sit under it, alone: there is no Enhanced tab (section 6.3). The note input is at the foot and stays on screen, because notes are the default action during a call. A line akou wrote from a fix of a transcript line (`Fixed: versal -> Vercel`) says "from a fix".

### 6.1 Notes

```
 Notes 4
 15:38  •  budget review first
 15:41  ☐  Ben: move build box
 15:44  ?  which region
 15:47     Ben owns the migration  agent claude-code   (agent colour)
 ──────────────────────────────────────────────────────
 [ Type a note, Enter to add it                      ]
 - bullet   [] action   ? question   # section
```

A note's marker (`- `, `[] `, `? `, `# `) is drawn as a glyph before the text, and the note keeps it: an edit starts from the whole line. The markers are listed as small hints under the input, never inside its placeholder.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W6.1 | Notepad with markers, time gutter, agent lines in their own colour | done | DESIGN 5.1 | Existing tests | has |
| W6.2 | Editing a note saves on blur and after a 2 s pause, not only on Enter | P0 | Audit: clicking away drops the edit, which loses what the user typed; DESIGN 5.1 says Enter or a 2 s pause | Type in an existing note, click the transcript: the log has `note rev+1` with the new text | has |
| W6.3 | Delete a note with a 10 s undo | P1 | Audit: no confirm and no undo | Delete shows "Note deleted · Undo"; Undo restores it as a new revision | partial |

### 6.2 Ask

```
 [ ✦ Ask about this call                        ⌄  ↵ ]
      ⌄ opens the presets: Catch me up · Was my name mentioned? · Decisions so far ·
        Action items · What did Ben say?
 ─────────────────────────────────────────────────────
 What did Ben say about the budget?
 ┌ ✦ Answer                        answered by claude-code ┐
 │ Ben asked to move the build to the new box [15:41 Ben]  │
 └──────────────────────────────────────────────────────────┘
   15:41 Ben "we should move the build…"          (the excerpts that matched)
```

The column shows one question and its answer: the last one asked here, or, until one is, the call's last answered question from the log, marked with who asked it when an agent did. The answer card is in the agent's colour; its citations are chips that scroll to the line and play it. Enter asks; the presets are a menu on the input (arrow keys move, Escape closes), never a row of buttons.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W6.6 | Ask box, presets, evidence within 300 ms, streamed answer, clickable citations, "Copy context for my agent" when no provider | done | DESIGN 5.3, 7 | Existing tests | has |
| W6.7 | Stop a running answer | P1 | Audit | Stop aborts the provider process; the log has the partial `answer` marked stopped; the box is ready for the next question | missing |
| W6.8 | Past questions and answers of the call are drawn from the log on open and on call switch | P1 | Audit: they vanish on switch; intent: the log is the truth | Ask, switch calls, switch back: the Q&A is there; answers an agent asked through MCP are listed too, marked by client | partial: the last answered one shows, marked by client |
| W6.9 | Copy an answer (with citations as `[15:41 Ben]`) | P1 | Granola, audit | Copy puts the answer text on the clipboard with wall-time citations | missing |
| W6.10 | "Last 5 minutes" preset | P1 | Fireflies "Catch Up (Last 1 min)" | The preset sends a question that the query engine routes to the recent window; the pack holds only lines from the last 5 minutes | missing |
| W6.11 | Name-mention marker: when `user.name` or a word in `watch.words` appears in a committed call-channel line, a quiet marker in the transcript. The notification with the window in back needs a row in DESKTOP section 8 and carries no line text | P2 | Zoom, Teams markers; ASK-05 and PG-S4 are the same item at P2 | A fake call line containing the user's name produces one `mention` marker; a mic line with the name produces none | missing |
| W6.13 | "What should I ask next?" preset | P2 | Granola, Fireflies Follow Up | Ships as a preset file (PG-F2) | missing |
| W6.14 | Live memo pane: the rolling memo shown above the Q&A when a provider writes it | P2 | Otter live summary, Fathom | With a memo event, the pane shows it with its time; hidden when there is none | missing |
| W6.23 | Answer footer: the provider and model, the pack size in tokens, and "Show request" with the exact pack sent | P2 | VoiceInk; ASK-11 is marked `has` but only the no-provider path shows the pack | After a fake provider answers, the footer shows its name and the pack's token count; Show request displays the same text the provider received | partial |
| W6.24 | Remembered lines (`remember` events, DESIGN 4.3) listed at the top of the Ask pane, marked by author, editable and retractable by the user as new revisions | P2 | Parity: `akou remember` and `akou_remember` exist, the window cannot see them | An agent's `remember` appears within one push; editing it writes `remember rev+1 by:user`; Retract writes `text: null` and the line leaves the next pack | missing |

Moved: W6.12 (presets as files) is PG-F2; the ask box and the palette draw presets from `GET /presets`.

### 6.3 Enhanced

Hidden. Enhance is not part of the window: a word is fixed once, on its line (W4.8), and the final transcript carries the fixes. The code, `akou enhance`, the API and the MCP tools stay, and notes already written stay in the export's Notes section and `GET /calls/{id}/enhanced`. The rows below wait until Enhance comes back.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W6.16 | Enhance, template switcher, revisions, user versus AI styling, citations | done | DESIGN 5.2 | Existing tests | hidden from the window (`enhanced.ts` is not mounted) |
| W6.17 | Copy the enhanced notes as Markdown | P1 | Granola, Fathom, Wispr | Copy yields the `## Notes` section of the export render | missing |
| W6.18 | Edit the enhanced notes in place; saving writes `enhanced rev+1 by:user` and stops automatic re-enhance | P1 | Audit: `PUT /enhanced` exists but no UI | Edit, save: a new revision by user; `final.done` afterwards offers a button instead of re-enhancing | missing |
| W6.19 | Rewrite by instruction ("make next steps more detailed") on the whole notes or a selection | P2 | Granola | The instruction goes to the provider with the current revision and the pack; the result is a new revision; the previous stays selectable | missing |
| W6.20 | An agent's rewrite of notes the user edited arrives as a proposal with a diff, applied or declined | P2 | anarlog | `akou_enhanced_put` on user-edited notes shows a "Proposed edit" banner with a unified diff; Decline leaves the user's revision current | missing |
| W6.21 | Summary language setting per workspace (same as the call, or a fixed language) | P2 | Granola, anarlog, Meetily; Spanish is a first-target language | A Spanish call with the setting "English" enhances in English; the setting is passed to the provider prompt | missing |

## 7. Search inside a call

Find works on the fold the page already holds, so it needs no API and no index. It searches this call only. The call list filter matches titles, workspaces and dates from the metadata list, never content, which keeps the no-knowledge-base line.

```
 ┌ Find in this call ────────────────────────── 3 of 15 ─ ▲ ▼ ─ ✕ ┐
 │ budget                                   [ ] include heard text │
 └─────────────────────────────────────────────────────────────────┘
```

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W7.1 | Find in this call: `Mod+F`, live results, count, Enter and Shift+Enter move, Esc closes, matches highlighted | P1 | Granola, Buzz, MacWhisper, Descript, tl;dv | On a 2 000-line fixture, typing a word shows the right count and Enter scrolls to the next match. The 100 ms budget is timed in the nightly performance job (TS-23), never on a PR runner | missing |
| W7.2 | Option: also match the raw heard text | P2 | Intent: vocabulary keeps what was heard | "kubernetis" finds a line displayed as "Kubernetes" with the option on, not off | missing |
| W7.3 | Filter the call list by title, workspace and date | P2 | Audit: no filter over 200 calls | Typing in the filter narrows the list; no request reads call content | missing |

## 8. Speakers

Speaker colours stay off the accent's hue, so the accent is only ever the one primary action. Everyone else takes a hue from the palette in order of first appearance; you are drawn in a neutral grey (`--you`), in the transcript and in the speaker chips.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W8.1 | Speaker chip popover: rename, merge, unmerge; a renamed speaker keeps its hue | done | DESIGN 7 | Existing tests | has |
| W8.2 | The popover is a real dialog: `aria-haspopup="dialog"`, focus moves in and returns, Esc closes | P1 | Audit: chip says menu, popover is a dialog with no focus handling | The axe scan (W15.5) reports no ARIA mismatch; a keyboard test opens, renames and closes without the mouse | partial |
| W8.3 | Name suggestions while typing, from this call only: the words passed at start (`--vocab`, W3.15) and names already typed in this call | P2 | MacWhisper, Descript; TRN-07. Reading names from other calls would start a people list, which principle 7 rules out | Typing "Be" suggests "Ben" when Ben was passed at start; a name typed in another call of the same workspace is never suggested | missing |
| W8.4 | Hear a speaker: a 5 s sample from their longest line, from the popover | P2 | Buzz | The button plays that speaker's line through the existing player | missing |

## 9. Vocabulary

The vocabulary is the one thing that carries across calls, and nothing enters it without the user's yes ([knowledge-handoff.md](../knowledge-handoff.md)). The window's job is to make adding, approving and removing fast. All of it lives in one Words dialog, opened from the "Words to review" pill, the palette and Settings, so the settings groups stay the ones DESKTOP DK-S1 defines.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W9.1 | Fix on a line (W4.8), "Words to review" pill and dialog, raw text on hover, decode list as the tooltip of the call header's line | done | DESIGN 7 | Existing tests | has |
| W9.2 | The vocabulary list is editable in the Words dialog: add a term (with heard forms), remove, confirm, change scope | P1 | Audit: read-only panel; Wispr, VoiceInk, Descript | Adding "Vercel" heard "versal" writes the workspace file through the API; the dialog and `akou vocab list` agree | partial: the Dictionary dialog (DICTATION DC-U5) adds, removes and changes scope in the global file, and Settings opens it instead of its old read-only list; confirming and the workspace file are not there yet |
| W9.3 | An inline edit that changes one word becomes a vocabulary proposal, not an automatic add | P2 | VoiceInk AutoLearn, Descript, Wispr | Editing "versal" to "Vercel" on a line adds a pending proposal to "Words to review"; nothing is written to the vocabulary until Approve | missing |
| W9.4 | Rejected proposals are never proposed again, and the dialog says so | done | DESIGN, `vocab/pass.ts` | Existing tests | has |

## 10. First run and models

[DESKTOP.md](DESKTOP.md) section 11 owns the first-run flow, its steps and their order. What ships is the welcome below; the rest of that flow (your name and the interface language, a permission per screen, the capture test) is DK-O2 and DK-O1, not built. Every step writes a normal setting; setup has no state of its own.

While the speech models are missing, downloading or failed, and no call is recording, the welcome replaces the transcript, the side pane and the player. The sidebar stays, with the calls on disk, and its readiness row reads "Models missing" (or "Downloading models", or "Download failed") with "Setup 1 of 3"; the Models row carries an amber dot. It says "Welcome to akou", one line on what to do, then three steps:

1. **Speech models** (Required): one row per model the download fetches, each with its job and size, the total, one dim sentence with the teal info glyph on where they are kept ("Kept in Application Support on this Mac. Nothing leaves this computer."), and the one Download button. While it downloads: a bar, the bytes of the total, the percentage and the file being fetched. The API has no cancel, so the step shows none. A failed download says why and offers Try again.
2. **Microphone and system audio** (Later): "macOS asks for both the first time you press Record."
3. **Your agent** (Optional): one line, and a quiet button that opens Settings on the provider field.

The footer says "You can change any of this later in Settings." While the welcome shows, the composer row keeps only its state word, and the word reads "setup", never "ready": no title field, template, meters or Record. The welcome goes by itself when the models are ready, without a reload. A call recording without models (started from the CLI) keeps the workspace on screen. A call picked in the sidebar also lifts the welcome, so a call recorded without models can be read once it is stopped; until the user picks it, the welcome shows, that call is only the marked row in the sidebar, and the composer row shows its state word. "Setup 1 of 3" brings the welcome back with the focus on the download.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W10.1 | The welcome: the three steps above, a resumable checksummed download with real progress, Record disabled with its reason until the models are there | done | DESIGN 7; design-explorations | `tests/ui/window.test.ts` "the welcome": with the models missing the workspace carries `hidden`, the state word reads "setup", the rows and sizes show, the progress moves with every `GET /models` failing, and the welcome goes when the download ends | has |
| W10.6 | Download progress on the status push: the app pushes the status at most once a second while a download runs; the one-second `GET /models` poll runs only after the push has been quiet for 3 s | P1 | DESKTOP DK-E2 | Same test: with every `GET /models` aborted, the bar still moves | has |

Moved: W10.2 (guided first run) is DK-O2. W10.3 (3 s capture test) is DK-O1. W10.4 (free space, speed, time left, Cancel) is DK-O3 and DK-E2. W10.5 (sample call) is in the parking list.

## 11. Settings

Settings is a page of the window, not a dialog: the sidebar's Settings row, the application menu's Settings… (`Mod+,`), and the welcome's "Choose an agent" open it in the place of the call workspace, and the sidebar's Calls, or any call in its list, leads back. The design is direction A of [design-explorations](design-explorations/README.md) ([sd-a-settings.png](design-explorations/sd-a-settings.png)); what shipped is [st-1-settings-dark.png](design-explorations/built/st-1-settings-dark.png).

The page is one centred column of sections, each a rounded panel of rows: a human label and at most one short line of muted help on the left, the control on the right (a switch, a segmented choice, a select, a field with its unit, keycaps). A default shows as its value. No row names a setting's key, a path of akou's own or a value in code quotes; the words are in [settings-labels.ts](../../src/ui/settings-labels.ts), and [settings-labels.test.ts](../../tests/ui/settings-labels.test.ts) fails on a key without words or words that quote a key. The sections are General, Workspaces and recordings, Calls, Notes and AI, Privacy and sharing, and Advanced, whose rows (Speech engines, Audio capture, Word lists, Export and ports, Server mode) each lead to a page of their own under a back link and say what that page holds. Every key the registry has and the Dictation page and the Models page do not show lives on the page or one of those pages; a key the layout does not place yet lands on an "Other settings" page rather than out of reach. The live transcript's row leads to Models, where it is chosen, and the search finds the Models page's settings (the graphics chip, who spoke, the unused-days sweep, the size cap) and goes there. A key the registry keeps file only is shown read only, and the page opens the config file in the system's text editor. The foot says the version and the speech engine's state in words, never the engine's own reason (it names a folder and a command), with a way to Models while the speech models are not downloaded; the agent's state is the help line of "Answers". Share links open to the tailnet, the local network, only this computer, or an address typed into a field. The record shortcut's Change button says the shortcut to a screen reader, and Use default goes back to the default. A search at the title's right finds a setting by its words across the page and its Advanced pages and goes to it.

Each change saves that key alone through `PATCH /config`, which validates it as the file is validated; a refusal shows under the row's label. A field saves when it is left, and leaving the page, or opening it again from its sidebar row, saves what is still typed into one. Server mode's Settings page (SERVER SV-U2) is the same page with the server's sections.

Models is a page too, built from the same rows ([sd-a-models.png](design-explorations/sd-a-models.png); what shipped is [st-2-models-dark.png](design-explorations/built/st-2-models-dark.png), with [a download](design-explorations/built/st-2-downloading-dark.png), [Remove's second press](design-explorations/built/st-2-remove-dark.png), [during a call](design-explorations/built/st-2-during-call-dark.png) and [the helpers](design-explorations/built/st-2-helpers-dark.png)). The sidebar's Models row, the Settings page's Live transcript row and its foot while the speech models are missing, and "Setup 1 of 3" during a recording open it. Under the title, how much is on this computer; while the speech models are missing, the one download instead. Its sections: Live transcript, a radio list (Automatic, Nemotron streaming, Parakeet between pauses, Nemotron with each line rewritten by Qwen, and Voxtral listed and unavailable) where "next call" marks what the next call runs and "this call" what the live call runs; After the call, the recognizer of the final pass; Dictation, Fast and Best; Speakers, a radio list of who-spoke-when; and On this Mac, with the graphics chip, the unused-days sweep, the size cap and a row to the helpers (voice detection, the program Qwen3-ASR runs in, and any other model no section places). Each fact is a sentence built from the numbers in [model-scores.ts](../../src/main/asr/model-scores.ts) and [live-setups.ts](../../src/main/asr/live-setups.ts), and each accuracy figure names its test set: read speech, meetings, real calls ([models-rows.ts](../../src/ui/models-rows.ts)). A row shows its models' size where the page owns them and "Already here" where another row does; a missing one is one Download away, a downloading one shows its bar and Cancel, which keeps the partial file for the next download; Remove shows on the row under the pointer and asks once more; the default and a model in use draw no Remove. The size's tooltip says when an unused model goes, or why a model is kept. Server mode's Models page (SERVER SV-U6) is the same page with Jobs in place of the live transcript, After the call and Dictation, and the choice of what a client's missing model does.

Dictation is a page too, built from the same rows ([sd-a-dictation.png](design-explorations/sd-a-dictation.png); what shipped is [st-3-dictation-dark.png](design-explorations/built/st-3-dictation-dark.png), with [its Advanced page](design-explorations/built/st-3-advanced-dark.png), [other states](design-explorations/built/st-3-states-dark.png) and [the setup](design-explorations/built/st-3-setup-dark.png)). The sidebar's Dictation row and `#dictation` open it. Its sections and what each holds are DICTATION.md section 6; the dictionary and the history still open as dialogs over it, from its Words and history rows. Server mode's Dictation page (SERVER SV-U2) is the same page with one section, for other computers.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W11.1 | Registry-driven form, secrets write-only, file-only keys read-only | done | DESIGN 7 | Existing tests | has |
| W11.10 | Settings is a page of grouped rows in the window, not a dialog: human labels, defaults as values, switches, no key names; every non-dictation key reachable on it or an Advanced page; one key per change; leaving saves what is typed; a search that goes to a setting | P0 | Owner: the Settings dialog showed raw keys and could not be closed like a window; direction A | `tests/ui/settings-page.test.ts`: the page hides the call and Calls or a call leads back; every key has a home, file-only keys read only, the text quotes no key or path; each change one `PATCH /config`, a refusal under its row, typed-then-left saves; the search focuses a setting on an Advanced page; the record shortcut recorded with Change; the config file opens. `tests/ui/settings-labels.test.ts` for the words | has |
| W11.11 | Models is a page of grouped rows in the window, not a dialog: the live transcript as a radio list, after the call, dictation's engines, speakers, and the computer's own settings; facts as plain sentences, each accuracy figure naming its test set; Download with progress and Cancel, Remove on a second press, none on the default; one key per change; leaving saves what is typed | P0 | Owner: "Models ... needs the same redesign"; direction A | `tests/ui/models-page.test.ts`: the page hides the call and Calls leads back; the facts name their test set and quote no key, id or path; five live choices with the mark following the models and the setting; no Remove on the default, and Remove asking once more on the speaker choice's own model; Download, Cancel, Download again; speakers and the graphics chip one `PATCH` each; a number saves when left and when the page is left; the helpers under a back link; Settings' Live transcript row and search lead here. `tests/models-rows.test.ts` for the sentences | has |
| W11.12 | Dictation is a page of grouped rows in the window, not a dialog: the grants and the setup, the keys as keycaps, voice, words and history, rules per app, the engine and another computer running akou, inserting, cleaning up, learning, the pill and sounds, and an Advanced page naming what it holds; one key per change; leaving saves what is typed and lets go of the recorder, the mic's level and the wait for an app | P0 | Owner: "the Dictation page looks horrible", "can't close it like a normal window"; direction A | `tests/ui/dictation.test.ts` DC-U1: the page hides the call, the sidebar and `#dictation` open it and Calls leaves it; every section and the Advanced page with every key and no key's name; one `PATCH` per change, a refusal in words under its row; the back link; keycaps, "Not set" and Set on macOS; another computer waits for its address, then turns on, and off again; the AI tidy shows its instructions. The other `tests/ui/dictation*.test.ts` files for the recorder, the setup, the microphone, the remote, the rules and the words to review | has |

Moved, all to [DESKTOP.md](DESKTOP.md) unless named: W11.2 (labels, groups, pickers, reset) is DK-S4 with PG-A3. W11.3 (when each key applies) is DK-S1, DK-K3 and DK-L2. W11.4 (`app.headless` not a live checkbox) is DK-L3. W11.5 (settings search) is DK-S4. W11.6 (Speech engines section) is DK-S3; the engine registry it draws from is not designed yet and is listed as lagging in PRINCIPLES, since [DESIGN](../DESIGN.md) still describes one engine. W11.7 (hotkey recorder) is DK-K5. W11.8 (no `Ctrl+Alt` default) is DK-K4. W11.9 (webhook test button) is in the parking list; the test itself is PG-W2.

## 12. Hand-off, export and sharing

The window shows where a call went and gives the one-click ways out. It does not grow connectors: email, chat and task tools are the user's harness or hooks.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W12.1 | Hand-off status line: export path, hook results, webhook result | done | DESIGN 7 | Existing tests | has |
| W12.2 | Copy transcript so far: `Mod+Shift+C`, palette, a button in the call header | P0 | REQ F1.42 marks it carried from hark (`y`), and it is not built; Granola, Fathom, Buzz | During a call, the clipboard gets the transcript rendered as the export's `## Transcript` section; after the final pass, the final layer | partial: the key and the call header's button; the palette entry comes with W14.5 |
| W12.3 | Copy the whole call as Markdown (the export render) | P1 | Wispr, Granola | The clipboard equals the export file body for that call | missing |
| W12.4 | Reveal the export in the file manager; open it in the default app | P1 | Desktop craft | Native smoke: the button opens the folder with the file selected | missing |
| W12.5 | Re-run hooks and re-export from the window | P2 | Audit: CLI-only | Buttons call the hooks route; a `hook.done` appears | missing |
| W12.6 | Live share with a red pill, viewer count and Stop; copy link | done | DESIGN 8.3 | Existing tests | has |
| W12.7 | Share options before starting: include names, notes, enhanced; expiry; bind address | P2 | DESIGN 8.3 options; audit: the window cannot choose them | The dialog sends the options; the viewer shows only what was included | missing |
| W12.8 | Follow-up email draft as a shipped template that produces text to copy; nothing is sent | P2 | Granola, tl;dv, Fathom, Amurex | Choosing the template yields a draft; Copy works; there is no send action | missing |
| W12.10 | Run the final pass again from the call's menu, for example after choosing other engines, the window's equal of `akou finalize` | P2 | Parity: the CLI has `finalize`, the window only has Retry after a failure (section 17) | Run again on a finished call writes a new final layer and `final.done`; the previous layer stays in the log; the button is disabled while the call records | missing |

## 13. Calls list

The sidebar is the window's left column, the full height of the window: the wordmark, then Calls with its search and the calls grouped by workspace, each row with its day, then Dictation, Models and Settings, which open their pages (section 11), and at the foot the readiness row. The row of the page on screen is marked, and Calls is marked while the calls are; while a page shows, no call in the list is marked. The readiness row is green "Ready" when the app can record, and amber "Models missing" with "Setup 1 of 3" while the speech models are not there (section 10). With no call on disk the list shows the default workspace with "No calls yet". The search filters the metadata the list already holds, titles and workspaces; it is not a search across meetings (DESIGN section 7). A renamed call is listed and found by its new title at once (W3.16). `Mod+K` stays with the command palette (W14.5), so the search has no key of its own yet. The app has no file jobs today; if it gains them, they are listed as their own group under the workspace, each by its name (SERVER.md SV-J10), and the sidebar search covers them.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W13.1 | The sidebar's calls: grouped by workspace, each group folding with the mouse or the keyboard and showing its count; newest first inside a group, the live call on top with a red dot, the group with the newest call first; each row the title and a line with the day (Today, Yesterday, the weekday within a week, then the date), the local start time and how long it ran ("live", "failed"); a search that narrows the list by title or workspace as you type, never by what was said, and Escape or clearing it brings every group back; switch without reload | done | DESIGN 7; design-explorations | `tests/ui/parity.test.ts` "Sidebar list of calls by workspace and day…", with a positive control on the search; `tests/ui-model.test.ts` "the calls list" | has |
| W13.2 | Rename a call and move it to another workspace | P1 | Audit: no rename anywhere | Rename goes through PG-A4 and writes a `call.renamed` event (W3.16); moving a call to another workspace moves its folder; the export file is found again by `akou_id` and renamed on the next export | partial: rename done (W3.16); move and the export's new file name missing |
| W13.3 | Delete a call to the Trash, restore from it, empty it now | P1 | Granola, Minutes; audit: no delete in any surface | Delete follows PG-A4 (refused for a live call, folder moved to `trash/`, purged after 30 days); the call leaves the list; Restore brings it back intact; "Empty trash now" asks for confirmation. Exports already written are the user's and are not touched | missing |
| W13.4 | Suggested title for a call started without one, applied only on the user's yes | P2 | heed | After the final pass, an untitled call shows "Title: Budget review? Use it" | missing |
| W13.6 | Open on a workspace: `akou open -w WS`, `POST /window {workspace}` and the page's `?workspace=` put that workspace first in the picker, even before any call is filed under it | P2 | hark-viewer `?workspace=` (carried) | Opening with `?workspace=ops` on an empty home shows "ops" selected in the picker; Record starts a call in it | missing |

hark-viewer's other page parameter, `?quiet=SECONDS`, is dropped on purpose. The page used it to guess a dead capture from missing lines when hark gave no call-side health. akou's helper reports each channel's health directly, so the window never guesses from silence.

## 14. Keyboard map and command palette

`Mod` is Cmd on macOS and Ctrl on Windows and Linux. Single-letter keys work only when focus is in the transcript, never in a text field. Every key is a registry action, so the palette, the `?` sheet and the menus show the same keys. The system-wide hotkeys are DESKTOP's (section 5 there).

| Keys | Action | Scope |
|---|---|---|
| global hotkey (DK-K4 sets the defaults) | Record / Stop | system-wide |
| `Mod+Shift+R` | Record / Stop | window |
| `Mod+Shift+M` | Mute / unmute mic | window |
| `Mod+Shift+P` | Pause / resume | window |
| `Mod+D` | Mark this moment | window |
| `Mod+K` | Command palette | window |
| `Mod+F` | Find in this call | window |
| `Mod+J` | Focus the ask box | window |
| `Mod+Shift+C` | Copy transcript so far | window |
| `Mod+,` | Settings | window |
| `Alt+↑` `Alt+↓` | Previous / next call | window |
| `?` | Shortcuts sheet | window, outside text fields |
| `Space` | Play / pause | outside text fields |
| `[` `]` | Slower / faster | outside text fields |
| `Shift+←` `Shift+→` | Back / forward 5 s | outside text fields |
| `↑` `↓` | Focus previous / next line | transcript |
| `Enter` | Play the focused line | transcript |
| `E` | Edit the focused line | transcript |
| `1` to `9` | Give the focused line to speaker N | transcript |
| `N` | Name the focused line's speaker | transcript |
| `C` | Copy the focused line | transcript |
| `Shift+F10`, the Menu key | The focused line's menu (W4.4) | transcript |
| `L` or `End` | Back to live | transcript |
| `+` `-` `Mod+0` | Text size up, down, reset | window |
| `Esc` | Close the top dialog, popover, find bar | window |

```
 ┌─────────────────────────────────────────────────────────────┐
 │ > mute                                                      │
 ├─────────────────────────────────────────────────────────────┤
 │   Mute mic                                       ⇧⌘M        │
 │   Stop                                           ⇧⌘R        │
 │   Ask: "mute"                                    ↵          │
 └─────────────────────────────────────────────────────────────┘
```

The palette fuzzy-matches action labels in the current language and in English, lists recent actions first, shows each key, and runs only actions whose condition holds (no Stop when nothing records). Text that matches no action becomes "Ask: <text>", so a question is one keystroke away during a call.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W14.1 | Font keys, Esc, tab arrows, Enter in the notepad | done | DESIGN 7 | Existing tests | has |
| W14.2 | The action registry that buttons, keys, palette, sheet, menus and tooltips all read | P1 | Intent: full programmability; Linear, VS Code | A test lists every registry action and asserts each has a label in en and es and is reachable from the palette; a button not backed by an action fails a lint check | missing |
| W14.3 | Window shortcuts in the table above | P1 | Otter, Granola, MacWhisper, Linear | One test per row: the key runs the action; single-letter keys do nothing inside a text field | missing |
| W14.4 | `?` shortcuts sheet, generated from the registry | P1 | Linear, Otter | The sheet lists every action with keys, in the current language | missing |
| W14.5 | Command palette with "Ask: <text>" fallback | P1 | Linear, VS Code, Obsidian, Raycast, Minutes | `Mod+K`, "catch", Enter runs the Catch me up preset; typing an unmatched question and Enter sends an `ask` | missing |

## 15. Accessibility

Rules for every screen: every control reachable and usable by keyboard alone; focus visible; focus moves into a dialog and back out; state never by colour alone; motion off when the OS asks; text contrast at WCAG AA (4.5:1 for text, 3:1 for large text and control borders); the transcript is a log region, and the user chooses what it announces.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W15.1 | Focus-visible outlines, tab keyboard navigation, native `<dialog>` | done | built | Existing tests | has |
| W15.2 | Contrast: `--faint` meets AA (today 2.83:1 dark, 2.33:1 light). The one accent fill, the welcome's Download, already does: 7.86:1 dark, 5.73:1 light | P1 | Audit (ratios computed from `theme.css`) | The token contrast test in TESTING TS-15b passes in both themes; it fails on today's tokens | partial |
| W15.3 | `prefers-reduced-motion`: no pulse, rise or flash; a fade at most | P1 | Apple HIG; audit: none today | With reduced motion emulated, no element has a running animation (TS-15b) | missing |
| W15.4 | Screen-reader announcements for new lines: all, other speakers only, or off (`a11y.announceLines`); the provisional row is not announced; an answer is announced once when it ends | P2 | Apple HIG; audit | With "others only", a mic line adds no live-region text; a streamed answer changes the live region once | partial |
| W15.5 | Automated accessibility scan with axe-core, a dev-only dependency, on every screen in both themes | P1 | Testing; the ARIA checks in W2.2 and W8.2 need a real scanner, which token parsing cannot replace | The UI suite runs axe on idle, recording, each tab, Settings, first run and each dialog; zero serious or critical findings. A positive control removes a label from one control and the scan fails | missing |
| W15.6 | Forced-colors and increased-contrast support | P2 | Accessibility | With forced colors emulated, controls and states stay visible | missing |
| W15.7 | Theme override: System, Light, Dark; the share viewer follows it | P2 | VS Code, Obsidian | The setting overrides `prefers-color-scheme` | missing |
| W15.8 | Every dialog closes like a window: a × with the accessible name "Close" in its top-right corner, on a title row that stays in sight while the content scrolls; Escape; a click on the backdrop; the focus goes back to the control that opened it, in WebKit too, where a clicked button takes no focus. A stray backdrop click cannot drop a key shown once in server mode: for it the backdrop does nothing. Text typed into the Words and replacements fields stays for the next open. On the Dictation page Escape stops a key recording and nothing more, since a page does not close. Settings, Models and Dictation are pages now (section 11), and leaving them saves what is typed | P0 | Owner: the Dictation page could not be closed from the top | `tests/ui/dialogs.test.ts` opens Words to review, History, Dictionary and the quit question, closes each by ×, Escape and the backdrop, checks the × is in sight scrolled to the end and the focus is back on the opener (Settings is a page since W11.10, Models since W11.11, Dictation since W11.12); `tests/ui/server-page.test.ts` SV-U3 for the key shown once | has |

## 16. Languages: English and Spanish

The interface language is a setting (`app.language`: system, en, es). Transcript text, names and notes are never translated; only akou's own words are.

- One JSON catalog per language in `src/ui/i18n/` and one `t(key, vars)` function, shared by the window, the tray and the notifications. No library.
- Plurals through `Intl.PluralRules`; dates, times and durations through `Intl` with the chosen locale. The 24-hour clock follows the locale unless the user sets it.
- `<html lang>` follows the setting, so screen readers use the right voice.
- Spanish text is written properly, with accents, ñ and opening ¿ and ¡. The consent notice has a reviewed Spanish version.
- The palette matches labels in the current language and in English, so shortcuts learned from English docs still work.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W16.1 | English and Spanish catalogs; every UI string from the catalog | P1 | Spanish is a first-target language; audit: all strings hard-coded English | A test fails if a key exists in one catalog and not the other, and a lint check fails on a string literal assigned to `textContent`, `title` or `aria-label` outside the catalog | missing |
| W16.2 | Locale-aware dates and times (no fixed `en-CA`/`en-GB`) | P1 | Audit | With `es`, the call list shows "25 sept 2026" and a wall time in the locale's format; the CLI keeps its own format | missing |
| W16.3 | Consent reminder and notice text in both languages | P1 | REQ F3.8 carried | With `es`, "Copy a notice" copies the Spanish text | partial |

## 17. Loading, empty and error states

| Place | Empty | Loading | Error |
|---|---|---|---|
| Transcript, no call | "Press Record to start a call." (hark-viewer's text) | n/a | n/a |
| Transcript, call with no lines | live: "Listening. A line appears each time someone pauses."; saved: "No transcript lines in this call." | provisional row | dead-capture banner (red) with the channel named |
| Transcript, echo | n/a | n/a | amber banner when `health {state: echo}` holds: "The microphone hears the call. Headphones fix this." Echo lines stay hidden (W17.3) |
| Recording, disk | n/a | n/a | amber banner at the low-disk threshold: "Disk almost full: about N minutes left", then the stop reason `low-disk` in the call header if it runs out |
| Calls list | the default workspace with "No calls yet"; a search that matches nothing says so | skeleton rows | "Could not read the recordings folder: reason" with Open Settings |
| Notes | the input's placeholder, "Type a note, Enter to add it", with the markers as hints under it | n/a | save failed: the line stays in the input with "Not saved. Retry" |
| Ask | the input with its presets menu, and the call's last answered question if it has one | evidence cards within 300 ms, then the stream | the reason stated, excerpts kept, "Copy context for my agent" (has) |
| Final pass | n/a | progress bar (has) | "Improving the transcript failed: reason" with Retry |
| Models | the welcome with each model, its size and the one Download (has) | bar, bytes of the total, percentage, file (has); speed and time left | the reason with Try again (has) |
| Settings | n/a | n/a | the registry's refusal per key (has) |
| Page lost the app | n/a | "Reconnecting…" | after 10 s: "akou is not running. Open it with `akou open`." Never `akou start`, which records (CLI.md rule 4) |

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W17.1 | Every cell of the table above that says something has a UI test that renders it | P1 | Testing | One test per cell other than "n/a" | partial |
| W17.2 | Error text names the cause and the next step, never a CLI flag, in the window | P1 | Audit (W2.5, the `--boost` and `akou devices` pointers in setting descriptions); CLI-17 runs the same scan for the CLI | A lint over the catalog fails on backticked CLI flags in window strings, except the two command names in the table above; setting descriptions that name a command point at one that exists | partial |
| W17.3 | Echo banner: the health verdict `echo` when echo-marked mic lines pass a share of the last minute, shown once per call with Dismiss | P2 | meeting-transcriber; DESIGN 3 echo rule | A fixture where half the mic lines in a minute are `echo: true` shows the banner once; a fixture with headphones (no echo) never does | missing |

The low-disk threshold, the stop itself and its `part.ended` reason belong to the capture design ([DESKTOP.md](DESKTOP.md) section 9 names it as capture-owned). The window only draws them.

## 18. Decisions this document waits on

The open product decisions are listed once, in [PRINCIPLES.md](PRINCIPLES.md#open-decisions). The ones that change this window:

- **Meeting detection prompt** (open decision 1). The prompt itself would live in DESKTOP's floating indicator (DK-D1), off by default. The window gains nothing until it is decided.
- **Dropped predecessor features** (open decision 2): SRT and VTT export, and importing an audio file as a call (REQUIREMENTS F1.8, F1.11). Both are cheap on the existing fold and final pass.
- **Redaction** (open decision 3). A redaction event that the fold, export and share honour, with the raw text still in `events.jsonl`, fits the append-only log. A true purge would be a separate tool.
- **Screen or slide capture** (open decision 4). Not designed.

## 19. Parking list

Seen, not planned. No acceptance line and no bead until someone asks or a decision moves it.

| ID | Item | Seen in |
|---|---|---|
| W4.5 | Toggle to show hidden echo lines, struck through | Descript |
| W4.7 | Verbatim view that hides fillers at read time, raw kept | VoiceInk, Descript, noScribe |
| W4.12 | Split a line at the caret; needs word timings | MacWhisper |
| W5.9 | Waveform of both channels in the scrubber, from a precomputed peak file | VoiceInk |
| W6.4 | Bold and italic shortcuts in the note input | Granola |
| W6.5 | Paste an image into the notes as an attachment | Granola |
| W6.15 | Dictate a question with the mic, kept out of the transcript | Granola, Otter |
| W6.22 | Chapters as a template section with clickable start times | tl;dv, Zoom, Open Granola |
| W8.5 | Change a speaker's hue | MacWhisper, Descript |
| W8.6 | Talk time per speaker after the final pass | tl;dv, Fathom, Minutes |
| W10.5 | A labelled sample call to try Ask and export, never exported | Granola, Minutes |
| W11.9 | "Send test delivery" button for the webhook; the CLI test is PG-W2 | anarlog, MacWhisper, Fathom |
| W12.9 | "Email these notes" as a `mailto:` draft | Granola |
| W13.5 | Retention: delete audio older than N days, keep the transcript, off by default | anarlog, VoiceInk, Granola |
| W14.6 | Pinned palette actions | Obsidian |
| W16.4 | Pseudo-locale 40 % longer, for layout screenshots | i18n practice |

## P0 list

Five items, each a small pull request, each fixing something that is broken or promised and missing today:

- **W1.1** The notes pane is Notes alone, with no Enhanced tab (TESTING TS-15 proves "hidden means hidden" everywhere).
- **W2.5** Record with missing models is disabled with its reason, and the welcome offers the download, instead of a toast naming a CLI flag.
- **W5.2** The player can pause: a button and `Space`.
- **W6.2** A note edit saves on blur and after a 2 s pause, so clicking away no longer loses it.
- **W12.2** Copy transcript so far, promised as carried from hark and not built.

The window also depends on DESKTOP's P0s for the shell around it (the tray icon, the Edit menu roles, notifications for agent-started calls and dead capture, the quit confirm) and on PG-U1 for `akou://`. They are counted there, not here.

## Summary

- The window stays one page of three columns over the event log. One action registry feeds buttons, keys, the palette, the shortcuts sheet and the menus; one catalog per language feeds every string.
- This file now owns only the window's own content. The tray, menus, notifications, floating indicator, first run, settings registry and engine settings moved to [DESKTOP.md](DESKTOP.md), and `akou://` and presets to [PROGRAMMABILITY.md](PROGRAMMABILITY.md). Their old `W` ids stay as pointers so nothing dangles. The compact strip is gone: DESKTOP's indicator shows no transcript text, and asking goes through `Mod+J` or the palette.
- Five P0s: the stacked tabs, Record waiting for the models with its reason, pausing playback, note edits lost on blur, and Copy transcript so far.
- P1 is what makes the window the best way to follow a call: find in call, real playback with follow-audio, inline edits and per-line speakers through PG-A5, provisional live labels, mark this moment, ask stop, history and copy, a registry-driven Settings form, the keyboard map and palette, AA contrast, reduced motion and an axe scan, and English and Spanish.
- New rows from the critique: Discard in the first 60 s, words for this call, remembered lines and an answer footer in the Ask pane, re-running the final pass, opening on a workspace, and echo and low-disk banners. P3 items moved to a parking list with no beads.
