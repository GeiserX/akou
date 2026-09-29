/**
 * How each catalog model behaves: accuracy and speed, each as the raw number we measured or read,
 * with where it is written down, and a 0 to 100 score for the Models page's two bars
 * (docs/ux/SERVER.md SV-U6). A number nobody measured is `notMeasured` with the reason; the page
 * shows that, never a guess.
 *
 * The scores:
 * - **Accuracy from WER** (word error rate, %): `100 - 5 * WER`. WER is the mean of FLEURS
 *   English and Spanish from our own benchmark, so every recognizer is scored on the same clips.
 *   A 20 % WER scores 0.
 * - **Accuracy from DER** (diarization error rate, %): `100 - DER`.
 * - **Speed from RTFx** (seconds of audio per second of compute, the inverse of the real-time
 *   factor) on the reference machine: `50 * log10(RTFx)`. Real time scores 0, 10x scores 50, 100x
 *   scores 100. Logarithmic because the models span two orders of magnitude.
 *
 * The live setups' bars (live-setups.ts), lower is better on each:
 * - **Accuracy on calls** (WER on AMI meetings, %): `100 - 2 * WER`. Meetings are harder than
 *   FLEURS read speech, so a 50 % WER scores 0.
 * - **Latency** (seconds from a word said to the word shown, p50): `100 - 50 * s`. 2 s scores 0.
 * - **Cores** (CPU cores the live path uses for one channel): `100 - 50 * cores`. 2 cores score 0.
 * - **Memory** (resident GB during a call): `100 - 6.25 * GB`. 16 GB scores 0.
 *
 * Every score is clamped to 0..100 and rounded. The reference machine is `REFERENCE_MACHINE`.
 *
 * Keyed by catalog id. The llama-server builds (`serves: ["runtime"]`) are programs, not models,
 * and are answered by `scoresOf` without a row here.
 */

import type { CatalogEntry, ModelSpecEntry } from "./models.ts";

export const REFERENCE_MACHINE = "Apple M4 Mac mini, 10 cores, 16 GB";

export type Metric = "wer" | "der" | "rtfx" | "call-wer" | "seconds" | "cores" | "gb";

/** One number: what it is, on what, and where it is written down. */
export interface Measure {
  metric: Metric;
  /** WER or DER in percent, or RTFx. */
  value: number;
  /** What was measured, in words: the set, the build, the machine. */
  what: string;
  /**
   * An accuracy figure's test set in the plain words the Models page says it in: `read speech`
   * (FLEURS), `meetings` (AMI), `real calls` (our own recorded calls).
   */
  set?: string;
  /** A repository path or a public URL. */
  source: string;
}

/** A number nobody has measured, and why. */
export interface NotMeasured {
  notMeasured: string;
}

export interface ModelScores {
  accuracy: Measure | NotMeasured;
  speed: Measure | NotMeasured;
}

const ARCH = "docs/research/asr-architecture.md";
const BENCH = "docs/research/asr-benchmark.md";
const REQS = "docs/REQUIREMENTS.md";

/** Speed from minutes of compute per audio hour, as the architecture research reports it. */
function perHour(minutes: number): number {
  return Math.round((60 / minutes) * 10) / 10;
}

export const SCORES: Readonly<Record<string, ModelScores>> = {
  "parakeet-tdt-0.6b-v3-fp32": {
    accuracy: {
      metric: "wer",
      value: (6.03 + 3.07) / 2,
      set: "read speech",
      what: "FLEURS, 150 English and 150 Spanish clips, greedy: 6.03 % and 3.07 %",
      source: `${BENCH}#parakeet-int8-fp16-and-fp32`,
    },
    speed: {
      metric: "rtfx",
      value: perHour(1.3),
      what: `1.3 min of compute per audio hour over eight public sets, on the ${REFERENCE_MACHINE}`,
      source: `${ARCH}#4-final-pass-default-engines-and-what-n-engines-buy`,
    },
  },
  "qwen3-asr-1.7b": {
    accuracy: {
      metric: "wer",
      value: (3.76 + 2.81) / 2,
      set: "read speech",
      what: "FLEURS, 150 English and 150 Spanish clips, the Q8_0 GGUF through llama.cpp on a Linux arm64 CPU: 3.76 % and 2.81 % (bf16 on Metal reads 3.79 % and 2.89 %)",
      source: `${ARCH}#23-runtimes-akou-bundles-or-downloads-three-no-python`,
    },
    speed: {
      metric: "rtfx",
      value: perHour(8.0),
      what: `8.0 min of compute per audio hour over eight public sets, llama-server on Metal, on the ${REFERENCE_MACHINE}`,
      source: `${ARCH}#4-final-pass-default-engines-and-what-n-engines-buy`,
    },
  },
  "nemotron-en-560": {
    accuracy: {
      metric: "wer",
      value: 9.3,
      set: "read speech",
      what: "FLEURS, 150 English clips through the live path (an English-only model: no Spanish figure): 9.30 %",
      source: `${ARCH}#31-what-replaces-the-12-s-windows`,
    },
    speed: {
      metric: "rtfx",
      value: Math.round((1 / 0.067) * 10) / 10,
      what: `the benchmark's streaming Nemotron at 560 ms: real-time factor 0.067 at 4 threads, one channel, the first 600 s of an Earnings-22 call, on the ${REFERENCE_MACHINE}`,
      source: `${ARCH}#31-what-replaces-the-12-s-windows`,
    },
  },
  "nemotron-3.5-560": {
    accuracy: {
      metric: "wer",
      value: (10.16 + 6.31) / 2,
      set: "read speech",
      what: "FLEURS, 150 English and 150 Spanish clips through the live path, language auto: 10.16 % and 6.31 %",
      source: `${ARCH}#31-what-replaces-the-12-s-windows`,
    },
    speed: {
      metric: "rtfx",
      value: Math.round((1 / 0.067) * 10) / 10,
      what: `the benchmark's streaming Nemotron at 560 ms: real-time factor 0.067 at 4 threads, one channel, the first 600 s of an Earnings-22 call, on the ${REFERENCE_MACHINE}`,
      source: `${ARCH}#31-what-replaces-the-12-s-windows`,
    },
  },
  "nemotron-3.5-1120": {
    accuracy: {
      metric: "wer",
      value: (9.99 + 6.36) / 2,
      set: "read speech",
      what: "FLEURS, 150 English (language auto) and 150 Spanish (language es) clips through the live path: 9.99 % and 6.36 %",
      source: `${ARCH}#31-what-replaces-the-12-s-windows`,
    },
    speed: {
      notMeasured:
        "the benchmark timed the 560 ms tier only; the 1120 ms tier decodes the same model in larger chunks",
    },
  },
  "nemotron-3-diarization": {
    accuracy: {
      metric: "der",
      value: (8.7 + 11.1) / 2,
      set: "real calls",
      what: "final pass on eight real two-channel calls (6.6 h): 8.7 to 11.1 % DER, the middle of that range. The nightly AMI test (two meetings, 0.25 s collar, overlap scored) reads 20.17 % on Linux x64",
      source: `${REQS}`,
    },
    speed: { notMeasured: "no speed figure for the diarizer on its own has been recorded" },
  },
  "pyannote-segmentation-3.0": {
    accuracy: {
      metric: "der",
      value: (54 + 64) / 2,
      set: "real calls",
      what: "the embeddings diarizer (this segmentation with TitaNet clusters) on the same eight real calls: 54 to 64 % DER, the middle of that range",
      source: `${REQS}`,
    },
    speed: { notMeasured: "no speed figure for the diarizer on its own has been recorded" },
  },
  "titanet-small": {
    accuracy: {
      notMeasured:
        "measured only as part of the embeddings diarizer, whose DER is on the pyannote row",
    },
    speed: { notMeasured: "no speed figure for the embedder on its own has been recorded" },
  },
  "silero-vad": {
    accuracy: { notMeasured: "finds speech, writes no words: no WER or DER applies" },
    speed: { notMeasured: "no speed figure for the VAD on its own has been recorded" },
  },
};

const RUNTIME: ModelScores = {
  accuracy: { notMeasured: "a program that runs Qwen3-ASR, not a model: it hears nothing itself" },
  speed: { notMeasured: "its speed is Qwen3-ASR's, on that row" },
};

/** The scores of one catalog entry, or null for an entry with no row (a test catalog's). */
export function scoresOf(m: ModelSpecEntry): ModelScores | null {
  const row = SCORES[m.id];
  if (row) return row;
  const serves = (m as Partial<CatalogEntry>).serves;
  return serves?.length === 1 && serves[0] === "runtime" ? RUNTIME : null;
}

const RAW: Readonly<Record<Metric, (v: number) => number>> = {
  wer: (v) => 100 - 5 * v,
  der: (v) => 100 - v,
  rtfx: (v) => 50 * Math.log10(v),
  "call-wer": (v) => 100 - 2 * v,
  seconds: (v) => 100 - 50 * v,
  cores: (v) => 100 - 50 * v,
  gb: (v) => 100 - 6.25 * v,
};

/** A measure's 0 to 100 score, by the formulas at the top of this file. */
export function score(m: Measure): number {
  const raw = RAW[m.metric](m.value);
  return Math.round(Math.min(100, Math.max(0, raw)));
}

/** How the page states each formula, beside the number. */
export const FORMULAS: Readonly<Record<Metric, string>> = {
  wer: "100 - 5 x WER (a 20 % WER scores 0)",
  der: "100 - DER",
  rtfx: `50 x log10(RTFx) on the ${REFERENCE_MACHINE} (real time 0, 10x 50, 100x 100)`,
  "call-wer": "100 - 2 x WER on AMI meetings (a 50 % WER scores 0)",
  seconds: "100 - 50 x seconds (2 s scores 0)",
  cores: "100 - 50 x cores (2 cores score 0)",
  gb: "100 - 6.25 x GB (16 GB scores 0)",
};
