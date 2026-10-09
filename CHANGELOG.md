# Changelog

All notable changes to akou. Versions follow [semantic versioning](https://semver.org); while the version is 0.x, every release is a prerelease.

## 0.6.5 — a call's lines no longer wait for their speaker, and `akou start` and `akou quit` finish

On 0.6.4, with the Nemotron diarizer on, every line of the call channel waited until the diarizer had decided who spoke it. Nemotron decides about 2 s behind the audio, so the other side's words reached the transcript late: 2.42 s after the speech ended at worst on a Mac mini M4, while your own lines stayed within 1.25 s. In 0.6.5 a call line is written when its segment closes and its speaker follows on the same line a moment later. Two commands also stop failing at the edges: the first `akou start` after an install waits for a slow first launch, and `akou quit` on Linux always finishes.

### Calls
- **A call line lands when it is said, and its speaker follows.** The line is written as soon as its segment closes, as "Unknown speaker", and the diarizer's decision arrives as a correction to that same line, so nothing is duplicated in the window, the API, `akou watch` or a shared link. A speaker you set by hand before the decision is kept. On a Mac mini M4 the call channel now commits within 1.5 s of the end of the speech, 1.18 s at worst with Nemotron in the runs that started clean, and the speaker lands about when the whole line used to (#359).
- **A search hit names the speaker who said the word.** `akou search` cited the first line of the matched passage, which can span several speakers, so a word one person said could come back under another's name. The citation now names the first line that contains a search term (#365).

### Starting and quitting
- **`akou start` waits out a slow first launch.** The first start after installing a new build failed with "akou did not answer within 3 s of launching" while the app came up a moment later, and the launcher left behind then blocked every later start. The command now waits up to 20 s while the launch is still in progress, fails at once when nothing is starting, and stops the idle launcher once the app answers (#360).
- **`akou quit` always finishes on Linux.** After a call, a quit could log `quitting` and then never end, leaving the app running. A call that is still stopping is now allowed to end before anything closes, and every step of the quit has a deadline. A step that fails or takes too long is named in `app.log` and the quit goes on (#367).
- **Three messages no longer point at a command that cannot help.** `akou status` and the `akou dictate` session commands against an `AKOU_URL` that does not answer say `nothing answers at <url>` and exit 69, instead of telling you to run `akou open`. The help of `akou open` says an address is printed only by an app with no desktop shell. The `models_missing` error of `akou_start` names the tool's own `withoutModels` argument, not the CLI flag (#366).

### Server
- **A file job without speaker labels fetches only the models it runs.** With speaker labels off, a job still downloaded the speaker models and the live model first, about 1.1 GB it never used, and a server with `server.auto_download` off or a small `server.models_max_gb` refused the job with 409 for those models. Both the download and the admission now count the recognizer alone unless the job asks for speaker labels (#364).

### Behind the scenes
- G1 and G3 pass. G1 now runs on macOS as well as Linux and Windows, and Linux passed four runs in a row after the quit fix. G3 passed with the signed 0.6.4 installed over the signed 0.6.2: no new permission prompt, and a reset prompted again (#354, #357, #362, #371).
- G4, G6 and G7 stay Partial. G4 needs a USB input device to measure two real clocks, G6 needs the four-core x64 lines inside 1.5 s, and G7 needs a Codex with a working sign-in. Claude answered in the packaged app on two Macs (#354, #358, #363, #372).
- The dictation audio tests wait for the audio write instead of reading the folder too early on a loaded runner (#361).
- The repository carries a `glama.json`, so the MCP server can be listed on Glama (#373).

### Known limitations
- **The first lines after a cold start can be late.** In three of eight runs on a Mac mini M4 the first one to three lines, in the first 9 s of the call, took 1.5 to 5.8 s. The rest stayed within 1.5 s.
- **On four x64 cores a line still takes longer than 1.5 s.** At worst it took 1.85 s on the microphone and 2.27 s on the call.
- A line the diarizer cannot decide stays "Unknown speaker".
- A launcher left behind by an earlier failed launch still blocks `akou start`, which now waits 20 s before it fails. Quit that akou process and start again.
- `akou quit` waits up to 20 s without printing anything while a call ends. A live Qwen server that ignores the stop signal can outlive the app when you quit from the window. `akou quit` from the command line stops it.
- A search for one word of a term akou corrected from several heard words, or for several words spoken on different lines, can still cite another line of the passage than the one you meant.
- A stalled queue still reports as healthy over the API (queued N, running 0, every remote up); a signal for it is a follow-up.
- A job only a remote can run that was refused with 409 waits for the next submit, probe change or remote job end before it is offered again.
- Every item under 0.6.3's Known limitations still applies.

## 0.6.4 — a server whose remotes all drop at once dispatches again when they return

On 0.6.3 a primary with `server.remotes` could stop dispatching for good. When every remote timed out in the same moment while the 30-second probe was in flight, the probe compared the remotes against the state it had seen before its requests, saw no change, announced nothing, and the queue sat with hundreds of jobs queued, none running and every remote reported up, until a restart. In 0.6.4 the probe compares against the state after its requests, so a remote marked down mid-probe is announced up and the queue runs again.

### Server
- **Dispatch resumes after every remote drops at once.** The probe takes its change snapshot after its two requests, so a `remote.down` written while they were in flight ends in `remote.up` and a dispatch, with the local worker's own jobs untouched (#353).

### Behind the scenes
- The macOS nightly no longer dies when Bun's hidden 6-minute fetch limit cuts a slow Qwen request; the night's requests pass `timeout: false` and the macOS leg has 200 minutes (#352).
- G6 is recorded as Partial on fp32 with both machines measured: speed passes, the committed line misses 1.5 s on the call channel while the diarizer holds that line for its speaker (#350).

### Known limitations
- A stalled queue still reports as healthy over the API (queued N, running 0, every remote up); a signal for it is a follow-up.
- A job only a remote can run that was refused with 409 waits for the next submit, probe change or remote job end before it is offered again.
- Every item under 0.6.3's Known limitations still applies.

## 0.6.3 — a server that hands work to other akou servers keeps working itself while they are busy

On 0.6.2 a job that a `server.remotes` entry names waited whenever every remote that offers it was busy, even when the primary could run it and sat idle. A primary that is a good worker itself could not share a backlog with its remotes: it either kept every job or watched them queue behind its slower helpers. In 0.6.3 one setting lets it run those jobs itself while its remotes are full.

### Server
- **`server.remotes_overflow`.** Off by default, so nothing changes until you turn it on. On: a job a remote entry names runs on the primary while every remote that would take it already holds its jobs, instead of waiting. A job only a remote can run still waits for one, and after a start a job waits until the remotes it names have answered their first probe. Turning it on over the API routes the waiting jobs at once. Settings shows it under Other servers (#340).

### Behind the scenes
- The macOS nightly no longer dies in the Qwen stage on a runner short of memory (#339).
- A 1.0.0 release is refused while any gate has only half a Pass on record (#341).

### Known limitations
- A remote that goes to sleep with a job keeps its copy and may finish it after the primary has run the job again elsewhere. Only the primary's answer reaches the client.
- Every item under 0.6.2's Known limitations still applies.

## 0.6.2 — a phone can stream live words to an akou server, and the server can keep its recordings

On 0.6.1 nothing on the network could reach the streaming model a server already runs. The only streamed input was a WAV, decoded once its body ended, and a job deleted its upload the moment it finished, so a phone that dropped its copy after uploading lost the audio for good. In 0.6.2 a server takes a live recording over a WebSocket and sends the words back while you speak, and it keeps a client's recording until the client deletes it. This is the server half of a phone client. No phone app ships yet, and so far a command-line client drives it.

### Server
- **Live words over a WebSocket.** In server mode, any key can open `GET /v1/live`. The client sends Ogg Opus pages or 16-bit PCM and gets the words back with their times in seconds into the recording. A client that reconnects partway through gets its words at file times without keeping track itself. A missing or revoked key never gets a socket, and a key revoked mid-session closes it within about a second. akou closes a client that gets more than 30 s of audio ahead of the model with `too_fast`, instead of piling its frames up in memory. `GET /v1/server` lists `capabilities.live` and the streaming models on disk in `live.engines` (#335).
- **A server can keep a recording.** `keep_audio=true` on `POST /v1/jobs` keeps the upload after the job ends. `GET /v1/jobs/{id}/audio` serves it byte for byte, with `Range`, and the retention sweep leaves the job alone until the client deletes it. The job answer carries `keep_audio`, so a client deletes its own copy only after reading `true` (#335).
- **A server loads its streaming model at start** when the model is on disk, so the first live session does not wait for the load. The idle release still frees it later (#335).
- The [server page](docs/server.md) has a section for a phone or another live client, and its reverse proxy blocks now pass WebSockets. [`scripts/live-client.ts`](scripts/live-client.ts) streams a file at real-time pace, the way a phone records it (#335).

### Windows
- **The recognizer's first load no longer freezes the app's main thread on Windows.** Windows holds a lock for a library's whole first load, up to 1.7 s for fresh files, and the main thread waited on it. The recognizer now loads it once in a short child process first. Stalls of 50 ms or more fell from 111 of 120 runs to none (#334). The Windows desktop app is still not published.

### Behind the scenes
- The Windows test run no longer times out on a different test each time (#332), and the G2 gate holds the main thread to a 100 ms wait, above a 4-core runner's scheduling noise (#333).
- The 1.0 gates rest on firmer ground. The terms reading cites both regional versions of Anthropic's Consumer Terms and names one open question per vendor, and the macOS 14.3 VM run fails a guest on any other version or a helper that exits non-zero (#328).
- akou now depends on `opus-decoder` 0.7.12 at run time. It loads only when a live session receives Ogg Opus, so the desktop app and the CLI never load it (#335).

### Known limitations
- **No phone app yet.** Only `scripts/live-client.ts` has driven `GET /v1/live`.
- **One streaming engine serves every live session at a time.** akou refuses a session that asks for another engine while one is open, with `engine_busy`.
- Every item under 0.6.1's Known limitations still applies.

## 0.6.1 — akou is signed and notarized, idles in about 2 GB, records the app you pick, and a call's final pass can fuse engines

On 0.6.0 an idle akou held about 3.9 GB, enough to start freezing a 24 GB Mac, because the models a call or a dictation loaded were never let go. Recording one app instead of the whole computer meant typing an app id into Settings, and the call stopped the moment that app quit. In 0.6.1 an idle app drops back to about 2 GB, a menu beside Record picks the app for one call from the apps playing now, and a call whose app quits goes on recording the whole computer. A call's final pass can also run the fusion preset's engines, as a fusion file job does. And 0.6.1 is the first release signed with a Developer ID and notarized, so macOS opens it without an extra step and should keep its permissions across updates.

### Calls
- **A call's final pass can fuse several engines.** `asr.final.model` takes `fusion`, and so do `akou start --final`, `POST /calls {final}`, `akou_start {final}` and `akou finalize --model`. The pass runs the `fusion` preset's engines over the whole call and joins their words, and its lines read `rover-conf(<ids>)`. An engine that is not downloaded is left out, and `final.done` names the engines that decoded and the ones left out, with why. It is slower by about one pass per engine and holds about 0.25 GB per hour of call while it runs. The default stays one engine (#325).
- **Pick the app to record for one call from the apps playing now.** A Call menu beside the Live menu lists Whole computer, None (microphone only) and the apps playing sound, by name. A pick holds for that call and is never saved. Whole computer stays the default (#326).
- **Settings' One app mode picks from the running apps** by name, instead of an empty box for an id few people know. It is hidden on Linux, where akou cannot record one app (#324).
- **A per-app call whose app quits keeps recording**, now as the whole computer, with the microphone carried straight across. Before, the call ended as if you had pressed Stop, with no word of why (#317).
- **akou checks a per-app scope when it comes in.** A typo such as `zoom` is refused when you save it or start a call, a start whose app is not running says what to do, and an agent that attaches to a call recording another scope is told so (#318).
- **`akou devices` and `akou apps` list microphones and the apps playing sound**, with the ids `--mic` and `--call app:<id>` take. Before, both exited "not built". The API has `GET /devices` and `GET /apps`, and agents have `akou_devices` (#265).

### Memory and models
- **An idle akou lets go of models nothing uses**, from about 3.9 GB down to about 2 GB on the reference Mac. A live dictation no longer loads Parakeet unless its text comes from Parakeet, and `asr.modelIdleMinutes`, 5 by default, drops every model once no call or dictation has used it for that long (#322).
- **A server keeps its loaded model between jobs** for `server.model_idle_minutes`, 60 by default, so a stream of short voice notes no longer pays the load on almost every file. A switch of preset no longer evicts Qwen, and two `best` jobs on Metal no longer stop each other's llama-server (#270).
- **A freshly unpacked GPU build is asked which devices it can open** before the first job runs on it, so the first job on a new box no longer finds out the hard way (#260).
- **The GPU docs pass one render node to the Vulkan image**, not the whole `/dev/dri`. On an Intel GPU with virtual functions, llama-server could open the wrong one and hang. The server now says when that can happen (#266).

### Dictation
- **A quiet dictation keeps its sentence ends.** On a quiet microphone, Parakeet lost the ends of sentences and some dictations came back empty. The cut at pauses now works on a gained copy of the audio (#263).
- **A dictation's audio is kept as Opus**, about 180 KB a minute instead of 1.9 MB as WAV (#264).
- **An Enter pressed just after the text went in now sends**, and the dictation key while the draft box has the keyboard adds to the draft (#276).
- **Each choice of what inserts the text says how long it makes you wait** after you let go of the key, measured on this kind of machine where a measurement exists (#295).
- **Three settings stopped doing nothing or saying what is not true.** Pause music while you dictate now reaches the helper on Windows and Linux, and on a Mac it is shown off with the reason. History's Retry offers only the engines on this machine, and the draft box shows what was heard under a tidied text (#293).
- **"at sign" can become @**, and the Words page no longer loses words on an odd workspace name or a re-import (#301).
- Dictated words stay out of the log when the formatting hook fails, a cue that cannot play falls back to another player, and the key recorder survives a helper restart (#275).
- **Learned words stay off for Qwen dictation.** A measured run found that a longer list also made Qwen write listed words nobody said, so `dictation.glossary` stays `off` (#302).

### Agents and the API
- **Agents can do every per-call action the CLI does.** They can run the final pass, share a call, read a template, edit or delete a note, open the window and read a setting. Start answers no longer carry an `akou://` link that opened nothing (#262).
- **Ask presets are files.** The five questions in the ask box ship as Markdown files, and a file in the config folder's `presets/` adds or replaces one without a restart. `akou presets list` and `akou ask --preset NAME` use them, and agents get one MCP prompt per preset (#273).
- **The event stream can be filtered by type**, and `akou events` prints a call's log as one JSON object per line, so a monitor reads only what it needs (#287).
- **Agents can move a call to another workspace, trash it and restore it**, change who spoke one line, and ask `GET /calls` for only the calls changed since a cursor. akou deletes a trashed call after 30 days (#297).
- The [MCP tool reference](docs/reference/mcp.md) and the [CLI reference](docs/cli.md) are generated from the code, and CI fails when either drifts (#233, #283).

### Server and jobs
- **A running job shows how far it is**, by stage and seconds of audio, and a job the server already let go answers 410 instead of 404 (#267). A fused job's progress counts every engine (#323).
- **A job result names the spoken language** when Qwen ran, and the OpenAI route answers `und` rather than `unknown` when nothing names one (#255).
- **The server says what it really does.** It reports what `auto` runs and the diarize default, prints the address it is really bound to, and logs each failed callback as it fails (#253).
- **A key's callback hosts can change without losing its jobs**, with `PATCH /v1/keys/{id}` or `akou keys update`, and key and job changes are written to the server's log (#237).
- **`akou transcribe` takes `--keyword`, `--keywords-file` and `--priority`**, so an agent's job need not wait behind a backlog (#284).
- The server refuses a job title with a control character, and an open job's panel follows a rename (#286).

### The window
- The sidebar keeps its full width on Settings, Models and Dictation in a narrow window (#241).
- Ask says plainly why it has no answer, without naming a setting key, and the side column matches the design (#257).
- `akou ask --preset` right after the app starts no longer answers "not found" for a call on disk (#327).

### Install and releases
- **The app and the macOS command line are signed with a Developer ID and notarized by Apple.** macOS opens akou without the Open Anyway step, the `akou` binary runs after a browser download without clearing its download mark, and the microphone, system audio and Accessibility grants should now survive updates. A release fails when a signing secret is missing, and checks the shipped app and command line with Gatekeeper before it publishes them (#330).
- **Homebrew installs akou** with `brew install --cask geiserx/akou/akou`, and every release bumps the cask (#298).
- **Each release publishes an update feed**, so an installed app can learn that a newer version exists (#291).
- **A tag releases only a commit whose CI passed.** The release notes are its CHANGELOG section, and every asset carries a build attestation (#281).
- The desktop app is now built and checked on Windows x64 and Linux x64. Those builds are not published yet (#315).
- Importing a call folder whose post-processing file ends in an empty step no longer crashes (#279).
- More checks behind the scenes: a coverage floor, a running test for every trap, no new wall-clock reads in the code, a nightly a year ahead, fuzzing, an 8-hour soak, the window suite in WebKit on every pull request, and fixes for the flakiest tests (#256, #269, #272, #274, #279, #292, #299, #327). The release gates gained their runners, including a speech run on Windows (#294, #296, #307, #312, #313, #314, #316).

### Known limitations
- **Coming from 0.6.0 or older, macOS asks for the microphone, system audio and Accessibility once more**, because those builds were ad-hoc signed. Allow akou again in System Settings, then Privacy & Security, as [docs/troubleshooting.md](docs/troubleshooting.md#the-dictation-key-does-nothing) shows.
- **One app cannot be recorded on Linux**, so the mode is hidden there.
- **Pause music while you dictate cannot work on a Mac**, because macOS does not let one app see what another is playing.
- Every item under 0.5.5's Known limitations still applies.

## 0.6.0 — a file transcribes on the desktop app, and the fusion preset joins three engines

Up to 0.5.5 a recording on your own Mac had to be copied to a server before `akou transcribe` would take it, and on a server one engine decided every word. In 0.6.0 the desktop app runs file jobs itself, with its own token and the same queue and presets as a server. A server gains the `fusion` preset: Qwen3-ASR, Whisper large-v3 and Parakeet decode the same pieces and the result keeps, per word, the one the confidence vote prefers. On the benchmark the trio scores 7.97 pooled WER against 8.63 for Qwen alone.

### Files
- **`akou transcribe FILE` works on the desktop app.** Up to 0.5.5 it exited 69 with `not_server` unless akou ran in server mode, so a recording on your own Mac had to be copied to a server first. The desktop app now takes file jobs with its own token, on the same queue, presets and models as a server: long audio is cut at its pauses, `--diarize` labels the speakers, and the command prints the transcript and exits 0. The app keeps the job, so `akou jobs list` shows it until `server.retain_days` deletes it; a server still deletes it once the text is printed. Server mode keeps its one meaning: keyed access for other programs over the network. The app binds loopback as before, reads no keys, signs no callbacks, sends no job to `server.remotes`, and still answers 404 on `/v1/keys` and the OpenAI-compatible route.
- **A `best` file job waits its turn behind a call's final pass on Qwen**, and a final pass that starts meanwhile waits for the job: only one llama-server fits on Metal, and starting a second stops the first. A server's jobs do not wait.
- **The app closes a job's Worker once the queue is empty**, so a file transcribed once does not keep its model in memory. A server keeps its default model loaded, as before.
- **The app finds Homebrew's ffmpeg.** A Mac app opened from the Finder runs with a short PATH, so M4A, MP3 and Ogg files failed with "ffmpeg is not installed" although `brew install ffmpeg` had put one in `/opt/homebrew/bin`. akou now looks there and in `/usr/local/bin` when PATH has none.
- **No message sends anyone to server mode for a local file.** `akou help transcribe` says the desktop app runs the job, names `AKOU_URL`, `AKOU_API_KEY` and `AKOU_API_KEY_FILE` for a server, and lists the exit codes. An akou with no job routes now answers `no_jobs` (it was `not_server`), and `akou jobs list` no longer suggests `akou serve`. [docs/agents.md](docs/agents.md), [docs/usage.md](docs/usage.md#transcribing-a-file), [docs/server.md](docs/server.md) and the [akou skill](skills/akou/SKILL.md) say the same.

The HTTP API: the job routes and `GET /v1/events` answer in the desktop app too, and `GET /v1/server` there has `capabilities.jobs` and `events` true and a `queue` object; `webhooks`, `openai` and `interactive` stay false, and `dictation` stays null.

### Server jobs
- **The `fusion` preset is built.** A job with `preset: fusion` runs Qwen3-ASR, Whisper large-v3 and Parakeet over the same pieces of the file, one engine loaded at a time, and joins their words by confidence ROVER. On the benchmark this trio scored 7.97 pooled WER, against 8.63 for Qwen alone. The job's model reads `rover-conf(qwen3-asr-1.7b,whisper-large-v3,parakeet-tdt-0.6b-v3-fp32)`. A client can name such a list itself in `model`, and `server.default_model` can be `fusion`. `akou models pull fusion` fetches the three engines, the llama-server build and the speaker models.
- **An engine that fails is left out, and the job goes on.** An engine that will not load, crashes or refuses a piece is dropped, for the whole job or for that piece. The job fails only when no engine is left. The result's `engine.fusion` lists the engines that ran, with their decode seconds, and the dropped ones with the reason.
- **New settings:** `asr.final.engines` sets the preset's engines and their order (add `canary-1b-v2` for a fourth). `asr.fusion` is `rover-conf`, `rover-freq` or `first`. `asr.memoryBudgetMb` leaves out an engine whose estimated memory is over the budget. The fusers that ask a language model are not built yet.
- `GET /v1/server` gives each preset's speaker model (`diarizer`) and how it joins its engines (`fusion`).
- A recorded call's final pass still runs one engine, Parakeet or Qwen.

## 0.5.5 — a stuck akou recovers on its own, a double-click fixes a word, and server jobs run Qwen

On 0.5.4 akou could stop answering while its port still took connections. Every command then waited out its 60 s timeout, a plain kill did nothing, and one recording started 21 minutes late. In 0.5.5 the app ends itself when its main thread is stuck and no call records, and the command line restarts an app that stopped answering, never while a call records. Fixing a misheard word takes a double-click, and the agent following the call is told what the fix taught. On a server, a job that names no model now runs Qwen wherever it is downloaded, and its result says when each word was said.

### When akou stops answering
- **The command line restarts an app that stopped answering.** A command that changes something, `akou start` among them, stops the stuck app, saves a sample of it in the hangs folder, opens it again and runs, all within about 15 s, and says so. A command that only reads stops nothing and points at `--restart`. While a call records, it stops nothing. It says the audio is still being written and how to restart akou by hand (#226).
- **The app ends itself when its main thread is stuck.** A watchdog watches a heartbeat from that thread. With no call recording, after 10 s without one it logs a line, saves a sample, ends the app and every process under it, and opens akou again if its window was open. While a call records it only logs. A Mac waking from sleep does not trip it. The app now writes app.log itself, rotated at 4 MB and readable only by you (#227).
- **`akou quit` says "akou has quit" only once every akou process is gone**, the app, the launcher above it and the helpers below it. On 0.5.4 it could answer while the launcher was still running (#228).
- **A model import no longer freezes the app.** Importing from a folder copied files of up to 2.5 GB on the thread that answers the API, so akou went silent for the whole copy, 22 s for one model from another disk. The copy now runs in steps, checks SHA-256 as before, shows progress like a download, can be cancelled, and leaves no temporary file behind (#225).
- **A Mac with no display no longer crashes when a call starts.** The app died about 18 s in, when the menu bar item switched to the recording mark. With no display it now leaves the item as it is (#244).
- **The Dictation page says why when akou is out of reach**, for example while it restarts, instead of hanging on "Reading the dictation settings…". A failed save marks its row and names the setting (#229).

### Fixing a word
- **Double-click a word to fix it.** The fix opens on the line, above it when it does not fit below. A fix that taught akou a word shows as learned on the line, and from there you can rename the word or forget it. Forget removes only what this fix taught (#224).
- **An agent following the call learns what a fix taught.** The fix writes a `vocab.learned` event, and the agent's next read carries a learned list, once: the term taught, taken back or renamed, what it was heard as, and how many lines the fix changed. `akou_read` and `akou tail` print one plain line per item, and `akou_context` lists the five newest (#223). The [fix-a-word design](docs/ux/design-explorations/fix-a-word-on-the-line.md) now says a fix learns the word at once (#213).
- **A word no longer corrects its own inflections.** With "sandbox" in the vocabulary, "sandboxing" and "sandboxed" read as themselves again (#248).
- **A call archive's glossary imports whole.** akou cuts an entry over the vocabulary file's limits to fit and lists it with the reason, instead of failing the whole import. Variants marked `(ctx)` or `(refused)` and the call banners are left out (#248).

### The window
- **The live transcript stays at the bottom**, newest line last, with any empty space above it. Before, 40 percent of the window's height sat empty under the newest line, and the view could stop following on long lines. A reader who scrolled up stays where they are (#222).
- **A saved call says Back to the end**, not Back to live, when you scroll up. The share viewer does the same on an ended share (#235).
- **The player bar has a round play button, one time readout and a speed pill**, and a mark on the scrubber for each note taken in the part being played (#282).
- **Pressing two Download buttons for one model downloads it once.** Before, both downloads wrote the same file, it failed its SHA-256 check and was fetched again (#234).
- **Settings picks a job's model, language and dictation engine by name**, in both the desktop and server mode, instead of free-text fields holding `auto` (#246).

### Dictation
- **The draft key, fix last and paste last keys work.** The app sent them to the helper, but the helper only listened for the dictation key. Fix last opens the newest dictation in the draft box, and paste last types its text again (#277).
- **A tapped key session stops after silence**, Enter during a chord that holds Shift ends and sends again, and Mouse3 to Mouse5 can be the dictation key (#252).
- **The Dictation page names engines and apps in words.** A per-app rule shows the app's name on macOS, not its bundle id (#258).
- **A long dictation on Best no longer loses words.** Qwen's answer stopped where its context filled, so a five-minute dictation kept 100 of 679 words. Anything longer than 180 s now goes to Qwen in pieces cut at a quiet moment. The second pass and server jobs use the same path (#278).

### Server and jobs
- **A job that names no model runs Qwen wherever Qwen is downloaded**, as the app's final pass does. Otherwise it runs Parakeet when Parakeet is downloaded. With neither, it fetches Qwen on a GPU with 16 GB of memory and Parakeet elsewhere. `GET /v1/server` says what `auto` picks and why, and the Models page shows that sentence (#243).
- **A job's result says when each word was said and how sure the engine was**, lists the spans it could not decode, and says when speaker labels were asked for and lost. Qwen gives confidences but no word times. The result comes as JSON, the OpenAI shape, text, SRT or VTT (#238).
- **Each job can bound its auto language** with `languages[]`, so one server can serve clients that speak different languages (#247).
- **An agent can transcribe a file on its own machine in one tool call.** `akou mcp` adds `akou_transcribe`, `akou_job_get` and `akou_jobs_list`, and `POST /v1/jobs` takes `wait` to hold the answer until the job ends. A file that is not audio or video never leaves the machine (#251).
- **A client can trust the job feed.** A synchronous OpenAI transcription leaves no event behind, a cancelled event carries the job's metadata, and every page carries a `feed_id` that changes when the jobs database is replaced (#242).
- **A job that asks for speaker labels with no speaker helper fails** with `diarize_unavailable` and says how to fix it, instead of finishing without speakers. The release now publishes the macOS helper on its own as `akou-diarize-0.5.5-darwin-arm64.tar.gz` (#245).
- **The OpenAPI file lists every error code each route can answer** (#250). The [server page](docs/server.md) covers a reverse proxy in front of akou and the limits to raise for long recordings on a Mac (#271).

### Command line
- **`akou` exits 3 whenever there is no call to act on**, so a script can tell "no call yet" from a typo, and exits 130 on Ctrl-C without printing an error (#239).
- Dictation ids stay unique within one millisecond, a late cancel of a second-pass review no longer leaks, and a write to a helper that just exited no longer fails the run (#236, #240).

### Docs
- Every diagram on the [docs site](https://geiserx.github.io/akou/) reads in the dark theme (#230). The roadmap, design and requirements say what ships today, including Nemotron live, Qwen final and Parakeet as the fallback (#288, #289, #290). The settings reference fails the check when it drifts from the code (#259).
- The [compose example](examples/compose/telegram-archive/.env.example) pins the published 0.5.4 images (#221).

The HTTP API adds fields, routes and query parameters, and changes two answers. A synchronous OpenAI transcription writes no event to the job feed, and a bad audio range answers `bad_range` in the usual error shape instead of an empty 416.

### Known limitations
- **After installing a new build, macOS asks for Accessibility again**, because the app is ad-hoc signed. Allow akou again in System Settings, then Privacy & Security, then Accessibility, as [docs/troubleshooting.md](docs/troubleshooting.md#the-dictation-key-does-nothing) shows.
- **The hang itself is not fixed, only recovered from.** A window call waits on the app's main thread with no time limit. While a call records, akou never ends a stuck app, so you restart it by hand.
- **The fix for a Mac with no display has not run on one.** The crash did not reproduce on the machines at hand, so the evidence is a shell test and the recorded crash.
- **A model import on the same disk is now a real copy**, about 2.4 times slower than the old instant clone.
- Every item under 0.5.4's Known limitations still applies.

## 0.5.4 — Qwen writes the final transcript, and a Mac on Nemotron and Qwen needs no Parakeet

On 0.5.3 the final transcript always came from Parakeet, whatever was downloaded, and every Mac needed Parakeet before it could record. A long final pass showed no progress until it ended. In 0.5.4 Qwen writes the final transcript whenever it is downloaded, and a Mac that runs Nemotron for the live lines and Qwen after the call keeps no Parakeet at all. The final pass says how far it is, in the window and in `akou status`, and the Models page lists the whole catalog.

### After the call
- **Qwen writes the final transcript whenever it is downloaded.** `asr.final.model` picks the model. `auto`, the default, runs Qwen3-ASR when Qwen and its llama-server are on disk, and Parakeet when they are not. `qwen` or `parakeet` names one model. A model that is not downloaded never runs. The setting falls back to the other one and the log says why, as [docs/configuration.md](docs/configuration.md) describes. If Qwen cannot start or fails twice in a row, the pass fails with Qwen's error and does not switch to Parakeet halfway (#218).
- **`akou finalize --force --model qwen` reruns a past call on Qwen.** `--model` overrides the setting for one run. akou refuses a model that is not downloaded and starts no pass (#218).
- **One Qwen pass runs at a time.** A second pass waits its turn, and its note names the call it waits for. Quitting akou stops a running pass and its llama-server, and the next start runs the pass again (#218).
- **The final pass shows how far it is.** The window's note and bar read `final transcript: running, 37 of 152 min (Qwen)`, and `akou status` prints the same on a `Final:` line. Before the minutes move, the pass names its step, `starting Qwen` and then `labelling speakers` (#217, #218).

### Models
- **A Mac needs only the models its chosen setups use.** With Nemotron for the live lines and Qwen after the call, that means Nemotron, Qwen with its llama-server, the voice detector and the two speaker models. Parakeet is not on the list. It stays in the catalog, and once downloaded it has a Remove like any other model. An upgraded Mac keeps what it has and downloads nothing new before its next call (#219).
- **A fast dictation without Parakeet gets a plain `models_missing` answer**, because the fast engine is Parakeet (#219).
- **The All models page lists the whole catalog** for this Mac, grouped as Live transcript, After the call, Speakers and Helpers, with Download or Remove on each. A model that does not suit this Mac or the call's languages says why under its name and keeps its Download. The Helpers page is folded into it (#216).
- **Six more streaming Nemotron tiers**: English at 80, 160 and 1120 ms, and Nemotron 3.5 at 80, 160 and 320 ms, about 0.66 to 0.68 GB each. Nobody has measured their accuracy or speed yet, so `auto` never picks one. The 80 ms tiers can fall behind on a slow machine (#216).
- **A faded model row keeps its Download at full strength.** When the call's languages rule a model out, only its radio and name fade (#215).

### Live calls and agents
- **A read waits up to 30 s for the second pass**, up from 20 s. Qwen took 19 to 20 s on about 3 minutes of backlog and hit the old cap about half the time (#212).
- **The [akou skill](skills/akou/SKILL.md) no longer reminds anyone about consent**, as the window stopped doing in 0.5.3. Telling the others you are recording stays your job (#211).
- The [compose example](examples/compose/telegram-archive/.env.example) pins the published 0.5.3 images (#214).

The HTTP API only adds fields. `GET /status` has `finals[]` and `last.final`, `GET /calls/{id}` has `final.progress`, `POST /calls/{id}/finalize` takes `model`, and `GET /models` has `final` and `live.advice`. The `final.started` and `final.done` events name the model that ran.

### Known limitations
- **After installing a new build, macOS asks for Accessibility again**, because the app is ad-hoc signed. Allow akou again in System Settings, then Privacy & Security, then Accessibility, as [docs/troubleshooting.md](docs/troubleshooting.md#the-dictation-key-does-nothing) shows.
- **A 0.5.3 Mac with Parakeet and no Qwen keeps running Parakeet after the call** until Qwen is downloaded from the Models page.
- **Without a GPU, Qwen decodes on the processor and is slow.** A pass gets half the call's length plus 300 s, so a long call can run out of time. Set `asr.final.model` to `parakeet` on such a machine.
- Every item under 0.5.3's Known limitations still applies.

## 0.5.3 — pick the live model and a second pass by name, and dictate with no wait

On 0.5.2 the live menu named setups instead of models, and dictation could wait about 10 s for Qwen to load. In 0.5.3 one panel picks the live model by name and, as a separate choice, a second pass that goes back over the lines. The second pass also runs before an agent reads the call, so the agent reads corrected lines. Dictation types with the live model by default, shows everything you say, and its key works as soon as Accessibility is granted.

### The window
- **One panel picks the live model and the second pass.** It lists the downloaded models by name, one plain line each, with no Automatic row. The second pass is Off by default, or Qwen or Parakeet every 1, 2 or 5 minutes (#199, #203).
- **Add a model from the panel.** Each slot ends in Add a model, which downloads a model that fits the slot right there, with progress and Cancel. "From a folder…" copies a model you already have (#203).
- **The 1120 ms Nemotron is named "Nemotron 3.5, 1 s"**, after its wait. Nothing measured backed calling it steadier (#209).
- **The recording popup's level bars move**, and the extra space past Stop is gone (#202).
- **No consent reminder row when a call starts.** Telling the others you are recording stays your job (#204).

### Transcription
- **Parakeet can be the second pass.** On FLEURS it has 16% fewer errors than the live stream alone in English and 46% fewer in Spanish, and it adds no memory, because the live Worker already has Parakeet loaded. A line someone edited or fixed a word on keeps their text, and that now holds for Qwen's pass too (#200).
- **The second pass runs before an agent reads the call.** With a second pass on, a read of a live call first reviews the lines closed since the last review. A read waits at most 20 s, and its answer counts the lines it did not reach as `unreviewed`. `akou tail -f` and `akou watch` read with `review=skip` and never wait (#206).

### Dictation
- **Dictation types with the live model by default**, with no wait for a model to load. `dictation.final` picks the text that goes in: `live`, the default and the fastest, `parakeet` or `qwen`, as [docs/configuration.md](docs/configuration.md) lists. `live` gives up 3.0 points of word error rate in English and 0.6 in Spanish against Parakeet. akou loads dictation's models first when the app starts. It keeps a press made while they load, and the pill says "loading model" (#207).
- **The pill shows everything you say.** It grows up to eight lines, then scrolls, pinned to the newest words (#205).
- **The dictation key works once Accessibility is granted**, with no restart of akou (#208).

### Docs
- **The docs are a site** at [geiserx.github.io/akou](https://geiserx.github.io/akou/) (#190), and the site and README show the real app (#201).
- The live panel's [design drawings](docs/ux/design-explorations/lm-live-menu-slots.html) are in the repo (#198), and the [compose example](examples/compose/telegram-archive/.env.example) pins the published 0.5.2 images (#197).

The HTTP API only adds fields. `POST /calls` takes `review` and `reviewEvery`, `GET /status` has `live.review`, a live call's transcript read has `unreviewed`, and `GET /v1/dictation` has `final` and `live`. With the second pass Off, the default, no read waits.

### Known limitations
- **After installing a new build, macOS asks for Accessibility again**, because the app is ad-hoc signed. Allow akou again in System Settings, then Privacy & Security, then Accessibility ([docs/troubleshooting.md](docs/troubleshooting.md#the-dictation-key-does-nothing)).
- **The late Accessibility grant has not been checked on a real Mac yet.** The tests cover the helper and the app, but not a real grant and key tap.
- **With Qwen as the second pass and 5 minutes of lines pending, a read reaches its 20 s cap about half the time.** It then answers with the rest counted as `unreviewed`.
- **Parakeet in dictation can drop sentence ends on quiet speech**, because the pause finder hears the raw signal. That hits `dictation.final` `parakeet` and the fallback when no streaming model is downloaded.
- Every item under 0.5.2's Known limitations still applies.

## 0.5.2 — every setting is a page of plain words, and first run asks only what you need

On 0.5.1, Settings, Models and Dictation were dialogs full of config keys that did not close like a normal window. In 0.5.2 each one is a page of the main window with plain rows, and you leave it from the sidebar. A first run now asks what you will use akou for and sets up only that. Your API key moves into the macOS Keychain.

### The window
- **Settings is a page** of plain rows with a search box. Every change saves on its own, so the Save button is gone (#178).
- **Models is a page** of plain facts, and a download can be cancelled (#182).
- **Dictation is a page**, with its permissions, keys, voice, rules per app and engine as rows (#189).
- **Words and History are pages under Dictation**, so no settings dialog is left (#193).
- **The first run asks what akou is for**: calls, dictation or both. Then it asks only the steps that use needs: where calls go, permissions, the dictation key and engine, and the assistant (#195).
- **The workspace in the Record row is a menu.** A click switches it, and New workspace… adds one (#183).
- **The Record row picks the live transcription model** where the template was. It lists only the models on this Mac, and offers the Models page when there are none (#184).
- **The notes pane is just your notes.** The window no longer shows Enhance or Find misheard words. Their API routes, CLI commands and MCP tools stay (#185).
- **The menu bar shows the akou mark with a red dot while a call records**, with no text beside it (#187).

### Transcription
- **Fix a misheard word once, on its line, and the rest of the call reads it right.** A name or term you fix is learned for the workspace too (#186).
- **The optional Qwen review of live lines runs once a minute**, with about 80% fewer requests and no worse word error rate on FLEURS. Automatic now picks it when the Mac has Qwen, a GPU and 16 GB or more. The reviewed text lands about 45 s after the words instead of 6 to 9 s (#191).

### Assistant and agents
- **On macOS your API key lives in the Keychain**, never in `config.json`. A key already in the file moves there on first start. Settings lets you pick Claude Code or Codex, an API key, a local model (Ollama) or none (#194).
- **Starting a call while one records hands back the live call**, so an agent can follow it. `akou start --attach` and the MCP `akou_start` attach instead of failing. With no assistant set up, Ask becomes "Search this call" (#192).

### Docs
- **A shorter README** that says what akou is and how to install it. `docs/install.md` is now [docs/getting-started.md](docs/getting-started.md) (#188).

The Telegram-Archive contract keeps its shape. `POST /calls` takes a new optional `attach`, and a refused start names the live call under `already_recording`.

### Known limitations
- **On Windows and Linux the API key still sits in `config.json`**, and so does server mode's ([docs/providers.md](docs/providers.md)).
- **The first time a call records, the macOS menu bar item may move** to another spot, because akou replaces it to change its image.
- **Lines still waiting for their minute when a call ends are not reviewed live.** The final pass covers them.
- Every item under 0.5.1's Known limitations still applies.

## 0.5.1 — the final pass no longer fills the disk with swap

On 0.5.0, every final pass left its speech models in the app's memory, about 2.7 GB with Parakeet fp32. The first start of 0.5.0 runs the final pass over every past call that lacks one, so a few calls in a row were enough to grow the app to 10 GB, most of it in swap, until the disk was full. 0.5.1 fixes that and also brings a macOS window without the grey title bar, dialogs that close from the top, and a simpler in-call upgrade.

### Fixed
- **A final pass lets go of its models when it ends.** Each pass runs in its own Worker, and akou used to stop that Worker before the models' memory was freed. The Worker now frees them first. Three 40-minute calls in a row used to leave the app at 8.6 GB. Now it ends at about 1.2 GB, and that falls to about 130 MB after a few idle minutes. You no longer have to quit akou to get the memory back.
- **Every dialog closes from its top corner, with Escape, or with a click outside.** That covers Dictation, Words to review, Models, Settings, History, Dictionary, the quit question and server mode's key shown once. The title row with its × stays in view while the dialog scrolls, and closing puts the focus back where it was. See [docs/ux/WINDOW.md](docs/ux/WINDOW.md). A click outside does nothing while Settings or Models holds a change you have not saved, and never closes the key shown once. On the quit question, every way out means Cancel, so the call keeps recording.

### Changed
- **The macOS window runs to the top edge.** The grey title bar that only said "akou" is gone. The traffic lights sit over the sidebar, you drag the window by the strip above the rows, and a double-click on that strip zooms it. Windows, Linux and the browser page keep their normal frame.
- **The optional in-call upgrade (`asr.live: upgrade`) rewrites each line once, with Qwen alone.** Before, Parakeet rewrote each line and then a Qwen and Parakeet vote rewrote it again. On FLEURS read speech the result is 4.75 WER in English and 2.75 in Spanish, against 5.18 and 3.60 for the vote ([docs/research/asr-architecture.md](docs/research/asr-architecture.md#32-upgrading-live-text-during-the-call)). It has not been measured on meetings, so the Models page now shows these FLEURS numbers in place of the old AMI figure.

The Telegram-Archive contract is unchanged from 0.5.0.

### Known limitations
- **Nobody has dragged or double-click zoomed the new macOS window on a real Mac yet.** The tests run the page in a browser engine. Both steps are on the [release checklist](scripts/release-checklist.md).
- **A final pass stopped at its time budget still keeps its models** until akou restarts. Only a pass that ends by itself releases them.
- **The first-start catch-up has no retry limit.** A call whose final pass fails every time is tried again at every start.
- **During an in-call upgrade that started its own Qwen, dictation uses the `fast` engine** until the call ends.
- **Dictation still ships in the macOS app only**, and with Accessibility refused the dictation key does nothing yet.
- **The island's live words show in a screen share** (DK-P3). Turn `dictation.pillPreview` off before sharing your screen if that matters.
- **Streaming Nemotron loses words over a long call**, and **the Parakeet live path does not keep to `asr.languages`**, as in 0.5.0.
- Every other item under 0.5.0's Known limitations still applies.

## 0.5.0 — a new window, and the accurate transcript for every call the app records

The desktop window is rebuilt around a sidebar, and a first start now opens on a welcome that downloads the speech models instead of a workspace that cannot record. Dictation moves to a black island at the top of the screen that shows your words as you speak. The accurate final pass, which never ran on a call the desktop app recorded, now does. The live transcript can come from streaming Nemotron, which shows words sooner and never takes one back.

### The window
- **A welcome on first start.** While the speech models are missing, the window shows three steps in place of the workspace: download the models, what macOS will ask at the first Record, and the optional agent. Record stays disabled with its reason, and the state word reads `setup`, not `ready`. See [docs/ux/WINDOW.md](docs/ux/WINDOW.md).
- **The sidebar.** Calls grouped by workspace, newest first, with the live call on top. A search box finds a call by title or workspace (it never searches what was said). Dictation, Models and Settings moved from the header into the sidebar, and a row at the bottom says whether akou can record.
- **One composer row.** A round red Record with the global hotkey beside it, the title and template fields, and two thin meters for the mic and the call. The debug chips (clock, workspace, template, provider, engine) are gone; Settings shows the agent and speech engine in use.
- **A call header over the transcript**, with the title, day, length, workspace and the speakers with their talk time.
- **Ask and notes together.** The ask box sits on top with its presets in a menu, the last answer shows as a card, and the note input stays at the foot whether Notes or Enhanced is selected.
- **The player shows only when the open call has a recording.** The accent colour is kept for the one primary action, the welcome's Download.
- **Rename a call any time**, live or saved: click the title in the call header, `PATCH /v1/calls/{id}`, `akou calls rename last Weekly sync`, or MCP `akou_rename_call`. The call's folder keeps its first name.
- **A call started from the CLI or an agent takes the window over**, even after you clicked another call. The floating indicator has an Open transcript button, and both its meters and the window's now rise and fall like a level meter instead of jumping.

### Dictation
- **The island.** The pill is now a black island at the top of the display you dictate into. It shows a dot the moment the key goes down, the words as you speak (`dictation.pillPreview`, on by default), then a check or `Copied · ⌘V`. The draft box drops from it as a sheet, with Discard, Retry on another engine, Copy, Insert and Send. See [docs/ux/DICTATION.md](docs/ux/DICTATION.md).
- **Languages.** Setup asks which languages you speak. A language chip on the island and in the draft box switches the language with a click when the engine can be forced into one (`best` or `remote`), and the history row and the done island name the language used. `akou dictate start --language es` starts in a given language.
- **Alternatives.** Once two engines have read a dictation, clicking an underlined word offers what the other engine heard there.
- **Spacing and case.** Words dictated mid-sentence get the space before and after they need, and the first word is lower-cased mid-sentence (`Maybe` becomes `maybe`; `I`, `NASA` and `iPhone` stay). This reads the focused field, never a password field or a terminal, and only with `dictation.readField` and `dictation.smartSpacing` on.
- **Per-app rules work.** The rules the Dictation page saves now apply: the engine, the language, the formatting pass, the insert method and send key, and sending the text to the draft box instead. `dictation.insert: type` now types, as its name says, and pastes only text that holds a line break, so a spoken new line never presses Return in a chat app.
- **Clipboard only when Accessibility is refused.** Every insert then goes to the clipboard, with `Copied · ⌘V` on the island.
- **It says why the key does nothing.** The island names a lost Accessibility grant, and dictation starts again by itself once the grant is back. With Secure Input on, it says a key chord cannot reach akou and a single key still works. The key recorder has a Use Fn test.
- **A failed dictation keeps its words.** The error sheet has Retry, Copy and Open draft.
- **Sounds when the island is off**, the Linux default: start, stop, cancel and done cues through the OS's own player.
- **The Dictation page's mic meter moves**, and the page says when reading the field waits for Accessibility.

### Transcription
- **The final pass runs on the calls the desktop app records.** The capture helper now decodes its own Opus parts, so `akou finalize` and `akou wait --for final.done` work on every call, not only on calls with a WAV beside each part. **The first start of 0.5.0 runs the final pass on every past call that does not have a finished one, including calls whose pass failed before, one call at a time in the background.**
- **Streaming Nemotron for the live transcript.** Words show about 0.7 s after they are said and are never taken back. It measured 18.80 WER on AMI meetings against 36.17 for the Parakeet path ([docs/research/asr-architecture.md](docs/research/asr-architecture.md)). The model is not part of the first download: get one from the Live section of the Models page (or `akou models pull nemotron-en-560`). `asr.live.engine` picks the model from `asr.languages`.
- **Choose what writes the live transcript.** `asr.live` is `auto`, `parakeet`, `nemotron` or `upgrade`, set on the Models page, with `akou config set`, or per call with `akou start --live nemotron` and `POST /calls {live}`. `auto` uses Nemotron when its model is on disk, else Parakeet. `upgrade` rewrites each utterance during the call with Parakeet and then Qwen (13.31 WER on AMI), but keeps the GPU busy for the whole call, so it runs only when you choose it. `akou status` and `GET /status` report the setup a call runs.
- **Qwen no longer invents words on silence.** On 25 silent clips it wrote 78 words before this fix and none after. The nightly models job now checks Qwen's accuracy, its silence and llama-server's memory.

### Server mode
- **Named jobs.** `POST /v1/jobs` takes an optional `title`, the OpenAI door takes it as `metadata.title`, and `PATCH /v1/jobs/{id}` renames a job. `GET /v1/jobs?q=` finds jobs by title, id or state, and the Jobs page shows the title and has a search box. `akou jobs list` prints it. See [docs/ux/SERVER.md](docs/ux/SERVER.md).

The Telegram-Archive contract keeps its shape: the event feed, the job fields and the error shape are as in 0.4.0. `title` and `q` are new and optional.

### Known limitations
- **Dictation still ships in the macOS app only.** No desktop app is built for Windows or Linux yet.
- **Clipboard only without Accessibility is the app's half.** On macOS the helper's key tap needs Accessibility, so with the grant refused the dictation key does nothing yet. A dictation started from the tray, `akou dictate start` or the API does land on the clipboard.
- **The island's live words show in a screen share.** akou cannot hide its windows from screen capture yet (DK-P3). Turn `dictation.pillPreview` off before sharing your screen if that matters.
- **Streaming Nemotron loses words over a long call.** One stream per channel for the whole call read 12.84 WER on 40 joined English clips, against 8.05 for the same clips one call each. The final pass after the call is unaffected.
- **The live pass does not keep to `asr.languages` on the Parakeet path.** Parakeet takes no language, so a short English word can come out in another script in the live transcript.
- **The first-start catch-up has no retry limit.** A call whose final pass fails every time is tried again at every start.
- Every other item under 0.4.0's Known limitations still applies, except the ones this release closes: the error sheet's buttons, the still mic meter, per-app rules, sounds, and grants seen only while the helper runs.

## 0.4.0 — hold a key, talk, and akou types it into the app

akou can now type what you say into whatever app has the keyboard. Hold the dictation key, speak, let go, and the text goes in at the cursor. When you fix a word it heard wrong, it offers to learn that word, once, and learns it only if you say yes. The macOS app runs it end to end. The Windows and Linux halves of the helper pass CI, but no desktop app ships for those systems yet. A machine with no model of its own can send its dictations to another akou. The Models page now compares the models and downloads or deletes them, in the app as well as on the server.

The full design is [docs/ux/DICTATION.md](docs/ux/DICTATION.md).

### Dictation
- **Where it runs.** On macOS the helper hears the key through a key tap, which needs the Accessibility grant, then pastes the text or types it. Fn or Globe can be the key, and akou records from the built-in mic instead of a Bluetooth headset. On Windows the helper hears the key, pastes and types, and CI checks this on a real Windows desktop. On Linux the helper hears the key through the GlobalShortcuts portal or `/dev/input` and records the mic, but it cannot insert yet, so every dictation opens in the draft box. CI checks this with virtual devices and a fake portal. See [section 9](docs/ux/DICTATION.md#9-the-platform-layer).
- **The key.** Hold it to talk, or tap it to keep talking hands-free. The default is Right Command on macOS, Right Control on Windows and Control+Shift+Space on Linux. While you talk, Escape cancels, Enter sends once the text is in, and Shift+Enter puts the text in the draft box instead. A session stops by itself at `dictation.maxMinutes`, and saying "send it" at the end sends when `dictation.spokenSend` is on. The tray, `akou dictate start` and `POST /v1/dictation/start` start one too.
- **Nothing lost, nothing misplaced.** The first syllable is kept, from a short ring buffer while the mic stays warm. The old clipboard comes back only after the app has read the new text. Nothing is typed into a password field, or into a window other than the one where the dictation began.
- **The pill and the draft box.** A small floating window, the pill, shows `listening`, `transcribing`, `inserted` or the error, with Stop and Cancel. It is off by default on Linux. When the app cannot take the text, the text lands in the [draft box](docs/ux/DICTATION.md#52-the-draft-box) and is kept. You can edit it there, then insert it, insert and send, or discard it. The draft box underlines the words the engine was unsure of.
- **Engines.** `dictation.engine` is `fast` (Parakeet, about 0.1 s for 5 s of speech), `best` (Qwen3-ASR, kept warm while dictation is on), `auto` (`best` where Qwen runs on a GPU, the default) or `remote`. When `best` fails or stalls, akou uses `fast` and says so. akou drops filler words and room noise. With `dictation.spokenPunctuation` on, "comma" and "period" become marks.
- **It learns from your fixes.** Fix a word in the draft box or in the app's own field and a chip offers to learn it, with Learn and Not a word. Before it offers, akou decodes the dictation's audio again with the new word, and offers it only if the audio agrees. A learned word is a replacement in dictation only and never touches call transcripts. A fix you let go shows up under Words to review. The dictionary page saves words and replacements, so "example dot com" types example.com. See [section 8](docs/ux/DICTATION.md#8-learning-from-what-you-fix).
- **History.** Dictations are listed, with search, insert again, fix and delete for good. Each one keeps its audio by default, so Retry can decode it again on another engine. `dictation.retainDays` and `dictation.keepAudio` decide what stays and for how long.
- **A remote akou.** With `dictation.engine: remote`, the audio goes to another akou you run, with one of its `jobs` keys. akou sends it while you hold the key, so a 20 s dictation answers about as fast as a 3 s one. The address must be `https`, or `http` to a loopback, private or Tailscale address. When the remote gives no answer, `dictation.remote.fallback` decodes on this machine and says so, or shows the error. The Dictation page's Test button reports a bad key or a remote that is down before you first press the key. See [section 7.2](docs/ux/DICTATION.md#72-a-remote-akou-as-the-engine).
- **Formatting.** `dictation.format: provider` passes the text through your configured provider to fix punctuation and casing before it is typed. History keeps the raw text. If the provider fails or runs past its timeout, the raw text is typed and none of your words go into the log.
- **Doors.** `/v1/dictation` and `/v1/dictations` on the local API, dictation events on the event stream, `akou dictate` and `akou dictations` on the CLI (`akou dictate clip.wav` prints the text), and read-only history over MCP. See [section 10](docs/ux/DICTATION.md#10-doors-api-cli-and-mcp).

### Models
- The Models page runs on the server's web page and in a new Models dialog in the desktop window. It lists each model with what it is for, its size, its state and when it was last used. Each row has Download with live progress, Delete, and Set as default. Two bars score accuracy and speed from 0 to 100, with the source of each number in the tooltip. A model this machine has run also shows its measured real-time factor. See [docs/ux/SERVER.md](docs/ux/SERVER.md#124-the-web-page).
- The desktop app now deletes models left unused for a set number of days, as server mode already did. It never deletes the app's own recognizer, VAD or diarizer, or a model that is in use. `GET /models`, `POST /models/pull` and `DELETE /models/{id}` work in the app too, and `akou models list` prints both scores.

### Server mode
- A lane for dictation. With `interactive=true` on `POST /v1/jobs` or `POST /v1/audio/transcriptions`, a request runs on Workers that `server.dictation_slots` keeps apart (1 by default, 0 turns it off). The server answers a dictation at once, even while it drains a backlog, and the queue limits never refuse it. `server.dictation_engine` picks what it runs. The server's web page has a Dictation page, and `GET /v1/server` reports `capabilities.interactive` and `dictation`.
- A reused `Idempotency-Key` with a different file or a different transcript option (`preset`, `model`, `language`, `keywords[]`, `diarize`) answers `422 idempotency_conflict` and names the fields that differ, instead of returning the old job. A plain retry, or one with its keywords reordered or its language in another case, still answers the first job.
- Speaker labels no longer add "Yeah." or "Okay." at speaker changes, and a job's `speaker` is never `s?`. One llama.cpp build table now drives detection, the native download and the image, so a Mac with `asr.accelerator=cpu` runs `best`, and `GET /v1/server` stops reporting a GPU while Qwen runs on the CPU.

The Telegram-Archive contract keeps its shape: the event feed, the job fields and the error shape are as in 0.3.0. Two things behave differently. A retry that reuses an `Idempotency-Key` with different options now gets `422 idempotency_conflict`, the code a different file already got, instead of the old job. A job's `speaker` is never `s?`. `interactive` is new and optional.

### Known limitations
- **Dictation ships in the macOS app only.** No desktop app is built for Windows or Linux yet (akou-w51.70). The Linux helper has no X11 or Wayland insert, and its portal backend has not been tried on a real GNOME or KDE desktop.
- **The pill's error state has no buttons.** The app does not wire up Retry, Copy and Open draft yet, so you retry a failed dictation from History. The learn chip does show in the pill after a direct insert. But a second fix arriving while a chip is up replaces it without answering it, and no test covers the chip over a whole app yet. On macOS nobody has checked on a real Mac that clicking Stop leaves the keyboard with the app.
- **The hotkey recorder and the mic picker wait on the app's main side.** The recorder takes chords and single modifiers, but not Fn or Globe. Fn as the key is set in the config and has not been tried on a real Mac with an Apple keyboard. The mic picker has no device list, its meter does not move, and the mic you choose is not used yet.
- **Onboarding sees grants only while the helper runs.** Turning dictation on with the mic or Accessibility grant missing does not open the setup. A grant given after the helper started is seen only once dictation is turned off and on again.
- **Some saved settings have no effect yet:** per-app rules (`dictation.apps`), the draft, fix-last and paste-last keys, sounds, pausing other media, and the silence stop for a session you latched by tapping the key. Sessions started from the tray, the CLI or the API do stop after silence.
- **The latency nightly and the engine-biasing gate are not in CI.** The latency figures in [section 7](docs/ux/DICTATION.md#7-engines-and-the-remote-mode) are estimates, and `dictation.glossary` stays off by default until the gate shows that biasing helps without inventing names.
- **GPU speed is measured on Apple silicon and on one Intel iGPU.** On an Intel UHD 770 the `-vulkan` image decoded about 2x slower than the CPU image, so `best` on that iGPU is not faster than the CPU yet. Pass the render node akou detected with `--device`, not the whole `/dev/dri`. The CUDA image has passed CI, but nobody has timed it on a real card. Every other item under 0.3.0's Known limitations still applies.

## 0.3.0 — the best preset, on the GPU the box has

The server now runs the `best` preset, on Qwen3-ASR with speaker labels, and uses the GPU it finds: Intel or AMD through Vulkan, NVIDIA through CUDA, Apple silicon through Metal. A server that has no fitting GPU can hand its jobs to another akou, such as a Mac mini. A backlog of tens of thousands of files can drain without a client flooding the server.

### Server mode
- `best` runs Qwen3-ASR-1.7B, the most accurate open model akou knows for English and Spanish, through llama.cpp's `llama-server` (release b11200, every file pinned by SHA-256). A job asks for it with `preset=best`, or `server.default_model` makes it the default. `diarize=true` adds Nemotron speaker labels. The model and its llama-server download on demand, like any model. `asr.languages` keeps Qwen's automatic language choice inside the languages you list. See [docs/getting-started.md](docs/getting-started.md#the-best-preset).
- GPU images: `drumsergio/akou:<version>-vulkan` for Intel (integrated or Arc) and AMD GPUs, with `--device /dev/dri` and the render node's group, and `drumsergio/akou:<version>-cuda` for NVIDIA, with `--gpus all`. The plain `drumsergio/akou:<version>` runs on the CPU. All three are built for amd64 and arm64. See [docs/getting-started.md](docs/getting-started.md#a-gpu).
- `asr.accelerator` (`auto` by default, or `AKOU_ACCELERATOR`) picks the GPU: Metal on Apple silicon, CUDA for an NVIDIA card, Vulkan for an Intel or AMD GPU, else the CPU. llama-server then confirms the device itself. `GET /v1/server` reports `gpu` and `accelerator`, with the device's name, or the reason it runs on the CPU.
- Sending jobs to another akou: `server.remotes` names other akou servers, their key files and the presets to send them first. A job this server cannot run goes to a remote that offers it. The client still sees one server, with its own job ids, feed, webhooks and metadata. When a remote goes down, its jobs go back to the queue and never fail for that reason. See [docs/getting-started.md](docs/getting-started.md#sending-jobs-to-another-akou).
- A Mac as the server: `akou serve` from a source checkout uses Metal, with steps for a LaunchDaemon that starts it at boot. CI runs it on a macOS arm64 runner. See [docs/getting-started.md](docs/getting-started.md#a-mac-as-the-server).
- A large backlog: `server.concurrency` runs jobs in parallel, `server.queue_max` and `server.queue_max_per_key` cap the queue, and a submit past a limit gets `429 queue_full` with `Retry-After` before the upload is read. A job may carry `priority` from -10 to 10. `GET /v1/server` and `/healthz` report the queue's depth, throughput and ETA. See [docs/getting-started.md](docs/getting-started.md#a-large-backlog).

The Telegram-Archive contract does not change: the event feed, `Idempotency-Key`, the job fields and the error shape are as in 0.2.1. `priority` is new and optional.

### Known limitations
- **GPU speed is measured on Apple silicon only.** A Mac mini M4 runs `best` with speaker labels at a real-time factor of 0.16, natively on Metal. The Vulkan image on an Intel UHD 770 and the CUDA image on a real NVIDIA card have passed CI with no GPU, but nobody has timed them yet.
- **A Mac serves from a source checkout.** Docker on a Mac has no GPU, and the single-file CLI's `akou serve` still carries no speech engine.
- **`best`'s nightly accuracy checks are not in CI yet.** CI covers it with a fake llama-server. Qwen's per-word confidences do not reach the result yet.
- Every item under 0.2.0's Known limitations still applies, except the one that said only `fast` had an engine and the image used no GPU.

## 0.2.1 — the first published 0.2 release

The `v0.2.0` tag exists, but 0.2.0 never published a Docker image or a GitHub release. Docker Hub refused the push to `geiserx/akou`, a namespace that does not exist, and the release waits for the image. 0.2.1 ships everything listed under 0.2.0, under the image name that works.

### Changed
- The server image is now `drumsergio/akou:<version>`, starting with `drumsergio/akou:0.2.1` for linux/amd64 and linux/arm64. There is still no `latest` tag. The [Dockerfile](Dockerfile), [docs/getting-started.md](docs/getting-started.md#the-server), the [compose example](examples/compose/telegram-archive/compose.akou.yml) and the release workflow all use the new name.

### Added
- akou has a logo. The mark is a lowercase a that holds the red recording dot.
- The mark is the menu bar and tray icon, the macOS app icon in the Dock and Finder, and the favicon of akou's web pages. The idle tray icon has no red dot, so it never looks like it is recording.

### Known limitations
Every item under 0.2.0's Known limitations, below, still applies to 0.2.1.

## 0.2.0 — server mode

akou now also runs as a transcription server. The Docker image, for amd64 and arm64, takes audio files from other programs and returns their transcripts. It fetches the models it needs and has its own web page. The app, the CLI and the agent tools grew too: a player you can drive from the keyboard, a floating recording indicator, `akou watch`, and MCP answers that never outgrow an agent's context.

### Server mode
- Image for linux/amd64 and linux/arm64, built from the [Dockerfile](Dockerfile). It was meant to be `geiserx/akou:0.2.0`, but that name was never published: see 0.2.1. It runs `akou serve`. There is no `latest` tag. `akou models pull fast` fetches the models into a volume before the first start, with no server running. See [docs/getting-started.md](docs/getting-started.md#the-server).
- File jobs. `POST /v1/jobs` takes an audio file, such as an Ogg Opus voice note, M4A, MP3 or WebM. Wait on it with `?wait=`, read the result, or cancel and delete it. A retried submit with the same `Idempotency-Key` gets the first job back. Queued jobs survive a restart. A file longer than 240 minutes fails as `too_long` (`server.max_audio_minutes`).
- A job can name its model. Without one, akou uses `server.default_model`, then `fast`. A model akou does not have is downloaded while the job waits in the queue, and every file is checked against its pinned SHA-256. `server.auto_download` set to `false` turns that off. `server.default_language` and `server.default_diarize` apply when a request does not say.
- akou deletes on its own. A job, its result and its events go after `server.retain_days`, 7 by default. A model nobody has used for 30 days goes too (`server.models_unused_days`, 0 for never), but never the default model or one a job needs. A download that would take the models folder past 40 GB is refused (`server.models_max_gb`).
- Results arrive three ways: long poll, an event feed (`GET /v1/events`, JSON or Server-Sent Events), or signed webhooks (Standard Webhooks, retried for about three days).
- An OpenAI-compatible `POST /v1/audio/transcriptions`, so an OpenAI client pointed at akou transcribes files.
- One key per program. `akou keys create|list|revoke` issues keys with a `jobs` or `admin` scope and a list of hosts their webhooks may call. akou stores only a hash of each key, and refuses a revoked key on its next request.
- A web page for the server. An admin logs in from another machine with a password (`akou admin set-password`) or an admin key. The page has Jobs (watch, open, cancel and delete jobs), Keys (create and revoke), Settings (the server's defaults) and Models (state and download). The same key routes are at `/v1/keys`.
- Uploads up to 512 MB (`server.max_upload_mb`) stream to disk, so a large file never sits in memory.
- `GET /healthz` for container health checks. `GET /v1/server` lists presets, engines and how many days a job's result is kept.
- `akou transcribe <file>` sends a file to a server-mode akou and prints the transcript. That akou can be the image, `akou serve` in a source checkout, or one `AKOU_URL` names. The desktop app takes no file jobs.
- `AKOU_URL` with a key from `AKOU_API_KEY` or `AKOU_API_KEY_FILE` points the CLI and `akou mcp` at an akou on another machine.
- A compose example runs akou beside Telegram-Archive ([examples/compose/telegram-archive/compose.akou.yml](examples/compose/telegram-archive/compose.akou.yml)). CI runs the pair end to end: a voice note goes in, and its transcript comes back through the signed webhook.
- A data or models folder akou cannot write stops the start with one line naming the folder and the uid, not a stack trace later.

### API
- akou serves its own OpenAPI file at `GET /v1/openapi.json`, with no key needed. akou generates it from its route table, and CI fails when the committed [docs/api/openapi.json](docs/api/openapi.json) differs. `?scope=jobs` returns only what a `jobs` key may call, which Executor loads as tools.

### Transcript
- Parakeet now decodes greedily by default. Beam search with name boosts dropped stretches of meeting speech and inserted names nobody said. On AMI meetings beam lost 651 words where greedy lost none. Pooled over the public sets we measured, word error rate fell from 11.23% to 9.50% ([docs/research/asr-architecture.md](docs/research/asr-architecture.md)). `asr.parakeet.decoding` set to `beam` brings beam back, with a lower boost. Your word list still corrects the transcript after decoding, but under greedy its per-word decode boosts are not used.
- Groundwork for more speech engines: one engine interface, and a model catalog that knows which platforms each model runs on. Nothing changes for you yet.

### Window
- The player has Play and Pause, and Space toggles it. `[` and `]` set the speed from 0.75x to 2x, and `Shift+←` and `Shift+→` seek 5 s. The line being played stays highlighted and in view until you scroll away.
- A live speaker label is marked as a guess (`c1?`, dashed) until the final pass or until you name the speaker.
- Right-click a line, or press `Shift+F10`, for Play from here, Copy line, Copy with time and speaker, Name this speaker… and Fix a word….
- Fixes: the Notes, Ask and Enhanced tabs no longer show all at once. A note edit saves when you click away and after a 2 s pause. Copy transcript so far works.

### Desktop
- Quitting during a recording asks "A call is recording. Stop it and quit?" first.
- A small always-on-top indicator shows the recording time, both levels, Mute and Stop while the akou window is not in front. It never shows transcript text, so it can stay up during a screen share. `app.floatingIndicator` turns it off.
- The menu bar item shows an icon while idle. akou notifies you when an agent or the CLI starts a recording, when a start is refused, and when capture dies.
- Clicking the Dock icon opens the window, and the window comes back where you left it.
- On macOS, the Edit menu makes copy, paste and undo work in the notepad and the ask box, and `⌘,` opens Settings.
- akou menu > Install Command-Line Tool… puts `akou` on your PATH.
- Windows and Linux: the default global hotkey is now `Control+Shift+F9`, no longer `Control+Alt+R`, which is AltGr on many European layouts and could swallow a typed character. If you relied on the old default, set `app.hotkey` to `Control+Alt+R` in Settings.

### CLI
- `akou watch` follows a live call in the terminal. Type a question to ask the call, or a `/` command to run against it.
- `akou wait --for final.done|enhanced|exported` returns when the call reaches that stage, so a script no longer polls.
- Every command that works on a call takes `-c/--call`. Help comes from the command registry, so every accepted flag shows, and every command has an example.
- `akou config set KEY -` reads a secret from stdin. akou refuses a secret passed as an argument, because it is already in your shell history.
- Colour on a terminal only, off with `NO_COLOR` or a pipe.
- `akou doctor --grant` works. It used to exit with "not built".

### Agents
- `akou skill install` also registers `akou mcp` with Claude Code and Codex. `akou skill uninstall` removes both.
- Call text reaches an agent inside a marked block that says it is quoted speech, not instructions.
- MCP tools carry read-only and destructive hints and typed output. No answer passes 8,000 tokens, and `akou_get_call` pages through long calls.
- The repository is a Claude Code plugin with its own marketplace ([.claude-plugin](.claude-plugin)).

### Known limitations
- **Unsigned macOS build.** The first open needs a manual step, and macOS may ask for the microphone and system audio again after an update. See [docs/getting-started.md](docs/getting-started.md).
- **macOS only as an app.** The release ships the macOS app (Apple Silicon), the CLI and the server image. There is still no packaged desktop app for Windows or Linux. The Linux and Windows CLI archives manage models, the skill and the settings, but cannot record. The new `linux-arm64` archive has not been run on a Raspberry Pi yet.
- **Server mode and the image are new in this release.** CI builds the image on amd64 and arm64 and transcribes a spoken sentence in each. Nobody has run it for long on a real server yet. The design and what is still missing are in [docs/ux/SERVER.md](docs/ux/SERVER.md). A container refuses to start until you set `AKOU_BEHIND_PROXY=true` and put a reverse proxy with TLS in front of it, because akou has no TLS of its own. See [docs/getting-started.md](docs/getting-started.md#the-server).
- **The server's web page is partly built.** The Models page shows the models' state and a download button, but not each model's size, last use, deletion date or a Delete button. There is no preset picker yet, and the Jobs page polls twice a second instead of following the event feed.
- **One engine, on the CPU.** Only the `fast` preset has an engine. `lite`, `best` and `fusion` are refused, and akou does not choose by hardware yet. The image uses no GPU. Results carry no word times or confidences: `words` is empty and both confidence fields are null.
- **Transcribing a file needs server mode.** The single-file CLI's `akou serve` answers the API but carries no speech engine, and says so when it starts. On a Mac, use the image or a source checkout.
- **The window is tested in Chromium, but the app draws it in WebKit.** CI runs the window tests in headless Chromium. The WebKit run is manual while some of its tests still fail there, so the new player, line menu and indicator are not tested in the app's own webview.
- **Drift between two clocks is not measured.** One recording can take the mic and the call from two devices with separate clocks. How far they drift apart over an hour has not been measured on real hardware yet. See [docs/gates/M0-results.md](docs/gates/M0-results.md).
- **The 1 s rebuild has not been seen on a real device.** It is proven in simulated capture, but no call audio died during the hour-long run on a real Mac.
- **Large first download.** The speech and speaker models are about 3.0 GB, downloaded on first run.

## 0.1.0 — first prerelease

akou records a call from the window, the CLI, the local API or an agent (Claude Code or Codex, through MCP and the akou skill). It transcribes the call live and lets you or an agent ask questions about it while it is still going. After the call it hands the call to your own notes and tools. akou has no knowledge base of its own.

### Recording
- Mic and call audio recorded on separate channels by a native helper, in parts, so a crash loses little: 1.25 s when we killed the helper outright. The app never freezes waiting on capture.
- macOS through a process tap. Windows through process loopback, with akou's own audio left out. Linux through PulseAudio or PipeWire. Tested with real audio: Windows and Linux in CI, macOS on a reference Mac.
- A call side that stops delivering audio is rebuilt within about a second, down from 10 s. A silent first start no longer loses the first word.

### Transcript
- Live transcript, then a final pass over the whole call.
- Speech recognition with Parakeet TDT 0.6B v3 at full precision. On FLEURS it gets 6.0% of English words wrong where the compressed build gets 8.5%, and 3.1% of Spanish where it gets 4.0%. See [docs/research/asr-benchmark.md](docs/research/asr-benchmark.md).
- Speaker labels from NVIDIA Nemotron 3 Diarization, live and in the final pass. On our test calls, the share of speech with a wrong or missing label fell from over half to about a tenth.
- Your own word list corrects names and terms live and in the final pass. A learning step proposes new words from calls and documents, and adds nothing until you approve it.

### Asking and notes
- Ask about the call while it runs. akou builds a small context pack of the relevant lines instead of sending the whole transcript.
- Answers and enhanced notes come from your own Claude Code or Codex subscription by default. Any OpenAI-compatible or Anthropic endpoint works too, and so does no model at all.
- Hand-off to your own tools: export files, hooks and webhooks.

### Programmability
- `akou` CLI, a local HTTP API (`/v1`, loopback only, with a token), MCP tools and skills for Claude Code and Codex.

### Known limitations
- **Unsigned macOS build.** The first open needs a manual step, and macOS may ask for the microphone and system audio again after an update. See [docs/getting-started.md](docs/getting-started.md).
- **macOS only as an app.** The release ships the macOS app (Apple Silicon) and the CLI. Windows and Linux capture is tested in CI, but there is no packaged app for them yet.
- **Drift between two clocks is not measured.** One recording can take the mic and the call from two devices with separate clocks. How far they drift apart over an hour has not been measured on real hardware yet. See [docs/gates/M0-results.md](docs/gates/M0-results.md).
- **The 1 s rebuild has not been seen on a real device.** It is proven in simulated capture, but no call audio died during the hour-long run on a real Mac.
- **Large first download.** The speech and speaker models are about 3.0 GB, downloaded on first run.
