# Desktop integration

How akou lives on the desktop around its window: the tray or menu bar item, global hotkeys, the application menu, the floating recording indicator, notifications, start at login, first run and permissions, updates, the model manager, the settings registry and the speech-engine settings, and the privacy indicators that tie them together. It covers macOS, Windows and Linux.

The main window is in [WINDOW.md](WINDOW.md), the command line in [CLI.md](CLI.md), the `akou://` scheme and OS automation in [PROGRAMMABILITY.md](PROGRAMMABILITY.md) section 8. The rules every line here follows are in [PRINCIPLES.md](PRINCIPLES.md), and the gap list against other tools is in [COMPETITOR-MATRIX.md](COMPETITOR-MATRIX.md). How the lines are tested is in [TESTING.md](../TESTING.md) and [CI-CD.md](../CI-CD.md). The architecture behind the shell is [DESIGN.md](../DESIGN.md) sections 1.4, 1.5, 7 and 9.

## 0. The simple version

- **The tray item is the app when the window is closed.** It always has an icon, and the icon alone says idle, recording, paused, degraded or shared. Its menu reaches Record, Stop, Mute, Pause, the last calls and Quit.
- **One small floating window does three jobs.** While recording it is the indicator with Stop. It carries no transcript text, so it can stay up during a screen share. It is also where every prompt with a button goes, because ElectroBun's notifications have none: an auto-stop countdown the user switched on, and the consent reminder for calls an agent started.
- **Notifications only inform.** A short fixed list of events (a call started by something other than the window, capture dead, a start refused, notes ready, a hand-off failed), never with call content, and quiet while the window is in front.
- **First run proves capture works.** Each permission gets one screen with one button, then a 3 s test per channel with meters. A missing system-audio grant shows up before a real call, not after it.
- **Speech engines are rows from a registry.** The model manager and the engine settings draw whatever engines the registry lists. Adding an engine is one registry entry and its runtime adapter. No screen changes.
- **Every setting says when it takes effect, and the ones that can apply at once do.** A hotkey change re-registers the hotkey. A login-item change writes the login item.
- **akou makes no network call you did not ask for.** The update check is off until you switch it on.

**Ownership.** This file owns the tray, the application menu, the Dock, the floating indicator, notifications, the quit path, the first-run flow, the settings registry fields and group list, and the speech-engine settings. Its ids and priorities are the ones beads use. [WINDOW.md](WINDOW.md) sections 3.2, 10 and 11 point here, and the matrix rows mirror these ids:

| Here | WINDOW.md | COMPETITOR-MATRIX.md |
|---|---|---|
| DK-T1, DK-T2 | W3.9 | SYS-01, SYS-02 |
| DK-T3, DK-T4 | W3.14 | SYS-03 |
| DK-M1 | W3.8 | WIN-04 |
| DK-M2 | W3.10 | |
| DK-M3 | W2.6 | WIN-16 |
| DK-F1 | W3.6 (was the compact strip) | |
| DK-F3 | | SYS-05 |
| DK-N1, DK-N2, DK-N4 | W3.11 | SYS-04 |
| DK-N3 | W3.12 | SYS-04 |
| DK-P3 | W3.7 | WIN-07 |
| DK-K4, DK-K5, DK-K6, DK-K7 | W11.7, W11.8 | KEY-07, KEY-08 |
| DK-O1, DK-O2, DK-O3 | W10.2, W10.3, W10.4 | |
| DK-S1, DK-S4 | W11.2, W11.3, W11.5 | SET-01, SET-03, SET-04 |
| DK-S3 | W11.6 | SET-05 |
| DK-D1 | | REC-18 |

Where a matrix row carries another priority, the one here wins, for the reason given on the line (WIN-07 is P1 here because it depends on a spike). `akou://` is owned by [PROGRAMMABILITY.md](PROGRAMMABILITY.md) PG-U1. Tray and notification strings come from the message catalog WINDOW.md defines.

The shell is already built behind a seam. `NativeUi` in `src/main/window/shell.ts` wraps ElectroBun, so the tray, hotkey, quit path and notification policy are unit-tested with a fake and nothing opens a window in a test. Every line below keeps that seam.

## 1. What we do not build

| Not built | Why | What covers the need |
|---|---|---|
| Auto-recording by default | Non-goal: akou starts only when a person or an agent asks ([PRINCIPLES.md](PRINCIPLES.md)). [ROADMAP.md](../ROADMAP.md) allows a per-app opt-in, off until chosen; whether to build it is open decision 1 | DK-D1, if the answer is yes |
| A calendar connector, calendar reminders, "Coming up" lists | akou would keep a calendar database and grow toward a knowledge tool | The `akou` skill reads the invite through the harness and starts with the title and attendees (`akou start -t … --vocab …`) |
| Listening to audio to detect a meeting | Detection must never be a second recorder | The OS already knows which process holds the microphone (DK-D1) |
| Transcript text, answers or an ask box in the floating indicator | It stays on top while the user shares their screen | Its Ask button brings the window forward with the ask box focused (`Mod+J`); the palette turns text into a question (WINDOW W14.5) |
| An update check on by default, or a GitHub API poll next to the updater | akou makes no network call the user did not ask for ([PRINCIPLES.md](PRINCIPLES.md) principle 10, [CLI.md](CLI.md) section 1) | The opt-in check through ElectroBun's `Updater` (DK-U1) |
| A menu bar popover or a mini app in the tray | Apple's guideline: a menu bar extra shows a menu, not a popover | The tray menu plus the floating indicator |
| Notification action buttons through a patched ElectroBun | A fork to maintain for one feature | The floating indicator carries every button (DK-F2) |
| A start or stop sound on by default | The mic hears it, so the call hears it | Parked as an opt-in cue (section 18) |
| Mobile, watch or in-person capture apps | Outside the three desktop targets | The share link lets a phone view a live call ([DESIGN.md](../DESIGN.md) 8.3) |
| Signed builds and notarization now | Builds are unsigned for now | The update notice links the release (DK-U1); signing returns in a later milestone |

## 2. Priorities and the shape of a line

The same scale as [PROGRAMMABILITY.md](PROGRAMMABILITY.md) section 2:

- **P0**: a control that silently does nothing, a promise the repo makes that does not hold, or a hole in the rule that recording never stops silently and is never hidden. Before the next release. Here a P0 is also small: one PR fixes it. Design work and new surfaces are P1 even when they close a gap.
- **P1**: part of the UX milestone.
- **P2**: the milestone after, or when the P1 it builds on lands.
- **P3 and undecided features**: the parking list in section 18. A name, where it was seen and one line. No acceptance and no bead until someone asks for it.

Every line in a table has an id (`DK-…`), a priority, where it comes from (our intent, our design, a gap found in the code, a competitor, or a platform guideline), an acceptance check that can fail, and what akou has today: **has**, **partial** or **missing**, read from `origin/main`. A line becomes one bead: the id goes in the title and the acceptance check in the acceptance field.

## 3. What each OS gives us

ElectroBun 2.0.1 decides most of what is cheap and what is hard. These facts come from its SDK and its shipped native library, and each one shapes a line below.

| Capability | macOS | Windows | Linux |
|---|---|---|---|
| Tray item | Status item; `Tray` takes an `image` and a `template` flag, so the OS recolours it for dark and light menu bars | Notification-area icon | Ayatana AppIndicator: icon and menu; no raw click on the icon; stock GNOME shows no tray without the AppIndicator extension |
| Global hotkey | An `NSEvent` global monitor, which needs the Accessibility grant and can register without ever firing ([electrobun#334](https://github.com/blackboardsh/electrobun/issues/334)). The issue says the grant lands on the launcher bundle, so which process a grant check must run in is unverified. No Carbon `RegisterEventHotKey` in the library | Global registration | X11 grab; Wayland needs the GlobalShortcuts portal |
| Notifications | `Utils.showNotification`: title, subtitle, body, silent. No action buttons, no click event | Same API; behaviour to verify | Same API; behaviour to verify |
| Always-on-top small window | `setAlwaysOnTop`, `setVisibleOnAllWorkspaces`, `titleBarStyle: "hidden"`, `transparent` | Same | Same; stacking depends on the compositor |
| Hiding a window from screen capture | Not in the SDK. `BrowserWindow.ptr` exposes the native window, so `NSWindow.sharingType` can be set through `bun:ffi`; whether current screen sharing honours it must be measured | Not in the SDK; `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` through `bun:ffi` on Windows 10 2004 and later | No reliable way: the compositor decides |
| Dock | `reopen` event, `Utils.setDockIconVisible` | n/a | n/a |
| URL scheme, file types | `urlSchemes`, `fileAssociations`, delivered as `open-url`. The scheme registers only when the app is in `/Applications`, and [install.md](../install.md) also allows `~/Applications` | "Not yet supported" | "Not yet supported" |
| Updater | `Updater` with delta patches and a full-bundle fallback, fed from a static `release.baseUrl`. `Updater.checkForUpdate()` reads the `<platform>-update.json` manifest without applying anything | Same, with the truncation bug DESIGN 9 names | Same |
| Start at login | LaunchAgent (built) | `HKCU` Run key (built) | XDG autostart (built); the Background portal inside Flatpak |
| Which process holds the mic | Core Audio process objects, which the helper already lists for per-app capture (`kAudioHardwarePropertyProcessObjectList`) | Audio sessions on the capture endpoint (`IAudioSessionManager2`) | PipeWire or PulseAudio source outputs with their process |
| Microphone permission | A prompt, attributed to the app that spawned the helper | Settings > Privacy > Microphone, with a deep link | None outside a sandbox |
| System-audio permission | A prompt for the process tap. We know of no public call that reports its state, so the only proof is audio arriving | None for loopback | None |

## 4. Tray and menu bar

Today the tray always has an image: one idle icon per OS, drawn by `scripts/tray-icons.ts` (a template PNG on macOS, an ICO on Windows, a PNG for the AppIndicator), and a text title while recording or sharing (`trayTitle` in `shell.ts`). The menu has Record or Stop, Show akou, Open at login and Quit. A tray or hotkey start that is refused says why in a notification.

The design is a monochrome template icon per state, a text title only as an extra (the elapsed time while recording), and a menu that controls a running call without the window.

Tray states, in priority order when several hold: **dead or permission-suspect** (a warning mark), **shared** (the recording dot with a ring), **recording** (a filled dot), **paused** (two bars), **final pass running** (a small progress mark), **update ready** (a badge), **idle** (the plain mark). Each has a distinct shape, never only a colour ([PRINCIPLES.md](PRINCIPLES.md) principle 12), and a tooltip that says it in words.

The menu while recording:

```
● Recording "Standup" · 12:04 since 15:36
  Mute microphone            (the global mute key, if set)
  Pause
  ■ Stop recording           ⌥⌘R
  Copy last 5 minutes
──────────
  Stop sharing               (only while shared)
  Show akou
  Recent calls  ▸  (last five, opens the window on one)
──────────
  Open at login  ✓
  Check for updates…
  Quit akou
```

While idle the first item is `● Record` with a submenu `Record in workspace ▸` listing the workspaces. Call titles appear in the menu because only the person at the machine sees it. They never appear in a notification (section 8). "Copy last 5 minutes" puts that stretch of the transcript on the clipboard with wall-clock times, the tray's version of hark-viewer's "Copy transcript so far", for pasting into a chat while the window stays closed.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| DK-T1 | A template tray icon, shipped as image assets per OS (template PNG on macOS, ICO on Windows, PNG for AppIndicator), always set, including idle. One image is enough for this line; the existing text title keeps showing recording state | P0 | gap: no image in the repo, empty idle title; Apple HIG menu bar extras | A shell unit test asserts `createTray` receives an image, and a positive control with no image fails it. On the reference Mac, the idle item is visible in a dark and a light menu bar (screenshots recorded in the release checklist). On Ubuntu with the AppIndicator extension, the icon shows | has (unit test); the menu bar and Ubuntu checks are in the release checklist |
| DK-T2 | One icon per state (dead, shared, recording, paused, final pass, update, idle) with `setImage`, plus a tooltip in words | P1 | intent: glanceable state; DESIGN 8.3 promises "a changed tray icon" while sharing | A table-driven test over `AppStatus` fixtures asserts the icon and tooltip for each state and the priority when several hold. A positive control feeds a dead-and-shared status and expects the dead icon | partial (text title only) |
| DK-T3 | Elapsed time in the title while recording, updated once a second on macOS; off with `app.trayTimer` set to false | P2 | Granola floating timer; tray apps | A fake-clock test advances 61 s and sees `1:01`; with the setting off, the title stays empty | missing |
| DK-T4 | Menu items Mute, Pause, Copy last 5 minutes, Stop sharing, Recent calls, Record in workspace, Check for updates | P1 | gap vs hark controls; SYS-03; intent: every action through every door | Unit test of `trayMenu` per state lists the items. Clicking each through the fake calls the same app method the window calls (one parity test). Copy last 5 minutes on a fake call puts exactly the lines of the last 5 minutes, with times of day, on the fake clipboard | partial (Record, Stop, Show, Login, Quit) |
| DK-T5 | A tray start that fails says why: a notification with the reason, and the window shown on its models or permission card | P0 | gap: a failed tray or hotkey start only writes a log line | With models missing, the fake tray's Record produces one notification whose body names the window's download card, and the window opens on it | has (models card; a refused start for a permission names the privacy pane, since the window's permission banner shows only during a call) |
| DK-T6 | Linux without a tray: the window, the hotkey and the CLI reach every tray action; [install.md](../install.md) names the GNOME AppIndicator extension | P1 (M4) | GNOME Shell shows no tray by default | The parity test from DK-T4 also runs with the tray disabled and finds each action in the window; the install doc line exists | missing |

## 5. Global hotkeys

Today there is one hotkey, `app.hotkey`, default `Option+Command+R` on macOS and `Control+Shift+F9` elsewhere (DK-K4; it was `Control+Alt+R`). It is registered once at start. A change waits for a restart and nothing says so. When registration fails, only the log hears about it.

Two problems are platform facts, not bugs in our code. On macOS, ElectroBun's global monitor needs the Accessibility grant. Without it the hotkey registers and never fires, so `register()` returning true proves nothing. On Windows and Linux, `Ctrl+Alt` is AltGr on many European layouts, Spanish included, so a global grab on `Ctrl+Alt+R` can swallow a typed character.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| DK-K1 | macOS: check the Accessibility grant (`AXIsProcessTrusted` through `bun:ffi`) at start and on every hotkey change. When it is missing, the Settings hotkey row, the onboarding hotkey step and `akou doctor` say "the hotkey needs Accessibility" with a button that opens that pane. First, record which process the grant must be checked in: the launcher bundle or the Bun process that owns the monitor | P1 | [electrobun#334](https://github.com/blackboardsh/electrobun/issues/334); trap candidate below | A hardware note under `docs/gates/` records which process reports the grant, with the grant on and off. On a Mac with the grant removed, `akou doctor --json` reports `hotkey: needs-accessibility` and the Settings row shows the button. Unit test: a fake that reports no grant yields the warning; a fake with the grant yields none | missing |
| DK-K2 | macOS: a hotkey that needs no grant, through Carbon `RegisterEventHotKey` (an upstream ElectroBun change or a small native addon), decided by a one-day spike | P2 | ElectroBun #334 | With Accessibility not granted, pressing the hotkey on the reference Mac starts a call (hardware check). DK-K1's warning disappears for this path | missing |
| DK-K3 | A changed `app.hotkey` re-registers at once from any door (window, `akou config set`, `PATCH /config`). A refusal comes back as an error on that door | P0 | gap: the setting takes effect only after a restart, and `PATCH /config` says "at the next start" for every key | `PATCH /config {"app.hotkey": "…"}` against the fake shell unregisters the old accelerator and registers the new one. A fake that refuses registration makes the PATCH answer `409 hotkey_taken` and keeps the old one | missing |
| DK-K4 | A default for Windows and Linux with no `Ctrl+Alt` and no common application shortcut. Settings warns when a typed hotkey contains `Ctrl+Alt` | P1 (M3) | Microsoft keyboard guidelines (AltGr) | A unit test over `hotkeyFor` asserts no default contains `Control+Alt` off macOS, and the validator warns for `Control+Alt+X`. The test keeps a list of known collisions (browser reload, Game Bar, AltGr) and checks the chosen default against it | has: `Control+Shift+F9` off macOS, and Settings warns under the field (unit test in `tests/desktop.test.ts`) |
| DK-K5 | A hotkey recorder in Settings: press the keys, see them as keycaps, see a conflict or a refusal, save | P1 | Raycast recorder | A Playwright test presses a combination into the recorder and the saved value equals the accelerator string. Pressing a taken combination on the fake shows the conflict text | missing |
| DK-K6 | A second global hotkey for mute (`app.hotkeyMute`, empty by default) | P2 | VoiceInk and Superwhisper multiple shortcuts; intent: keyboard first during a call | With the setting set, the fake hotkey toggles mute on the live fake call and back. Empty registers nothing | missing |
| DK-K7 | Wayland: bind through the GlobalShortcuts portal and show the trigger the portal returns | P2 (M4) | XDG GlobalShortcuts portal; ROADMAP M4 | On a Wayland session, akou calls `BindShortcuts` and Settings shows the portal's trigger description (manual check on Ubuntu 24.04 GNOME, recorded) | missing |

In-window shortcuts (focus notes, focus ask, mark a moment, play and pause, the shortcut sheet) are in [WINDOW.md](WINDOW.md). Only keys that work while another app is in front belong here.

## 6. The application menu, the Dock and quitting

On macOS akou sets the application menu with ElectroBun's Edit roles, which are what give editable web content the system copy, paste, undo and select-all shortcuts. Quit is the `quit` role, which runs the same before-quit path as the tray. Windows and Linux have no application menu to set, and their webviews handle the clipboard keys themselves. "Check for updates…" joins the menu with DK-U1, and "Show logs folder" once the app writes a log file: an item with nothing behind it would be a control that does nothing. Closing the window leaves the app running, by design; clicking the Dock icon opens it again, or brings it forward. Quitting from the tray, the menu or `⌘Q` during a recording asks first, and the window opens where it was left.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| DK-M1 | An application menu with the system roles: akou (About, Settings… `⌘,`, Check for updates…, Hide, Quit `⌘Q`), Edit (undo, redo, cut, copy, paste, select all), Window (minimize, zoom, close `⌘W`), Help (Open the docs, Show logs folder). On Windows and Linux, the same items where the platform has a menu | P0 | ElectroBun Edit roles; Apple HIG menu bar | On the packaged macOS app, `⌘C` and `⌘V` copy and paste in the notepad and the ask box (hardware check recorded). Unit test: the menu passed to the fake contains the Edit roles | partial: the Edit roles and the rest of the menu (unit test); Check for updates… waits for DK-U1 and Show logs folder for a log file; the keyboard check is in the release checklist |
| DK-M2 | Handle `reopen`: clicking the Dock icon with no window shows the window | P1 | ElectroBun `reopen` event | Shell test: a fake `reopen` with no window calls `openWindow`; with a window, it brings it forward | has (`tests/desktop.test.ts`) |
| DK-M3 | Quitting while a call records asks first: "A call is recording. Stop it and quit?" with Cancel as the default. The question is asked in the window, never in the SDK's message box, which blocks the main process (TRAPS "A synchronous SDK dialog"). What `akou quit` does during a call is in [CLI.md](CLI.md) | P0 | intent: recording never stops by accident | Shell test: quit with a live fake call asks the fake page, and on Cancel the call is still recording. On Stop and quit, the log gets `part.ended {reason: stop}` before exit (`stop` is the reason every user stop writes). UI test: Cancel has the focus, Return and Escape keep the call | has: the tray, the menu's Quit and `⌘Q` ask in the window (`tests/desktop.test.ts`, `tests/ui/desktop.test.ts`); `akou quit` is CLI.md's |
| DK-M4 | Remember the window's frame and restore it inside the visible work area | P1 | gap: the window always opens at 1280 by 820 | Close at a frame, reopen, same frame. A saved frame off every display is clamped into the primary work area (unit test on the clamp function) | has: `shell.json` in the config folder, `placeFrame` (`tests/desktop.test.ts`) |
| DK-M6 | "Install command-line tool" in the akou menu: links the bundled `akou` into a folder on PATH, asking for a password only if the folder needs one | P1 | DESIGN 6.1 promises it; [install.md](../install.md) asks for a manual tarball step | On a clean Mac the menu item makes `akou --version` work in a new terminal and match the app's version (hardware check). A second run says it is already installed | has: the menu item, the link and the password path (`tests/desktop.test.ts`); the app carries `akou` since this change (`smoke-app.ts` runs it from the bundle); the clean-Mac terminal check is in the release checklist |

DK-M5 (Dock visibility modes) is in the parking list.

## 7. The floating indicator

This is the one design for akou's second window. It replaces the compact strip WINDOW.md used to carry (W3.6), and the setting `app.floatingIndicator` replaces `window.compactOnRecord`.

One small always-on-top window, no title bar, draggable, its position remembered. It shows only while a call records or a prompt is waiting, and only while the main window is closed or not in front, so switching to the meeting app is all it takes to get it. It has three jobs:

1. **The indicator.** A recording dot, the elapsed time, two thin level bars (you, the call), Mute, Ask and Stop. A degraded capture turns the dot into the warning mark with one word ("call side silent"). Ask brings the main window forward with the ask box focused. Clicking the body shows the main window on the call.
2. **Prompts with buttons.** The countdown of an auto-stop rule the user switched on, "Low disk. Stopping in 30 s" or "Maximum length reached. Stopping in 30 s", with Keep recording (matrix REC-02 and REC-03). The "Record this call?" prompt, only if open decision 1 is answered yes (DK-D1). The confirm for a link that asks akou to record, only if [PROGRAMMABILITY.md](PROGRAMMABILITY.md) PG-U2 ships. A prompt that nobody answers dismisses itself and does nothing.
3. **The consent reminder for calls the window did not start.** When an agent or the CLI starts a call, the indicator shows "Remember to tell the others" with Copy a notice for the first 10 s, the same text the window shows.

It shows no transcript text, no speaker names and no answers, so it is safe to leave visible during a screen share. It is also hidden from capture along with every other akou window where the OS allows (DK-P3).

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| DK-F1 | The floating indicator: dot, elapsed time, level bars, Mute, Ask, Stop, click to open; draggable, position remembered; hidden while the main window is focused; `app.floatingIndicator` on by default | P1 | Granola floating nub; Wispr Flow bar; MacWhisper overlay; intent: reach the live call during the call | UI test against the indicator page with a fake call: Stop stops, Mute mutes, Ask focuses the main window's ask box, and the dot changes on a `health {state: dead}` event. A content test renders the page with segments, a title and names carrying unique markers and finds none of them; a positive control injects one and fails. Shell test: the indicator window is created on `call.created`, hidden on focus of the main window, closed on `part.ended` | has: `src/ui/indicator.ts` in its own ElectroBun view; UI tests drive it inside the real shell (`tests/ui/desktop.test.ts`), shell tests in `tests/desktop.test.ts`. The look over a real meeting and the drag are in the release checklist |
| DK-F2 | The indicator as the prompt surface: a queue of at most one prompt, each with a timeout and a "do nothing" default | P1 | ElectroBun notifications have no buttons | Unit test: two prompts queue in order; a timed-out prompt performs no action and writes nothing to the log | missing |
| DK-F3 | Consent reminder for calls not started from the window, with Copy a notice | P1 | intent: an agent-started recording is announced on the machine | Starting a fake call with `by: "agent"` shows the reminder for 10 s. `by: "user"` from the window does not (the window has its own) | partial (window only) |

## 8. Notifications

Native notifications carry information only. Any action goes through the tray, the floating indicator or the window. The policy is one pure function, `notifyFor(event, context)`, so it is table-tested.

| Event | Title | Body | When |
|---|---|---|---|
| A call started, not from the focused window | Recording started | "Started by an agent" / "from the command line" / "from the hotkey", from the call's `by` | Always, even with notifications at `errors` |
| Capture dead or permission-suspect | Call side silent / Microphone silent | What akou is doing about it ("rebuilding", "check the permission") | Window not focused |
| A start refused (hotkey, tray, agent) | Could not start recording | The reason, naming a window card or a setting that exists | Always |
| Recording stopping or stopped by a rule (low disk, maximum length) | Recording stopping / Recording stopped | The rule, in words | Always |
| Recovered after a crash | akou recovered a call | "The recording up to the crash is saved" | At the next launch |
| Final pass done or failed | Transcript ready / Final pass failed | Nothing more | Window not focused |
| Hand-off failed (export, hook, webhook) | Hand-off failed | Which stage | Window not focused |
| A share link started by an agent | This call is shared live | "Stop it from the akou window" (the tray too, once DK-T4 adds Stop sharing) | Always |

Rules:

- **No call content.** No transcript text, no speaker names, no call titles, no workspace names. Notifications show on lock screens and in shared screenshots. DK-N4 is the one check for this rule, and every other doc that states it points there.
- **Quiet while the window is in front**, except the rows marked "Always". The window already shows the same thing as a banner.
- **One setting**, `app.notifications`: `all` (default), `errors` (the "Always" rows and the failures), `off` (the "Always" rows only, because an unseen start is a privacy hole).
- **Deduplicated.** The same event for the same call notifies once per minute at most.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| DK-N1 | `notifyFor` and the rows marked Always: started-not-from-window, start refused, agent-started share | P0 | intent: an agent-started recording is announced; gap: nothing calls `showNotification` | Table test over `notifyFor`. Shell test: `POST /calls` with `by: "agent"` and the window closed produces exactly one notification through the fake. Positive control: the same start from the focused window produces none | has |
| DK-N2 | Capture dead and permission-suspect while the window is not focused | P0 | intent: recording never stops silently | A fake helper emitting `health {state: dead}` with the window closed produces one notification, and a second within a minute produces none | has |
| DK-N3 | Recovered call, final pass done or failed, hand-off failed, stopping or stopped by a rule | P1 | Granola, Wispr Flow post-call notices; REC-02 | One table row per event. A fake final-pass failure notifies with the window closed and stays quiet with it focused | missing |
| DK-N4 | The content scan: no rendered notification contains the call's title, workspace, speaker names or any segment text | P0 | intent: private by default | A test renders every row with a call whose title, names and text are unique markers and greps the output for them. A positive control injects the title and the test fails | has |
| DK-N5 | `app.notifications` with `all`, `errors`, `off` | P1 | per-app notification settings in every competitor | Table test over the three values and every event | missing |
| DK-N6 | Notifications verified per OS: macOS Notification Center, Windows toast, Linux notification daemon | P1 (M3, M4) | ElectroBun behaviour per OS not verified | A shell-gate run per OS shows one notification and records a screenshot under `docs/gates/` | missing |

DK-N1, DK-N2 and DK-N4 ship as one bead: `notifyFor`, its first rows and the scan that guards them.

## 9. Meeting detection

This is open decision 1 in [PRINCIPLES.md](PRINCIPLES.md). Nothing here gets built, and nothing goes into the helper protocol, until it is answered.

If the answer is yes, the shape is fixed now so the decision is about something concrete. It is off by default, with one toggle in onboarding and in Settings. It never records without the click. It inspects no audio: the helper reports which processes hold the microphone, which it can already do on all three OSes (section 3), and a user-editable list of call apps decides whether to ask. A browser only tells us "Chrome is using the microphone", and the prompt says exactly that. The full design (the helper message, the matcher, the end-of-call countdown, detection on the event stream) is written after the yes.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| DK-D1 | "Record this call?" prompt from the OS's microphone-holder signal, off by default, per-app list, Not now, Never for this app | decision | Granola, Notion, MacWhisper, Minutes, anarlog; ROADMAP "Later"; REC-18 | Written after the yes. It will include a grep test proving the detector reads no audio buffers | missing |

Silence reminders (WINDOW W3.5), a maximum length and a low-disk stop are matrix rows REC-02 and REC-03, and their capture side lands in DESIGN 4.3 as `part.ended` with a reason. None of them starts a recording, so they are not auto-recording. None of them stops one without the countdown in the indicator (DK-F2) and the notification row in section 8, so [PRINCIPLES.md](PRINCIPLES.md) principle 1 holds.

## 10. Start at login

Built: `app.openAtLogin` writes a LaunchAgent, an XDG autostart entry or the `HKCU` Run key, with `AKOU_HEADLESS=1` in the environment. The tray toggles it and applies it at once. The other doors do not apply it yet, and first run does not offer it.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| DK-L1 | Start at login, headless, with tray and hotkey ready; single instance brings the window forward | done | DESIGN 1.4 | Existing tests in `tests/` for `login-item.ts` and the single-instance path | has |
| DK-L2 | Changing `app.openAtLogin` from Settings, `akou config set` or `PATCH /config` writes or removes the login item at once | P0 | gap: only the tray applies it | `PATCH /config {"app.openAtLogin": true}` against a scratch home creates the LaunchAgent file (macOS), the autostart file (Linux) or calls the fake `reg.exe` (Windows); `false` removes exactly that | partial (tray only) |
| DK-L3 | `app.headless` is file-only or environment-only, not a live checkbox in Settings | P1 | gap: saving it makes the next normal launch start with no window | `GET /config` marks `app.headless` as not API-writable, and `PATCH` refuses it with a message naming `AKOU_HEADLESS` | partial |

Offering "Open akou at login" in onboarding is step 6 of DK-O2. The Flatpak Background portal is in the parking list.

## 11. First run, permissions and the capture test

Today the first run is the models card (one 2.6 GB download, checksummed, resumable) and a permission-suspect banner with a button that opens the right settings pane. The 3 s capture test that DESIGN 7 lists is not built (`doctor.ts` says so). The costly failure is silent. A call records with the system-audio side empty because a grant was denied or lost after an update, and nobody knows until half the call is missing from the transcript.

This is the one first-run flow; [WINDOW.md](WINDOW.md) section 10 draws it. One screen at a time, each skippable, each reachable again from Settings > Run setup again. Every step writes a normal setting, so setup has no state of its own.

1. **You.** One sentence on what akou does, your name (`user.name`), the interface language (`app.language`), and "Download the speech models (2.6 GB)" with the size and free space shown. The download runs in the background from here on, so it never blocks the next screens. Skipping it leaves audio-only recording (WINDOW W2.5).
2. **Microphone.** One sentence on why, and one Continue button that makes the helper open the mic, so the OS prompt names akou. Windows gets a button to the microphone privacy page when access is off. Linux skips this step.
3. **The other side of the call** (macOS). The same, for the system-audio tap.
4. **Capture test.** Two meters. "Say something" fills the mic meter. "Play any sound on this computer for 3 s (a video, music)" fills the call meter. akou cannot play the test sound itself, because the call channel excludes akou's own audio by design. Pass shows two ticks. A meter that stays flat names the pane to fix and offers to run the test again.
5. **Answers.** The harnesses found on PATH (Claude Code, Codex), or none, with the other providers named. No key is asked for unless the user picks an API provider. One button connects akou to each harness found, the way [PROGRAMMABILITY.md](PROGRAMMABILITY.md) section 5 defines it (PG-M1).
6. **Hand-off and desktop.** The export folder (optional), the hotkey as keycaps, the Accessibility step on macOS if DK-K1 finds it missing, Open at login (off until chosen), and Check for updates (off until chosen, DK-U1).
7. **"Record this call?" prompts**, off, only if open decision 1 is answered yes.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| DK-O1 | The 3 s capture test per channel, in the window and as `akou doctor --capture-test`, with a verdict per channel and the pane to fix | P1 | DESIGN 7; intent: recording never loses a side silently | With a fake helper delivering mic frames and zeros on the call side, the test reports `mic: ok, call: silent` and names the macOS pane; with both delivering, both are ok. The CLI exits non-zero on any silent channel (positive control: the zeros fixture) | missing |
| DK-O2 | The onboarding flow above, one permission per screen, one Continue button each, skippable, rerunnable | P1 | Apple HIG onboarding and privacy; Granola troubleshooting | Playwright walks the flow against the fake app to the end, and again skipping every step; skipping leaves login and update check off; Settings > Run setup again reopens it | partial (models card) |
| DK-O3 | Free-space check before the model download, in the card and in `akou models pull` | P1 | gap | With a fake disk reporting less free space than the download, both refuse with "needs X GB, Y GB free" and start nothing | missing |
| DK-O4 | After an app update, the first recording checks the call channel within its first 10 s of output running. If it is silent, the permission banner and notification name the likely cause ("macOS may need the permission again after an update") | P1 | [install.md](../install.md): an ad-hoc build may lose its grants on update | Fake: `app.version` differs from the last recorded one, the call side is zeros while output runs, and the banner text contains the update hint. Same version, no hint | missing |
| DK-O5 | A "Report a problem" item (Help menu, `akou doctor --bundle`) that writes a zip with `doctor --json`, versions and a redacted config, and shows it in the file manager; never call content | P2 | desktop convention | The bundle from a scratch home with one call contains no file from the call folder and no segment text (grep test with a marker). It contains `doctor.json` | missing |

## 12. Updates

Builds are unsigned for now, and every 0.x release is a prerelease. The ElectroBun updater exists but akou does not wire it. On an ad-hoc signed Mac an in-place update may cost the permission grants, which makes silent auto-apply a bad default today.

The design has two steps and one mechanism, ElectroBun's `Updater`, fed by the release feed [CI-CD.md](../CI-CD.md) CI-23 publishes. First a notice. With `app.updateCheck` on, akou calls `Updater.checkForUpdate()` once a day and says that a newer version exists, in the tray (a badge and a menu item), in Settings, and in `akou status`. Clicking opens the release page. "Check for updates…" in the tray and the menu runs the same call whenever someone clicks it, because a click is the user asking. Second, once it is proven on hardware, apply in place through the same `Updater`. Never while a call records or a final pass runs. It applies on "Restart to update" or at the next quit, and DK-O4's post-update check follows.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| DK-U1 | Update notice through `Updater.checkForUpdate()`: a daily check while `app.updateCheck` is on, off by default and offered in onboarding step 6 and Settings; "Check for updates…" on demand; tray badge and item, Settings row, `akou status --json` field `update` | P1 | Granola, most desktop apps; DESIGN 9; [PRINCIPLES.md](PRINCIPLES.md) principle 10 | Against a fake feed with a higher version and the setting on, the tray shows the item and `status --json` carries it; an equal version shows nothing. With the setting off, a day passes on a fake clock and the fake feed receives no request (positive control: the same run with the setting on records one), while "Check for updates…" still sends one | missing |
| DK-U2 | In-place update through the same `Updater`, gated on no live call and no final pass, applied on restart or quit | P2 | DESIGN 9 | Shell test: an update ready while a fake call records is held until `part.ended`, then offered. Hardware: 0.x to 0.x+1 on the reference Mac applies, and the next recording passes DK-O4 (recorded) | missing |
| DK-U3 | The Windows updater always also links the full installer, because of the patch truncation bug | P2 (M3) | DESIGN 9 | The Windows update item has both actions (unit test on the menu) | missing |

A stable and prerelease channel setting is in the parking list.

## 13. The model manager

Today akou has one model bundle: one card, one download of every missing file, progress as a percentage, files checked against SHA-256, resumable, plus `akou models list|pull|import`. We want any number of speech engines, each downloaded and verified by akou when chosen, never a manual install. The engine design itself (which engines, their runtime per OS, fusion, streaming, language id) is not written yet; [PRINCIPLES.md](PRINCIPLES.md) lists it among the docs that lag. This section fixes only what the window, the CLI and the API draw, and they draw whatever the engine registry lists.

**What the registry must give them**, per engine: an id, a display name, its roles (`live`, `final`, `diarize`, `langid`), languages, the platforms it runs on, the files with their sizes and SHA-256, and whether it is the default for a role. Nothing else is needed, and adding an engine changes no UI code.

**Settings > Speech engines** is the model manager. One row per engine:

```
Parakeet TDT v3            live · final     25 languages      2.4 GB   Installed      Used: live, final
<engine B>                 final            en, es            3.1 GB   Download        ─
<diarizer>                 diarize          any               0.1 GB   Downloading 42 % · 18 MB/s · 2 min   Cancel
──────────
On disk 2.5 GB · 180 GB free · Models folder …            Verify all
```

Rules:

- **Choosing an engine that is not installed starts its download.** There is no separate install step.
- **A missing engine never blocks a recording.** Live runs on an installed live engine. The final pass runs with the selected engines that are installed and writes which were skipped and why, and `akou finalize --force` reruns it later.
- **Remove refuses while an engine is selected** and offers to deselect it first.
- **The same rows on every door.** `akou models list --json`, `GET /models` (per engine) and the MCP read tool list the same fields ([CLI.md](CLI.md), [PROGRAMMABILITY.md](PROGRAMMABILITY.md)).

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| DK-E1 | `GET /models` per engine from the registry: state, bytes, total, roles, languages, used-by; the window and `akou models list` draw from it | P1 | intent: any number of engines | A test registry with a fake second engine appears in the window's list, the CLI table and the API without any UI or CLI code change (one test that adds only a registry entry) | partial (one bundle) |
| DK-E2 | Per-engine Download, Cancel, Remove, Verify, with speed and time left while downloading; progress on the status push, not a poll | P1 | Buzz, VoiceInk, MacWhisper model libraries; gap: the models card polls `GET /models` every second | Fake downloader: Cancel stops and keeps the partial file for resume. Remove of a selected engine refuses with the deselect offer. Verify flags a corrupted fake file. The card makes no timed request to `/models` while a download runs | partial (download, resume, checksum) |
| DK-E3 | Selecting a missing engine in any door starts its download; a final pass with an engine still missing runs with the others and records the skip | P1 | intent: no user setup | `PATCH /config` selecting a missing fake engine moves it to `downloading`. A final pass meanwhile ends `final.done` with `skipped: [{engine, reason: "not installed"}]` | missing |
| DK-E4 | Measured cost per engine on this machine (real-time factor and peak memory from the last runs), shown in the row as information, never as a block | P2 | VoiceInk performance panel; intent: memory and speed are never a veto for an engine the user chose | After two fake final passes with timings, the row shows the median. An engine never run shows "not measured" | missing |

## 14. Settings: the registry fields and the speech-engine keys

### 14.1 The registry fields

Today `GET /config` sends type, bounds and doc only, so every choice is a free text field. `PATCH /config` answers "takes effect at the next start" for every key, which is false for the tray-applied login item and will be false for most keys below. The registry grows four fields, and every door reads them: the window draws them ([WINDOW.md](WINDOW.md) section 11), the CLI prints them (`config show`, [CLI.md](CLI.md) CLI-35), and the API returns them (PG-A3).

- `values`: a fixed list, or the name of a source (`engines:live`, `engines:final`, `workspaces`), so the window draws a picker and the CLI completes and validates.
- `default`: shown next to the field, with Reset to default.
- `group`, one of: **Recording** (devices, call source, timings), **Speech engines**, **Provider** (provider, harness path, memo, templates, presets), **Export and hooks**, **Sharing**, **Shortcuts** (global hotkeys), **Desktop** (tray, floating indicator, notifications, login, updates), **Appearance** (theme, language, accessibility). File-only keys appear read-only in their group with "Edit config.json…". The vocabulary lives in the Words dialog ([WINDOW.md](WINDOW.md) section 9), not in a group.
- `applies`, one of `now`, `next-call`, `next-final`, `restart`, shown as "now", "next call", "next final pass" and "next app start". `PATCH /config` returns the `applies` of each changed key, and the window says it next to the field.

### 14.2 The speech-engine keys

Their exact names can still move with the engine design. What this section fixes is their shape, how every door draws them, and when each takes effect.

| Key | Type | Values come from | Takes effect |
|---|---|---|---|
| `asr.live.engine` | one engine id | registry entries with role `live` | next call |
| `asr.final.engines` | ordered list of engine ids; the first is the primary | registry entries with role `final` | next final pass |
| `asr.final.fusion` | one method, shown only when two or more final engines are chosen | the engine design's list, for example `off`, a per-word vote among the engines, or per word by the provider | next final pass |
| `asr.language` | `auto` or a language code | the union of the chosen engines' languages | next call |
| `asr.diarizer` | one engine id | registry entries with role `diarize` | next final pass |
| `asr.liveLabels` | `clusters` (live speaker clustering, the default) or `channels` (You and Them only) | fixed; a live diarizer, if the engine design adds one, becomes a third value | next call |

`asr.liveLabels` replaces the name `asr.liveSpeakers` WINDOW.md used for W4.3.

Live is one engine on purpose, because fusing live would delay the line the user reads. If live fusion is ever wanted, the key becomes a list with a migration.

The final pass runs after every stop without anyone asking, so a fusion method that calls the provider runs unattended. With the harness, it follows the rolling-memo rule in [providers.md](../providers.md): off unless the user turns it on, because it would spend the subscription after every call. The per-word vote needs no provider and has no such limit. providers.md's table gains a row for fusion when the engine design lands.

Each of these keys can be overridden per workspace (a Spanish workspace picks another engine or language), through one mechanism for every overridable key (DK-S6), not one per feature.

In the window, the group reads top to bottom as the questions a person asks: which engine runs live, which engines run after the call and how they are combined, which language, who spoke. Each choice is a list of rows with the install state inline, so choosing and downloading are one action.

### 14.3 New keys this design adds

Every key the ux docs name that the registry lacks, in one list, so the registry PR has a single source. The line that owns each key is where its acceptance lives.

| Key | Values | Default | Applies | Group | Line |
|---|---|---|---|---|---|
| `app.notifications` | `all`, `errors`, `off` | `all` | now | Desktop | DK-N5 |
| `app.updateCheck` | on, off | off | now | Desktop | DK-U1 |
| `app.floatingIndicator` | on, off | on | now | Desktop | DK-F1 |
| `app.hideFromCapture` | on, off | on where measured to work | now | Desktop | DK-P3 |
| `app.trayTimer` | on, off | on | now | Desktop | DK-T3 |
| `app.hotkeyMute` | an accelerator or empty | empty | now | Shortcuts | DK-K6 |
| `app.language` | `system`, `en`, `es` | `system` | now | Appearance | [WINDOW.md](WINDOW.md) section 16 |
| `a11y.announceLines` | all, others, off | per WINDOW W15.4 | now | Appearance | W15.4 |
| `watch.words` | a list of words | empty | now | Provider | PG-S4 |
| `asr.live.engine`, `asr.final.engines`, `asr.final.fusion`, `asr.language`, `asr.diarizer`, `asr.liveLabels` | section 14.2 | the registry's defaults | section 14.2 | Speech engines | DK-S2 |

`window.compactOnRecord` and `window.hideFromCapture` are retired names, replaced by `app.floatingIndicator` and `app.hideFromCapture`. `detect.*` keys wait for open decision 1.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| DK-S1 | `values`, `default`, `group`, `applies` in the settings registry and in `GET /config`; `PATCH /config` reports `applies` per changed key | P0 | intent: every choice a setting; gap: one "next start" note for every key, including ones that apply at once | Schema test: every key has `group` and `applies`, and a key with a fixed set has `values`. `PATCH` of `app.hotkey` returns `applies: now`, of `asr.threads` returns `restart`. The settings reference doc generated from the registry diffs clean in CI | missing |
| DK-S2 | The engine keys above, validated against the engine registry, with per-workspace overrides through DK-S6. Lands with the engine design PR, not before | P1 | intent: any number of engines, every choice a setting | Setting `asr.final.engines` to an id not in the registry is refused on every door with the list of valid ids. A workspace override is used for a call in that workspace and not for another (fold or config test) | missing |
| DK-S3 | The Speech engines group in the window: live as a single choice, final as an ordered checklist with drag to reorder, fusion shown at two or more, language, diarizer, install state inline | P1 | intent; VS Code grouped settings | Playwright against a fake registry with three engines: choosing two final engines shows the fusion select, reordering changes the saved list, choosing a missing engine shows its progress | missing |
| DK-S4 | Settings grouped by `group`, with search, modified markers, Reset to default, pickers from `values`, and "Edit in config.json" for file-only keys | P1 | VS Code settings editor; audit: 37 flat fields, raw keys, no pickers | Playwright: typing "hotkey" leaves only the matching row; a changed key shows the marker and Reset restores the default; `provider.kind` renders as a picker | partial (flat list) |
| DK-S5 | Secrets from standard input: `akou config set provider.apiKey -`. Owned by [CLI.md](CLI.md) CLI-06; listed here only as the Settings side | P1 | clig.dev; shell history | CLI-06's acceptance | missing |
| DK-S6 | The keys DESIGN 7 and REQUIREMENTS promise and the registry lacks: default workspace, default template, share defaults, `final.speakerThreshold` (REQUIREMENTS F1.30), `capture.tapSilenceSeconds` and `capture.recover` (REQUIREMENTS I0.7); and one per-workspace override mechanism that any key can opt into, used first by the provider (DESIGN 7) | P1 | gap: promised in the docs, absent from `src/main/config/schema.ts` | A test reads every config key named in backticks in `docs/*.md` and `docs/ux/*.md` and fails for any that is not in the registry, retired, or listed as waiting for a decision; a positive control adds a made-up key to a fixture doc and fails. A per-workspace `provider.kind` is used for a call in that workspace and not another | missing |

## 15. Privacy indicators

What tells the person at the machine, and the people on the call, that akou is recording, sharing or visible. Most rows point back to a line above.

| Surface | What it shows | Line |
|---|---|---|
| Tray icon | Recording, paused, shared, degraded, as distinct shapes | DK-T1, DK-T2 |
| Floating indicator | Recording, elapsed time, levels, Stop; no transcript text | DK-F1 |
| Notification | A call started by an agent, the CLI or the hotkey; an agent-started share; never call content | DK-N1, DK-N4 |
| Consent reminder | For every call, whoever started it | DK-F3 |
| Window header | The shared-live pill with the viewer count (built) | [WINDOW.md](WINDOW.md) |
| The OS | macOS orange microphone dot, Windows microphone icon; akou never tries to hide them | none |

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| DK-P1 | The share state in the tray icon and menu (Stop sharing) | P1 | DESIGN 8.3 promises a changed tray icon | Covered by the DK-T2 table with a shared fixture, and DK-T4's Stop sharing item stops the fake share | partial (text title) |
| DK-P2 | The call's `by` is shown wherever the call is: tray menu ("started by an agent"), notification, window header | P1 | intent: agentic and UI recording are equal, and visible | A call started with `by: "agent"` shows the words in the tray menu (unit) and the window header (Playwright) | partial (in the log only) |
| DK-P3 | Hide every akou window from screen capture, `app.hideFromCapture` on by default where the OS honours it. macOS: `NSWindow.sharingType` through the window pointer and `bun:ffi`. Windows: `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`. Linux: the setting says it cannot be guaranteed. Settings shows "measured on this OS version" or "not honoured here". The spike is the first bead; the feature follows only where it passed | P1 | Wispr Flow, Minutes; [PRINCIPLES.md](PRINCIPLES.md) principle 10; WIN-07 | Hard, not impossible: neither call is in ElectroBun 2.0.1. The spike sets both, then a real screen share in Zoom, Meet and Teams on the reference Mac and a Windows 11 machine records whether the window is absent. The result per OS and version is committed under `docs/gates/`, and the default is on only where it passed. If current macOS screen sharing ignores the flag, the setting says so instead of claiming protection | missing |

The content rule for notifications is DK-N4. The start and stop cue is in the parking list.

## 16. Trap candidates

Failures this design found that are not yet in [TRAPS.md](../TRAPS.md). Each becomes a trap entry and a test named after it when its line is built.

- **A hotkey that registers and never fires.** Given macOS without the Accessibility grant, ElectroBun's global monitor registers and receives nothing. akou must not treat a successful register as a working hotkey. It must check the grant, in the process the grant applies to, and say so (DK-K1).
- **A setting that says saved and does nothing.** Given a key that applies only at the next start, every door must say so for that key. Given a key that can apply at once, it must (DK-S1, DK-K3, DK-L2).
- **akou cannot test the call channel with its own sound.** Given the call tap excludes akou's own audio by design, a capture test that plays its own tone would always read silent. The test must ask for other audio (DK-O1).
- **The transcript on top of a screen share.** Given the floating indicator stays on top while the user shares their screen, it must carry no transcript text, names or answers (DK-F1).
- **AltGr swallowed by a global hotkey.** Given a Spanish or other AltGr layout, a `Ctrl+Alt` global hotkey can eat a typed character (DK-K4).
- **A URL scheme that never registers.** Given ElectroBun registers `urlSchemes` only for an app in `/Applications`, an install in `~/Applications` gets no `akou://` handler. The API must not hand out a link that opens nothing ([PROGRAMMABILITY.md](PROGRAMMABILITY.md) PG-U1).

## 17. Testing

Everything the shell decides is a pure function or goes through `NativeUi`, so the existing fake unit-tests it: tray menus and icons per state, the notification policy, the hotkey re-register, the quit confirm, the prompt queue. The window-side screens (onboarding, the model manager, the engine settings, the floating indicator page) run in the Playwright suite against the headless app with a fake helper. Some things only a real desktop can show: the icon in a real menu bar, the Accessibility grant, notifications per OS, hiding from a real screen share, an in-place update keeping grants. Each is a recorded hardware check with the date, OS version and akou version under `docs/gates/`, listed in the release checklist. Every check that guards a rule carries a positive control. The jobs are in [CI-CD.md](../CI-CD.md) and the layers in [TESTING.md](../TESTING.md).

## 18. Parking list

Seen, weighed and not scheduled. No acceptance and no bead until someone asks.

| Id | Item | Seen in | Note |
|---|---|---|---|
| DK-T7 | Left-click on the tray icon toggles recording (`app.trayClickRecords`) | Superwhisper | macOS and Windows only; AppIndicator gives no raw click |
| DK-M5 | `app.showInDock`: always, or only while the window is open (macOS) | tray-first apps | `setDockIconVisible` exists |
| DK-L5 | Flatpak autostart through the Background portal | XDG portal | Only if a Flatpak is ever built |
| DK-U4 | Update channel setting, stable or prerelease | Granola beta channel | Only once a stable release exists |
| DK-P5 | An opt-in start and stop cue, `app.recordingCue`, off by default, never used as a test signal | anarlog, Superwhisper, VoiceInk | The mic hears it, so the call hears it |

## P0 list

- **DK-T1** Ship a template tray icon and always set it, including idle.
- **DK-T5** A failed tray or hotkey start says why, instead of writing only a log line.
- **DK-K3** A changed hotkey re-registers at once from every door.
- **DK-M1** Set the application menu with the Edit roles, so copy and paste work in the notepad and ask box.
- **DK-M3** Confirm before quitting while a call records.
- **DK-N1, DK-N2, DK-N4** One `notifyFor` bead: notify when a call starts from anything but the focused window, when a start is refused, when an agent starts a share, and when capture dies with the window closed, with a marker scan proving no call content.
- **DK-L2** `app.openAtLogin` applies at once from every door.
- **DK-S1** `values`, `default`, `group` and `applies` in the settings registry, and `PATCH /config` reporting when each change takes effect.

Moved to P1 because they are design work or depend on a spike: DK-T2 and DK-P1 (the seven-state icon set), DK-K1 (the Accessibility check, after recording which process holds the grant), DK-O1 (the capture test), DK-S2 (engine keys, with the engine design).

## Summary

- The desktop layer is the tray, the hotkeys, the application menu, one floating indicator with no transcript text, informational notifications, first run with a real capture test, an opt-in update notice, and a model manager and engine settings drawn from a registry. It sits on the existing `NativeUi` seam, so almost all of it is unit-tested with fakes.
- ElectroBun 2.0.1 shapes the design: notifications have no buttons, so the floating indicator carries every prompt; the macOS hotkey needs Accessibility and can fail silently; hiding a window from screen capture is a `bun:ffi` spike; URL schemes work only on macOS and only from `/Applications`; `Updater.checkForUpdate()` covers the update notice, so there is no second mechanism.
- This file owns the floating indicator, the first-run flow, the settings registry fields, the group list, the `applies` values and every new key. WINDOW.md and the matrix point here, and the priorities here win.
- The P0s are eight small fixes where a control does nothing or hides something today: the invisible idle tray, a failed start that says nothing, settings that claim to be saved but wait for a restart, no Edit menu, quitting a live call with one click, and no notification for an agent-started call or dead capture.
- Meeting detection is open decision 1, reduced to one row until it is answered. P3 niceties are in the parking list. The engine list, fusion methods and defaults wait for the engine design, and a provider-based fusion follows the harness rule for unattended work.
