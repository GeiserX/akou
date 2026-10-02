# GPUs and presets

Which image to run for your GPU, where the accurate `best` preset runs fast, and the settings for a server with thousands of files to transcribe. Start with [Server mode](server.md) for the image, the models and the keys.

## A GPU

The large speech model, Qwen3-ASR, runs on llama-server, and a GPU makes it many times faster than the CPU. Every image carries a llama-server build, uses the GPU it can open, and falls back to the CPU. Pick the image for your GPU:

| GPU | Image | Add to `docker run` |
|---|---|---|
| None | `drumsergio/akou:0.5.4` | Nothing |
| Intel (integrated or Arc) or AMD | `drumsergio/akou:0.5.4-vulkan` | `--device /dev/dri/renderD128 --group-add $(stat -c %g /dev/dri/renderD128)`, with the GPU's own render node |
| NVIDIA | `drumsergio/akou:0.5.4-cuda` | `--gpus all`, with the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the host. The image carries the CUDA runtime; the host needs only the driver (570 or newer on x64) |
| Apple silicon | None: Docker on macOS has no GPU | Run akou on the Mac itself ([A Mac as the server](server.md#a-mac-as-the-server)); it uses Metal |

Pass one render node, the GPU's own, not the whole `/dev/dri`. llama-server picks among the render nodes it can open by its own device order, not by path. An iGPU with SR-IOV virtual functions shows several nodes (`ls /dev/dri`): on an Intel UHD 770 with two virtual functions, llama-server opened a virtual function instead of the GPU akou had detected, and the GPU hung. Mesa could pin llama-server to the detected GPU by its PCI bus address, which a virtual function does not share, but akou does not do that yet: it needs a run on a box with virtual functions. When akou can open more than one node, `accelerator.reason` lists them and names the one to pass.

`--group-add` gives the container's user the group that owns the render node on the host (`render` on most distributions). Without it the GPU is there but akou cannot open it, and it says so. In compose, the Vulkan image takes:

```yaml
    devices: ["/dev/dri/renderD128:/dev/dri/renderD128"]
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

`gpu` is the GPU backend (`metal`, `vulkan`, `cuda`, `sycl` or `rocm`) or null for the CPU. `accelerator.device` is the GPU's name as llama-server lists it, `verified` is true once llama-server itself confirmed the device, and `reason` says why when it runs on the CPU. The setting `asr.accelerator` overrides the choice: `auto` (the default), `cpu`, `metal`, `vulkan`, `cuda`, `sycl` or `rocm`, also as the environment variable `AKOU_ACCELERATOR`. `auto` never picks SYCL or ROCm, which need Intel's oneAPI or AMD's ROCm runtime on the host; Vulkan runs the same cards. OpenVINO is not offered: its llama.cpp backend does not run speech models yet.

The GPU runs the `best` preset's Qwen3-ASR ([The best preset](#the-best-preset)); Parakeet (`fast`) stays on the CPU, where it already runs far faster than real time.

## The best preset

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
| The `-vulkan` image on an Intel UHD 770 iGPU | `auto` | The iGPU, but slower than the CPU beside it: on Spanish voice notes of 23 s and 101 s it decoded in 33 s and 118 s once the model had loaded, about 1.2 times slower than real time, while the plain image on the same box took 17 s and 66 s, about 1.5 times faster than real time. The UHD 770 has less compute than the box's own cores and shares their memory bandwidth, so on it run the plain image, or send `best` to a Mac ([Sending jobs to another akou](server.md#sending-jobs-to-another-akou)). The first load after a pull compiles shaders and can pass the 5-minute load limit once |
| Linux or Windows, akou run natively, with an NVIDIA card | `auto` or `cuda` | llama.cpp's CUDA build and NVIDIA's CUDA runtime, both downloaded with Qwen, so the host needs only the driver |
| Linux or Windows, akou run natively, with an Intel or AMD GPU | `auto` or `vulkan` | llama.cpp's Vulkan build, through the GPU's Vulkan driver (Mesa on Linux) |
| Linux or Windows x64, akou run natively, with Intel's oneAPI or AMD's ROCm installed | `sycl` or `rocm` | llama.cpp's SYCL or ROCm build, downloaded with Qwen. `auto` never picks these |
| Any machine, akou run natively | `cpu` | llama.cpp's CPU build (on a Mac, the Metal build with no GPU device) |

Docker on a Mac has no Metal, so on a Mac run akou natively rather than in a container. A server elsewhere on the network (a Telegram-Archive box, for example) then reaches it by URL and key like any client.

`GET /v1/server` shows where Qwen runs, in the `provider` of its entry in `engines` (`metal`, `vulkan`, `cuda`, `sycl`, `rocm` or `cpu`), and `gpu` and `accelerator` say which GPU was found and why. A setting with no build here (`metal` on Linux, or `sycl` in an image) runs on what `auto` finds, the CPU when there is no GPU, and `accelerator.reason` says so. Natively, akou asks the build which devices it can open once `best` has downloaded it; a GPU it cannot open runs on the CPU build. For a build akou does not pin, compile `llama-server` on the machine and name it in `asr.llamaServer` in `config.json` (for example `["/opt/llama.cpp/build/bin/llama-server"]`); akou adds the model and port arguments.

## A large backlog

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
  "jobs_last_hour": 610, "audio_seconds_last_hour": 21480, "mean_job_seconds": 23.5, "eta_seconds": 1246,
  "loaded": ["qwen3-asr-1.7b"] }
```

`audio_seconds_last_hour` over 3600 is how many hours of audio the box transcribes per hour. `eta_seconds` is the time left at the pace of the last 50 jobs, and `null` until one has ended since the server started.
