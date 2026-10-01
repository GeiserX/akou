# Troubleshooting

Each section is one thing that goes wrong: what you see, why, and what to do. If yours is not here, see [Reporting a bug](#reporting-a-bug).

## macOS says akou cannot be opened

**Why.** The 0.x builds carry an ad-hoc signature, not an Apple Developer ID, so macOS refuses the first open. See [Why macOS refuses it](getting-started.md#why-macos-refuses-it).

**Fix.** On macOS 14, Control-click akou in Applications, choose Open, then Open again. On macOS 15 and later, open System Settings, then Privacy & Security, and click Open Anyway near the bottom. Or clear the download mark once from a terminal:

```sh
xattr -dr com.apple.quarantine /Applications/akou.app
```

## One side of a recording is silent after an update

**Why.** macOS remembers the microphone and system audio grants by the app's signature, and an ad-hoc signed app gets a new one with every build. After an update macOS may treat akou as a different app.

**Fix.** Open System Settings, then Privacy & Security, then Microphone (for your side) or Screen & System Audio Recording (for the other side). Remove akou with the minus button, then record again so macOS asks.

## Record is disabled and the sidebar says "Models missing"

**Why.** akou transcribes with speech models it does not ship, and it does not start a recording until they are on disk.

**Fix.** Click **Set up** beside "Models missing", or open the **Models** page, and download the speech models (about 3.0 to 3.7 GB, by what your Mac runs). From a terminal, `akou models pull` does the same with progress per file.

## `akou start` answers `503 models_missing`

**Why.** The same as above: the speech models are not downloaded.

**Fix.** Run `akou models pull`. To record right away, `akou start --without-models` records the audio only, with no live transcript; `akou finalize` transcribes it once the models are there.

## The dictation key does nothing

**Why, and what to do,** in the order to check:

- **Accessibility is missing or was lost**, often after an update. The island says so. Allow akou again in System Settings, then Privacy & Security, then Accessibility; dictation starts again by itself once the grant is back.
- **Secure Input is on**: a password field, or an app that asks for one, holds the keyboard. A key chord cannot reach akou then; a single key such as Right Command still works. The island says so.
- **A Bluetooth headset is the default mic.** akou dictates on the built-in mic instead, so the headset keeps its good sound profile. Turn off `dictation.preferBuiltInOverBluetooth` to use the headset.
- **Dictation is off.** Check the Dictation page, or `akou config show dictation.enabled`.

## The menu bar item moved after the first recording

**Why.** Known in 0.5.4: akou replaces its menu bar item to change its image to the mark with the red dot, and macOS may put the new one in another spot.

**Fix.** None needed. Command-drag the item back where you want it.

## The live transcript shows a wrong word

**Why.** The live pass is fast and sometimes mishears a name or a term.

**Fix.** Open the line's menu, choose **Fix this line…**, change what akou got wrong and press Enter. A name or term is fixed on every line of the call at once, and learned for the workspace too; other words are fixed on that line only. After the call, the accurate final pass runs on the whole recording. To prepare names before a call, see [The vocabulary is the one thing that carries over](knowledge-handoff.md#the-vocabulary-is-the-one-thing-that-carries-over).

## Ask says the provider cannot answer

**Why.** akou says why and shows the excerpts it found instead: the program is missing (Claude Code or Codex not installed or not on your `PATH`), a usage limit is reached, you are logged out, or no answer came within `provider.timeoutSeconds` (60 s by default). It never queues or retries the request quietly.

**Fix.** Run the harness once in a terminal (`claude` or `codex`) to see whether it is logged in and within its limits, set `provider.harnessPath` if it is installed somewhere akou does not look, or pick another assistant on the Settings page. See [Providers](providers.md).

## The server refuses to start with exit 78

**Why.** Inside a container, and with `akou serve`, akou listens on every address by default, and it refuses to do that until you say a reverse proxy with TLS is in front of it, because akou has no TLS of its own.

**Fix.** In Docker, add `-e AKOU_BEHIND_PROXY=true` and publish the port on loopback only (`-p 127.0.0.1:8476:8476`). With `akou serve` on a plain machine, set `{ "api.bind": "127.0.0.1" }` in `~/.config/akou/config.json`. See [Server mode](server.md).

## The model pull exits 70, or the server exits 77, naming `EROFS`

**Why.** The server runs as uid 1000 and writes to both `/data` and `/models`. A read-only mount (`:ro`), or a bind-mounted folder owned by another user, cannot be written.

**Fix.** Use named volumes, or `chown 1000:1000` the host folders and mount them read-write.

## akou does not answer

**What you see.** A command waits a few seconds, then prints `akou was not answering; restarted it (12 s)` and goes on. Or it stops with `akou is not answering`, and exit code 69.

**Why.** Some of akou's work waits on the window's toolkit, and when the toolkit stops responding akou waits with it. It still takes connections on its port but answers none, and a plain `kill` or `pkill` does not end it. The recording itself is not affected: the capture helper writes the audio to its file on its own.

**What akou does.** Before its first request every command gives the app 3 s to answer. When it does not, a command that changes something, such as `akou start`, gives it up to 10 s in all, so a busy akou is left alone. If it is still silent, the command stops akou and starts it again, then runs, all within about 15 s. A command that only reads, such as `akou status`, says akou is not answering and stops nothing; add `--restart` to restart it from there. If a call is recording, nothing is stopped, and the message says so. A restart does stop a final pass in progress, which runs again at the next start, and a dictation in progress, whose words are lost.

The app also watches itself. When its own work stops for 10 s, it writes a line to `~/.config/akou/app.log`, and with no call recording it ends itself, so the next command starts a fresh one. If its window was open, it opens again a second later, at most once in ten minutes; after a second hang inside that time it stays closed, and opening akou from Applications brings it back.

**Fix by hand.** When a call is recording and you want akou back before it ends, the message names akou's process: `kill -KILL` that number, then run the command again. The recording so far stays on disk and akou closes it at its next start. On macOS each restart leaves a few seconds of `sample` of the stuck process in `~/.config/akou/hangs/`; attach the newest one when you report the bug.

## Reporting a bug

Open an issue on the [issues page](https://github.com/GeiserX/akou/issues) with:

- the output of `akou doctor`, which checks the models, the helper, the token, the API and the permissions;
- the output of `akou --version`, and your macOS version;
- the log that goes with the problem: a call's `logs/` folder inside its folder under `~/Recordings/akou`, and `~/.config/akou/app.log`, the app's own log (`app.log.1` is the one before it). It names calls by id only, never a title or a word said.

Never attach a recording, a transcript or notes from a real call. To report a security problem, follow the [security policy](https://github.com/GeiserX/akou/blob/main/SECURITY.md) and do not open a public issue.
