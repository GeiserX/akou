/**
 * The speech engines behind the live and final passes (docs/DESIGN.md section 3), as interfaces,
 * so the pipelines are plain code that CI runs against deterministic fakes and the app runs
 * against sherpa-onnx (`sherpa.ts`).
 *
 * Every engine works on 16 kHz mono float audio. A `ModelSet` loads each model once per app run
 * and counts the loads (TRAPS "Models loaded twice"); the Silero VAD keeps per-stream state, so
 * there is one VAD per channel, never one per part.
 */

import type { TermCheck } from "../vocab/bpe-vocab.ts";
import type { DecodeList, ModelKind } from "../vocab/decode-list.ts";

export const ASR_RATE = 16000;

export interface Recognized {
  text: string;
  /** Only models that detect the language report it (Whisper); Parakeet leaves it empty. */
  lang?: string;
}

export interface Recognizer {
  /** Registry name, written into every `seg` (`parakeet-tdt-0.6b-v3-int8`). */
  readonly model: string;
  readonly kind: ModelKind;
  /**
   * Decodes one span. `hotwords` is the per-stream list (`createStream(list)`); it is passed only
   * when the model takes hotwords, and never as an empty string.
   */
  decode(samples: Float32Array, hotwords?: string): Recognized;
}

/** Voice activity, one fixed-size window at a time. */
export interface Vad {
  /** Samples per window (512 for Silero at 16 kHz). */
  readonly windowSize: number;
  /** Feeds one window; true while speech is detected. */
  accept(window: Float32Array): boolean;
  /** Clears the stream state (a new part, or audio that skipped ahead). */
  reset(): void;
}

export interface Embedder {
  readonly dim: number;
  embed(samples: Float32Array): Float32Array;
}

export interface DiarizedSpan {
  /** Seconds into the audio given to `process`. */
  start: number;
  end: number;
  speaker: number;
}

export interface Diarizer {
  process(samples: Float32Array): DiarizedSpan[];
}

/** The hotwords a decode will use, after the tokenization check (bpe-vocab.ts). */
export interface PreparedHotwords {
  recognizer: Recognizer;
  /** The `createStream` argument, or undefined for none. */
  arg: string | undefined;
  /** Entries in force, in the `vocab.used` form (`term` or `term :N`). */
  entries: string[];
  dropped: { term: string; reason: string }[];
  warnings: string[];
  /** Per-term results of the tokenization check, for the log and `akou vocab check`. */
  checks: TermCheck[];
}

export interface ModelSet {
  /** The recognizer's registry name, known before it loads (for the decode list). */
  readonly recognizerModel: string;
  /**
   * The recognizer that will decode with this list, and the list as it will be used. A list whose
   * words the loaded recognizer cannot bias (sherpa-onnx fixes its hotword tokenizer at load) may
   * cost one reload; `loads` counts it.
   */
  prepare(list: DecodeList | null): PreparedHotwords;
  /** A VAD with its own stream state. */
  vad(): Vad;
  embedder(): Embedder;
  diarizer(): Diarizer;
  /** Model loads so far, by model. */
  readonly loads: Readonly<Record<string, number>>;
}

/**
 * How a Worker gets its models: sherpa-onnx with files from the models folder, or a module that
 * exports `createModels(options)` (the test fakes, which CI uses).
 */
export type ModelSpec =
  | { kind: "sherpa"; dir: string; cacheDir: string; threads?: number }
  | { kind: "module"; path: string; model: string; options?: unknown };

export async function loadModelSet(spec: ModelSpec): Promise<ModelSet> {
  if (spec.kind === "module") {
    const mod = (await import(spec.path)) as {
      createModels(o: unknown, model: string): ModelSet;
    };
    return mod.createModels(spec.options, spec.model);
  }
  const { SherpaModels } = await import("./sherpa.ts");
  return new SherpaModels(spec);
}
