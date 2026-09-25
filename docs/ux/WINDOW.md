# The window

This document designs akou's main window: what is on screen, in which state, what every control does, which keys drive it, and what we build next. It extends [DESIGN section 7](../DESIGN.md#7-the-window), which stays the source for the parts already built. The other documents in [this folder](./) own the rest: [DESKTOP.md](DESKTOP.md) the tray, menus, notifications, floating indicator, first run and settings plumbing; [CLI.md](CLI.md) the command line; [PROGRAMMABILITY.md](PROGRAMMABILITY.md) the API, MCP, skills and `akou://`. The rules behind every choice are in [PRINCIPLES.md](PRINCIPLES.md). How each line is tested is in [TESTING.md](../TESTING.md), and how those tests run is in [CI-CD.md](../CI-CD.md).

The window is one of two equal ways to drive akou. The other is the harness, through the skill, the CLI and MCP. Both are first class, so nothing here may become the only way to do something an agent also needs.

## 0. The simple version

- **One window, three columns.** Calls on the left, the transcript in the middle, a side pane on the right with three tabs: Notes, Ask, Enhanced. A header on top holds the state, the controls and the pills. A player bar sits under the side pane.
- **Asking is one keystroke away.** `Mod+J` focuses the ask box, and the command palette turns any text it cannot match into a question. The small floating indicator that stays up while the meeting app is in front belongs to [DESKTOP.md](DESKTOP.md) (DK-F1). It carries no transcript text, so it is safe during a screen share, and clicking it brings this window forward.
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
┌ header ─────────────────────────────────────────────────────────────────────────────┐
│ ● Recording  Weekly sync  · 27 min      [15:36] [work] [standup] [Claude Code] [models]│
│ [workspace ▾] [title……………] [template ▾]  ● Record | Mute  Pause  ■ Stop  Share  ⚙      │
│ mic ▮▮▮▮▯▯  call ▮▮▮▮▮▯                                                               │
├ banner (only when something needs attention) ─────────────────────────────────────────┤
├──────────────┬──────────────────────────────────────────┬─────────────────────────────┤
│ Calls        │ transcript                               │ [Notes] [Ask] [Enhanced]    │
│ ▸ today      │ 15:41  Ben    we should move the build   │                             │
│   Weekly…  ● │ 15:41  You    to the new box? which one  │  side pane                  │
│   1:1 Ana    │ …                                        │                             │
│ ▸ yesterday  │ ┆ 15:42  c3?  (still being spoken)  ┆    │                             │
│              │                          [↓ Back to live]│ ▶ 15:41:07  1.0x  mic ◂▸ call│
└──────────────┴──────────────────────────────────────────┴─────────────────────────────┘
```

| Region | Holds | Reads from |
|---|---|---|
| Header | state label and dot, title, elapsed time, pills (clock, workspace, template, provider, models, words to review, languages, shared), controls, level meters | `status` push, the fold |
| Banner | one message at a time, highest severity first, with at most one action button | `health`, provider, models |
| Calls | calls grouped by day, live call on top, failed calls marked | the metadata list |
| Transcript | committed lines, the provisional row, the find bar when open | the fold |
| Side pane | Notes, Ask, Enhanced | the fold and the ask stream |
| Player bar | play or pause, position as wall time, speed, balance | the call's audio |
| Dialogs | Settings, Words (review and vocabulary), share options, speaker popover, shortcuts sheet, command palette | registry and fold |

Under 900 px wide the calls column collapses to a button in the header. Under 640 px the side pane becomes a drawer over the transcript.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W1.1 | The Notes, Ask and Enhanced tabs show one pane at a time | P0 | Audit: `[role="tabpanel"]{display:flex}` in `theme.css` beats `[hidden]`, so all three panes show stacked | For each tab, the other two panes have computed `display: none` and are skipped by Tab. The general "hidden means hidden" invariant with its positive control is TESTING TS-15; this row is the fix that turns it green | has |
| W1.3 | Narrow layouts: calls column collapses under 900 px, side pane becomes a drawer under 640 px | P2 | Audit: at 800 px the sidebar keeps its width | Screenshots at 1280, 800 and 600 px show the described layout; no horizontal scroll | missing |

Moved: W1.2 (tests assert computed visibility) is TESTING TS-15. W1.4 (remember the window frame) is DESKTOP DK-M4.

## 2. States

The header state is one of the rows below. The state machine lives in the main process, and the window only draws it. Every state has a way out, and the table names it.

| State | Label (en / es) | Dot | Enabled controls | Way out |
|---|---|---|---|---|
| No call yet | Ready / Listo | grey | Record, workspace, title, template | Record |
| Starting | Starting… / Iniciando… | amber pulse | Stop | 201 → Recording; failure → Failed to start |
| Recording | Recording / Grabando | red pulse | Mute, Pause, Stop, Share; Discard in the first 60 s | Stop, Pause, Discard (W2.7) |
| Paused | Paused / En pausa | amber | Resume, Stop | Resume, Stop |
| Mic muted | Recording · mic muted | red, mic meter crossed | Unmute, Pause, Stop | Unmute |
| Stopping | Stopping… | grey pulse | none (under 5 s by design) | → Final pass |
| Final pass running | Saved · improving transcript N % | green | Restart, Enhance so far, Copy | → Ready |
| Ready (done) | Saved | green | Restart, Enhance, Export, Share off | Record a new call |
| Failed to start | Could not start: reason | red | Record (retry), open the named settings pane | Retry |
| Ended unexpectedly or interrupted | Ended unexpectedly at 15:52 | red | Restart (same call) | Restart |
| Another call recording | Another call is recording: title | red | Open that call, Stop the other call | either |
| App unreachable (browser page, share viewer) | Reconnecting… / Offline | grey | none | reconnects from last `seq` |

Overlays that stack on any state: models missing or downloading (section 10), provider unavailable (the pill turns amber and the ask pane says why), shared live (red pill with viewer count).

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W2.1 | Header states and banners as in hark-viewer | done | DESIGN 7 | Existing parity tests | has |
| W2.2 | State is never shown by colour alone: every dot has a label, every health dot an icon shape and text | P1 | Accessibility | With forced-colors emulated, each state and channel health is still distinguishable by text; the axe scan (W15.5) reports no colour-only state | partial |
| W2.3 | Only errors use `role=alert`; info toasts use `role=status` | P1 | Audit | An info toast is announced politely; a dead-capture banner assertively | partial |
| W2.4 | Stop while the meeting app still uses the mic: "Call audio was active 12 s ago. Stop anyway?" with a 10 s undo | P1 | DESIGN 7 (M2) | Fake helper reports call audio 5 s ago; Stop shows the inline confirm; Undo within 10 s leaves the call recording with no `part.ended` | missing |
| W2.5 | Record while the speech models are missing offers "Record audio only" instead of a CLI hint | P0 | Audit: the toast says "run `akou models pull` … or start with --without-models" | With no models, Record shows two choices; "Audio only" starts a call with `withoutModels`; the models card stays visible; no string names a CLI flag | partial |
| W2.7 | Discard a mistaken recording in its first 60 s: stops the call and moves it to the Trash (W13.3) before any hand-off runs | P2 | Superwhisper, VoiceInk; REC-05 | Discard at 30 s leaves no call in the list, no export and no `hook.done`; after 60 s the button is gone and Stop is the only way out | missing |

Moved: W2.6 (confirm Quit during a call) is DESKTOP DK-M3.

## 3. Recording: header controls and the shell around the window

### 3.1 Starting and controlling a call

The header controls are the ones hark-viewer had (DESIGN 7). The additions are the input choice, start-muted, words for the call, and marking a moment.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W3.1 | Record, Mute, Pause, Stop, Restart; workspace, title, template pickers | done | DESIGN 7 | Existing tests | has |
| W3.2 | Mark this moment: a button and `Mod+D` star the line being spoken, with an optional label | P1 | Otter, tl;dv, Fathom, MacWhisper | During a call, `Mod+D` writes one `mark` event at the current wall time; the line shows a star; the mark is in the pack for "what did I mark" and in the export | missing |
| W3.3 | Mic and call source picker in the header (idle only) | P1 | REQ F0.7, audit: the window cannot pick devices | The picker lists the devices the API reports; the chosen one is sent as `mic`/`call` on start. Depends on CLI-07 and a devices route in [PROGRAMMABILITY.md](PROGRAMMABILITY.md) | missing |
| W3.4 | Start with the mic muted (checkbox beside Record) | P2 | Minutes | Start with the box ticked writes `mute` before the first mic segment; the mic meter shows muted | missing |
| W3.5 | Silence reminder: after N minutes with no audio on either channel, a banner "Nothing heard for 10 min. Keep recording?" with Keep and Stop; never stops by itself unless the user set an auto-stop | P2 | Minutes, Granola, Wispr; intent: no false alarms | Fake helper silent for the set time shows the banner once; Keep resets it; no banner in a quiet but live call where either channel has speech | missing |
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
| W4.4 | Right-click (and `Shift+F10`) on a line: Play from here, Copy line, Copy with time and speaker, Edit, Change speaker, Fix a word, Mark | P1 | Descript, anarlog; audit: no context menu | Each item runs its registry action; keyboard users reach the same menu | partial: Play from here, Copy line, Copy with time and speaker, Name this speaker and Fix a word, by mouse, `Shift+F10` and the Menu key; Edit and Change speaker wait for PG-A5, Mark for W3.2 |
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
| W4.8 | "Fix this word", then "Everywhere in this call" and "Add to the workspace vocabulary" | done | DESIGN 7 | Existing tests | has |
| W4.9 | Inline edit of a line: `E` or double-click; Enter or blur saves `seg rev+1 by:user`; Esc cancels; an edited line shows a mark and the raw text on hover | P1 | DESIGN 7 (designed, not built), Descript, anarlog | Edit, save, reload: the line shows the new text and the log has one `seg` revision with `by: user`; the raw heard text is still in the log. Needs the segment edit route PG-A5 | partial (style only) |
| W4.10 | Change the speaker of one line: a picker, or keys `1` to `9` on a focused line | P1 | MacWhisper, Descript, anarlog | Pressing `2` on a focused line writes `seg rev+1 {spk}` through PG-A5; the chip updates; merge and unmerge still work on clusters | missing |
| W4.11 | Replace in this call: Find (section 7) plus "Replace all" writes a call-scoped `vocab.add`, the same event as "Everywhere in this call" | P2 | noScribe | Replacing "versal" with "Vercel" changes every match in the view and adds one call-scoped pair; the log keeps raw text | missing |

## 5. Audio sync

The player bar gets real controls. Line-level sync comes first, because it needs nothing new in the log. Word-level sync waits for word timings, which the multi-engine fusion work needs anyway.

```
 ▶ 15:41:07  ───────●─────────── 16:03:40   1.25x   mic ◂──●──▸ call
```

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W5.1 | Play from any line, mic/call balance | done | DESIGN 7 | Existing tests | has |
| W5.2 | Play and pause: a button and `Space` (outside text fields) | P0 | Audit: the player has no controls and nothing can pause it | Start a line, press Space: `player.paused` is true; press again: it resumes from the same position | has |
| W5.3 | Position shown as wall time, a scrubber over the call | P1 | Buzz, MacWhisper, VoiceInk | Seeking to 50 % shows the wall time of that instant, never a bare offset (TRAPS time rule) | has: the scrubber spans the part being played, the unit the audio route serves |
| W5.4 | Speed 0.75x to 2x in 0.25 steps, `[` and `]`, remembered | P1 | Buzz, MacWhisper | `]` twice sets 1.5x; reload keeps it | has |
| W5.5 | Seek back or forward 5 s: `Shift+←` / `Shift+→` | P1 | Otter, MacWhisper | Position moves 5 s; clamps at the part bounds | has |
| W5.6 | Follow audio: the line being played is highlighted and kept in view; scrolling by hand pauses following until "Follow" is pressed | P1 | Buzz | With playback running, the highlighted row's `a0 ≤ t < a1`; a manual scroll stops auto-scroll | has |
| W5.7 | Replay the current line: `R` | P2 | MacWhisper | Seeks to the line's `a0` | missing |
| W5.8 | Word-level highlight and click a word to play it | P2 | Descript, Scriberr, whishper | With word timings in `seg`, clicking a word seeks to its start ±50 ms; depends on word timings in the log | missing |

## 6. The side pane

### 6.1 Notes

```
 [Notes] Ask  Enhanced
 15:38 │ - budget review first
 15:41 │ [] Ben: move build box
 15:44 │ ? which region
 15:47 │ ◆ agent: Ben owns the migration          (agent colour)
       │ ┌─────────────────────────────────────┐
       │ │ Type a note, Enter to add           │
       │ └─────────────────────────────────────┘
```

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W6.1 | Notepad with markers, time gutter, agent lines in their own colour | done | DESIGN 5.1 | Existing tests | has |
| W6.2 | Editing a note saves on blur and after a 2 s pause, not only on Enter | P0 | Audit: clicking away drops the edit, which loses what the user typed; DESIGN 5.1 says Enter or a 2 s pause | Type in an existing note, click the transcript: the log has `note rev+1` with the new text | has |
| W6.3 | Delete a note with a 10 s undo | P1 | Audit: no confirm and no undo | Delete shows "Note deleted · Undo"; Undo restores it as a new revision | partial |

### 6.2 Ask

```
 Notes [Ask] Enhanced
 [ Ask about this call…                       ] [Ask]
 Catch me up · Last 5 min · Was my name mentioned? · Decisions · Action items · What did Ben say?
 ─────────────────────────────────────────────────────
 Remembered  · Ben owns the migration (agent)              ✎
 ─────────────────────────────────────────────────────
 Q  What did Ben say about the budget?         15:52
    Evidence  15:41 Ben "we should move the build…"   ▶
    Ben asked to move the build to the new box [15:41 Ben] …   ■ Stop
    Claude Code · pack 4.1k tokens                Show request · Copy
```

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W6.6 | Ask box, presets, evidence within 300 ms, streamed answer, clickable citations, "Copy context for my agent" when no provider | done | DESIGN 5.3, 7 | Existing tests | has |
| W6.7 | Stop a running answer | P1 | Audit | Stop aborts the provider process; the log has the partial `answer` marked stopped; the box is ready for the next question | missing |
| W6.8 | Past questions and answers of the call are drawn from the log on open and on call switch | P1 | Audit: they vanish on switch; intent: the log is the truth | Ask, switch calls, switch back: the Q&A is there; answers an agent asked through MCP are listed too, marked by client | missing |
| W6.9 | Copy an answer (with citations as `[15:41 Ben]`) | P1 | Granola, audit | Copy puts the answer text on the clipboard with wall-time citations | missing |
| W6.10 | "Last 5 minutes" preset | P1 | Fireflies "Catch Up (Last 1 min)" | The preset sends a question that the query engine routes to the recent window; the pack holds only lines from the last 5 minutes | missing |
| W6.11 | Name-mention marker: when `user.name` or a word in `watch.words` appears in a committed call-channel line, a quiet marker in the transcript. The notification with the window in back needs a row in DESKTOP section 8 and carries no line text | P2 | Zoom, Teams markers; ASK-05 and PG-S4 are the same item at P2 | A fake call line containing the user's name produces one `mention` marker; a mic line with the name produces none | missing |
| W6.13 | "What should I ask next?" preset | P2 | Granola, Fireflies Follow Up | Ships as a preset file (PG-F2) | missing |
| W6.14 | Live memo pane: the rolling memo shown above the Q&A when a provider writes it | P2 | Otter live summary, Fathom | With a memo event, the pane shows it with its time; hidden when there is none | missing |
| W6.23 | Answer footer: the provider and model, the pack size in tokens, and "Show request" with the exact pack sent | P2 | VoiceInk; ASK-11 is marked `has` but only the no-provider path shows the pack | After a fake provider answers, the footer shows its name and the pack's token count; Show request displays the same text the provider received | partial |
| W6.24 | Remembered lines (`remember` events, DESIGN 4.3) listed at the top of the Ask pane, marked by author, editable and retractable by the user as new revisions | P2 | Parity: `akou remember` and `akou_remember` exist, the window cannot see them | An agent's `remember` appears within one push; editing it writes `remember rev+1 by:user`; Retract writes `text: null` and the line leaves the next pack | missing |

Moved: W6.12 (presets as files) is PG-F2; the ask box and the palette draw presets from `GET /presets`.

### 6.3 Enhanced

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W6.16 | Enhance, template switcher, revisions, user versus AI styling, citations | done | DESIGN 5.2 | Existing tests | has |
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
| W9.1 | "Fix this word", "Words to review" pill and dialog, raw text on hover, decode list under the models pill | done | DESIGN 7 | Existing tests | has |
| W9.2 | The vocabulary list is editable in the Words dialog: add a term (with heard forms), remove, confirm, change scope. Today it is a read-only panel in Settings | P1 | Audit: read-only panel; Wispr, VoiceInk, Descript | Adding "Vercel" heard "versal" writes the workspace file through the API; the dialog and `akou vocab list` agree | partial (read-only) |
| W9.3 | An inline edit that changes one word becomes a vocabulary proposal, not an automatic add | P2 | VoiceInk AutoLearn, Descript, Wispr | Editing "versal" to "Vercel" on a line adds a pending proposal to "Words to review"; nothing is written to the vocabulary until Approve | missing |
| W9.4 | Rejected proposals are never proposed again, and the dialog says so | done | DESIGN, `vocab/pass.ts` | Existing tests | has |

## 10. First run and models

[DESKTOP.md](DESKTOP.md) section 11 owns the first-run flow, its steps and their order. The window draws those screens with strings from the catalog (section 16), and the Welcome screen carries the interface language choice next to `user.name`, so everything after it is already in the right language. Every step writes a normal setting; setup has no state of its own.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W10.1 | Models card: size, resumable checksummed download, percentage | done | DESIGN 7 | Existing tests | has |

Moved: W10.2 (guided first run) is DK-O2. W10.3 (3 s capture test) is DK-O1. W10.4 (free space, speed, time left, Cancel) is DK-O3 and DK-E2; the card's progress should arrive on the status push rather than the one-second poll it uses today. W10.5 (sample call) is in the parking list.

## 11. Settings

Settings are drawn from the settings registry, which already validates every value. [DESKTOP.md](DESKTOP.md) section 14 owns the registry fields (`values`, `default`, `group`, `applies`), the group list, the `applies` values, and the Speech engines group; the API side is PG-A3. The window draws whatever the registry says: one form per group, a picker for every key with `values`, the default beside the field, a reset per key, a modified marker, and the `applies` note next to each field. Nothing in the window hard-codes a key, a group or an engine. The same fields generate the CLI help and the reference table, so the docs cannot drift ([TRAPS](../TRAPS.md) rule on generated docs).

```
 Settings                                          [ search settings…      ]
 ┌───────────────────┬────────────────────────────────────────────────────┐
 │ Recording         │ Microphone            [ System default      ▾ ]   │
 │ Speech engines    │   capture.mic · applies next call        ↺ reset  │
 │ Provider          │ Call audio            [ Whole computer      ▾ ]   │
 │ Export and hooks  │ ▎Stop budget          [ 5 ] s   (default 5)       │
 │ Sharing           │   modified                                         │
 │ Shortcuts         │                                                    │
 │ Appearance        │ Edit config.json…                                  │
 └───────────────────┴────────────────────────────────────────────────────┘
```

The group names in this sketch follow DK-S1; if that list changes, the sketch follows it.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W11.1 | Registry-driven form, secrets write-only, file-only keys read-only | done | DESIGN 7 | Existing tests | has |

Moved, all to [DESKTOP.md](DESKTOP.md) unless named: W11.2 (labels, groups, pickers, reset) is DK-S4 with PG-A3. W11.3 (when each key applies) is DK-S1, DK-K3 and DK-L2. W11.4 (`app.headless` not a live checkbox) is DK-L3. W11.5 (settings search) is DK-S4. W11.6 (Speech engines section) is DK-S3; the engine registry it draws from is not designed yet and is listed as lagging in PRINCIPLES, since [DESIGN](../DESIGN.md) still describes one engine. W11.7 (hotkey recorder) is DK-K5. W11.8 (no `Ctrl+Alt` default) is DK-K4. W11.9 (webhook test button) is in the parking list; the test itself is PG-W2.

## 12. Hand-off, export and sharing

The window shows where a call went and gives the one-click ways out. It does not grow connectors: email, chat and task tools are the user's harness or hooks.

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W12.1 | Hand-off status line: export path, hook results, webhook result | done | DESIGN 7 | Existing tests | has |
| W12.2 | Copy transcript so far: `Mod+Shift+C`, palette, header menu | P0 | REQ F1.42 marks it carried from hark (`y`), and it is not built; Granola, Fathom, Buzz | During a call, the clipboard gets the transcript rendered as the export's `## Transcript` section; after the final pass, the final layer | partial: key and header button; the palette entry comes with W14.5 |
| W12.3 | Copy the whole call as Markdown (the export render) | P1 | Wispr, Granola | The clipboard equals the export file body for that call | missing |
| W12.4 | Reveal the export in the file manager; open it in the default app | P1 | Desktop craft | Native smoke: the button opens the folder with the file selected | missing |
| W12.5 | Re-run hooks and re-export from the window | P2 | Audit: CLI-only | Buttons call the hooks route; a `hook.done` appears | missing |
| W12.6 | Live share with a red pill, viewer count and Stop; copy link | done | DESIGN 8.3 | Existing tests | has |
| W12.7 | Share options before starting: include names, notes, enhanced; expiry; bind address | P2 | DESIGN 8.3 options; audit: the window cannot choose them | The dialog sends the options; the viewer shows only what was included | missing |
| W12.8 | Follow-up email draft as a shipped template that produces text to copy; nothing is sent | P2 | Granola, tl;dv, Fathom, Amurex | Choosing the template yields a draft; Copy works; there is no send action | missing |
| W12.10 | Run the final pass again from the call's menu, for example after choosing other engines, the window's equal of `akou finalize` | P2 | Parity: the CLI has `finalize`, the window only has Retry after a failure (section 17) | Run again on a finished call writes a new final layer and `final.done`; the previous layer stays in the log; the button is disabled while the call records | missing |

## 13. Calls list

| ID | Feature | P | From | Accept | Today |
|---|---|---|---|---|---|
| W13.1 | Calls grouped by date, live call on top, failed calls marked, switch without reload | done | DESIGN 7 | Existing tests | has |
| W13.2 | Retitle a call and move it to another workspace | P1 | Audit: no rename anywhere | Rename goes through PG-A4 and writes a `call.retitled` event; the export file is found again by `akou_id` and renamed on the next export | missing |
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
| `Mod+1` `Mod+2` `Mod+3` | Notes, Ask, Enhanced (focus its input) | window |
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
| W15.2 | Contrast: `--faint` and the dark-theme Record button meet AA (today 2.83:1 dark, 2.33:1 light, white on dark accent 2.43:1) | P1 | Audit (ratios computed from `theme.css`) | The token contrast test in TESTING TS-15b passes in both themes; it fails on today's tokens | partial |
| W15.3 | `prefers-reduced-motion`: no pulse, rise or flash; a fade at most | P1 | Apple HIG; audit: none today | With reduced motion emulated, no element has a running animation (TS-15b) | missing |
| W15.4 | Screen-reader announcements for new lines: all, other speakers only, or off (`a11y.announceLines`); the provisional row is not announced; an answer is announced once when it ends | P2 | Apple HIG; audit | With "others only", a mic line adds no live-region text; a streamed answer changes the live region once | partial |
| W15.5 | Automated accessibility scan with axe-core, a dev-only dependency, on every screen in both themes | P1 | Testing; the ARIA checks in W2.2 and W8.2 need a real scanner, which token parsing cannot replace | The UI suite runs axe on idle, recording, each tab, Settings, first run and each dialog; zero serious or critical findings. A positive control removes a label from one control and the scan fails | missing |
| W15.6 | Forced-colors and increased-contrast support | P2 | Accessibility | With forced colors emulated, controls and states stay visible | missing |
| W15.7 | Theme override: System, Light, Dark; the share viewer follows it | P2 | VS Code, Obsidian | The setting overrides `prefers-color-scheme` | missing |

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
| Transcript, no call | "No call yet. Press Record, or start one from your agent with `akou start`." (hark-viewer text) | n/a | n/a |
| Transcript, call with no lines | "Listening. Lines appear about a second after someone finishes a sentence." | provisional row | dead-capture banner (red) with the channel named |
| Transcript, echo | n/a | n/a | amber banner when `health {state: echo}` holds: "The microphone hears the call. Headphones fix this." Echo lines stay hidden (W17.3) |
| Recording, disk | n/a | n/a | amber banner at the low-disk threshold: "Disk almost full: about N minutes left", then the stop reason `low-disk` in the header if it runs out |
| Calls list | "Your calls will be listed here." | skeleton rows | "Could not read the recordings folder: reason" with Open Settings |
| Notes | the input placeholder with the markers | n/a | save failed: the line stays in the input with "Not saved. Retry" |
| Ask | presets only | evidence cards within 300 ms, then the stream | the reason stated, excerpts kept, "Copy context for my agent" (has) |
| Enhanced | "Enhance turns your notes and the transcript into clean notes." | progress with the template name | the reason, the previous revision still shown |
| Final pass | n/a | progress bar (has) | "Improving the transcript failed: reason" with Retry |
| Models | card with size and Download (has) | progress, speed, time left | checksum or network error with Resume |
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
| W10.5 | A labelled sample call to try Ask, Enhance and export, never exported | Granola, Minutes |
| W11.9 | "Send test delivery" button for the webhook; the CLI test is PG-W2 | anarlog, MacWhisper, Fathom |
| W12.9 | "Email these notes" as a `mailto:` draft | Granola |
| W13.5 | Retention: delete audio older than N days, keep the transcript, off by default | anarlog, VoiceInk, Granola |
| W14.6 | Pinned palette actions | Obsidian |
| W16.4 | Pseudo-locale 40 % longer, for layout screenshots | i18n practice |

## P0 list

Five items, each a small pull request, each fixing something that is broken or promised and missing today:

- **W1.1** The three side-pane tabs show one pane at a time (TESTING TS-15 proves the rule everywhere).
- **W2.5** Record with missing models offers "Record audio only" instead of naming a CLI flag.
- **W5.2** The player can pause: a button and `Space`.
- **W6.2** A note edit saves on blur and after a 2 s pause, so clicking away no longer loses it.
- **W12.2** Copy transcript so far, promised as carried from hark and not built.

The window also depends on DESKTOP's P0s for the shell around it (the tray icon, the Edit menu roles, notifications for agent-started calls and dead capture, the quit confirm) and on PG-U1 for `akou://`. They are counted there, not here.

## Summary

- The window stays one page of three columns over the event log. One action registry feeds buttons, keys, the palette, the shortcuts sheet and the menus; one catalog per language feeds every string.
- This file now owns only the window's own content. The tray, menus, notifications, floating indicator, first run, settings registry and engine settings moved to [DESKTOP.md](DESKTOP.md), and `akou://` and presets to [PROGRAMMABILITY.md](PROGRAMMABILITY.md). Their old `W` ids stay as pointers so nothing dangles. The compact strip is gone: DESKTOP's indicator shows no transcript text, and asking goes through `Mod+J` or the palette.
- Five P0s: the stacked tabs, audio-only recording without models, pausing playback, note edits lost on blur, and Copy transcript so far.
- P1 is what makes the window the best way to follow a call: find in call, real playback with follow-audio, inline edits and per-line speakers through PG-A5, provisional live labels, mark this moment, ask stop, history and copy, a registry-driven Settings form, the keyboard map and palette, AA contrast, reduced motion and an axe scan, and English and Spanish.
- New rows from the critique: Discard in the first 60 s, words for this call, remembered lines and an answer footer in the Ask pane, re-running the final pass, opening on a workspace, and echo and low-disk banners. P3 items moved to a parking list with no beads.
