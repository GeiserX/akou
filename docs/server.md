# Server mode

akou also runs as a self-hosted transcription server: one Docker image on linux/amd64 and linux/arm64, running the same core as the desktop app. A program uploads an audio file, gets a job id back at once, and reads one result with text, language, words, segments and the engine that made it, by long-poll, by an event feed, or by a signed webhook. The server also speaks the OpenAI transcription endpoint, the Wyoming protocol and Bazarr's `/asr`, so Nextcloud, Home Assistant and Bazarr work with no code on their side. There is no akou cloud and no relay: the server is your own box, reached by your own programs.

The steps below cover the image, the models, the first start and the keys. [GPUs and presets](server-hardware.md) covers the GPU images, the `best` preset and a large backlog.

## Running the image

[ux/SERVER.md](https://github.com/GeiserX/akou/blob/main/docs/ux/SERVER.md) has the design. The image is `drumsergio/akou`, tagged with each release (`drumsergio/akou:0.5.4` today; use the current release in the commands below), built from the [Dockerfile](https://github.com/GeiserX/akou/blob/main/Dockerfile) for linux/amd64 and linux/arm64, with `-vulkan` and `-cuda` variants for a GPU ([A GPU](server-hardware.md#a-gpu)). There is no `latest` tag: name the version you want.

The server runs as an unprivileged user, uid 1000, keeps its settings, keys and jobs under `/data` and the models under `/models`. Both must be writable by uid 1000, `/models` too even when every model is already in it: the pull and the server write downloads and the models' `usage.json` there. Named volumes, as below, already are. A bind-mounted folder in place of a volume must belong to uid 1000 (`chown 1000:1000` it on the host), and a read-only mount (`:ro`) does not work: the pull stops with exit 70 and the server with exit 77, both naming the folder and `EROFS`.

Pull the models into their volume first, so the first start is not a 3.0 GB download. No server needs to run for this.

The speaker model is Nemotron by default, and that needs no step. Only to use pyannote (`asr.diarizer` `embeddings`) instead, set it on the data volume before the pull; without it the pull fetches Nemotron. Skip this on a volume whose models are already pulled for Nemotron: with it the pull fetches pyannote too.

```sh
docker run --rm -v akou-data:/data --entrypoint sh drumsergio/akou:0.5.4 -c \
  'mkdir -p /data/.config/akou && echo "{ \"asr.diarizer\": \"embeddings\" }" > /data/.config/akou/config.json'
```

Then pull. Mount the data volume too, since the pull reads `asr.diarizer` from the settings there:

```sh
docker run --rm -v akou-data:/data -v akou-models:/models drumsergio/akou:0.5.4 models pull fast
```

`fast` fetches everything the server loads before it transcribes: Parakeet TDT 0.6B v3, the voice-activity model and the two speaker models (Nemotron 3 Diarization and TitaNet; pyannote in place of Nemotron with `asr.diarizer` set to `embeddings`). A second run checks every file's SHA-256 and downloads nothing. `akou models pull MODEL` fetches one model by the id `akou models list` shows.

`best` is the other preset with an engine: Qwen3-ASR-1.7B, run by llama.cpp's `llama-server`, with the same speaker models when a job asks for speakers. `models pull best` fetches Qwen (2.5 GB), the llama-server build for this machine and the speaker models, and leaves Parakeet out. Without the pull, the first `best` job fetches them. See [The best preset](server-hardware.md#the-best-preset) for where it runs fast.

Inside a container akou listens on every address, and it refuses to start that way (exit 78) until you say a reverse proxy with TLS is in front of it, because akou has no TLS of its own. Say it with `AKOU_BEHIND_PROXY=true`, which sets `server.behind_proxy`, and publish the port on this machine's loopback only, for the proxy to reach:

```sh
docker run -d --name akou -e AKOU_BEHIND_PROXY=true -p 127.0.0.1:8476:8476 \
  -v akou-data:/data -v akou-models:/models drumsergio/akou:0.5.4
```

`curl -s http://127.0.0.1:8476/healthz` answers `{"ok":true,…,"models_ready":true}` once the pulled models are found. The server decodes any audio file with the ffmpeg inside the image, and `docker stop` ends it cleanly.

Every program that sends jobs needs its own key. Create one in the running container, with a `jobs` scope and every host its `callback_url` may name:

```sh
docker exec akou akou keys create --name archive --scope jobs --callback-host telegram-viewer
```

It prints the `ak_` API key and the `whsec_` webhook secret once, and never again: give the key to the program as its bearer token, and the secret to whatever checks the signed callbacks. The key works at once, with no restart. Repeat `--callback-host` for each host; `*` allows any public host, but a callback to a private address, such as another container by its name, needs that host named. A key with no callback host submits jobs and reads the event feed, and a submit that names a `callback_url` is refused with 422 `callback_not_allowed`. `akou keys list` and `akou keys revoke ID` manage them the same way. To change the hosts of a key a program already uses, run `akou keys update ID --callback-host HOST ...`: the key, its secret and its jobs stay, and the server uses the new hosts from the next request. Each key edit, and each job, is a line in the server's log (`key.created`, `key.updated`, `key.revoked`, `job.created`, `job.done`, `job.failed`), never with the audio or the text.

To run it beside [Telegram-Archive](https://github.com/GeiserX/Telegram-Archive), use the compose file in [examples/compose/telegram-archive](https://github.com/GeiserX/akou/tree/main/examples/compose/telegram-archive/) and the one-time setup in [ux/SERVER.md section 12.5](https://github.com/GeiserX/akou/blob/main/docs/ux/SERVER.md#125-one-compose-file-for-both).

Without Docker, run `bun src/main/cli/cli.ts serve` in a source checkout. That is `akou serve`, the same server in the foreground. The single-file `akou` CLI runs `akou serve` too, on Linux x64 and arm64 and on macOS. It carries no speech engine, so it answers the API but cannot transcribe, and it says so when it starts.

`akou serve` binds every address by default too, so on a plain machine it refuses to start (exit 78) until you choose. Put `{ "api.bind": "127.0.0.1" }` in `~/.config/akou/config.json` to serve this machine only, or set `server.behind_proxy` to `true` once a reverse proxy with TLS is in front of it.


## A Mac as the server

Docker on a Mac has no Metal, so on a Mac the server runs natively, from a source checkout at the release tag. The single-file `akou` CLI cannot transcribe, as above. You need [Bun](https://bun.sh) at the version in `.bun-version`, and ffmpeg for anything but a 16 kHz WAV (`brew install ffmpeg`):

```sh
git clone --branch v0.5.4 https://github.com/GeiserX/akou.git && cd akou
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

## Sending jobs to another akou

An akou server can hand jobs to other akou servers, for example a container that sends `best` to a Mac mini with a GPU, while its clients keep talking to it alone. [ux/SERVER.md section 14](https://github.com/GeiserX/akou/blob/main/docs/ux/SERVER.md#14-sending-jobs-to-another-akou) has the design. On the remote, make a `jobs` key for the server that will send it jobs:

```sh
akou keys create --name primary --scope jobs
```

On the sending server, save the printed `ak_` key in a file only the server's user can read (in the container, under `/data`, owned by uid 1000, mode 0600), and name the remote in `config.json` with the URL, the key file and, optionally, the presets to send there first:

```json
{ "server.remotes": ["https://mini.example /data/remotes/mini.key best"] }
```

Restart the server. `GET /v1/server` then lists the remote under `remotes` with its state (`up`, `down` or `refused`) and the presets it offers, and a preset a remote offers shows as available. A job for a preset this server cannot run goes to a remote that offers it; one for a preset the entry names goes there first and runs here while the remote is down; everything else runs here. A remote that goes down leaves its jobs queued, never failed, until it or another remote that offers them is back.

## The command line against a server

The CLI and `akou mcp` talk to a remote akou when `AKOU_URL` is set. The key comes from `AKOU_API_KEY`, or from a file named by `AKOU_API_KEY_FILE`, never from a flag:

```sh
export AKOU_URL=https://akou.example
export AKOU_API_KEY_FILE=~/.config/akou/remote.key
akou jobs list
```

With `AKOU_URL` set, akou never looks for the app on this machine and never starts it. A server that refuses the connection, or answers nothing within the request's time, exits 69 and names `AKOU_URL`; a wrong key exits 77. `akou quit` refuses to run, since it stops only the app on this machine, and `akou doctor` reports the server it reaches. `AKOU_API_KEY_FILE` may start with `~/`, as `docker -e` and a systemd unit pass it unexpanded.
