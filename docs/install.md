# Installing akou

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

Signing and notarization will come later. The [release workflow](../.github/workflows/release.yml) is ready for them. Once the owner adds a Developer ID and Apple credentials as secrets, the same build signs and notarizes, and this step goes away.

## The speech models

akou transcribes on your Mac, with speech models it does not ship. The first time the window opens it shows a card: **Download speech models**. It is one download of about 3.0 GB into `~/Library/Application Support/akou/models`: the recognizer, the voice-activity model and the two speaker models (Nemotron 3 Diarization and TitaNet). With `asr.diarizer` set to `embeddings` it is about 2.6 GB, with pyannote in place of Nemotron. Every file is checked against a SHA-256 written into akou's code, and a file that does not match is thrown away. Nothing else is sent anywhere.

From a terminal it is the same download, with progress per file:

```sh
akou models pull
```

On a machine without internet, copy the files from another machine and run `akou models import DIR`. `akou models list` shows what is there. The files and their checksums are listed in [src/main/asr/models.ts](../src/main/asr/models.ts).

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

To teach Claude Code or Codex to use akou:

```sh
akou skill install
```

It copies the akou skills into each harness's skills folder (`~/.claude/skills`, and `$CODEX_HOME/skills`, by default `~/.codex/skills`) and registers the akou tools with each harness through its own `claude mcp add` and `codex mcp add`. If a harness's program is not on your `PATH`, it prints the exact `mcp add` command to run instead. An `akou` entry that runs another akou, such as a source checkout or an older install, is replaced by the akou you ran, and the output names the command it replaced. An `akou` entry in Claude Code's local or project config wins over the user one akou writes, so akou leaves it alone and prints the commands to replace it. `akou skill uninstall` removes both again.

For Claude Code there is also a plugin, served from akou's own repository:

```sh
claude plugin marketplace add GeiserX/akou
claude plugin install akou@akou
```

It gives Claude Code the akou skills and the `akou_*` tools in one step, and updates them with the plugin. Its tools run `akou mcp`, so the `akou` command above must be on your `PATH`. Use the plugin or `akou skill install` for Claude Code, not both: with both, Claude Code lists every akou skill and tool twice.

## The server

akou also runs as a transcription server that other programs send audio to. [ux/SERVER.md](ux/SERVER.md) has the design. The image is `drumsergio/akou:<version>`, built from the [Dockerfile](../Dockerfile) for linux/amd64 and linux/arm64, with `-vulkan` and `-cuda` variants for a GPU ([A GPU](#a-gpu)). There is no `latest` tag: name the version you want.

Pull the models into their volume first, so the first start is not a 3.0 GB download. No server needs to run for this. Mount the data volume too: the pull reads `asr.diarizer` from the settings there, and without it an `embeddings` choice is ignored and it fetches Nemotron instead of pyannote. On a new volume, set `asr.diarizer` first:

```sh
docker run --rm -v akou-data:/data --entrypoint sh drumsergio/akou:<version> -c \
  'mkdir -p /data/.config/akou && echo "{ \"asr.diarizer\": \"embeddings\" }" > /data/.config/akou/config.json'
```

Then pull:

```sh
docker run --rm -v akou-data:/data -v akou-models:/models drumsergio/akou:<version> models pull fast
```

`fast` fetches everything the server loads before it transcribes: Parakeet TDT 0.6B v3, the voice-activity model and the two speaker models (Nemotron 3 Diarization and TitaNet; pyannote in place of Nemotron with `asr.diarizer` set to `embeddings`). A second run checks every file's SHA-256 and downloads nothing. `akou models pull MODEL` fetches one model by the id `akou models list` shows.

`best` is the other preset with an engine: Qwen3-ASR-1.7B, run by llama.cpp's `llama-server`, with the same speaker models when a job asks for speakers. `models pull best` fetches Qwen (2.5 GB), the llama-server build for this machine and the speaker models, and leaves Parakeet out. Without the pull, the first `best` job fetches them. See [The best preset](#the-best-preset) for where it runs fast.

Inside a container akou listens on every address, and it refuses to start that way (exit 78) until you say a reverse proxy with TLS is in front of it, because akou has no TLS of its own. Say it with `AKOU_BEHIND_PROXY=true`, which sets `server.behind_proxy`, and publish the port on this machine's loopback only, for the proxy to reach:

```sh
docker run -d --name akou -e AKOU_BEHIND_PROXY=true -p 127.0.0.1:8476:8476 \
  -v akou-data:/data -v akou-models:/models drumsergio/akou:<version>
```

The server runs as an unprivileged user, uid 1000, keeps its settings, keys and jobs under `/data` and the models under `/models`, and decodes any audio file with the ffmpeg inside the image. `docker stop` ends it cleanly. A bind-mounted folder in place of a volume must belong to uid 1000 (`chown 1000:1000` it on the host): a folder the server cannot write stops it at start with exit 77 and the folder's name.

To run it beside [Telegram-Archive](https://github.com/GeiserX/Telegram-Archive), use the compose file in [examples/compose/telegram-archive](../examples/compose/telegram-archive/) and the one-time setup in [ux/SERVER.md section 12.5](ux/SERVER.md#125-one-compose-file-for-both).

Without Docker, run `bun src/main/cli/cli.ts serve` in a source checkout. That is `akou serve`, the same server in the foreground. The single-file `akou` CLI runs `akou serve` too, on Linux x64 and arm64 and on macOS. It carries no speech engine, so it answers the API but cannot transcribe, and it says so when it starts.

`akou serve` binds every address by default too, so on a plain machine it refuses to start (exit 78) until you choose. Put `{ "api.bind": "127.0.0.1" }` in `~/.config/akou/config.json` to serve this machine only, or set `server.behind_proxy` to `true` once a reverse proxy with TLS is in front of it.

### A Mac as the server

Docker on a Mac has no Metal, so on a Mac the server runs natively, from a source checkout at the release tag. The single-file `akou` CLI cannot transcribe, as above. You need [Bun](https://bun.sh) at the version in `.bun-version`, and ffmpeg for anything but a 16 kHz WAV (`brew install ffmpeg`):

```sh
git clone --branch v<version> https://github.com/GeiserX/akou.git && cd akou
bun install --frozen-lockfile
bun src/main/cli/cli.ts models pull fast
bun src/main/cli/cli.ts models pull best   # Qwen3-ASR and its Metal llama-server, for the best preset
bun src/main/cli/cli.ts serve
```

It keeps its settings, keys and jobs in `~/.config/akou` and the models in `~/Library/Application Support/akou/models`. To reach it from another machine, put a proxy with TLS in front of it (a `tailscale serve` of port 8476 on a tailnet works) and set `{ "api.bind": "127.0.0.1", "server.behind_proxy": true }` in `~/.config/akou/config.json`.

To start it at boot, with no one logged in, save this as `/Library/LaunchDaemons/io.github.geiserx.akou.serve.plist` with your user name, the checkout's path and Bun's path filled in, then run `sudo launchctl bootstrap system /Library/LaunchDaemons/io.github.geiserx.akou.serve.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.github.geiserx.akou.serve</string>
  <key>UserName</key><string>YOU</string>
  <key>WorkingDirectory</key><string>/Users/YOU/akou</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/.bun/bin/bun</string>
    <string>src/main/cli/cli.ts</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>/Users/YOU</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/akou-serve.log</string>
</dict>
</plist>
```

`KeepAlive` starts it again if it stops; `sudo launchctl bootout system/io.github.geiserx.akou.serve` stops it for good.

### Sending jobs to another akou

An akou server can hand jobs to other akou servers, for example a container that sends `best` to a Mac mini with a GPU, while its clients keep talking to it alone. [ux/SERVER.md section 14](ux/SERVER.md#14-sending-jobs-to-another-akou) has the design. On the remote, make a `jobs` key for the server that will send it jobs:

```sh
akou keys create --name primary --scope jobs
```

On the sending server, save the printed `ak_` key in a file only the server's user can read (in the container, under `/data`, owned by uid 1000, mode 0600), and name the remote in `config.json` with the URL, the key file and, optionally, the presets to send there first:

```json
{ "server.remotes": ["https://mini.example /data/remotes/mini.key best"] }
```

Restart the server. `GET /v1/server` then lists the remote under `remotes` with its state (`up`, `down` or `refused`) and the presets it offers, and a preset a remote offers shows as available. A job for a preset this server cannot run goes to a remote that offers it; one for a preset the entry names goes there first and runs here while the remote is down; everything else runs here. A remote that goes down leaves its jobs queued, never failed, until it or another remote that offers them is back.

### A GPU

The large speech model, Qwen3-ASR, runs on llama-server, and a GPU makes it many times faster than the CPU. Every image carries a llama-server build, uses the GPU it can open, and falls back to the CPU. Pick the image for your GPU:

| GPU | Image | Add to `docker run` |
|---|---|---|
| None | `drumsergio/akou:<version>` | Nothing |
| Intel (integrated or Arc) or AMD | `drumsergio/akou:<version>-vulkan` | `--device /dev/dri --group-add $(stat -c %g /dev/dri/renderD128)` |
| NVIDIA | `drumsergio/akou:<version>-cuda` | `--gpus all`, with the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the host. The image carries the CUDA runtime; the host needs only the driver (570 or newer on x64) |
| Apple silicon | None: Docker on macOS has no GPU | Run akou on the Mac itself ([A Mac as the server](#a-mac-as-the-server)); it uses Metal |

`--group-add` gives the container's user the group that owns the render node on the host (`render` on most distributions). Without it the GPU is there but akou cannot open it, and it says so. In compose, the Vulkan image takes:

```yaml
    devices: ["/dev/dri:/dev/dri"]
    group_add: ["993"] # the number `stat -c %g /dev/dri/renderD128` prints on the host
```

and the CUDA image:

```yaml
    deploy:
      resources:
        reservations:
          devices: [{ driver: nvidia, count: all, capabilities: [gpu] }]
```

To see what it chose:

```sh
curl -s http://127.0.0.1:8476/v1/server | jq '.gpu, .accelerator'
```

`gpu` is `vulkan`, `cuda`, `metal` or null for the CPU. `accelerator.device` is the GPU's name as llama-server lists it, `verified` is true once llama-server itself confirmed the device, and `reason` says why when it runs on the CPU. The setting `asr.accelerator` overrides the choice: `auto` (the default), `cpu`, `metal`, `vulkan`, `cuda`, `sycl` or `rocm`, also as the environment variable `AKOU_ACCELERATOR`. `auto` never picks SYCL or ROCm, which need Intel's oneAPI or AMD's ROCm runtime on the host; Vulkan runs the same cards. OpenVINO is not offered: its llama.cpp backend does not run speech models yet.

The GPU runs the `best` preset's Qwen3-ASR ([The best preset](#the-best-preset)); Parakeet (`fast`) stays on the CPU, where it already runs far faster than real time.

### The best preset

`best` runs Qwen3-ASR-1.7B, the most accurate open model akou knows for English and Spanish, as a child process of akou (`llama-server`, pinned to llama.cpp release b11200 and downloaded like a model). A job asks for it with `preset=best`; a server makes it the default for every job that names nothing with `server.default_model`:

```sh
akou config set server.default_model best
akou config set asr.languages '["en","es"]'
```

`asr.languages` lists the languages the people you transcribe speak. Qwen picks the language of each stretch of audio itself, and sometimes names one nobody spoke (a filler heard as Chinese); with the list set, such a stretch is decoded again in the listed language the model scores higher. A job that sends `language` gets that language instead.

Where it runs is `asr.accelerator`:

| Machine | Setting | What runs |
|---|---|---|
| A Mac with Apple silicon, akou run natively (`akou serve`) | `auto` (the default) | Metal. On a Mac mini M4 a 10-minute meeting with speaker labels took 94 s, a real-time factor of 0.16 |
| The Docker image, any Linux box | `auto` | The GPU the image can open, else the CPU: the `-vulkan` image on an Intel or AMD GPU, the `-cuda` image on NVIDIA ([A GPU](#a-gpu)). The plain image runs the CPU, several times slower |
| Linux or Windows, akou run natively, with an NVIDIA card | `auto` or `cuda` | llama.cpp's CUDA build, downloaded with Qwen. On Linux the host needs the CUDA 12 runtime; on Windows akou downloads it with the build |
| Linux or Windows, akou run natively, with an Intel or AMD GPU | `auto` or `vulkan` | llama.cpp's Vulkan build, through the GPU's Vulkan driver (Mesa on Linux) |

Docker on a Mac has no Metal, so on a Mac run akou natively rather than in a container. A server elsewhere on the network (a Telegram-Archive box, for example) then reaches it by URL and key like any client.

`GET /v1/server` shows where Qwen runs, in the `provider` of its entry in `engines` (`metal`, `vulkan`, `cuda` or `cpu`), and `gpu` and `accelerator` say which GPU was found and why. A setting with no build for the platform (`metal` on Linux) runs on what `auto` finds, the CPU when there is no GPU, and the server log says so. For a GPU llama.cpp publishes no build for, such as Intel's SYCL or AMD's ROCm, build `llama-server` on the machine and name it in `asr.llamaServer` in `config.json` (for example `["/opt/llama.cpp/build/bin/llama-server"]`); akou adds the model and port arguments.

### A large backlog

A client with thousands of files to send, such as Telegram-Archive transcribing a whole archive, leans on three settings:

| Setting | Default | What it does |
|---|---|---|
| `server.concurrency` | 1 | Jobs run at once. Each running job loads its own copy of the model and uses `asr.threads` threads (default 2), so keep `server.concurrency` times `asr.threads` under the machine's cores: on a 20-thread box, 4 jobs of 4 threads leaves room for the rest |
| `server.queue_max` | 1000 | Jobs queued or running at most, across every key. 0 means no limit |
| `server.queue_max_per_key` | 500 | The same for one key, so one client cannot fill the queue. 0 means no limit |

Set them on the web page's settings, with `PATCH /v1/config` and an admin key, or in `config.json` as above. A new `server.concurrency` applies from the next submit or job end.

A submit past a limit is refused with `429 queue_full` and a `Retry-After` header in seconds, before akou reads the upload; wait that long and send it again. A job may carry `priority`, from -10 to 10 (default 0): a higher one runs first, then the oldest. The queue is kept in `jobs.db` in the data volume, so a restart resumes it in the same order.

`GET /v1/server` and `GET /healthz` answer how the queue is doing, with no key:

```sh
curl -s http://127.0.0.1:8476/v1/server | jq .queue
```

```json
{ "concurrency": 4, "max": 1000, "max_per_key": 500, "depth": 212, "queued": 208, "running": 4,
  "jobs_last_hour": 610, "audio_seconds_last_hour": 21480, "mean_job_seconds": 23.5, "eta_seconds": 1246 }
```

`audio_seconds_last_hour` over 3600 is how many hours of audio the box transcribes per hour. `eta_seconds` is the time left at the pace of the last 50 jobs, and `null` until one has ended since the server started.

### The command line against a server

The CLI and `akou mcp` talk to a remote akou when `AKOU_URL` is set. The key comes from `AKOU_API_KEY`, or from a file named by `AKOU_API_KEY_FILE`, never from a flag:

```sh
export AKOU_URL=https://akou.example
export AKOU_API_KEY_FILE=~/.config/akou/remote.key
akou jobs list
```

With `AKOU_URL` set, akou never looks for the app on this machine and never starts it. A server that refuses the connection, or answers nothing within the request's time, exits 69 and names `AKOU_URL`; a wrong key exits 77. `akou quit` refuses to run, since it stops only the app on this machine, and `akou doctor` reports the server it reaches. `AKOU_API_KEY_FILE` may start with `~/`, as `docker -e` and a systemd unit pass it unexpanded.

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
