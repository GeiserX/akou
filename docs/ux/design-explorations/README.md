# Design explorations: the first run and the call workspace

akou 0.4.0 opens on a full call workspace even when it cannot record yet. With no speech models on disk the window shows a status dot that says READY, a Record button that works, a clock, debug chips for the provider and the speech engine, an empty calls list, a placeholder that says "Press Record", tabs for Notes, Ask and Enhanced over nothing, and a player with two volume sliders for a recording that does not exist. The one thing the user has to do, download the models, is a banner in the middle. Three controls share the same blue: the active tab, Record and Download. Informational text uses the primary accent too.

This page holds three mockups of a different shape, what the apps closest to akou do on the same screens, and the direction we want to take. Each mockup is a self-contained HTML file beside its image, rendered at 1440 x 900.

## The rules every mockup follows

- **Readiness drives the shell.** With no models there is no workspace, only the welcome. Record is never enabled with a reason hidden somewhere else.
- **One accent per screen.** The primary action is the only thing in the accent colour. Selected tabs and list rows use a neutral fill. Red means recording or stop. Green means ready or live.
- **Information gets its own colour.** Where the models live, what leaves the computer, what a permission is for: those are teal, never the accent, so they cannot be mistaken for a button.
- **No debug chips.** The version, the provider and the speech engine live under Settings. The header shows one status word.
- **Nothing dead on screen.** The player exists only when the call has a recording. The Notes and Ask surfaces exist only when a call is selected.
- **Permissions are asked in context**, at the first recording, and the welcome says so instead of asking up front.

## A. A welcome card, then one document

![A, welcome](a-welcome.png)

![A, ready](a-ready.png)

First run is a centred card with three steps. Step one is the download, with the only accent button, the size and a time estimate, and a progress inset that says the window can be closed. Step two explains the microphone and system audio prompts and when they come. Step three is the optional agent, a quiet link. The chrome keeps a "Setting up" status at the top left and a gear at the top right.

Once ready, the window is a list and a document. Record sits at the top of the list with its shortcut, then search, then calls grouped by day. Dictation, Models, the agent and Settings are four icons at the foot of the list. The document is the call: title, date, duration, people, then the transcript as timestamped speaker paragraphs, with the user's notes, actions and questions inline as tinted blocks at the moment they were written. Ask is an input at the bottom of the document. The player is a slim bar under it, with note marks on the scrubber, and it exists only because this call has a recording.

## B. A sidebar shell

![B, welcome](b-welcome.png)

![B, ready](b-ready.png)

A permanent sidebar carries the app mark, navigation to Calls, Dictation, Models and Settings, search and the workspaces with their calls. Its footer is the readiness row: an amber "Models missing" with "Setup 1 of 3", or a green "Ready". The Models item carries an amber dot while something is missing.

First run keeps the sidebar and replaces the main area with a stepper of three cards: the models with what is inside them and their sizes, the teal strip that says where they are kept and that nothing else leaves the computer, and the one download button; the permissions card marked "Later" with an explanation; the optional agent card.

Once ready, the main area has a compact composer row above the transcript: the workspace as a chip inside the title field, the template select, two thin live meters for mic and call, and Record as the only accent. Speakers have warm non-accent colours and time totals as chips under the title. The right column has Ask on top with a cited answer, then Notes with a Notes and Enhanced toggle, then the input with its three syntax hints as chips under it. The player is a slim bar under the transcript.

## C. A checklist, light and calm

![C, welcome](c-welcome.png)

![C, ready](c-ready.png)

A light theme, to see the same ideas without the dark chrome. First run is a two-column welcome. The left column is the checklist: Speech models to do with its size, Microphone and System audio marked as asked at the first recording, the agent optional, and a footer that counts what is left before you can record. The right column explains the selected step before it asks: the three models with sizes and what each does, the teal "Kept on this Mac" box, three flat tiles with time estimates, the one download button, and a grey link to skip for people who will only dictate through a remote akou.

Once recording, the checklist collapses into a green "All set" dot in the top bar, and the pages become three text tabs on the right. The call header has the title, the workspace and the people, the elapsed time with a red dot, two thin live meters and one red Stop button. The transcript follows live from the bottom with the partial line lighter, and a footer says scrolling up holds the view. The notepad on the right has timestamped notes, an action with a checkbox, a question with its answer and the timestamp it came from, and the input with the syntax hints under the field rather than inside the placeholder. There is no player while recording.

## What the nearest apps do

The four apps closest to akou on a Mac handle the same screens like this. None of them shows a full workspace plus a warning banner when something required is missing.

**MacWhisper** (Goodsnooze) is a native split view: a sidebar with Home, Queue, History and People, and a Home grid of eight equal tiles with no primary action. Its model list is the part worth copying: every row shows the engine, the capabilities and the size on one line, with badges and exactly one button, Download or Activate. Meeting recording needs Screen Recording and Microphone, asked when a meeting is detected. The dictation setup is a modal sheet that explains the feature and hands over to its settings. The transcript document has speaker names in colour above each paragraph, a bottom player with a scrubber, time and speed, and a right inspector with tabs for display, AI, translate, info and share. Light by default with the system blue accent, and filler words in red. What to avoid: the eight-tile Home with no primary action, and warning about the multi-minute first model load only in the docs.

**Handy** (open source dictation) is one settings window with a sidebar: General, Models, Advanced, History, Post Process, About. The first run is a full-window gate that hides the app until it is done: a permissions step with two cards, Microphone and Accessibility, each with a Grant button and live Waiting and Granted states, then a model step with two recommended picks, accuracy and speed bars, language and streaming chips and the size on each card. Clicking a card starts the download with real percent and speed and a cancel; when it finishes the model is selected and the app opens by itself. Pink is the brand, selection and primary colour, emerald means success only. What to avoid: "Show all" expands to about sixteen models, many niche, and permissions are asked before the app has shown any value.

**Minutes** (the open source Tauri meeting recorder) replaces the empty meeting list with a first-run card, not a separate screen: "Download the model once, then create one short recording. The moment it saves, this becomes your real meeting list." Three numbered steps, each disabled until the previous one is done: download a model with Tiny, Base as the recommended primary, or Small, each with its size; record a ten-second test; watch it appear. Permissions are deliberately not front-loaded. Each is asked in context with the app's own priming copy before the macOS dialog: mic at the first recording, screen recording at the first call capture, accessibility at the first hotkey. Its footer during recording reports source health per input: "Mic waiting", "Call audio waiting", "Listening". Dark by default, green accent for primary and live, red for recording and delete, serif titles. What to avoid: its download bar animates to 85 percent without real progress.

**Granola** is a sidebar with Search, Home, Shared with me, Chat and Spaces, and a Home with a calendar card, the notes list grouped by day and a "Start now" pill on the live meeting. A note is one document with a serif title, chips for date and people, and a floating bottom bar that holds the live waveform, Stop and an "Ask anything" input. Its permission screen explains each grant as an outcome, "Transcribe my voice" and "Transcribe other people's voices", with the second button greyed until the first is done. The live transcript is hidden by default and opens as chat bubbles, grey on the left for the other people and green on the right for you. Light by default, black pill buttons, a lime brand, low density. What to avoid: mandatory sign-in and calendar access before the first recording, and hiding the live transcript, which is core in akou.

## The direction we want

- **The shell of A.** One list, one document, Record at the top of the list, pages as icons at its foot. It is the least chrome for what akou does, and it keeps the transcript and the notes on one timeline, which is akou's own idea.
- **The welcome of C, inside A's card.** Explain before asking: the models with sizes and what each does, the teal box for where they live, a real time estimate, one download button, and a skip link for remote-only dictation. The permissions rows say when they will be asked. The checklist collapses to one status dot once everything is set.
- **Real progress with a cancel, then continue by itself**, the way Handy does it. Never an animated bar.
- **A ten-second test recording as step two**, the way Minutes does it, so the first real item in the list is the user's own voice and the permissions arrive with their own priming line, in context.
- **B's readiness footer** as the one place that says what is missing, with an amber dot on the page that fixes it.
- **Live source health during a recording**: mic and call as two thin meters, each with a waiting state, instead of level bars parked in the header.
- **Speaker colours that are not the accent**, so the accent stays for the primary action.

Dark stays the default. The light theme in C is kept as a variant, not a direction.
