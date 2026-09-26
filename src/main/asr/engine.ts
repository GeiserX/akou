/**
 * The speech engines behind the live and final passes (docs/DESIGN.md section 3), as interfaces,
 * so the pipelines are plain code that CI runs against deterministic fakes and the app runs
 * against sherpa-onnx (`sherpa.ts`) and the `akou-diarize` helper (`nemotron.ts`).
 *
 * Every engine works on 16 kHz mono float audio. A `ModelSet` loads each model once per app run
 * and counts the loads (TRAPS "Models loaded twice"); the Silero VAD keeps per-stream state, so
 * there is one VAD per channel, never one per part.
 *
 * `FinalEngine`, `LiveEngine` and `Fuser` are the engine interfaces of
 * docs/research/asr-architecture.md section 2.1: any number of engines decode the same units into
 * `Hypothesis` values that carry per-word confidences and times, and a fuser combines them.
 * Parakeet on sherpa-onnx is the first `FinalEngine` (`RecognizerEngine` over the model set's
 * recognizer); the pipelines still call `Recognizer.decode` until the N-engine final pass (ASR-6).
 */

import type { Provider } from "../llm/provider.ts";
import type { TermCheck } from "../vocab/bpe-vocab.ts";
import type { DecodeList, ModelKind } from "../vocab/decode-list.ts";

export const ASR_RATE = 16000;

/** One word of a hypothesis. Times are seconds into the decoded unit. */
export interface WordHyp {
  w: string;
  /** 0 to 1, when the engine reports token probabilities. */
  conf?: number;
  t0?: number;
  t1?: number;
}

/** What one engine heard in one unit. */
export interface Hypothesis {
  /** The engine's registry id, written into `seg.model`. */
  engine: string;
  text: string;
  words: WordHyp[];
  lang?: string;
  /** Decode time, milliseconds. */
  ms: number;
}

/** One unit of the final pass: gained, padded audio and what the call knows about it. */
export interface FinalUnit {
  samples: Float32Array;
  lang: "auto" | string;
  glossary: readonly string[];
}

/** An engine of the final pass (`asr.final.engines`). */
export interface FinalEngine {
  /** Registry id, written into `seg.model`. */
  readonly id: string;
  readonly features: {
    confidence: boolean;
    timestamps: boolean;
    glossary: boolean;
    languageId: boolean;
  };
  load(): Promise<void>;
  unload(): Promise<void>;
  decode(unit: FinalUnit): Promise<Hypothesis>;
}

/** A live token. Append-only: a token is never taken back. */
export interface LiveToken {
  text: string;
  /** Seconds into the stream. */
  t: number;
  conf: number;
}

/** One live stream, kept for the whole call. */
export interface LiveStream {
  push(samples: Float32Array): LiveToken[];
  flush(): LiveToken[];
  close(): void;
}

/** A streaming engine of the live pass (`asr.live.engine`). */
export interface LiveEngine {
  readonly id: string;
  /** The engine's latency tier (560 or 1120 for Nemotron). */
  readonly tierMs: number;
  readonly languages: readonly string[];
  /** One stream per channel. */
  open(lang: "auto" | string): LiveStream;
}

export type FuserId = "first" | "rover-freq" | "rover-conf" | "llm-pick" | "llm-free";

/** Combines the hypotheses of any number of engines over one unit into one (`asr.fusion`). */
export interface Fuser {
  readonly id: FuserId;
  fuse(
    hyps: readonly Hypothesis[],
    ctx: { lang: string; glossary: readonly string[]; provider?: Provider },
  ): Promise<Hypothesis>;
}

export interface Recognized {
  text: string;
  /** Only models that detect the language report it (Whisper); Parakeet leaves it empty. */
  lang?: string;
  /** Per-word confidences and times, from engines that report them (sherpa-onnx). */
  words?: WordHyp[];
}

export interface Recognizer {
  /** Registry name, written into every `seg` (`parakeet-tdt-0.6b-v3-fp32`). */
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

/** Who speaks when over a whole stream (the final pass). */
export interface Diarizer {
  process(samples: Float32Array): DiarizedSpan[] | Promise<DiarizedSpan[]>;
}

/** Which speaker-label engine a model set runs (`asr.diarizer`). */
export type DiarizerKind = "nemotron" | "embeddings";

/** How Parakeet decodes (`asr.parakeet.decoding`); only `beam` takes hotwords. */
export type ParakeetDecoding = "greedy" | "beam";

/** One speaker active over `[start, end)`, in samples on a stream diarizer's own timeline. */
export interface SpeakerTurn {
  /** The model's speaker index in this stream, numbered by first appearance from 0. */
  speaker: number;
  start: number;
  end: number;
}

/** What a stream diarizer reports, as it decides. */
export interface StreamListener {
  /** Newly decided turns, and the stream position before which every sample is decided. */
  turns(turns: readonly SpeakerTurn[], decided: number): void;
  /** The diarizer stopped for good (its process died, or it refused its model). */
  dead(error: string): void;
}

/**
 * Who speaks when, live (Nemotron at its live latency). Audio is appended to one stream whose
 * speaker state carries from one push to the next, so a speaker keeps its index for as long as
 * the stream lives; results come back through the listener, some time after their audio.
 */
export interface StreamDiarizer {
  /** Appends audio (16 kHz mono) to the stream. */
  push(samples: Float32Array): void;
  /** Resolves once everything pushed so far is decided and reported; rejects if it died. */
  flush(): Promise<void>;
  /** Forgets the stream: the next push starts a new one at sample 0, speakers numbered afresh. */
  reset(): void;
  close(): void;
}

/** The hotwords a decode will use, after the tokenization check (bpe-vocab.ts). */
export interface PreparedHotwords {
  recognizer: Recognizer;
  /** The `createStream` argument, or undefined for none. */
  arg: string | undefined;
  /** Entries in force, in the `vocab.used` form (`term` or `term :N`). */
  entries: string[];
  /** Each logged as an error by the pipelines. */
  dropped: { term: string; reason: string }[];
  /** Anything else about the list the pipelines log at warn (a greedy recognizer takes none). */
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
  /** The final pass's diarizer. */
  diarizer(): Diarizer;
  /**
   * The live speaker labeller when the model set runs a streaming diarizer, else null (live
   * labels then come from embedding clusters).
   */
  streamDiarizer(listener: StreamListener): StreamDiarizer | null;
  /** Model loads so far, by model. */
  readonly loads: Readonly<Record<string, number>>;
}

/**
 * A final engine that runs as a llama-server child process (Qwen3-ASR, `qwen.ts`). The Worker that
 * decodes starts and supervises the process; `command` is an own llama-server (`asr.llamaServer`)
 * or a test's fake, else `build` is the pinned download, unpacked on first use.
 */
export interface LlamaEngineSpec {
  kind: "llama-server";
  /** The catalog id (`qwen3-asr-1.7b`). */
  engine: string;
  model: string;
  mmproj: string;
  accelerator: "cpu" | "metal" | "cuda" | "vulkan";
  command?: readonly string[];
  build?: { dir: string; archives: readonly string[]; platform: string };
  threads?: number;
  /** Layers on the GPU; default every one on a GPU build and none on a CPU build. */
  gpuLayers?: number;
  /** ISO codes the engine may choose among on `auto`; empty for any. */
  languages?: readonly string[];
}

/**
 * How a Worker gets its models: sherpa-onnx with files from the models folder, or a module that
 * exports `createModels(options)` (the test fakes, which CI uses). `final`, when set, is the engine
 * that decodes a file job's units in place of the model set's recognizer, which then never loads;
 * the model set still gives the VAD and the speaker labels.
 */
export type ModelSpec = (
  | {
      kind: "sherpa";
      dir: string;
      cacheDir: string;
      threads?: number;
      /** Default `nemotron`, the setting's default. */
      diarizer?: DiarizerKind;
      /** Default `greedy`, the setting's default. */
      decoding?: ParakeetDecoding;
      /** The `akou-diarize` command, program first (`locateHelper`). */
      diarizeHelper?: readonly string[];
    }
  | { kind: "module"; path: string; model: string; options?: unknown }
) & { final?: LlamaEngineSpec };

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

/**
 * A model set's recognizer as a `FinalEngine`: Parakeet on sherpa-onnx in the app, the fake
 * recognizer in CI. It decodes through `prepare`, so the recognizer still loads once per app run
 * whichever path asks for it. It takes no glossary: Parakeet decodes greedy, which takes no
 * hotwords, and the vocabulary applies when reading and after the call.
 */
export class RecognizerEngine implements FinalEngine {
  readonly id: string;
  readonly features = { confidence: true, timestamps: true, glossary: false, languageId: false };
  private rec: Recognizer | null = null;

  constructor(private readonly models: Pick<ModelSet, "recognizerModel" | "prepare">) {
    this.id = models.recognizerModel;
  }

  async load(): Promise<void> {
    this.rec ??= this.models.prepare(null).recognizer;
  }

  async unload(): Promise<void> {
    this.rec = null;
  }

  async decode(unit: FinalUnit): Promise<Hypothesis> {
    await this.load();
    const rec = this.rec as Recognizer;
    const t = performance.now();
    const r = rec.decode(unit.samples);
    const ms = performance.now() - t;
    const h: Hypothesis = { engine: this.id, text: r.text, words: r.words ?? [], ms };
    if (r.lang) h.lang = r.lang;
    return h;
  }
}
