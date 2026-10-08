# Server mode

akou also runs as a self-hosted transcription server: one Docker image on linux/amd64 and linux/arm64, running the same core as the desktop app. A program uploads an audio file, gets a job id back at once, and reads one result with text, language, words, segments and the engine that made it, by long-poll, by an event feed, or by a signed webhook. The server also speaks the OpenAI transcription endpoint, the Wyoming protocol and Bazarr's `/asr`, so Nextcloud, Home Assistant and Bazarr work with no code on their side. There is no akou cloud and no relay: the server is your own box, reached by your own programs.

You do not need server mode to transcribe a file on your own Mac: the desktop app takes `akou transcribe FILE` with its own token ([Usage](usage.md#transcribing-a-file)). Server mode is for other programs and other machines, with keys.

The steps below cover the image, the models, the first start and the keys. [GPUs and presets](server-hardware.md) covers the GPU images, the `best` preset and a large backlog.

## Running the image

[ux/SERVER.md](https://github.com/GeiserX/akou/blob/main/docs/ux/SERVER.md) has the design. The image is `drumsergio/akou`, tagged with each release (`drumsergio/akou:0.6.4` today; use the current release in the commands below), built from the [Dockerfile](https://github.com/GeiserX/akou/blob/main/Dockerfile) for linux/amd64 and linux/arm64, with `-vulkan` and `-cuda` variants for a GPU ([A GPU](server-hardware.md#a-gpu)). There is no `latest` tag: name the version you want.

The server runs as an unprivileged user, uid 1000, keeps its settings, keys and jobs under `/data` and the models under `/models`. Both must be writable by uid 1000, `/models` too even when every model is already in it: the pull and the server write downloads and the models' `usage.json` there. Named volumes, as below, already are. A bind-mounted folder in place of a volume must belong to uid 1000 (`chown 1000:1000` it on the host), and a read-only mount (`:ro`) does not work: the pull stops with exit 70 and the server with exit 77, both naming the folder and `EROFS`.

Pull the models into their volume first, so the first start is not a 3.0 GB download. No server needs to run for this.

The speaker model is Nemotron by default, and that needs no step. Only to use pyannote (`asr.diarizer` `embeddings`) instead, set it on the data volume before the pull; without it the pull fetches Nemotron. Skip this on a volume whose models are already pulled for Nemotron: with it the pull fetches pyannote too.

```sh
docker run --rm -v akou-data:/data --entrypoint sh drumsergio/akou:0.6.4 -c \
  'mkdir -p /data/.config/akou && echo "{ \"asr.diarizer\": \"embeddings\" }" > /data/.config/akou/config.json'
```

Then pull. Mount the data volume too, since the pull reads `asr.diarizer` from the settings there:

```sh
docker run --rm -v akou-data:/data -v akou-models:/models drumsergio/akou:0.6.4 models pull fast
```

`fast` fetches everything the server loads before it transcribes: Parakeet TDT 0.6B v3, the voice-activity model and the two speaker models (Nemotron 3 Diarization and TitaNet; pyannote in place of Nemotron with `asr.diarizer` set to `embeddings`). A second run checks every file's SHA-256 and downloads nothing. `akou models pull MODEL` fetches one model by the id `akou models list` shows.

`best` is the other preset with an engine: Qwen3-ASR-1.7B, run by llama.cpp's `llama-server`, with the same speaker models when a job asks for speakers. `models pull best` fetches Qwen (2.5 GB), the llama-server build for this machine and the speaker models, and leaves Parakeet out. Without the pull, the first `best` job fetches them. See [The best preset](server-hardware.md#the-best-preset) for where it runs fast.

Inside a container akou listens on every address, and it refuses to start that way (exit 78) until you say a reverse proxy with TLS is in front of it, because akou has no TLS of its own. Say it with `AKOU_BEHIND_PROXY=true`, which sets `server.behind_proxy`, and publish the port on this machine's loopback only, for the proxy to reach:

```sh
docker run -d --name akou -e AKOU_BEHIND_PROXY=true -p 127.0.0.1:8476:8476 \
  -v akou-data:/data -v akou-models:/models drumsergio/akou:0.6.4
```

`curl -s http://127.0.0.1:8476/healthz` answers `{"ok":true,…,"models_ready":true}` once the pulled models are found. The server decodes any audio file with the ffmpeg inside the image, and `docker stop` ends it cleanly.

Every program that sends jobs needs its own key. Create one in the running container, with a `jobs` scope and every host its `callback_url` may name:

```sh
docker exec akou akou keys create --name archive --scope jobs --callback-host telegram-viewer
```

It prints the `ak_` API key and the `whsec_` webhook secret once, and never again: give the key to the program as its bearer token, and the secret to whatever checks the signed callbacks. The key works at once, with no restart. Repeat `--callback-host` for each host; `*` allows any public host, but a callback to a private address, such as another container by its name, needs that host named. A key with no callback host submits jobs and reads the event feed, and a submit that names a `callback_url` is refused with 422 `callback_not_allowed`. `akou keys list` and `akou keys revoke ID` manage them the same way. To change the hosts of a key a program already uses, run `akou keys update ID --callback-host HOST ...`: the key, its secret and its jobs stay, and the server uses the new hosts from the next request. Each key edit, and each job, is a line in the server's log (`key.created`, `key.updated`, `key.revoked`, `job.created`, `job.done`, `job.failed`), never with the audio or the text.

akou keeps a job, its result and its events for `server.retain_days` (default 7), counted from the job's creation; `GET /v1/server` answers the number as `retain_days`. Once that time passes, or a client deletes the job, its id answers `410 Gone` with `retain_days` in the body, so a program can tell a job it must submit again from an id it got wrong, which answers `404`. The [OpenAPI file](https://github.com/GeiserX/akou/blob/main/docs/api/openapi.json) describes every job route.

To run it beside [Telegram-Archive](https://github.com/GeiserX/Telegram-Archive), use the compose file in [examples/compose/telegram-archive](https://github.com/GeiserX/akou/tree/main/examples/compose/telegram-archive/) and the one-time setup in [ux/SERVER.md section 12.5](https://github.com/GeiserX/akou/blob/main/docs/ux/SERVER.md#125-one-compose-file-for-both).

Without Docker, run `bun src/main/cli/cli.ts serve` in a source checkout. That is `akou serve`, the same server in the foreground. The single-file `akou` CLI runs `akou serve` too, on Linux x64 and arm64 and on macOS. It carries no speech engine, so it answers the API but cannot transcribe, and it says so when it starts.

`akou serve` binds every address by default too, so on a plain machine it refuses to start (exit 78) until you choose. Put `{ "api.bind": "127.0.0.1" }` in `~/.config/akou/config.json` to serve this machine only, or set `server.behind_proxy` to `true` once a reverse proxy with TLS is in front of it.


## A reverse proxy in front

akou has no TLS of its own, so a reverse proxy terminates it. Three things matter, and the blocks below set all three. Uploads are large: the proxy's body limit must be at least `server.max_upload_mb` (512 MiB by default). The event feed (`GET /v1/events` with `Accept: text/event-stream`) and the streaming answers are Server-Sent Events, so the proxy must pass each event on at once instead of filling a buffer first. And a long-poll (`?wait=60`) holds a request for up to 60 seconds with no bytes, so the proxy's read timeout must be longer. The live door (`GET /v1/live`, below) is a WebSocket, so the proxy must pass the upgrade and keep a quiet socket open; akou pings an idle socket and closes it after two minutes without an answer. In akou's settings, set `server.behind_proxy` to `true`, `server.public_host` to the name clients use, and `server.trusted_proxies` to the proxy's address, so the client's own address reaches the audit lines and the rate limits. Once `server.public_host` is set, akou answers `403 bad_host` to any other name, so containers that reach it by its service name (`http://akou:8476`, as the compose example does) must go through the public name instead, or leave `server.public_host` empty.

Caddy passes events on, holds long requests and passes WebSockets through by default; it only needs the body limit:

```caddyfile
akou.example {
	request_body {
		max_size 512MiB
	}
	reverse_proxy 127.0.0.1:8476 {
		flush_interval -1
	}
}
```

nginx needs each of them said, the WebSocket's `Upgrade` and `Connection` headers included:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name akou.example;
    ssl_certificate     /etc/ssl/akou.example.crt;
    ssl_certificate_key /etc/ssl/akou.example.key;

    client_max_body_size 512m;

    location / {
        proxy_pass http://127.0.0.1:8476;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

If you raise `server.max_upload_mb`, raise `max_size` or `client_max_body_size` with it. Then `curl https://akou.example/v1/server` answers the server's description.

## A phone or another live client

A client that records, such as a phone, gets two things from a server: the words while it records, from `GET /v1/live`, and the transcript of record once it stops, from a job. Its recording stays its own until the job has it, so a dropped connection costs a gap in the live words, never audio.

**Live words.** Open a WebSocket to `wss://akou.example/v1/live` with `Authorization: Bearer <key>` on the upgrade request; any key reaches it. A missing, wrong or revoked key gets a plain 401 answer, never a socket. `GET /v1/server` says whether it works here: `capabilities.live`, and `live.engines` lists the streaming models on disk (`akou models pull nemotron-3.5-560` fetches one). On a server, akou loads the streaming model a `hello` with no language opens at start, so the first session does not wait for it.

Text frames are JSON, binary frames are audio:

| From | Message | What it says |
|---|---|---|
| client | `{"type":"hello","v":1,"codec":"ogg-opus","language":"auto","model":"auto"}` | First, once. `codec` is `ogg-opus` or `pcm16`; `language` is `auto` or a BCP 47 tag, and picks the model as a call's languages do (`en`: `nemotron-en-560`, `es`: `nemotron-3.5-1120`, else `nemotron-3.5-560`), among the models on disk; `model` names one instead |
| server | `{"type":"ready","engine","lang","tier_ms","load_ms"}` | The stream is open. `tier_ms` is how far behind the audio a word can come |
| client | binary | With `ogg-opus`, exactly one Ogg page per frame, the bytes the client appends to its own file: the OpusHead page, the OpusTags page, then the audio pages in order, mono. With `pcm16`, raw 16 kHz 16-bit little-endian samples (for tests and measurements). At most 64 KB a frame, and at most 30 s of audio the model has not decoded yet: a client that sends faster is closed with 4400 `too_fast` |
| server | `{"type":"words","tokens":[{"text":" hola","t":1.23,"conf":0.91}]}` | The model's tokens as it gives them, append-only: a token is never taken back. A token with a leading space starts a word. `t` is seconds into the recording |
| client | `{"type":"stop"}` | The end: the server sends the last words, then `{"type":"closed"}`, and closes with 1000 |
| server | `{"type":"error","code","message"}` | A refusal, then a close: 4400 for a message or page that is not valid (`bad_message`, `bad_page`, `too_fast`, `unknown_model`, `unsupported_language`), 4401 `key_revoked`, 4409 `engine_busy`, 4500 `stream_lost`, 4503 `no_live_engine` |

A server holds one streaming model at a time, so while a session is open, a `hello` that resolves to another model is refused with 4409; one that resolves to the same model runs beside it. A key revoked while its session is open closes it with 4401 within about a second, whether or not the client is sending.

There is no resume. A new socket is a new session: send `hello`, the OpusHead and OpusTags pages again, then the pages from where the recording is now. The server places the words on the recording's timeline from the first audio page's granule position, so `t` stays seconds into the file across reconnects; the pages sent while the connection was down are in the file, and the job covers them. Opus at 16 kHz, 24 kbit/s VBR and 20 ms frames, in pages of 200 ms, is about 11 MB an hour on the socket (a minute of speech measured 178 KB), against 115 MB for `pcm16`.

`bun scripts/live-client.ts FILE --codec ogg-opus --pace realtime` streams a file the way a client records it and prints the words with their times, for a check against a server: `AKOU_URL` and `AKOU_API_KEY` name the server and the key, and `ffmpeg` converts a file that is not Ogg Opus.

**The recording, kept.** At the end, upload the file as a job: `POST /v1/jobs` with `keep_audio=true`, an `Idempotency-Key` header of the recording's own id (a retried upload gets the first job back), and `metadata` for what the client files it under, such as `{"workspace": "home", "recording_id": "…"}`, which every job answer carries back. A kept job keeps its upload after it ends, `GET /v1/jobs/{id}/audio` serves it back byte for byte (with `Range`, so a player can seek), and `server.retain_days` never removes it: the job, its result, its events and its audio stay until a client deletes the job. The job's `keep_audio` says whether the server keeps it, so a client deletes its own copy only once it reads `true`. The words with times come from `GET /v1/jobs/{id}/result`.

## A Mac as the server

Docker on a Mac has no Metal, so on a Mac the server runs natively, from a source checkout at the release tag. The single-file `akou` CLI cannot transcribe, as above. You need [Bun](https://bun.sh) at the version in `.bun-version`, and ffmpeg for anything but a 16 kHz WAV (`brew install ffmpeg`):

```sh
git clone --branch v0.6.4 https://github.com/GeiserX/akou.git && cd akou
bun install --frozen-lockfile
bun src/main/cli/cli.ts models pull fast
bun src/main/cli/cli.ts models pull best   # Qwen3-ASR and its Metal llama-server, for the best preset
bun src/main/cli/cli.ts serve
```

It keeps its settings, keys and jobs in `~/.config/akou` and the models in `~/Library/Application Support/akou/models`.

Two limits refuse long recordings by default. `server.max_upload_mb` is 512 MiB, which is less than a long meeting video, and `server.max_audio_minutes` is 240. For long meetings, raise both in `~/.config/akou/config.json`, for example `{ "server.max_upload_mb": 2048, "server.max_audio_minutes": 360 }`, and restart the server.

Speaker labels (`diarize`) with Nemotron, the default speaker model, run in the `akou-diarize` helper, which the app carries and a source checkout does not; `models pull` does not fetch it. Download `akou-diarize-<version>-darwin-arm64.tar.gz` from the release, unpack it, and put `akou-diarize` on the server's `PATH`, or set `asr.diarizeHelper` to its path in `~/.config/akou/config.json`, for example `{ "asr.diarizeHelper": ["/Users/YOU/bin/akou-diarize"] }`. The app's release zip carries it too, at `akou.app/Contents/Resources/app/bun/akou-diarize`. Releases up to 0.5.4 have no such file: take it from the zip, or build it from the checkout with Rust 1.88 or newer (`cargo build --locked --release --manifest-path native/akou-diarize/Cargo.toml`). Or set `asr.diarizer` to `embeddings`, which needs no helper. Without either, a job that asks for `diarize` fails with `diarize_unavailable` and says the same.

To reach it from another machine, put a proxy with TLS in front of it (a `tailscale serve` of port 8476 on a tailnet works) and set `{ "api.bind": "127.0.0.1", "server.behind_proxy": true }` in `~/.config/akou/config.json`.

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

`KeepAlive` starts it again if it stops; `sudo launchctl bootout system/io.github.geiserx.akou.serve` stops it for good. Started this way, with no one logged in, it still runs `best` on Metal: `GET /v1/server` shows `accelerator.active` as `metal`. After a reboot, check it came back with:

```sh
curl -s http://127.0.0.1:8476/healthz
```

which answers `{"ok":true,…,"models_ready":true}` once the models are loaded. If it answers nothing, the log is the `StandardErrorPath` file.

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

A remote holds two of this server's jobs at a time: the one it runs and the next. When every remote an entry names is busy, a job for that preset waits for one by default, which is right when this server is too slow to run it. When this server is a good worker itself, set `{ "server.remotes_overflow": true }`: the job then runs here instead, so this server and all its remotes work through a backlog at once. A job this server cannot run still waits for a remote, and right after a start a job waits until every remote it names has answered its first probe, since one that has not may have room. Changing the setting over the API routes the waiting jobs at once.

## The command line against a server

The CLI and `akou mcp` talk to a remote akou when `AKOU_URL` is set. The key comes from `AKOU_API_KEY`, or from a file named by `AKOU_API_KEY_FILE`, never from a flag:

```sh
export AKOU_URL=https://akou.example
export AKOU_API_KEY_FILE=~/.config/akou/remote.key
akou transcribe note.ogg --preset best
akou jobs list
```

`akou transcribe` uploads the file, waits for the job and prints the transcript; on a server the job is deleted once the text is printed, so it does not stay in `akou jobs list` there. Without `AKOU_URL` the same commands go to the desktop app on this machine, which runs the job itself.

With `AKOU_URL` set, akou never looks for the app on this machine and never starts it. A server that refuses the connection, or answers nothing within the request's time, exits 69 and names `AKOU_URL`; a wrong key exits 77. `akou quit` refuses to run, since it stops only the app on this machine, and `akou doctor` reports the server it reaches. `AKOU_API_KEY_FILE` may start with `~/`, as `docker -e` and a systemd unit pass it unexpanded.
