# Speech recognizer benchmark

We measured which Parakeet build akou should ship, and whether Qwen3-ASR should replace Parakeet. The decisions:

- akou ships Parakeet TDT 0.6B v3 in full precision (fp32). With beam search it makes a third fewer word errors in English than the int8 build akou shipped before (5.85 % against 9.04 % on FLEURS) and a fifth fewer in Spanish (3.12 % against 3.99 %), and it finds more names under decode biasing. The cost is a larger first download (2.55 GB for the recognizer instead of 670 MB) and about 0.6 GB more memory.
- fp16 is not an option today. The upstream fp16 repository is empty. A build we converted ourselves gave the same output as fp32 on every test utterance, and it used more memory, not less.
- akou stays on Parakeet. [Qwen3-ASR 1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) is more accurate in English. It ties in Spanish and on names, sometimes misreads the spoken language, copies words from its context list, and needs three times the memory. The one Qwen build that runs on every OS through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) is the 0.6B int8 export, and it loses to fp32 Parakeet in Spanish and on names.

The numbers for public data are in [asr-benchmark.json](asr-benchmark.json).

## Method

**Machine.** An Apple M4 Mac mini, 10 cores, 16 GB, running CI builds at the same time. Accuracy does not depend on load, but speed does. The first run's speed figures carry that load. For the int8, fp16 and fp32 speed comparison and the [G6 gate](../gates/M0-results.md#g6-recognizer-speed), each timed job waited until the one-minute load average was under 3.

**Parakeet.** sherpa-onnx-node 1.13.8 on the CPU with 4 threads, configured as akou configures it (`nemo_transducer`, 80-dimension features). Three conditions:

- `greedy`: greedy search.
- `beam`: `modified_beam_search` with 4 active paths, akou's decoder.
- `beam + list`: beam search plus the test's word list as hotwords at boost 3, with the `bpe.vocab` akou builds from the model's tokenizer. This is akou's production setting whenever a call has a decode list.

Each build is pinned to a commit:

| Build | Source | Recognizer download |
|---|---|---|
| int8 | [csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8@2bda32ec](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/tree/2bda32ec70b097a55adaa07d9a7173915b43cc78) | 670 MB |
| fp32 | [csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3@1a468a35](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3/tree/1a468a35cbba69418f126de829e75261dea4a4e4) | 2.55 GB |
| fp16 | The [fp16 repository](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-fp16) holds only `.gitattributes`. Upstream's answer in [k2-fsa/sherpa-onnx#3529](https://github.com/k2-fsa/sherpa-onnx/issues/3529) is to convert fp32 yourself, so we did, with onnxconverter-common 1.16 (`keep_io_types`) | 1.28 GB |

**Qwen3-ASR.** The 1.7B and 0.6B models through three runtimes. The official [`qwen-asr`](https://pypi.org/project/qwen-asr/) package runs Transformers in bf16 on the Mac GPU, with one fp32 CPU control run. [`mlx-qwen3-asr`](https://pypi.org/project/mlx-qwen3-asr/) runs MLX in fp16. The third is sherpa-onnx's Qwen3-ASR 0.6B int8 export. `plain` runs with no context. `ctx` passes the same word list Parakeet got as hotwords.

**Data.**

- [FLEURS](https://huggingface.co/datasets/google/fleurs), test split: 150 English (en_us, 24.2 minutes) and 150 Spanish (es_419, 31.0 minutes) utterances. The ids are in the JSON file.
- Synthetic names: 28 English sentences read by 7 text-to-speech voices. Five voices have English accents (Australia, Britain, Ireland, India, US) and two are Spanish voices reading the same English. 20 sentences contain one of ten rare names or product terms (140 clips). 8 contain none (56 control clips).
- Clips from our own call recordings: 30 clips that each contain one of five names, 30 clips that contain none of them, 40 ten-second clips in which one channel is silent (noise floor, bleed from the other side, or digital silence), and one 66-minute recording for long-form speed and memory. The recordings stay private, and this page reports only counts from them.

**Scoring.** One normalizer for every engine: NFKC, lower case, apostrophes dropped, punctuation turned into spaces, accents kept. The WER in the tables is also number-normalized: Whisper's English normalizer for English and `text2num` for Spanish, so "twenty" and "20" count as the same word. A name counts as found when it appears as a whole word, in any case, with an optional plural or possessive.

**Paired bootstrap.** For two engines on the same utterances: resample the 150 utterances with replacement 2,000 times (seed 0), recompute both WERs each time, and report the 2.5th and 97.5th percentiles of the difference. A range that excludes zero is a difference this sample can see. A range that includes zero is a tie.

**Memory** is the peak memory footprint `/usr/bin/time -l` reports for the whole process.

## Parakeet: int8, fp16 and fp32

On FLEURS, second run (all three builds on the same audio):

| Build | English, greedy | English, beam | Spanish, greedy | Spanish, beam | Peak memory |
|---|---|---|---|---|---|
| int8 | 8.50 % | 9.04 % | 4.01 % | 3.99 % | 1.9 to 2.1 GB |
| fp16 (converted) | 6.03 % | 5.85 % | 3.07 % | 3.12 % | 3.7 to 3.8 GB |
| fp32 | 6.03 % | 5.85 % | 3.07 % | 3.12 % | 2.5 to 2.7 GB |

int8 minus fp32, paired bootstrap:

| | Difference | 95 % range | Utterances where int8 is worse / better |
|---|---|---|---|
| English, greedy | +2.48 | 1.35 to 3.71 | 50 / 15 |
| English, beam | +3.19 | 1.58 to 5.19 | 47 / 17 |
| Spanish, greedy | +0.95 | 0.41 to 1.47 | 32 / 12 |
| Spanish, beam | +0.87 | 0.33 to 1.39 | 30 / 13 |

Every range excludes zero. int8 is worse in both languages, with both decoders.

fp16 against fp32 is 0.00, range 0.00 to 0.00, and the text was identical on all 600 decodes. onnxruntime has no fp16 kernels on the CPU for most of these operators, so it inserts casts and computes in fp32. The converted encoder has 134 Cast nodes. After onnxruntime 1.23 loads it for the CPU, it has 894. The fp16 build therefore gives fp32's results from weights rounded to fp16, and holds fp32 copies of them in memory. That is the extra gigabyte in the table. We did not run it on x64 Linux or Windows. With no upstream file to pin, akou would have to host its own conversion, and nothing in these numbers is worth that.

In the first run, which decoded a differently prepared copy of the same FLEURS audio, int8 against fp32 with greedy search was 8.74 % against 6.00 % in English (difference 2.75, range 1.67 to 3.98) and 4.11 % against 3.07 % in Spanish (1.05, range 0.50 to 1.60). The two runs agree on the direction and on the size to within 0.3 points.

## Names

Each engine with the word list, and without it for reference:

| Engine | Synthetic clips: names found | Synthetic clips: list words inserted where not spoken | Our recordings: names found | Our recordings: list words in the 30 clips without them |
|---|---|---|---|---|
| Parakeet int8, greedy, no list | 48 of 140 | 0 | 6 of 30 | 0 |
| Parakeet fp32, greedy, no list | 56 of 140 | 0 | 9 of 30 | 0 |
| Parakeet int8, beam + list | 94 of 140 | 2 | 22 of 30 | 2 |
| **Parakeet fp32, beam + list** | **96 of 140** | **1** | **27 of 30** | **1** |
| Qwen3-ASR 1.7B, MLX, ctx | 109 of 140 | 9 | 28 of 30 | 0 |
| Qwen3-ASR 1.7B, Transformers, ctx | 110 of 140 | 10 | 28 of 30 | 0 |
| Qwen3-ASR 0.6B, MLX, ctx | 112 of 140 | 11 | 27 of 30 | 0 |
| Qwen3-ASR 0.6B int8, sherpa-onnx, ctx | 74 of 140 | 10 | 7 of 30 | 0 |

On real speech the fp32 build finds 27 of 30 names, the int8 build 22, and Qwen 1.7B 28. At this sample size fp32 and Qwen tie. On the synthetic clips Qwen finds more names, and it also writes list words into 9 to 11 sentences that did not contain them. Parakeet does that once.

Qwen detects the spoken language on its own unless told. On the 56 synthetic clips where the Spanish voices read English, the 1.7B model (MLX, no context) labelled 30 as another language: 19 Spanish, 6 Swedish and 5 others. The 0.6B model labelled all 56 as another language. Forcing English fixes the label, but a call can switch languages, and Parakeet needs no language setting.

## Silent channels

40 clips in which one side of the call is silent. How many produced any text, and how many words:

| Engine | Clips with text | Words |
|---|---|---|
| Parakeet int8, greedy | 4 | 10 |
| Parakeet int8, beam | 0 | 0 |
| Parakeet int8, beam + list | 16 | 41 |
| Parakeet fp32, greedy | 0 | 0 |
| Parakeet fp32, beam + list | 9 | 30 |
| Qwen3-ASR 1.7B, MLX, no context / ctx | 2 / 0 | 2 / 0 |

The fp32 build writes nothing on silence with greedy search. With the word list it still writes something on 9 of 40 noise-only clips, fewer than int8's 16. The list's boost pulls noise toward the listed words. fp32 with beam search and no list was not run on this set.

## Speed, memory and long recordings

The 66-minute recording, cut by Silero VAD the way [akou's live worker](../../src/main/asr/live-worker.ts) cuts it (1,691 segments), first run, under load:

| Engine | Real-time factor | Peak memory |
|---|---|---|
| Parakeet int8, greedy | 0.031 | 2.7 GB |
| Parakeet int8, beam | 0.029 | 2.6 GB |
| Parakeet fp32, greedy | 0.049 | 3.3 GB |
| Qwen3-ASR 1.7B, MLX | 0.143 | 8.1 GB |
| Qwen3-ASR 0.6B, MLX | 0.057 | 3.3 GB |
| Qwen3-ASR 0.6B int8, sherpa-onnx | 0.174 | 3.4 GB |
| Qwen3-ASR 1.7B, Transformers, 300 s chunks | 0.387 | 15.2 GB |

The official Transformers path runs out of memory on 16 GB with its default 20-minute chunks, so it ran with 300-second chunks. Even then it dropped spans: against Parakeet's transcript, its longest run of missing words was 288 (1.7B) and 499 (0.6B). The MLX runs never miss more than 27 words in a row against Parakeet's transcript.

On FLEURS, Qwen3-ASR 1.7B on MLX ran at a real-time factor of 0.19 (English) and 0.25 (Spanish) in 8.1 GB, against fp32 Parakeet's 0.021 and 0.019 in 2.5 to 2.7 GB. That is 9 to 13 times slower on short utterances, 3 times slower on the long recording, and about 3 times the memory.

## Why akou stays on Parakeet

FLEURS, first run, greedy Parakeet against Qwen without context:

| | English | Spanish |
|---|---|---|
| Parakeet fp32 | 6.00 % | 3.07 % |
| Qwen3-ASR 1.7B, MLX | 3.64 % | 2.86 % |
| Qwen3-ASR 1.7B, Transformers | 3.52 % | 2.91 % |
| Qwen3-ASR 0.6B, MLX | 4.89 % | 4.52 % |
| Qwen3-ASR 0.6B int8, sherpa-onnx | 5.40 % | 6.34 % |

Parakeet fp32 minus Qwen, paired bootstrap:

| Qwen engine | English | Spanish |
|---|---|---|
| 1.7B, MLX | +2.36 (1.45 to 3.39) | +0.20 (−0.42 to 0.83) |
| 1.7B, Transformers | +2.48 (1.57 to 3.52) | +0.15 (−0.40 to 0.71) |
| 0.6B, MLX | +1.10 (0.19 to 2.07) | −1.46 (−2.29 to −0.67) |
| 0.6B int8, sherpa-onnx | +0.60 (−0.30 to 1.61) | −3.27 (−4.20 to −2.34) |

Qwen 1.7B wins English by 2.4 points, a real difference. Everything else points the other way or is a tie:

- Spanish is a tie with the 1.7B model. Both 0.6B builds lose to Parakeet.
- Names on our own recordings are a tie (28 against 27 of 30), and Qwen copies list words into sentences where nobody said them.
- Qwen misreads accented English as another language unless the language is forced.
- It is 3 to 13 times slower and needs about 3 times the memory.
- The 1.7B model runs well only through MLX, which is Apple silicon only, or PyTorch. The one Qwen path that runs through sherpa-onnx on every OS akou supports is the 0.6B int8 export. It ties fp32 Parakeet in English and loses clearly in Spanish (by 3.3 points) and on names (7 against 27 of 30).

Switching would buy 2.4 points of English WER on a Mac. It would cost Spanish, names, memory, speed, and the single engine akou runs on every OS. Moving from int8 to fp32 Parakeet already cut the English gap to Qwen 1.7B from 5.1 points to 2.4, for 0.6 GB of memory and a bigger download.
