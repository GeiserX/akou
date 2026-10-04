# ASR-12: speech on Windows before Windows defaults

The gate from [asr-architecture.md section 9](../research/asr-architecture.md#9-plan) ASR-12: run the live engine and Qwen on a Windows x64 machine before any Windows default rests on them. Until this run every Windows figure in that doc came from release assets.

Result: everything runs on Windows and gives the same words as on macOS and Linux. Speed is the finding. The live engine needs 2 threads, not 4, on a 4-core machine. Qwen on an integrated Intel GPU is slower than on the CPU.

The numbers are in [asr-12-windows.json](asr-12-windows.json).

## The machine and the commands

- Date: 2026-10-02. Windows 11 Pro on an Intel Core i9-12900: 16 cores (8 performance cores with two threads each, 8 efficiency cores), 24 logical CPUs, 32 GB. Two GPUs: the integrated Intel UHD Graphics 770 and an NVIDIA GeForce RTX 4070 Ti SUPER.
- Bun 1.4.2 for Windows x64, the repository at `origin/main` `ca0b686` plus this gate's two scripts.
- "A 4-core x64" is this machine pinned to four performance cores, one thread each (process affinity `0x55`).

```powershell
bun scripts/gates/asr-12-stream-rtf.ts --models <dir> --data <dir> --out stream.json
bun scripts/eval/nightly.ts --models <dir> --data <dir> --only qwen --accelerator cpu    --out qwen-cpu.json
bun scripts/eval/nightly.ts --models <dir> --data <dir> --only qwen --accelerator vulkan --out qwen-vulkan.json
bun scripts/eval/nightly.ts --models <dir> --data <dir> --only qwen --accelerator cuda   --out qwen-cuda.json
```

`asr-12-stream-rtf.ts` decodes the first 30 FLEURS English clips (296 s) through the app's own `SherpaModels` with `nemotron-en-560`, one stream per clip in 100 ms pushes, at 2 and at 4 threads (`asr.threads`). The Qwen stage is the nightly's ASR-5 check (30 FLEURS clips per language, 25 silent AMI stretches, memory over 150 requests with the default prompt cache as the failing control), which skips Windows unless a backend is named.

## Live: nemotron-en-560 on the CPU

| Where | 2 threads | 4 threads | WER |
|---|---|---|---|
| Windows, all 24 logical CPUs, two runs | RTF 0.531, 0.532 | 0.526, 0.524 | 6.47 |
| Windows, pinned to 4 cores, two runs | RTF 0.292, 0.284 | 0.731, 0.979 | 6.47 |
| Apple M4, the same script (control) | RTF 0.132 | 0.100 | 7.06 |

- On 4 cores, 2 threads keep live text at about 3.5 times real time. 4 threads take it to between 0.73 and 0.98, close to falling behind the call. `asr.threads` stays 2. The M4's gain from 4 threads (section 3.1) does not carry over to x64.
- With all 24 logical CPUs it runs at 0.53, slower than on 4 pinned cores, and threads change nothing. We have not established why. Windows placing the work on efficiency cores would explain it; we did not measure that.
- The words match across runs, and the WER is within 0.6 of the M4's. The Windows build decodes the same text.

## Final: Qwen3-ASR-1.7B on llama-server b11200

| Backend | WER en / es (30 clips) | Words on 25 silent stretches | p50 per clip (median clip 9.5 s) | About RTF | Memory over 150 requests | Default-cache control |
|---|---|---|---|---|---|---|
| CPU (`win-cpu`) | 3.82 / 1.73 | 0 | 2690 ms | 0.28 | +5.7 MB | +824 MB |
| Vulkan on the Intel UHD 770 (`win-vulkan`) | 3.53 / 1.73 | 0 | 4744 ms | 0.50 | +6.6 MB | +835 MB |
| CUDA on the RTX 4070 Ti SUPER (`win-cuda-12.4`) | 3.53 / 1.73 | 0 | 237 ms | 0.025 | +40.5 MB | +864 MB |

- Accuracy holds on every backend: within the ASR-5 bounds of 4.29 / 3.39 (the benchmark's 3.79 / 2.89 plus 0.5), no words on silence, no restarts.
- Memory stays flat with `--cache-ram 0`, and the default cache grows past 800 MB in 50 requests, so the bound can fail on Windows too.
- Vulkan listed one device, the integrated Intel GPU, and on it Qwen runs at half the CPU's speed. `asr.accelerator` `auto` picks CUDA when the NVIDIA driver is present and Vulkan whenever the Vulkan loader is, so a Windows machine whose only GPU is integrated runs Qwen on Vulkan. At RTF 0.50 a long call comes close to the stuck-pass limit (half the call's length plus 300 s). Picking the CPU over an integrated GPU is a change for `accelerator.ts`, not part of this gate.

## Not run yet

- **The transcribe-cpp win32 package** (`@transcribe-cpp/win32-x64-cpu-vulkan`, for Whisper, Cohere and Canary). It runs once the transcribe-cpp engines exist (ASR-8). Its row joins this page then.
