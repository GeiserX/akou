# Which models akou can offer, October 2026

The catalog had eleven entries on Apple silicon, and only five of them were speech models a person could choose. This page lists every model we found that akou's two shipped runtimes could run, [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) in the app and [llama-server](https://github.com/ggml-org/llama.cpp) as a child process. For each one it says what code akou would need before it could run it.

## What we added

We added six more chunk sizes of the two streaming Nemotron models. The live path drives them exactly as it drives the 560 ms and 1120 ms tiers: the same `onlineConfig` in [sherpa.ts](../../src/main/asr/sherpa.ts), the same file names, the same 128 features. Each one is a catalog entry, a row in `LIVE_ENGINES` with its chunk, a name and a line. Each encoder is its own file. The decoder, joiner and symbol table are byte for byte the 560 ms tier's.

| Id | Size | Languages | Chunk | Encoder SHA-256 |
|---|---|---|---|---|
| `nemotron-en-80` | 0.66 GB | English | 80 ms | `29a6aaf9…` |
| `nemotron-en-160` | 0.66 GB | English | 160 ms | `71111f61…` |
| `nemotron-en-1120` | 0.66 GB | English | 1120 ms | `7d2246da…` |
| `nemotron-3.5-80` | 0.68 GB | 35 | 80 ms | `411e1222…` |
| `nemotron-3.5-160` | 0.68 GB | 35 | 160 ms | `e1b39e5e…` |
| `nemotron-3.5-320` | 0.68 GB | 35 | 320 ms | `f79c3fcc…` |

Each repository is pinned to a revision in [models.ts](../../src/main/asr/models.ts). We downloaded every file through akou's own downloader, which checks the pinned SHA-256, and then computed each SHA-256 again on its own. All 24 files matched. Each tier then decoded a 3.8 s upstream test clip, "Ask not what your country can do for you…", through `SherpaModels.liveEngine`. Every one wrote the sentence word for word.

Accuracy and speed are `not_measured` in [model-scores.ts](../../src/main/asr/model-scores.ts). The benchmark ran the 560 ms tiers and Nemotron 3.5's 1120 ms tier only. The smoke runs happened on a Mac mini that was busy with other work, so their timings are not a measurement. One thing still stood out. The 80 ms tiers took 3 to 6 s for the 3.8 s clip, and the 1120 ms and 320 ms tiers took under 1 s. I would not recommend an 80 ms tier to anyone until it has been timed on two channels. `auto` never picks any of the six. They run only when someone names one.

## Every candidate

"Word times" means the runtime gives a time for each word, which the live path and the speaker labels need. "Vocabulary" means akou can bias the decode toward the user's words, as Parakeet does with beam search and hotwords and Qwen does through its context. "Pin" means a SHA-256 can be pinned. Hugging Face publishes one for every LFS file, and GitHub one for each release asset.

| Model | Runtime | Size | Languages | Word times | Vocabulary | Live or final | Licence | Source, pin | Code it needs | Now? |
|---|---|---|---|---|---|---|---|---|---|---|
| Nemotron streaming English, 80, 160, 1120 ms, int8 | sherpa-onnx | 0.66 GB | en | yes | no | live | NVIDIA Open Model License | csukuangfj2 exports, pinned | none | **added** |
| Nemotron 3.5 streaming, 80, 160, 320 ms, int8 | sherpa-onnx | 0.68 GB | 35 | yes | no | live | OpenMDW-1.1 | csukuangfj2 exports, pinned | none | **added** |
| Nemotron streaming, either model, fp32 exports | sherpa-onnx | 2.6 GB | en / 35 | yes | no | live | as above | csukuangfj2, pin available | file names per entry (`encoder.onnx` with `encoder.data`, not `encoder.int8.onnx`) | later, only if measured better than int8 |
| Qwen3-ASR 0.6B, Q8_0 GGUF | llama-server | 1.02 GB | 30 | no | yes (context) | final, second pass | Apache-2.0 | [ggml-org/Qwen3-ASR-0.6B-GGUF](https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF) at `928ab958`, pinned | small: `llamaSpec` takes the two file names from the catalog entry instead of the 1.7B constants, and a place that runs it (jobs today) | **next lane, first** |
| Qwen3-ASR 1.7B, bf16 GGUF | llama-server | 4.7 GB | 30 | no | yes | final, second pass | Apache-2.0 | same repository, pin available | the same small change | no: Q8_0 measured the same as bf16 |
| Parakeet TDT 0.6B v2, int8 or fp32 | sherpa-onnx | 0.66 / 2.51 GB | en | yes | yes (with its own tokenizer) | final, Parakeet live | CC-BY-4.0 | csukuangfj exports, pin available | wiring: the final pass and jobs take a recognizer id instead of the one Parakeet; the decode path is the same `nemo_transducer` | next lane |
| Parakeet TDT 0.6B v3, int8 | sherpa-onnx | 0.67 GB | 25 | yes | yes | final, live | CC-BY-4.0 | pinned before | none | no: retired, a third more errors in English than fp32 ([benchmark](asr-benchmark.md)) |
| Streaming Zipformer (k2 bilingual zh-en; Kroko en, es, de and others) | sherpa-onnx | 0.1 to 0.3 GB | per model | yes | possible (transducer) | live | Apache-2.0 for k2's; Kroko's to be checked | community and k2 exports, pin available | adapter config: 80 features and file names per entry | later; Kroko es is in the [architecture plan](asr-architecture.md) as an opt-in |
| Canary 180M Flash, int8 | sherpa-onnx | 0.21 GB | en, es, de, fr | no | no | final | CC-BY-4.0 | csukuangfj export, pin available | new adapter (sherpa's `canary` config, no word times) | later |
| Canary 1B v2 | sherpa-onnx or transcribe-cpp | 1.14 GB as Q8_0 | 25 | no | no | final | CC-BY-4.0 | community sherpa exports only | new adapter, or the transcribe-cpp runtime (ASR-8) | later, through ASR-8 |
| Whisper large-v3 turbo, distil-large-v3.5 | sherpa-onnx | 1 to 4.3 GB | 99 (distil: en) | no | no | final | MIT | csukuangfj exports, pin available | new adapter | no: the plan runs Whisper through transcribe-cpp (ASR-8) |
| SenseVoice Small, int8 | sherpa-onnx | 0.24 GB | zh, en, ja, ko, yue | yes | no | final | FunASR model licence, its own terms | csukuangfj export, pin available | new adapter (`sense_voice`) | no for akou's European users |
| Moonshine tiny and base, English | sherpa-onnx | 0.04 / 0.14 GB | en | no | no | final | MIT upstream for English; read the repository's LICENSE | csukuangfj2 exports, pin available | new adapter (`moonshine`) | no: English only, which Parakeet already covers |
| Dolphin small and base CTC | sherpa-onnx | 0.25 GB and up | 40 Eastern languages, 22 Chinese dialects | yes | no | final | Apache-2.0 | csukuangfj exports, pin available | new adapter (`dolphin`) | later, for those languages |
| FireRedASR2 AED, int8 | sherpa-onnx | 1.23 GB | zh, en | no | no | final | Apache-2.0 | csukuangfj2 export, pin available | new adapter (`fire_red_asr`) | no: Chinese and English only |
| Paraformer zh | sherpa-onnx | 0.24 GB | zh | not checked | no | final | FunASR model licence | csukuangfj export, pin available | new adapter (`paraformer`) | no: Chinese only |
| NeMo CTC (Parakeet CTC 1.1B, TDT-CTC 110M) | sherpa-onnx | 0.1 to 1.1 GB | en | yes | no | final | CC-BY-4.0 | csukuangfj and community exports | new adapter (`nemo_ctc`) | no: English only, no vocabulary |
| Qwen3-ASR 0.6B, int8 sherpa export | sherpa-onnx | 0.98 GB | 30 | no | yes | final | Apache-2.0 | csukuangfj2 export, pin available | new adapter (sherpa's Qwen3-ASR config) | no: 5.40 and 6.34 % on FLEURS English and Spanish, 7 of 30 names ([benchmark](asr-benchmark.md)); the GGUF route is the same model on a path akou already has |
| Voxtral Mini 3B 2507, Q4_K_M GGUF | llama-server | 3.2 GB with its projector | 8 (en, es, fr, pt, hi, de, nl, it) | no | no | final | Apache-2.0 | [ggml-org/Voxtral-Mini-3B-2507-GGUF](https://huggingface.co/ggml-org/Voxtral-Mini-3B-2507-GGUF), pin available | new adapter: its own transcription prompt and answer format | later, after a benchmark run |
| Voxtral Mini 4B Realtime | none akou ships | 4B parameters | not checked here | no | no | live | Apache-2.0 | listed in the live setups as unavailable | new runtime | no: it runs only at real time on an M4 |
| Other audio models with llama.cpp GGUFs (Ultravox, Qwen2.5-Omni, Gemma 3n, LFM2-Audio, Qwen3-Omni) | llama-server | 1 to 20 GB | varies | no | no | final | varies | ggml-org | new prompt adapter each | no: general audio models, not trained to transcribe |

## What to do next

1. **Qwen3-ASR 0.6B through llama-server.** Pin the Q8_0 GGUF and its projector, and make `llamaSpec` read the file names from the catalog entry. Today the 1.7B's file names are constants in [index.ts](../../src/main/index.ts). Then put it through the benchmark before anyone is offered it. The benchmark measured the 0.6B through MLX and sherpa-onnx, not llama.cpp. On the 56 synthetic code-switched clips the 0.6B labelled every one as another language, so offer it only with the call's languages set.
2. **Let the final pass and jobs take a recognizer id.** Parakeet TDT v2 and any other `nemo_transducer` export would then need only a catalog entry, its tokenizer for biasing, and a benchmark row.
3. **Measure the six new tiers.** Run FLEURS through the live path with [live-nemotron.test.ts](../../tests/live-nemotron.test.ts) and `AKOU_LIVE_MODELS`, and time two channels at real time. Their `not_measured` rows then become numbers, and their lines can say how they compare.
4. **New sherpa adapters only where a language needs one.** That means Dolphin for Eastern languages, and Kroko or Zipformer streaming for a language Nemotron does not hear. Each needs its own config branch, its own word-time handling and a benchmark row.
5. **Whisper, Canary 1B v2 and Cohere go through transcribe-cpp.** That is ASR-8 in the [architecture](asr-architecture.md), not sherpa-onnx.
