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

**Fix.** Click **Set up** beside "Models missing", or open the **Models** page, and download the speech models (about 3.0 GB). From a terminal, `akou models pull` does the same with progress per file.

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

**Why.** Known in 0.5.2: akou replaces its menu bar item to change its image to the mark with the red dot, and macOS may put the new one in another spot.

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

## Reporting a bug

Open an issue on the [issues page](https://github.com/GeiserX/akou/issues) with:

- the output of `akou doctor`, which checks the models, the helper, the token, the API and the permissions;
- the output of `akou --version`, and your macOS version;
- the log that goes with the problem: a call's `logs/` folder inside its folder under `~/Recordings/akou`, or `~/.config/akou/app.log` when the command line started the app.

Never attach a recording, a transcript or notes from a real call. To report a security problem, follow the [security policy](https://github.com/GeiserX/akou/blob/main/SECURITY.md) and do not open a public issue.
