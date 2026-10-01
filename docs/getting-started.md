# Getting started

akou 0.x runs on Macs with Apple silicon and macOS 14.4 or later. Every release on the [releases page](https://github.com/GeiserX/akou/releases) has these files:

| File | What it is |
|---|---|
| `akou-<version>-macos-arm64.dmg` | The app, to drag into Applications |
| `akou-<version>-macos-arm64.zip` | The same app, zipped |
| `akou-cli-<version>-darwin-arm64.tar.gz` | The `akou` command line for macOS |
| `akou-cli-<version>-linux-x64.tar.gz`, `akou-cli-<version>-linux-arm64.tar.gz`, `akou-cli-<version>-windows-x64.zip` | The command line alone, for Linux and Windows. The app for those systems is not released yet, so these can manage models, the skill and the settings, but cannot record |
| `SHA256SUMS` | A checksum for every file above |

To check a download, put it next to `SHA256SUMS` and run:

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
```

## The app

1. Open the DMG and drag akou into Applications.
2. Open akou once. macOS will refuse, because this build is not signed by Apple (see below).
3. Let it open:
   - On macOS 14, Control-click akou in Applications, choose Open, then Open again.
   - On macOS 15 and later, open System Settings after the refusal, then Privacy & Security. Near the bottom it says akou was blocked. Click Open Anyway and confirm with your password.
4. The first open takes a few seconds while the app unpacks itself in place.

You do this once per install. After that akou opens like any other app.

### Why macOS refuses it

Apple lets an app open without a warning only when it is signed with a paid Developer ID and checked by Apple (notarized). akou 0.x is neither. It carries an ad-hoc signature instead. That proves the files were not changed after the build, but it does not say who built them. That is why the first open needs your explicit OK. The `SHA256SUMS` check above is how you confirm the file is the one this repository built.

Signing and notarization will come later. The [release workflow](https://github.com/GeiserX/akou/blob/main/.github/workflows/release.yml) is ready for them. Once the owner adds a Developer ID and Apple credentials as secrets, the same build signs and notarizes, and this step goes away.

## The speech models

akou transcribes on your Mac, with speech models it does not ship. The first time the window opens it shows a card: **Download speech models**. It is one download into `~/Library/Application Support/akou/models` of the models your setup uses: the voice-activity model, the two speaker models (Nemotron 3 Diarization and TitaNet), and the speech models. On a Mac with a GPU and 16 GB of memory those are streaming Nemotron for the live transcript and Qwen3-ASR with its llama-server for the transcript after the call, about 3.7 GB in all. With less memory, Parakeet does both, about 3.0 GB. With `asr.diarizer` set to `embeddings`, pyannote takes Nemotron 3 Diarization's place. Parakeet stays one Download away on the Models page, and any model no setup uses can be removed there. Every file is checked against a SHA-256 written into akou's code, and a file that does not match is thrown away. Nothing else is sent anywhere.

From a terminal it is the same download, with progress per file:

```sh
akou models pull
```

On a machine without internet, copy the files from another machine and run `akou models import DIR`. `akou models list` shows what is there. The files and their checksums are listed in [src/main/asr/models.ts](https://github.com/GeiserX/akou/blob/main/src/main/asr/models.ts).

Until the models are there, akou does not start a recording: `akou start` answers `503 models_missing` and says to run `akou models pull`. If you need to record right away, `akou start --without-models` records the audio only, with no live transcript.

## Permissions

The first time you record, macOS asks two questions: may akou use the **microphone**, and may it record **system audio** (the other side of the call). Answer Allow to both. Both grants belong to the akou app, whichever way you started the recording.

**After an update, macOS may ask again.** macOS remembers a grant for an app by its signature. An ad-hoc signed app gets a new signature with every build, so macOS may treat the new version as a different app. If it asks, allow again. If a recording after an update is silent on one side, open System Settings, then Privacy & Security, then Microphone or Screen & System Audio Recording, remove akou with the minus button, and record again so macOS asks.

With a Developer ID signature, which comes later, the grants will survive updates.

## The command line

The app is all you need to record. The `akou` command lets you and your coding agent drive it from a terminal.

With the app installed, the quickest way is the akou menu: **Install Command-Line Tool…** links the app's own `akou` into `/usr/local/bin`. macOS asks for your password only when that folder needs it. Open a new terminal and run `akou --version`. The link follows the app, so an update updates the command too.

Without the app, use the release archive for your system. On a Mac:

```sh
tar -xzf akou-cli-<version>-darwin-arm64.tar.gz
mkdir -p ~/.local/bin
mv akou-cli-<version>-darwin-arm64/akou ~/.local/bin/
akou --version
```

On Linux it is the same with `linux-x64` in place of `darwin-arm64`. On Windows, unzip `akou-cli-<version>-windows-x64.zip` and move `akou.exe` into a folder on your `PATH`.

`~/.local/bin` must be on your `PATH`. If you downloaded the file with a browser, macOS marks it as downloaded and refuses to run it. Clear the mark once:

```sh
xattr -d com.apple.quarantine ~/.local/bin/akou
```

If the app is not running, a command that needs it opens `/Applications/akou.app` (or `~/Applications/akou.app`) in the background, with no window. `akou doctor` checks the setup: settings, the token, the models, the capture helper and the local API. The capture helper ships inside the app, so doctor asks the running app about it; with the app closed that line is a warning, not a failure.

To let Claude Code or Codex start, follow and question your calls, install the akou skill or the Claude Code plugin: see [Agents and the command line](agents.md).

## The server

akou also runs as a self-hosted transcription server in Docker. See [Server mode](server.md).

## Uninstalling

1. If you turned on "Open at login", turn it off in akou's menu bar item first, or delete `~/Library/LaunchAgents/io.github.geiserx.akou.login.plist`.
2. Quit akou: `akou quit`, or "Quit akou" in the menu bar item.
3. Delete `/Applications/akou.app` and the `akou` command, if you installed it: `/usr/local/bin/akou` from the menu (`sudo rm /usr/local/bin/akou` if the folder is root's), or `~/.local/bin/akou` from the release archive.
4. Delete what akou keeps for itself:
   - `~/.config/akou`: settings, vocabulary and the API token;
   - `~/Library/Application Support/akou`: the speech models;
   - `~/Library/Application Support/io.github.geiserx.akou`, if it is there: the app's unpacking and update folder.
5. Your recordings are in `~/Recordings/akou` (or the folder you chose). Keep or delete them as you like.
6. To remove the grants, open System Settings, then Privacy & Security, and remove akou from Microphone and from Screen & System Audio Recording.

## Your first call

1. Open akou.
2. On the first screen, pick **Calls** or **Both** (Both adds dictation), and continue.
3. At **Speech models**, click **Download speech models** and wait until it says the models are ready.
4. Finish the setup, then click **Record**.
5. Allow the microphone and system audio when macOS asks.
6. Speak for ten seconds, then click **Stop**.

It worked when the sidebar lists the call and the transcript shows your words with your name from Settings.
